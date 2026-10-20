import {randomUUID} from 'node:crypto';

// IDs and tombstones only: bodies remain in messages. Triggers put changes in
// the same transaction as every producer, including GPU/resource notifications.
export function installSyncSchema(db){
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_changes (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL,
      channel_id TEXT, message_id INTEGER, parent_id INTEGER, user_id TEXT
    );
    CREATE TABLE IF NOT EXISTS send_requests (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      client_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      PRIMARY KEY(user_id,client_id)
    );
    CREATE INDEX IF NOT EXISTS files_message ON files(message_id);
    CREATE TRIGGER IF NOT EXISTS sync_trim AFTER INSERT ON sync_changes
      WHEN NEW.seq % 128 = 0 BEGIN
        DELETE FROM sync_changes WHERE seq <= NEW.seq - 20000;
      END;
  `);
  const triggers=[
    ['messages','INSERT','NEW'," 'message',NEW.channel_id,NEW.id,NEW.parent_id,NULL"],
    ['messages','UPDATE','NEW'," 'message',NEW.channel_id,NEW.id,NEW.parent_id,NULL"],
    ['messages','DELETE','OLD'," 'message',OLD.channel_id,OLD.id,OLD.parent_id,NULL"],
    ['channels','INSERT','NEW'," 'channel',NEW.id,NULL,NULL,NULL"],
    ['channels','UPDATE','NEW'," 'channel',NEW.id,NULL,NULL,NULL"],
    ['memberships','INSERT','NEW'," 'membership',NEW.channel_id,NULL,NULL,NEW.user_id"],
    ['memberships','DELETE','OLD'," 'membership',OLD.channel_id,NULL,NULL,OLD.user_id"],
  ];
  for(const [table,operation,,values] of triggers)db.exec(`
    CREATE TRIGGER IF NOT EXISTS sync_${table}_${operation} AFTER ${operation} ON ${table}
    BEGIN INSERT INTO sync_changes(kind,channel_id,message_id,parent_id,user_id) VALUES(${values}); END;
  `);
  for(const table of ['files','reactions'])for(const operation of ['INSERT','DELETE']){
    const row=operation==='DELETE'?'OLD':'NEW';
    db.exec(`CREATE TRIGGER IF NOT EXISTS sync_${table}_${operation} AFTER ${operation} ON ${table}
      BEGIN INSERT INTO sync_changes(kind,channel_id,message_id,parent_id)
        SELECT 'message',channel_id,id,parent_id FROM messages WHERE id=${row}.message_id; END;`);
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS sync_read AFTER UPDATE OF last_read_id ON memberships
      WHEN NEW.last_read_id > OLD.last_read_id BEGIN
        INSERT INTO sync_changes(kind,channel_id,user_id) VALUES('read',NEW.channel_id,NEW.user_id);
      END;
    CREATE TRIGGER IF NOT EXISTS sync_user_insert AFTER INSERT ON users BEGIN
      INSERT INTO sync_changes(kind) VALUES('user');
    END;
    CREATE TRIGGER IF NOT EXISTS sync_user_update AFTER UPDATE OF name,handle,role ON users BEGIN
      INSERT INTO sync_changes(kind) VALUES('user');
    END;
  `);
  db.prepare("INSERT OR IGNORE INTO app_meta(key,value) VALUES('sync_epoch',?)").run(randomUUID());
}

export function createSync(db){
  const epoch=db.prepare("SELECT value FROM app_meta WHERE key='sync_epoch'").get().value;
  const head=()=>db.prepare("SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name='sync_changes'),0) n").get().n;
  const cursor=()=>`${epoch}:${head()}`;
  const read=value=>{
    const latest=head(),token=`${epoch}:${latest}`;
    if(!value)return {reset:true,cursor:token,changes:[]};
    const match=/^([a-f0-9-]{36}):(\d+)$/.exec(value);
    const since=match?Number(match[2]):NaN;
    const floor=db.prepare('SELECT min(seq) n FROM sync_changes').get().n??latest+1;
    if(!match||match[1]!==epoch||!Number.isSafeInteger(since)||since>latest||since<floor-1)
      return {reset:true,cursor:token,changes:[]};
    const changes=db.prepare('SELECT * FROM sync_changes WHERE seq>? ORDER BY seq LIMIT 501').all(since);
    // A bounded snapshot fallback is preferable to an unbounded replay response.
    return {reset:changes.length>500,cursor:token,changes:changes.length>500?[]:changes};
  };
  return {head,cursor,read};
}

// A slow receiver retains at most one invalidation, never an event-sized queue.
export function streamWriter(res){
  let blocked=false,pending=false,stopped=false,blockedAt=0;
  const stop=()=>{stopped=true;res.off('drain',drain);};
  const write=text=>{
    if(stopped||res.destroyed||res.writableEnded)return false;
    if(res.writableLength>64*1024||(blocked&&Date.now()-blockedAt>30000)){stop();res.destroy();return false;}
    if(blocked){pending=true;return false;}
    blocked=!res.write(text);if(blocked)blockedAt=Date.now();return !blocked;
  };
  const drain=()=>{blocked=false;if(pending){pending=false;write('event: refresh\ndata: {}\n\n');}};
  res.on('drain',drain);res.once('close',stop);
  return {write,stop};
}
