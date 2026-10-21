// GPU measurements belong to Lab Chat; only the transport is shared with the collector.
// Inputs are normalized by gpu.mjs. No command lines or per-process history are retained.
const DAY=86400000,MINUTE=60000,QUARTER=900000;

export function installGpuHistorySchema(db){
  db.exec(`
    CREATE TABLE IF NOT EXISTS gpu_history_devices (
      id TEXT PRIMARY KEY, host TEXT NOT NULL, gpu_index INTEGER NOT NULL,
      reported_at INTEGER NOT NULL, observed_at INTEGER NOT NULL,
      users_json TEXT NOT NULL, continuous INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS gpu_history_buckets (
      device_id TEXT NOT NULL, resolution INTEGER NOT NULL, at INTEGER NOT NULL,
      samples INTEGER NOT NULL, util_sum REAL NOT NULL, memory_sum REAL NOT NULL, total_sum REAL NOT NULL,
      PRIMARY KEY(device_id,resolution,at)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS gpu_history_retention ON gpu_history_buckets(resolution,at);
    CREATE TABLE IF NOT EXISTS gpu_history_shares (
      day INTEGER NOT NULL, user TEXT NOT NULL, milliseconds INTEGER NOT NULL,
      PRIMARY KEY(day,user)
    ) WITHOUT ROWID;
  `);
}

export function createGpuHistory({db,now=Date.now}){
  let lastPrune=0;
  const previous=db.prepare('SELECT * FROM gpu_history_devices WHERE id=?');
  const device=db.prepare(`INSERT INTO gpu_history_devices VALUES (?,?,?,?,?,?,1)
    ON CONFLICT(id) DO UPDATE SET reported_at=excluded.reported_at,observed_at=excluded.observed_at,
      users_json=excluded.users_json,continuous=1`);
  const bucket=db.prepare(`INSERT INTO gpu_history_buckets VALUES (?,?,?,1,?,?,?)
    ON CONFLICT(device_id,resolution,at) DO UPDATE SET samples=samples+1,
      util_sum=util_sum+excluded.util_sum,memory_sum=memory_sum+excluded.memory_sum,total_sum=total_sum+excluded.total_sum`);
  const share=db.prepare(`INSERT INTO gpu_history_shares VALUES (?,?,?)
    ON CONFLICT(day,user) DO UPDATE SET milliseconds=milliseconds+excluded.milliseconds`);
  const interrupt=()=>db.prepare('UPDATE gpu_history_devices SET continuous=0 WHERE continuous=1').run();
  // A restart cannot establish uninterrupted observation, even with a fresh cached snapshot.
  interrupt();

  function record(items,time=now()){
    const seen=new Set();
    for(const item of items){
      if(!['active','resident','idle'].includes(item.status)||!item.reportedAt||item.reportedAt>time)continue;
      seen.add(item.id);
      const old=previous.get(item.id);
      // Re-polling the same collector sample must not inflate time or averages.
      if(old&&item.reportedAt<=old.reported_at){
        if(item.reportedAt<old.reported_at)db.prepare('UPDATE gpu_history_devices SET continuous=0 WHERE id=?').run(item.id);
        continue;
      }
      const users=[...new Set(item.processes.map(p=>p.user||'미확인'))];
      if(old?.continuous&&time-old.observed_at<=MINUTE&&item.reportedAt-old.reported_at<=MINUTE){
        // Count a user once per GPU interval regardless of process count. Different users
        // sharing a GPU overlap by design; this is occupancy, not attributable compute.
        for(const user of JSON.parse(old.users_json)){
          for(let start=old.reported_at;start<item.reportedAt;){
            const day=Math.floor(start/DAY)*DAY,end=Math.min(item.reportedAt,day+DAY);
            share.run(day,user,end-start);start=end;
          }
        }
      }
      device.run(item.id,item.host,item.index,item.reportedAt,time,JSON.stringify(users));
      for(const resolution of [MINUTE,QUARTER])bucket.run(item.id,resolution,Math.floor(item.reportedAt/resolution)*resolution,item.utilization,item.memoryUsedMiB,item.memoryTotalMiB);
      db.prepare("INSERT OR IGNORE INTO app_meta VALUES ('gpu_history_started',?)").run(String(time));
    }
    // Missing and invalid devices break continuity; never bill across a collection gap.
    for(const row of db.prepare('SELECT id FROM gpu_history_devices WHERE continuous=1').all()){
      if(!seen.has(row.id))db.prepare('UPDATE gpu_history_devices SET continuous=0 WHERE id=?').run(row.id);
    }
    if(time-lastPrune>=3600000){
      db.prepare('DELETE FROM gpu_history_buckets WHERE resolution=? AND at<?').run(MINUTE,time-7*DAY);
      db.prepare('DELETE FROM gpu_history_buckets WHERE resolution=? AND at<?').run(QUARTER,time-90*DAY);
      db.prepare('DELETE FROM gpu_history_shares WHERE day<?').run(Math.floor(time/DAY)*DAY-89*DAY);
      db.prepare('DELETE FROM gpu_history_devices WHERE observed_at<?').run(time-90*DAY);
      lastPrune=time;
    }
  }

  function get(kind,params={}){
    const time=now(),started=db.prepare("SELECT value FROM app_meta WHERE key='gpu_history_started'").get();
    const envelope={fetchedAt:time,demo:false,source:'lab-chat',collectionStartedAt:started?Number(started.value):null};
    if(kind==='targets')return {...envelope,data:db.prepare('SELECT host,gpu_index AS "index" FROM gpu_history_devices ORDER BY host,gpu_index LIMIT 1024').all()};
    if(kind==='history'){
      const from=params.from*1000,to=params.to*1000;
      const resolution=to-from>DAY?QUARTER:MINUTE;
      const bucketMs=Math.max(resolution,Math.ceil(params.bucket*1000/resolution)*resolution);
      const id=JSON.stringify([params.host,params.gpu]);
      const data=db.prepare(`SELECT CAST(at / ? AS INTEGER)*? AS at,
          SUM(util_sum)/SUM(samples) AS utilization,
          SUM(memory_sum)/SUM(samples)/1024.0 AS memoryGiB,
          SUM(total_sum)/SUM(samples)/1024.0 AS totalGiB
        FROM gpu_history_buckets WHERE device_id=? AND resolution=? AND at>=? AND at<?
        GROUP BY CAST(at / ? AS INTEGER) ORDER BY at LIMIT 602`).all(bucketMs,bucketMs,id,resolution,from,to,bucketMs);
      return {...envelope,data,bucketMs,resolutionMs:resolution};
    }
    if(kind==='share'){
      // UTC calendar days, explicitly described by the response and UI.
      const from=Math.floor(time/DAY)*DAY-(params.days-1)*DAY;
      const data=db.prepare(`SELECT user,SUM(milliseconds)/3600000.0 AS hours,
          100.0*SUM(milliseconds)/SUM(SUM(milliseconds)) OVER () AS percent
        FROM gpu_history_shares WHERE day>=? AND day<=? GROUP BY user ORDER BY hours DESC,user LIMIT 2000`).all(from,time);
      return {...envelope,data,from,to:time,method:'observed-process-occupancy',timezone:'UTC'};
    }
    throw new Error('Unknown GPU history view');
  }
  return {record,interrupt,get};
}

// GPU history never falls back to the legacy dashboard. AI APIs retain their own source.
export function localGpuResourceSource(history,aiSource){
  return {get:(kind,params)=>['targets','history','share'].includes(kind)?history.get(kind,params):aiSource.get(kind,params),stop:()=>aiSource.stop()};
}
