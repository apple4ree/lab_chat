import {randomUUID} from 'node:crypto';
import {transaction,createChannel} from './db.mjs';
const STALE=180000, RECOVERY=30000;
const num=(x,max=1e16)=>typeof x==='number'&&Number.isFinite(x)&&x>=0&&x<=max?x:null;
const str=(x,max=180)=>typeof x==='string'?x.slice(0,max):null;
export function normalizeServerSample(raw,now=Date.now()){
  if(!raw||raw.version!==1||!num(raw.reportedAt)||raw.reportedAt>now+60000||!['host','container'].includes(raw.scope))throw new Error('Invalid server snapshot');
  const c=raw.cpu||{},m=raw.memory||{};
  const total=num(m.totalBytes),available=num(m.availableBytes,total??0),limit=num(m.limitBytes),used=num(m.cgroupUsedBytes);
  return {reportedAt:raw.reportedAt,hostname:str(raw.hostname,100),os:str(raw.os),kernel:str(raw.kernel),architecture:str(raw.architecture),model:str(raw.model),scope:raw.scope,
    bootId:typeof raw.bootId==='string'&&/^[0-9a-f-]{36}$/.test(raw.bootId)?raw.bootId:null,uptimeSeconds:num(raw.uptimeSeconds),
    cpu:{model:str(c.model),logicalCores:num(c.logicalCores,65536),physicalCores:num(c.physicalCores,65536),sockets:num(c.sockets,1024),usagePercent:num(c.usagePercent,100),load1:num(c.load1,1e6),allowedCores:num(c.allowedCores,65536),quotaCores:num(c.quotaCores,65536)},
    memory:{totalBytes:total,availableBytes:available,usedBytes:total!==null&&available!==null?total-available:null,swapTotalBytes:num(m.swapTotalBytes),swapFreeBytes:num(m.swapFreeBytes,num(m.swapTotalBytes)??0),limitBytes:limit,cgroupUsedBytes:used,cgroupAvailableBytes:limit!==null&&used!==null?Math.max(0,limit-used):null},
    disks:Array.isArray(raw.disks)?raw.disks.slice(0,32).filter(d=>d&&typeof d.mount==='string').map(d=>({mount:str(d.mount,250),filesystem:str(d.filesystem,32),totalBytes:num(d.totalBytes),availableBytes:num(d.availableBytes,num(d.totalBytes)??0),usedBytes:num(d.usedBytes,num(d.totalBytes)??0)})):[]};
}
function publicSample(sample,fresh){
  if(!sample)return null;
  const {bootId,...s}=sample;
  if(fresh)return s;
  return {...s,uptimeSeconds:null,cpu:{...s.cpu,usagePercent:null,load1:null},memory:{...s.memory,availableBytes:null,usedBytes:null,swapFreeBytes:null,cgroupUsedBytes:null,cgroupAvailableBytes:null},disks:s.disks.map(d=>({...d,availableBytes:null,usedBytes:null}))};
}
export function createServerMonitor({db,gpu,source=null,analyze=null,emit=()=>{},audit=()=>{},now=Date.now,autoStart=true,intervalMs=30000}){
  let stopped=false,timer=null,pending=null,controller=null,analysisTask=null,analysisController=null;
  let checkedAt=null,collectionError=false;
  // Persisted jobs are never silently reported as completed after a process exit.
  db.prepare("UPDATE server_incidents SET analysis_status='interrupted' WHERE analysis_status='running'").run();
  const isManager=id=>!!db.prepare('SELECT 1 FROM server_managers WHERE user_id=?').get(id);
  function syncChannel(){
    const managers=db.prepare("SELECT u.id,u.handle FROM server_managers m JOIN users u ON u.id=m.user_id WHERE u.identity_provider!='system'").all();
    if(!managers.length)return null;
    let bot=db.prepare("SELECT id FROM users WHERE identity_provider='system' AND external_subject='server-monitor'").get();
    if(!bot){const id=randomUUID();db.prepare('INSERT INTO users(id,email,name,handle,role,identity_provider,external_subject) VALUES(?,?,?,?,?,?,?)').run(id,`server-${id}@internal.invalid`,'서버 상태 알림',`server-${id.slice(0,8)}`,'bot','system','server-monitor');bot={id};}
    let id=db.prepare("SELECT value FROM app_meta WHERE key='server_alert_channel'").get()?.value;
    if(!id){
      id=createChannel(db,{name:`서버-관리-알림-${randomUUID().slice(0,4)}`,topic:'서버 관리자 전용 · 보고 중단, 재시작, 복구와 원인 분석',kind:'private',creator:managers[0].id,members:managers.map(u=>u.id)});
      db.prepare("INSERT INTO app_meta(key,value) VALUES('server_alert_channel',?)").run(id);
    }
    const channel=db.prepare('SELECT kind FROM channels WHERE id=?').get(id);
    if(channel?.kind!=='private')throw new Error('Invalid server alert channel');
    db.prepare('DELETE FROM memberships WHERE channel_id=? AND user_id!=? AND user_id NOT IN(SELECT user_id FROM server_managers)').run(id,bot.id);
    db.prepare('INSERT OR IGNORE INTO memberships(channel_id,user_id) VALUES(?,?)').run(id,bot.id);
    for(const u of managers)db.prepare('INSERT OR IGNORE INTO memberships(channel_id,user_id) VALUES(?,?)').run(id,u.id);
    return {id,bot:bot.id,managers};
  }
  // Initial responsibility follows existing administrators. Later assignment is explicit and separate.
  function initializeManagers(){
  if(source&&!db.prepare("SELECT 1 FROM app_meta WHERE key='server_managers_initialized'").get()&&db.prepare("SELECT 1 FROM users WHERE role='admin' AND identity_provider!='system'").get()){
    transaction(db,()=>{db.exec("INSERT OR IGNORE INTO server_managers SELECT id FROM users WHERE role='admin' AND identity_provider!='system'");db.prepare("INSERT INTO app_meta VALUES('server_managers_initialized','1')").run();syncChannel();});
  }
  }
  initializeManagers();
  const channelId=()=>db.prepare("SELECT value FROM app_meta WHERE key='server_alert_channel'").get()?.value||null;
  function publish(body){
    const channel=syncChannel();if(!channel)return;
    const mentions=channel.managers.map(u=>`@${u.handle}`).join(' ');
    const id=Number(db.prepare('INSERT INTO messages(channel_id,user_id,body) VALUES(?,?,?)').run(channel.id,channel.bot,`${mentions}\n${body}`).lastInsertRowid);
    for(const u of channel.managers)db.prepare('INSERT INTO mentions VALUES(?,?)').run(id,u.id);
  }
  const roleView=()=>db.prepare("SELECT u.id,u.name,u.handle,u.role,EXISTS(SELECT 1 FROM server_managers m WHERE m.user_id=u.id) AS serverManager FROM users u WHERE u.identity_provider!='system' ORDER BY u.name").all();
  function setManager(actor,id,enabled){
    if(typeof enabled!=='boolean'||typeof id!=='string'||!db.prepare("SELECT 1 FROM users WHERE id=? AND identity_provider!='system'").get(id))throw Object.assign(new Error('구성원과 역할을 확인해 주세요.'),{status:400});
    if(!enabled&&isManager(id)&&db.prepare('SELECT count(*) n FROM server_managers').get().n<=1)throw Object.assign(new Error('알림을 받을 서버 관리자를 최소 한 명 지정해 주세요.'),{status:409});
    transaction(db,()=>{if(enabled)db.prepare('INSERT OR IGNORE INTO server_managers VALUES(?)').run(id);else db.prepare('DELETE FROM server_managers WHERE user_id=?').run(id);syncChannel();audit(actor,'server.manager',id);});emit();return roleView();
  }
  function incident(host,kind,evidence){
    const at=now();
    const budget=db.prepare("SELECT count(*) n FROM server_incidents WHERE opened_at>? AND analysis_status NOT IN('disabled','rate_limited')").get(at-3600000).n;
    const state=!analyze?'disabled':budget>=4?'rate_limited':'pending';
    const id=Number(db.prepare('INSERT INTO server_incidents(host,kind,opened_at,evidence,analysis_status) VALUES(?,?,?,?,?)').run(host,kind,at,JSON.stringify(evidence),state).lastInsertRowid);
    const explanation=kind==='restart'?'커널 부팅 식별자가 변경됐습니다. 재부팅이 관측됐지만 원인은 확인되지 않았습니다.':'3분 이상 유효한 보고가 없습니다. 서버 종료·네트워크·수집기 오류를 구분할 추가 확인이 필요합니다.';
    publish(`⚠️ ${host} — ${kind==='restart'?'재시작 관측':'보고 중단'}\n${explanation}\n${evidence.source==='gpu'?'GPU 수집 보고 기준입니다. ':''}마지막 정상 보고: ${evidence.lastSeen?new Date(evidence.lastSeen).toISOString():'없음'}\n장애 #${id} · ${state==='pending'?'원인 분석 대기':'원인 분석 '+({disabled:'미연결',rate_limited:'시간당 한도 도달'}[state]||state)}`);
    return id;
  }
  function advance(host,sample,reportedAt,method,failed=false){
    const time=now();let row=db.prepare('SELECT * FROM server_observations WHERE host=?').get(host);
    if(!row){db.prepare('INSERT INTO server_observations(host,candidate_since) VALUES(?,?)').run(host,time);row=db.prepare('SELECT * FROM server_observations WHERE host=?').get(host);}
    const old=row.sample?JSON.parse(row.sample):null;
    const valid=reportedAt!==null&&reportedAt<=time+60000&&reportedAt>=(row.last_seen??0);
    const fresh=!failed&&valid&&time-reportedAt<=STALE;
    if(valid&&sample)db.prepare('UPDATE server_observations SET sample=?,last_seen=? WHERE host=?').run(JSON.stringify(sample),reportedAt,host);
    else if(valid&&!sample)db.prepare('UPDATE server_observations SET last_seen=? WHERE host=?').run(reportedAt,host);
    const lastSeen=valid?reportedAt:row.last_seen;
    const evidence={source:method,lastSeen,observedAt:time,collectionFailed:failed,cpu:old?.cpu?{usagePercent:old.cpu.usagePercent,load1:old.cpu.load1}:null,memory:old?.memory?{availableBytes:old.memory.availableBytes,totalBytes:old.memory.totalBytes}:null};
    if(fresh){
      if(row.incident_id){
        if(row.candidate_sample===null)db.prepare('UPDATE server_observations SET candidate_sample=? WHERE host=?').run(reportedAt,host);
        else if(reportedAt-row.candidate_sample>=RECOVERY){
          db.prepare('UPDATE server_incidents SET resolved_at=? WHERE id=?').run(time,row.incident_id);
          db.prepare("UPDATE server_observations SET status='online',incident_id=NULL,candidate_since=NULL,candidate_sample=NULL WHERE host=?").run(host);
          publish(`🟢 ${host} — 보고 복구\n30초 이상 진행된 새 보고를 확인했습니다. 장애 #${row.incident_id}`);
        }
      }else db.prepare("UPDATE server_observations SET status='online',candidate_since=NULL,candidate_sample=NULL WHERE host=?").run(host);
      if(sample?.bootId&&old?.bootId&&sample.bootId!==old.bootId&&sample.reportedAt>(row.last_seen??0)){
        const id=incident(host,'restart',{...evidence,bootChanged:true});db.prepare('UPDATE server_incidents SET resolved_at=? WHERE id=?').run(time,id);
      }
    }else{
      db.prepare('UPDATE server_observations SET candidate_since=coalesce(candidate_since,?),candidate_sample=NULL WHERE host=?').run(time,host);
      const missingSince=row.candidate_since??time;
      if(!row.incident_id&&time-(lastSeen??missingSince)>STALE){
        const id=incident(host,'report_lost',evidence);db.prepare("UPDATE server_observations SET status='offline',incident_id=? WHERE host=?").run(id,host);
      }else if(!row.incident_id)db.prepare("UPDATE server_observations SET status='degraded' WHERE host=?").run(host);
    }
  }
  async function runAnalysis(){
    if(stopped||!analyze||analysisTask)return;
    const job=db.prepare("SELECT * FROM server_incidents WHERE analysis_status='pending' ORDER BY id LIMIT 1").get();if(!job)return;
    db.prepare("UPDATE server_incidents SET analysis_status='running' WHERE id=?").run(job.id);
    analysisController=new AbortController();
    analysisTask=(async()=>{
      try{
        const result=await analyze({host:job.host,kind:job.kind,...JSON.parse(job.evidence)},analysisController.signal);
        if(stopped)return;
        transaction(db,()=>{db.prepare("UPDATE server_incidents SET analysis_status='complete',analysis=? WHERE id=?").run(JSON.stringify(result),job.id);publish(`🔎 ${job.host} — 장애 #${job.id} 원인 분석 (추정)\n${result.summary}\n확인할 사항: ${result.checks.join(' / ')}\n자동 복구는 실행하지 않았습니다.`);});
      }catch{if(!stopped){db.prepare("UPDATE server_incidents SET analysis_status='failed' WHERE id=?").run(job.id);publish(`ℹ️ ${job.host} — 장애 #${job.id} 자동 분석을 완료하지 못했습니다. 최초 알림과 관측 기록은 유지됩니다.`);}}
      finally{analysisTask=null;if(!stopped){emit(channelId());void runAnalysis();}}
    })();
    return analysisTask;
  }
  async function collect(){
    controller=new AbortController();
    const results=source?await source(controller.signal).catch(()=>null):[];
    if(stopped)return;
    initializeManagers();
    checkedAt=now();collectionError=results===null;
    const seen=new Set();
    transaction(db,()=>{
      for(const host of source?.hosts||[]){
        seen.add(host);const entry=results?.find(x=>x.host===host);let sample=null;
        try{if(entry?.sample)sample=normalizeServerSample(entry.sample,now());}catch{}
        advance(host,sample,sample?.reportedAt??null,'inventory',!sample);
      }
      const g=gpu?.view();const groups=new Map();
      for(const item of g?.items||[]){if(!seen.has(item.host))groups.set(item.host,Math.max(groups.get(item.host)??0,item.reportedAt??0));}
      for(const [host,ts] of groups){seen.add(host);advance(host,null,ts||null,'gpu',g.connection!=='ok');}
      for(const row of db.prepare('SELECT host FROM server_observations').all())if(!seen.has(row.host))advance(row.host,null,null,'missing',true);
      // Bounded metadata; chat messages follow existing workspace retention.
      db.prepare('DELETE FROM server_incidents WHERE resolved_at IS NOT NULL AND opened_at<? AND analysis_status NOT IN(\'pending\',\'running\')').run(now()-90*86400000);
    });
    emit(channelId());void runAnalysis();
  }
  const poll=()=>{if(stopped)return Promise.resolve();if(pending)return pending;pending=collect().finally(()=>{pending=null;});return pending;};
  function view(userId){
    const g=gpu?.view(),time=now(),manager=isManager(userId);
    const rows=new Map(db.prepare('SELECT * FROM server_observations').all().map(r=>[r.host,r]));
    for(const entry of source?.catalog||[])if(!rows.has(entry.host))rows.set(entry.host,{host:entry.host,status:'waiting',last_seen:null});
    for(const item of g?.items||[])if(!rows.has(item.host))rows.set(item.host,{host:item.host,status:'waiting',last_seen:item.reportedAt});
    return {checkedAt,analysisConfigured:!!analyze,isServerManager:manager,alertChannelId:manager?channelId():null,
      items:[...rows.values()].map(row=>{
        const s=row.sample?JSON.parse(row.sample):null,inventory=source?.hosts?.includes(row.host)||false;
        const fresh=row.status==='online'&&time-(row.last_seen??0)<=STALE&&checkedAt!==null&&time-checkedAt<intervalMs*3&&!collectionError;
        const devices=(g?.items||[]).filter(x=>x.host===row.host).map(({index,name,memoryTotalMiB,memoryFreeMiB,utilization,status})=>({index,name,memoryTotalMiB,memoryFreeMiB:g.connection==='ok'&&!['offline','unknown'].includes(status)?memoryFreeMiB:null,utilization:g.connection==='ok'&&!['offline','unknown'].includes(status)?utilization:null}));
        const meta=source?.catalog?.find(t=>t.host===row.host);
        return {host:row.host,hosting:meta?.hosting||'unknown',note:meta?.note||'',status:fresh?'online':row.incident_id?'offline':'unknown',reportedAt:row.last_seen??null,inventoryConnected:inventory,sample:publicSample(s,fresh&&inventory&&time-s.reportedAt<=STALE),gpus:devices};
      }).sort((a,b)=>a.host.localeCompare(b.host)),
      incidents:manager?db.prepare('SELECT id,host,kind,opened_at,resolved_at,analysis_status,analysis FROM server_incidents ORDER BY id DESC LIMIT 30').all().map(r=>({...r,analysis:r.analysis?JSON.parse(r.analysis):null})):[]};
  }
  if(autoStart){timer=setInterval(()=>void poll().catch(()=>{}),intervalMs);timer.unref();void poll().catch(()=>{});}
  return {poll,view,isManager,roleView,setManager,channelId,async stop(){if(stopped)return;stopped=true;clearInterval(timer);controller?.abort();analysisController?.abort();await Promise.allSettled([pending,analysisTask]);}};
}
