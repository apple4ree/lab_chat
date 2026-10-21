import express from 'express';
import helmet from 'helmet';
import multer from 'multer';
import {open} from 'node:fs/promises';
import { mkdirSync, unlinkSync, existsSync, createReadStream } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { openDatabase, transaction, createUser, createChannel, publicUser, seedDemo } from './db.mjs';
import { token, hashToken, hashPassword, verifyPassword, getSession, startSession, rateLimiter } from './auth.mjs';
import {createDemoGate} from './demo-gate.mjs';
import {createResourceCatalog,mountResourceCatalog} from './resource-catalog.mjs';
import {createSshConnections} from './ssh-connections.mjs';
import {createServerMonitor} from './servers.mjs';
import {createGpuMonitor} from './gpu.mjs';
import {createResources,mountResources} from './resources.mjs';
import {createResourceSource} from './resource-source.mjs';
import {createGpuHistory,localGpuResourceSource} from './gpu-history.mjs';
import {mountDesktopReleases} from './desktop-releases.mjs';
import {createSync,streamWriter} from './sync.mjs';
import {createMetrics} from './metrics.mjs';
import {createDomains} from './domains.mjs';

class HttpError extends Error { constructor(status,message) { super(message); this.status=status; } }
const fail=(status,message)=>{ throw new HttpError(status,message); };
const string=(value,label,max=16000,min=1)=>{
  if (typeof value!=='string' || value.trim().length<min || value.length>max) fail(400,`${label}을(를) 확인해 주세요.`);
  return value.trim();
};
const emailAddress=value=>{
  const email=string(value,'이메일',254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400,'올바른 이메일을 입력해 주세요.');
  return email;
};
const passwordValue=value=>{
  if (typeof value!=='string' || !value.trim() || value.length<10 || value.length>256) fail(400,'비밀번호는 10~256자로 입력해 주세요.');
  return value;
};
// This is a preview candidate; PDF bytes are verified at the serving boundary.
const previewKind=name=>/\.pdf$/i.test(name)?'pdf':/\.html?$/i.test(name)?'html':null;
const integer=value=>{
  const n=Number(value);
  if (!Number.isSafeInteger(n)||n<1) fail(400,'올바른 메시지 번호가 필요합니다.');
  return n;
};
const emojiSet=new Set(['👍','❤️','🎉','👀','🌱','✅']);

export function createApp({dataDir,origin='http://127.0.0.1:4310',mode='local',setupToken=token(),distDir=resolve('dist'),demoGateHash,gpuSource=null,gpuAutoStart=true,resourceSource=null,desktopReleaseDir=null,domainProbe,serverSource=null,serverAnalyze=null,sshOptions=null}={}) {
  if (!dataDir) throw new Error('dataDir is required');
  if (!['local','demo'].includes(mode)) throw new Error('LAB_AUTH_MODE must be local or demo');
  const demoGate=mode==='demo'&&demoGateHash?createDemoGate(demoGateHash):null;
  if(mode==='demo'&&new URL(origin).protocol==='https:'&&!demoGate)throw new Error('HTTPS demo deployments require LAB_DEMO_GATE_HASH.');
  const db=openDatabase(dataDir), uploads=join(dataDir,'uploads');
  const storedMode=db.prepare("SELECT value FROM app_meta WHERE key='auth_mode'").get()?.value;
  if((storedMode&&storedMode!==mode)||db.prepare("SELECT 1 FROM users WHERE identity_provider!=? AND identity_provider!='system' LIMIT 1").get(mode)){
    db.close();throw new Error('Demo and local accounts must use separate data directories.');
  }
  db.prepare("INSERT OR IGNORE INTO app_meta VALUES ('auth_mode',?)").run(mode);
  mkdirSync(uploads,{recursive:true,mode:0o700});
  if (mode==='demo') seedDemo(db);
  const app=express(), clients=new Set(), secure=origin.startsWith('https://'), sync=createSync(db);
  const metrics=createMetrics();
  const audit=(actor,action,target=null)=>db.prepare('INSERT INTO audit_log (actor_id,action,target_id) VALUES (?,?,?)').run(actor,action,target);
  const domains=createDomains({db,origin,mode,probe:domainProbe,audit});
  app.disable('x-powered-by');
  app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'"],styleSrc:["'self'","'unsafe-inline'"],imgSrc:["'self'",'data:'],connectSrc:["'self'"],upgradeInsecureRequests:secure?[]:null}},strictTransportSecurity:secure?undefined:false}));
  if(demoGate)app.use(demoGate);
  app.use('/api',metrics.middleware);
  app.use('/api',(req,res,next)=>{
    res.set('Cache-Control','no-store');
    if (!['GET','HEAD','OPTIONS'].includes(req.method)) {
      if (req.get('X-Lab-Request')!=='1' || (req.get('Origin') && !domains.accepts(req.get('Origin')))) return res.status(403).json({error:'요청 출처를 확인할 수 없습니다. 페이지를 새로고침해 주세요.'});
    }
    next();
  });
  app.use(express.json({limit:'64kb'}));
  app.use('/api',(req,res,next)=>{
    if(req.body!==undefined && (typeof req.body!=='object'||req.body===null||Array.isArray(req.body))) return res.status(400).json({error:'올바른 요청 본문이 필요합니다.'});
    req.body??={};next();
  });
  const authLimit=rateLimiter();
  const requireAuth=(req,res,next)=>{
    req.user=getSession(db,req);
    if (!req.user) return res.status(401).json({error:'로그인이 필요합니다.'});
    next();
  };
  const admin=req=>{if(req.user.role!=='admin') fail(403,'관리자만 사용할 수 있습니다.');};
  const membership=(userId,channelId)=>db.prepare('SELECT c.* FROM channels c JOIN memberships m ON c.id=m.channel_id WHERE c.id=? AND m.user_id=?').get(channelId,userId);
  const channelFor=(req,id)=>membership(req.user.id,id)||fail(404,'채널을 찾을 수 없거나 접근 권한이 없습니다.');
  const messageFor=(req,id)=>{
    const message=db.prepare('SELECT * FROM messages WHERE id=?').get(integer(id));
    if (!message || !membership(req.user.id,message.channel_id)) fail(404,'메시지를 찾을 수 없습니다.');
    return message;
  };
  function emit(channelId=null,userIds=null,excludeSession=null) {
    for (const client of clients) {
      const valid=db.prepare('SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?').get(client.sessionHash,Date.now());
      if (!valid) { client.res.end(); clients.delete(client); continue; }
      if(client.sessionHash===excludeSession)continue;
      if ((userIds && !userIds.includes(client.userId)) || (channelId && !membership(client.userId,channelId))) continue;
      client.writer.write(`event: refresh\ndata: ${JSON.stringify({channelId,cursor:sync.cursor()})}\n\n`);
    }
  }
  function decorate(message,viewerId) {
    const user=db.prepare('SELECT id,name,handle,role FROM users WHERE id=?').get(message.user_id);
    return {...message,revision:sync.head(),user,files:message.deleted?[]:db.prepare('SELECT id,original_name AS name,size FROM files WHERE message_id=?').all(message.id).map(file=>({...file,previewKind:previewKind(file.name)})),
      reactions:message.deleted?[]:db.prepare('SELECT emoji,count(*) AS count,max(user_id=?) AS mine FROM reactions WHERE message_id=? GROUP BY emoji ORDER BY emoji').all(viewerId,message.id),
      reply_count:db.prepare('SELECT count(*) AS n FROM messages WHERE parent_id=?').get(message.id).n};
  }
  const mentionUsers=(messageId,channelId,body)=>{
    db.prepare('DELETE FROM mentions WHERE message_id=?').run(messageId);
    const handles=new Set([...body.matchAll(/@([a-zA-Z0-9_-]+)(?![a-zA-Z0-9_-])/g)].map(m=>m[1]));
    const members=db.prepare('SELECT u.id,u.handle FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.channel_id=?').all(channelId);
    for (const user of members) if(handles.has(user.handle)) db.prepare('INSERT INTO mentions VALUES (?,?)').run(messageId,user.id);
  };
  const page=(rows,viewerId)=>({messages:rows.slice(0,80).map(m=>decorate(m,viewerId)).reverse(),hasMore:rows.length>80});

  const gpuHistory=mode==='demo'?null:createGpuHistory({db});
  const ssh=sshOptions?createSshConnections({...sshOptions,db,dataDir}):null;
  if(ssh)({serverSource,gpuSource}=ssh.mergeSources(serverSource,gpuSource));
  const gpu=createGpuMonitor({db,source:gpuSource,emit,history:gpuHistory,demo:mode==='demo',autoStart:gpuAutoStart});
  const catalog=createResourceCatalog({db,gpu,source:serverSource});
  const servers=createServerMonitor({db,gpu,catalog,source:serverSource,analyze:serverAnalyze,emit,audit,autoStart:gpuAutoStart&&(!!serverSource||!!gpuSource)});
  const sources=mode==='demo'?createResourceSource({demo:true}):localGpuResourceSource(gpuHistory,resourceSource||createResourceSource());
  const resources=createResources({db,gpu,catalog,emit,source:sources,autoStart:gpuAutoStart});

  app.get('/api/health',(_req,res)=>res.json({ok:true,version:'0.1.0'}));
  app.get('/api/workspace/connection',(_req,res)=>res.json(domains.connection()));
  app.get('/api/auth/config',(_req,res)=>res.json({mode,needsSetup:mode==='local'&&!db.prepare('SELECT 1 FROM users LIMIT 1').get(),demoUsers:mode==='demo'?db.prepare("SELECT id,name,handle,role FROM users WHERE identity_provider='demo'").all():[]}));
  app.post('/api/auth/setup',authLimit,async(req,res)=>{
    if(mode!=='local') fail(404,'사용할 수 없습니다.');
    const inputToken=typeof req.body.setupToken==='string'?req.body.setupToken:'';
    if(Buffer.byteLength(inputToken)!==Buffer.byteLength(setupToken) || !timingSafeEqual(Buffer.from(inputToken),Buffer.from(setupToken))) fail(403,'서버 시작 시 표시된 최초 설정 코드를 입력해 주세요.');
    const email=emailAddress(req.body.email),name=string(req.body.name,'이름',60),passwordHash=await hashPassword(passwordValue(req.body.password));
    const user=transaction(db,()=>{
      if(db.prepare('SELECT 1 FROM users LIMIT 1').get()) fail(409,'최초 설정이 완료되었습니다. 로그인해 주세요.');
      const user=createUser(db,{email,name,passwordHash,role:'admin'});
      createChannel(db,{name:'연구실-라운지',topic:'자유롭게 소식을 나누는 연구실 공간',creator:user.id});
      createChannel(db,{name:'공지사항',topic:'연구실 일정과 공지',creator:user.id});
      audit(user.id,'workspace.setup',user.id);
      return user;
    });
    gpu.ensureChannel();
    startSession(db,res,user,secure);res.status(201).json(publicUser(user));
  });
  app.post('/api/auth/login',authLimit,async(req,res)=>{
    if(mode!=='local') fail(400,'체험 계정을 선택해 주세요.');
    const login=string(req.body.login??req.body.email,'이메일 또는 아이디',254).toLowerCase();
    string(req.body.password,'비밀번호',256);const password=req.body.password;
    const user=login.includes('@')
      ? db.prepare("SELECT * FROM users WHERE email=? AND identity_provider='local'").get(login)
      : db.prepare("SELECT u.* FROM user_login_names n JOIN users u ON u.id=n.user_id WHERE n.login_name=? AND u.identity_provider='local'").get(login);
    if(!await verifyPassword(password,user?.password_hash)) fail(401,'이메일 또는 아이디와 비밀번호를 확인해 주세요.');
    startSession(db,res,user,secure);audit(user.id,'auth.login');res.json(publicUser(user));
  });
  app.post('/api/auth/demo',authLimit,(req,res)=>{
    if(mode!=='demo') fail(404,'사용할 수 없습니다.');
    const user=db.prepare("SELECT * FROM users WHERE id=? AND identity_provider='demo'").get(string(req.body.userId,'사용자',100));
    if(!user) fail(404,'체험 계정을 찾을 수 없습니다.');
    startSession(db,res,user,secure);res.json(publicUser(user));
  });
  app.post('/api/auth/register',authLimit,async(req,res)=>{
    if(mode!=='local') fail(404,'사용할 수 없습니다.');
    const inviteHash=hashToken(string(req.body.invite,'초대 코드',100));
    const email=emailAddress(req.body.email),name=string(req.body.name,'이름',60),passwordHash=await hashPassword(passwordValue(req.body.password));
    const user=transaction(db,()=>{
      const invite=db.prepare('SELECT * FROM invites WHERE token_hash=? AND used_at IS NULL AND expires_at>?').get(inviteHash,Date.now());
      if(!invite || (invite.email&&invite.email!==email)) fail(403,'초대 링크가 만료되었거나 이메일이 일치하지 않습니다.');
      if(db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) fail(409,'이미 등록된 이메일입니다.');
      const user=createUser(db,{email,name,passwordHash});
      db.prepare('UPDATE invites SET used_at=? WHERE token_hash=?').run(Date.now(),inviteHash);
      audit(user.id,'auth.register',user.id);return user;
    });
    startSession(db,res,user,secure);emit();res.status(201).json(publicUser(user));
  });
  app.use('/api',requireAuth);
  domains.mount(app,admin);
  app.get('/api/admin/metrics',(req,res)=>{admin(req);res.json({...metrics.snapshot(),streams:{active:clients.size,bufferedBytes:[...clients].reduce((sum,c)=>sum+c.res.writableLength,0)},sync:{retainedChanges:db.prepare('SELECT count(*) n FROM sync_changes').get().n}});});
  app.get('/api/resources/gpus',(req,res)=>{
    // Validate the full view, including freshness/connection metadata. The client
    // owns a session-local copy; intermediaries must still obey no-store.
    const body=JSON.stringify(gpu.view()),etag=`"${createHash('sha256').update(body).digest('base64url')}"`;
    res.set('ETag',etag);
    if(req.get('If-None-Match')===etag)return res.status(304).end();
    res.type('json').send(body);
  });
  app.get('/api/resources/servers',(req,res)=>res.json({...servers.view(req.user.id),sshEnabled:!!ssh}));
  ssh?.mount(app);
  app.get('/api/admin/server-managers',(req,res)=>{admin(req);res.json(servers.roleView());});
  app.post('/api/admin/server-managers',(req,res)=>{admin(req);res.json(servers.setManager(req.user.id,req.body.userId,req.body.enabled));});
  mountResourceCatalog(app,catalog);
  mountResources(app,resources);
  mountDesktopReleases(app,desktopReleaseDir);
  app.get('/api/me',(req,res)=>res.json({...publicUser(req.user),email:req.user.email}));
  app.post('/api/auth/logout',(req,res)=>{
    db.prepare('DELETE FROM sessions WHERE token_hash=?').run(req.user.session_hash);
    res.clearCookie('lab_session',{httpOnly:true,sameSite:'strict',secure,path:'/'});
    emit(null,[req.user.id]);res.status(204).end();
  });
  app.post('/api/auth/password',authLimit,async(req,res)=>{
    if(mode!=='local') fail(400,'체험 계정의 비밀번호는 변경할 수 없습니다.');
    string(req.body.currentPassword,'현재 비밀번호',256);const old=req.body.currentPassword;
    if(!await verifyPassword(old,req.user.password_hash)) fail(403,'현재 비밀번호가 일치하지 않습니다.');
    const hash=await hashPassword(passwordValue(req.body.password));
    transaction(db,()=>{
      db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash,req.user.id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(req.user.id);
      audit(req.user.id,'auth.password_change');
    });
    startSession(db,res,req.user,secure);emit(null,[req.user.id]);res.status(204).end();
  });
  app.get('/api/users',(_req,res)=>res.json(db.prepare("SELECT id,name,handle,role FROM users WHERE identity_provider!='system' ORDER BY name").all()));
  app.post('/api/admin/invites',(req,res)=>{
    admin(req);if(mode==='demo') fail(400,'체험 공간에서는 가입 초대를 만들 수 없습니다.');
    const value=token(),email=req.body.email?emailAddress(req.body.email):null;
    const expiresAt=Date.now()+7*86400000;
    db.prepare('INSERT INTO invites (token_hash,email,created_by,expires_at) VALUES (?,?,?,?)').run(hashToken(value),email,req.user.id,expiresAt);
    audit(req.user.id,'invite.create');res.status(201).json({url:`${domains.connection().canonicalOrigin}/#invite=${value}`,expiresAt});
  });
  app.get('/api/admin/overview',(req,res)=>{
    admin(req);
    res.json({users:db.prepare("SELECT count(*) AS n FROM users WHERE identity_provider!='system'").get().n,channels:db.prepare('SELECT count(*) AS n FROM channels').get().n,
      messages:db.prepare('SELECT count(*) AS n FROM messages WHERE deleted=0').get().n,
      fileBytes:db.prepare('SELECT coalesce(sum(size),0) AS n FROM files').get().n,
      audit:db.prepare('SELECT a.*,u.name AS actor FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 50').all()});
  });
  const usersView=()=>db.prepare("SELECT id,name,handle,role FROM users WHERE identity_provider!='system' ORDER BY name").all();
  function channelsView(userId,only=null){
    const rows=db.prepare(`SELECT c.*,m.last_read_id,
      (SELECT coalesce(max(x.id),0) FROM messages x WHERE x.channel_id=c.id AND x.user_id!=? AND x.deleted=0) AS latest_message_id,
      (SELECT count(*) FROM messages x WHERE x.channel_id=c.id AND x.id>m.last_read_id AND x.user_id!=? AND x.deleted=0) AS unread,
      (SELECT count(*) FROM mentions n JOIN messages x ON n.message_id=x.id WHERE x.channel_id=c.id AND x.id>m.last_read_id AND n.user_id=? AND x.user_id!=? AND x.deleted=0) AS mentions
      FROM channels c JOIN memberships m ON c.id=m.channel_id WHERE m.user_id=? AND (? IS NULL OR c.id=?) ORDER BY c.kind,c.created_at,c.name`).all(userId,userId,userId,userId,userId,only,only);
    return rows.map(c=>({...c,members:db.prepare('SELECT u.id,u.name,u.handle,u.role FROM users u JOIN memberships m ON u.id=m.user_id WHERE m.channel_id=? ORDER BY u.name').all(c.id)}));
  }
  app.get('/api/channels',(req,res)=>res.json(channelsView(req.user.id)));
  app.get('/api/sync',(req,res)=>{
    const batch=sync.read(typeof req.query.cursor==='string'?req.query.cursor:'');
    const active=typeof req.query.channelId==='string'?req.query.channelId:null;
    const parent=typeof req.query.threadId==='string'&&/^\d+$/.test(req.query.threadId)?Number(req.query.threadId):null;
    const usersChanged=batch.reset||batch.changes.some(c=>c.kind==='user');
    const changedChannels=new Set(),messageIds=new Set(),removedChannelIds=[];
    for(const change of batch.changes){
      if(change.kind==='read'&&change.user_id!==req.user.id)continue;
      const allowed=change.channel_id&&membership(req.user.id,change.channel_id);
      if(!allowed){if(change.kind==='membership'&&change.user_id===req.user.id)removedChannelIds.push(change.channel_id);continue;}
      changedChannels.add(change.channel_id);
      if(change.kind==='message'&&change.channel_id===active){messageIds.add(change.message_id);if(change.parent_id)messageIds.add(change.parent_id);}
    }
    const messages=[],threadMessages=[];
    for(const id of messageIds){
      const message=db.prepare('SELECT * FROM messages WHERE id=?').get(id);
      if(!message)continue;
      if(message.parent_id===null)messages.push(decorate(message,req.user.id));
      if(parent&&(message.id===parent||message.parent_id===parent))threadMessages.push(decorate(message,req.user.id));
    }
    res.json({cursor:batch.cursor,reset:batch.reset,
      channels:usersChanged?channelsView(req.user.id):[...changedChannels].flatMap(id=>channelsView(req.user.id,id)),
      removedChannelIds,users:usersChanged?usersView():undefined,messages,threadMessages});
  });
  app.post('/api/channels',(req,res)=>{
    const name=string(req.body.name,'채널 이름',60),topic=typeof req.body.topic==='string'?string(req.body.topic,'설명',250,0):'';
    const kind=req.body.kind==='private'?'private':'public';
    if(!/^[\p{L}\p{N}_-]+$/u.test(name)) fail(400,'채널 이름에는 문자, 숫자, 하이픈, 밑줄을 사용할 수 있습니다.');
    const members=Array.isArray(req.body.memberIds)?req.body.memberIds:[];
    if(members.length>100 || members.some(id=>typeof id!=='string'||!db.prepare('SELECT 1 FROM users WHERE id=?').get(id))) fail(400,'구성원을 확인해 주세요.');
    if(db.prepare("SELECT 1 FROM channels WHERE name=? AND kind!='dm'").get(name)) fail(409,'이미 사용 중인 채널 이름입니다.');
    const id=transaction(db,()=>createChannel(db,{name,topic,kind,creator:req.user.id,members}));
    audit(req.user.id,'channel.create',id);emit(id);res.status(201).json({id});
  });
  app.post('/api/dms',(req,res)=>{
    const other=string(req.body.userId,'사용자',100);
    if(other===req.user.id||!db.prepare("SELECT 1 FROM users WHERE id=? AND identity_provider!='system'").get(other)) fail(400,'다른 구성원을 선택해 주세요.');
    const key=[req.user.id,other].sort().join(':');
    let id=db.prepare('SELECT id FROM channels WHERE dm_key=?').get(key)?.id;
    if(!id) id=transaction(db,()=>createChannel(db,{name:'DM',kind:'dm',creator:req.user.id,members:[other],dmKey:key}));
    emit(id);res.json({id});
  });
  app.post('/api/channels/:id/members',(req,res)=>{
    const c=channelFor(req,req.params.id);
    if(c.id===servers.channelId())fail(403,'서버 관리자 역할 설정에서 구성원을 변경해 주세요.');
    if(c.kind!=='private'||(c.created_by!==req.user.id&&req.user.role!=='admin')) fail(403,'비공개 채널의 생성자 또는 관리자만 구성원을 추가할 수 있습니다.');
    const userId=string(req.body.userId,'구성원',100);
    if(!db.prepare('SELECT 1 FROM users WHERE id=?').get(userId)) fail(404,'구성원을 찾을 수 없습니다.');
    db.prepare('INSERT OR IGNORE INTO memberships (channel_id,user_id) VALUES (?,?)').run(c.id,userId);
    audit(req.user.id,'channel.add_member',c.id);emit(c.id);res.status(204).end();
  });
  app.post('/api/channels/:id/read',(req,res)=>{
    channelFor(req,req.params.id);
    const until=integer(req.body.until);
    if(!db.prepare('SELECT 1 FROM messages WHERE id=? AND channel_id=?').get(until,req.params.id)) fail(400,'채널의 메시지를 지정해 주세요.');
    const changed=db.prepare('UPDATE memberships SET last_read_id=? WHERE channel_id=? AND user_id=? AND last_read_id<?').run(until,req.params.id,req.user.id,until).changes;
    if(changed)emit(req.params.id,[req.user.id],req.user.session_hash);
    res.status(204).end();
  });
  app.get('/api/channels/:id/messages',(req,res)=>{
    channelFor(req,req.params.id);
    const before=req.query.before?integer(req.query.before):Number.MAX_SAFE_INTEGER;
    res.json(page(db.prepare('SELECT * FROM messages WHERE channel_id=? AND parent_id IS NULL AND id<? ORDER BY id DESC LIMIT 81').all(req.params.id,before),req.user.id));
  });
  app.get('/api/channels/:id/pins',(req,res)=>{
    channelFor(req,req.params.id);
    res.json(db.prepare('SELECT * FROM messages WHERE channel_id=? AND pinned=1 AND deleted=0 ORDER BY id DESC LIMIT 100').all(req.params.id).map(m=>decorate(m,req.user.id)));
  });
  app.get('/api/messages/:id',(req,res)=>res.json(decorate(messageFor(req,req.params.id),req.user.id)));
  app.get('/api/messages/:id/replies',(req,res)=>{
    const parent=messageFor(req,req.params.id);
    if(parent.parent_id) fail(400,'스레드의 원문을 선택해 주세요.');
    const before=req.query.before?integer(req.query.before):Number.MAX_SAFE_INTEGER;
    res.json(page(db.prepare('SELECT * FROM messages WHERE parent_id=? AND id<? ORDER BY id DESC LIMIT 81').all(parent.id,before),req.user.id));
  });
  function insertMessage(req,file=null,fileDigest=null) {
    const channel=channelFor(req,req.params.id);
    const body=string(req.body.body??'','메시지',16000,file?0:1);
    const parent=req.body.parentId?messageFor(req,req.body.parentId):null;
    if(parent && (parent.channel_id!==channel.id||parent.parent_id)) fail(400,'동일한 채널의 원문에 답글을 작성해 주세요.');
    const clientId=req.body.clientMessageId??null;
    if(clientId!==null&&(typeof clientId!=='string'||!/^[a-zA-Z0-9_-]{16,100}$/.test(clientId)))fail(400,'전송 식별자를 확인해 주세요.');
    const fingerprint=createHash('sha256').update(JSON.stringify([channel.id,body,parent?.id??null,file?[fileDigest,file.originalname,file.size]:null])).digest('hex');
    return transaction(db,()=>{
      if(clientId){
        const prior=db.prepare('SELECT * FROM send_requests WHERE user_id=? AND client_id=?').get(req.user.id,clientId);
        if(prior){if(prior.fingerprint!==fingerprint)fail(409,'같은 전송 식별자로 다른 내용을 보낼 수 없습니다.');return {message:db.prepare('SELECT * FROM messages WHERE id=?').get(prior.message_id),replayed:true};}
      }
      const id=Number(db.prepare('INSERT INTO messages (channel_id,user_id,parent_id,body) VALUES (?,?,?,?)').run(channel.id,req.user.id,parent?.id??null,body).lastInsertRowid);
      if(file) {
        // Original names are metadata only; disk paths are server-generated UUIDs.
        const name=basename(Buffer.from(file.originalname,'latin1').toString('utf8').replaceAll('\\','/')).replace(/[\x00-\x1f\x7f]/g,'').slice(0,255)||'attachment';
        db.prepare('INSERT INTO files VALUES (?,?,?,?,?)').run(randomUUID(),id,name,file.filename,file.size);
      }
      mentionUsers(id,channel.id,body);
      if(clientId)db.prepare('INSERT INTO send_requests VALUES (?,?,?,?)').run(req.user.id,clientId,fingerprint,id);
      return {message:db.prepare('SELECT * FROM messages WHERE id=?').get(id),replayed:false};
    });
  }
  const messageLimit=rateLimiter({limit:120,windowMs:60000});
  app.post('/api/channels/:id/messages',messageLimit,(req,res)=>{
    const {message,replayed}=insertMessage(req);if(!replayed)emit(message.channel_id);res.status(201).json(decorate(message,req.user.id));
  });
  const upload=multer({storage:multer.diskStorage({destination:uploads,filename:(_req,_file,cb)=>cb(null,randomUUID())}),limits:{fileSize:20*1024*1024,files:1,fields:3,fieldSize:64000,parts:4}});
  app.post('/api/channels/:id/files',messageLimit,(req,_res,next)=>{channelFor(req,req.params.id);next();},upload.single('file'),async(req,res,next)=>{
    let temporary=true;
    try {
      if(!req.file) fail(400,'파일을 선택해 주세요.');
      const hash=createHash('sha256');for await(const chunk of createReadStream(req.file.path))hash.update(chunk);
      const {message,replayed}=insertMessage(req,req.file,hash.digest('hex'));
      if(replayed)unlinkSync(req.file.path);
      temporary=false; // A committed file belongs to the message, even if delivery fails.
      if(!replayed)emit(message.channel_id);res.status(201).json(decorate(message,req.user.id));
    } catch(error) { if(temporary&&req.file&&existsSync(req.file.path))unlinkSync(req.file.path);next(error); }
  });
  function fileFor(req){
    const file=db.prepare('SELECT f.*,m.channel_id,m.deleted FROM files f JOIN messages m ON m.id=f.message_id WHERE f.id=?').get(req.params.id);
    if(!file||file.deleted||!membership(req.user.id,file.channel_id)) fail(404,'파일을 찾을 수 없습니다.');
    return file;
  }
  app.get('/api/files/:id',(req,res)=>{
    const file=fileFor(req);
    res.set('Content-Type','application/octet-stream');res.download(file.storage_name,file.original_name,{root:resolve(uploads),dotfiles:'deny'});
  });
  app.get('/api/files/:id/preview',async(req,res)=>{
    const file=fileFor(req),kind=previewKind(file.original_name);
    if(!kind)fail(415,'HTML과 PDF 파일만 미리볼 수 있습니다.');
    if(kind==='pdf'){
      const handle=await open(join(uploads,file.storage_name),'r');
      try{const header=Buffer.alloc(5);await handle.read(header,0,5,0);if(header.toString('ascii')!=='%PDF-')fail(415,'올바른 PDF 파일이 아닙니다. 원본을 다운로드해 확인해 주세요.');}
      finally{await handle.close();}
    }
    res.set('Content-Type',kind==='html'?'text/html; charset=utf-8':'application/pdf');
    res.set('Content-Disposition',`inline; filename*=UTF-8''${encodeURIComponent(file.original_name).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16))}`);
    // HTML stays opaque and scriptless even when this URL is opened directly.
    // PDFs use the browser's built-in viewer; iframe sandbox would disable it.
    res.set('Content-Security-Policy',kind==='html'
      ?"sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"
      :"default-src 'none'; object-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
    res.set('Referrer-Policy','no-referrer');
    res.sendFile(file.storage_name,{root:resolve(uploads),dotfiles:'deny',cacheControl:false});
  });
  app.patch('/api/messages/:id',(req,res)=>{
    const m=messageFor(req,req.params.id);
    if(m.user_id!==req.user.id||m.deleted) fail(403,'내 메시지만 수정할 수 있습니다.');
    const hasFile=db.prepare('SELECT 1 FROM files WHERE message_id=?').get(m.id);
    const body=string(req.body.body,'메시지',16000,hasFile?0:1);
    transaction(db,()=>{
      db.prepare("UPDATE messages SET body=?,edited_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(body,m.id);
      mentionUsers(m.id,m.channel_id,body);
    });
    emit(m.channel_id);res.json(decorate(db.prepare('SELECT * FROM messages WHERE id=?').get(m.id),req.user.id));
  });
  app.delete('/api/messages/:id',(req,res)=>{
    const m=messageFor(req,req.params.id);
    if(m.user_id!==req.user.id&&req.user.role!=='admin') fail(403,'내 메시지만 삭제할 수 있습니다.');
    transaction(db,()=>{
      db.prepare("UPDATE messages SET body='',deleted=1,pinned=0 WHERE id=?").run(m.id);
      db.prepare('DELETE FROM mentions WHERE message_id=?').run(m.id);
      audit(req.user.id,'message.delete',String(m.id));
    });
    emit(m.channel_id);res.status(204).end();
  });
  app.post('/api/messages/:id/reactions',(req,res)=>{
    const m=messageFor(req,req.params.id),emoji=req.body.emoji;
    if(m.deleted||!emojiSet.has(emoji)) fail(400,'사용할 수 없는 반응입니다.');
    const removed=db.prepare('DELETE FROM reactions WHERE message_id=? AND user_id=? AND emoji=?').run(m.id,req.user.id,emoji);
    if(!removed.changes) db.prepare('INSERT INTO reactions VALUES (?,?,?)').run(m.id,req.user.id,emoji);
    emit(m.channel_id);res.status(204).end();
  });
  app.post('/api/messages/:id/pin',(req,res)=>{
    const m=messageFor(req,req.params.id);if(m.deleted) fail(400,'삭제된 메시지입니다.');
    db.prepare('UPDATE messages SET pinned=1-pinned WHERE id=?').run(m.id);
    emit(m.channel_id);res.status(204).end();
  });
  app.get('/api/search',(req,res)=>{
    const query=string(req.query.q,'검색어',200);
    const before=req.query.before?integer(req.query.before):Number.MAX_SAFE_INTEGER;
    const escaped=query.replace(/[\\%_]/g,c=>'\\'+c);
    const rows=db.prepare(`SELECT x.*,c.name AS channel_name,c.kind AS channel_kind FROM messages x
      JOIN memberships m ON m.channel_id=x.channel_id JOIN channels c ON c.id=x.channel_id
      WHERE m.user_id=? AND x.deleted=0 AND x.id<? AND (x.body LIKE ? ESCAPE '\\' OR EXISTS
      (SELECT 1 FROM files f WHERE f.message_id=x.id AND f.original_name LIKE ? ESCAPE '\\'))
      ORDER BY x.id DESC LIMIT 81`).all(req.user.id,before,`%${escaped}%`,`%${escaped}%`);
    res.json({messages:rows.slice(0,80).map(m=>decorate(m,req.user.id)),hasMore:rows.length>80});
  });
  app.get('/api/mentions',(req,res)=>res.json(db.prepare(`SELECT x.*,c.name AS channel_name FROM mentions n JOIN messages x ON x.id=n.message_id
    JOIN channels c ON c.id=x.channel_id JOIN memberships m ON m.channel_id=x.channel_id
    WHERE n.user_id=? AND m.user_id=? AND x.deleted=0 ORDER BY x.id DESC LIMIT 100`).all(req.user.id,req.user.id).map(m=>decorate(m,req.user.id))));
  app.get('/api/events',(req,res)=>{
    if([...clients].filter(c=>c.userId===req.user.id).length>=10) fail(429,'열린 창이 너무 많습니다. 사용하지 않는 창을 닫아 주세요.');
    res.set({'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();
    res.write(`retry: ${2000+Math.floor(Math.random()*2000)}\nevent: ready\ndata: {}\n\n`);
    const writer=streamWriter(res);
    const client={res,writer,userId:req.user.id,sessionHash:req.user.session_hash};clients.add(client);
    const heartbeat=setInterval(()=>{
      if(!db.prepare('SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?').get(client.sessionHash,Date.now())) {res.end();return;}
      writer.write(': heartbeat\n\n');
    },20000);
    req.on('close',()=>{clearInterval(heartbeat);writer.stop();clients.delete(client);});
  });
  app.use('/api',(_req,res)=>res.status(404).json({error:'요청한 기능을 찾을 수 없습니다.'}));
  if(existsSync(distDir)) {
    app.use('/assets',express.static(join(distDir,'assets'),{index:false,maxAge:'1y',immutable:true}));
    app.use(express.static(distDir,{index:false,maxAge:0}));
    app.get('/{*splat}',(_req,res)=>res.sendFile(join(distDir,'index.html')));
  }
  app.use((error,_req,res,_next)=>{
    if(res.headersSent) return res.end();
    if(error instanceof multer.MulterError) return res.status(400).json({error:'파일은 한 번에 1개, 최대 20MB까지 첨부할 수 있습니다.'});
    const status=error.status||500;
    if(status>=500) console.error(error);
    res.status(status).json({error:status>=500?'서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.':error.message});
  });
  const closeStreams=()=>{for(const c of clients)c.res.end();};
  let closed=false;
  return {app,db,setupToken,gpu,resources,servers,catalog,ssh,closeStreams,close:()=>{if(closed)return;closed=true;ssh?.stop();metrics.close();void servers.stop();resources.stop();void gpu.stop();closeStreams();db.close();}};
}
