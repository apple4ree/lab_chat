import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {canManageResources} from './resource-catalog.mjs';
import {createSshVault} from './ssh-vault.mjs';
import {scanHost,executeSnapshot,validateEndpoint,validateCredential,sshError} from './ssh-transport.mjs';
import {validateSshPlan} from './ssh-planner.mjs';
import {normalizeServerSample} from './servers.mjs';
import {normalizeGpuSnapshots} from './gpu.mjs';

const inventory=readFileSync(fileURLToPath(new URL('../scripts/server-snapshot.py',import.meta.url)),'utf8').split("if __name__ == '__main__':")[0];
const extension=readFileSync(fileURLToPath(new URL('../scripts/ssh-snapshot.py',import.meta.url)),'utf8');
export const sshSnapshotScript=(gpu=true)=>`${inventory}\nCOLLECT_GPU = ${gpu?'True':'False'}\n${extension}`;
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const messages={invalid_endpoint:'SSH 주소·포트·사용자명을 확인해 주세요.',invalid_credential:'비밀번호 또는 개인 키 형식을 확인해 주세요.',ssh_failed:'SSH 인증·서버 키·Python 실행을 확인해 주세요. 원격 오류 원문은 저장하지 않습니다.',ssh_unavailable:'채팅 서버의 OpenSSH 실행 파일을 확인해 주세요.',host_key_missing:'서버 공개 키를 읽지 못했습니다.',timeout:'서버 응답 시간이 초과됐습니다.',output_limit:'수집 응답이 허용 크기를 초과했습니다.',cancelled:'연결 작업이 취소됐습니다.',invalid_sample:'Linux·Python 3 지원과 서버 시각을 확인해 주세요.',identity_changed:'서버 호스트명이 변경되어 수집을 중단했습니다.',planning_failed:'Codex 설정 판단에 실패했습니다. 계정 연결 상태를 확인하고 재시도해 주세요.',permission_revoked:'서버 관리 권한이 변경되어 설정을 중단했습니다.',interrupted:'채팅 서버가 재시작되어 설정이 중단됐습니다. 접속 정보를 다시 입력해 주세요.',collection_failed:'수집하지 못했습니다. SSH 인증·서버 키·Python 상태를 확인해 주세요.'};
export function parseSshSnapshot(output,host,expectedHostname,now=Date.now()){
  let value;try{value=JSON.parse(output);}catch{throw sshError('invalid_sample');}
  const raw=value?.sample;
  if(value?.platform!=='Linux'||!Array.isArray(value.python)||value.python.length!==3||value.python.some(n=>!Number.isSafeInteger(n)||n<0)||value.python[0]!==3||!raw||typeof raw.hostname!=='string'||!raw.hostname||raw.hostname.length>100||now-raw.reportedAt>120000)throw sshError('invalid_sample');
  if(expectedHostname&&raw.hostname!==expectedHostname)throw sshError('identity_changed');
  let sample,gpus;
  try{
    sample={version:1,...normalizeServerSample(raw,now)};
    if(sample.memory.totalBytes===null||sample.cpu.logicalCores===null)throw new Error('Incomplete inventory');
    if(!['ok','absent','error','disabled'].includes(value.gpu?.state))throw new Error('Invalid GPU state');
    gpus=normalizeGpuSnapshots([{host,ts:sample.reportedAt/1000,gpus:value.gpu.items}],now).map(g=>({index:g.index,name:g.name,mem_total:g.memoryTotalMiB,mem_used:g.memoryUsedMiB,util:g.utilization,temp:g.temperature,...(Array.isArray(value.gpu.items.find(x=>x.index===g.index)?.procs)?{procs:g.processes.map(p=>({pid:p.pid,used_mem:p.memoryMiB}))}:{})}));
  }catch{throw sshError('invalid_sample');}
  return {sample,gpu:{host,ts:value.gpu.state==='ok'?sample.reportedAt/1000:0,gpus},facts:{platform:'Linux',python:value.python,scope:sample.scope,logicalCores:sample.cpu.logicalCores,gpuState:value.gpu.state,gpuCount:gpus.length}};
}

export function createSshConnections({db,dataDir,planner=null,scan=scanHost,execute=executeSnapshot,now=Date.now}){
  const vault=createSshVault(dataDir,()=>!!db.prepare('SELECT 1 FROM server_ssh_connections WHERE credential IS NOT NULL LIMIT 1').get());
  const jobs=new Map(),scans=new Map(),limits=new Map(),cache=new Map();
  const lifecycle=new AbortController();let stopped=false,scanning=0;
  db.prepare("UPDATE server_ssh_connections SET status='failed',credential=NULL,last_error='interrupted' WHERE status NOT IN('connected','disabled','failed')").run();
  const row=host=>db.prepare('SELECT * FROM server_ssh_connections WHERE host=?').get(host);
  const active=()=>stopped?[]:db.prepare("SELECT * FROM server_ssh_connections WHERE status='connected'").all();
  function requireManager(id){if(stopped)throw sshError('cancelled');if(!canManageResources(db,db.prepare('SELECT id,role FROM users WHERE id=?').get(id)))fail(403,messages.permission_revoked);}
  function requireHost(host){if(typeof host!=='string'||!db.prepare('SELECT 1 FROM server_catalog WHERE host=?').get(host))fail(404,'먼저 자원 등록에서 서버를 등록해 주세요.');}
  const audit=(id,action,host)=>db.prepare('INSERT INTO audit_log(actor_id,action,target_id) VALUES(?,?,?)').run(id,action,host);
  function publicRow(r){const t=JSON.parse(r.target);return {host:r.host,id:r.id,address:t.address,ip:t.ip,port:t.port,username:t.username,fingerprint:t.fingerprint,status:r.status,hostname:r.hostname,plan:r.plan?JSON.parse(r.plan):null,lastSeen:r.last_seen,error:r.last_error?messages[r.last_error]||messages.collection_failed:null};}
  function view(id){requireManager(id);return {plannerConfigured:!!planner,connections:db.prepare('SELECT * FROM server_ssh_connections ORDER BY host').all().map(publicRow)};}
  function rate(id){for(const [key,value] of limits)if(now()-value.at>=60000)limits.delete(key);const limit=limits.get(id)||{at:now(),count:0};if(limit.count>=6)fail(429,'1분에 최대 6번 연결을 확인할 수 있습니다.');limit.count++;limits.set(id,limit);}
  async function inspect(id,body){
    requireManager(id);requireHost(body.host);rate(id);
    if(scanning>=2)fail(429,'다른 연결 확인이 진행 중입니다. 잠시 후 다시 시도해 주세요.');
    let endpoint;try{endpoint=validateEndpoint(body);}catch(e){fail(400,messages[e.sshCode]);}
    scanning++;
    try{
      const target=await scan(endpoint,lifecycle.signal);requireManager(id);
      for(const [key,value] of scans)if(value.expiresAt<now())scans.delete(key);
      if(scans.size>=32)fail(429,'확인 대기 중인 서버가 많습니다. 5분 후 다시 시도해 주세요.');
      const ticket=randomUUID();scans.set(ticket,{id,host:body.host,target,expiresAt:now()+300000});
      return {ticket,fingerprint:target.fingerprint,ip:target.ip,expiresAt:now()+300000};
    }catch(e){if(e.status)throw e;fail(400,messages[e.sshCode]||messages.collection_failed);}finally{scanning--;}
  }
  function connect(id,body){
    requireManager(id);requireHost(body.host);if(!planner)fail(409,'서버의 Codex 설정 계정이 연결되지 않았습니다.');
    const ticket=scans.get(body.ticket);
    if(!ticket||ticket.id!==id||ticket.host!==body.host||ticket.expiresAt<now()||body.trustHostKey!==true)fail(409,'서버 키를 다시 조회하고 지문을 확인해 주세요.');
    if(jobs.size>=2)fail(429,'동시에 두 서버까지 설정할 수 있습니다.');
    if(jobs.has(body.host)||row(body.host)?.status==='connected')fail(409,'이미 연결됐거나 설정 중입니다. 기존 연결을 해제한 뒤 다시 설정해 주세요.');
    if(active().length+jobs.size>=8)fail(409,'SSH 자동 수집은 최대 8대까지 지원합니다.');
    let credential;try{credential=validateCredential(body.credential);}catch(e){fail(400,messages[e.sshCode]);}
    const connectionId=randomUUID(),encrypted=vault.seal(connectionId,credential),host=body.host;
    scans.delete(body.ticket);
    db.prepare(`INSERT INTO server_ssh_connections(host,id,target,credential,status,actor_id,updated_at) VALUES(?,?,?,?,'probing',?,?)
      ON CONFLICT(host) DO UPDATE SET id=excluded.id,target=excluded.target,credential=excluded.credential,status=excluded.status,actor_id=excluded.actor_id,updated_at=excluded.updated_at,plan=NULL,hostname=NULL,last_seen=NULL,last_error=NULL`).run(host,connectionId,JSON.stringify(ticket.target),encrypted,id,now());
    audit(id,'resource.ssh.connect',host);
    const controller=new AbortController(),signal=AbortSignal.any([controller.signal,lifecycle.signal,AbortSignal.timeout(120000)]);
    function check(){if(stopped||signal.aborted)throw sshError('cancelled');try{requireManager(id);}catch{throw sshError('permission_revoked');}if(row(host)?.id!==connectionId||row(host)?.status==='disabled')throw sshError('cancelled');}
    function phase(status){check();db.prepare('UPDATE server_ssh_connections SET status=?,updated_at=? WHERE id=?').run(status,now(),connectionId);}
    const task=Promise.resolve().then(async()=>{
      try{
        const first=parseSshSnapshot(await execute(ticket.target,credential,sshSnapshotScript(),signal),host,null,now());check();phase('planning');
        let plan;
        try{plan=await planner(first.facts,signal);plan={...validateSshPlan({...plan,supported:true},first.facts),usage:plan.usage||null};}catch{throw sshError('planning_failed');}
        check();phase('verifying');
        const verified=parseSshSnapshot(await execute(ticket.target,credential,sshSnapshotScript(plan.collectGpu),signal),host,first.sample.hostname,now());check();
        if(plan.collectGpu&&verified.facts.gpuState!=='ok')throw sshError('collection_failed');
        cache.set(host,{...verified,lastAttempt:now()});
        db.prepare("UPDATE server_ssh_connections SET status='connected',plan=?,hostname=?,last_seen=?,last_error=NULL,updated_at=? WHERE id=?").run(JSON.stringify(plan),verified.sample.hostname,verified.sample.reportedAt,now(),connectionId);
        audit(id,'resource.ssh.verified',host);
      }catch(e){if(!stopped&&row(host)?.id===connectionId&&row(host)?.status!=='disabled'){db.prepare("UPDATE server_ssh_connections SET status='failed',credential=NULL,last_error=?,updated_at=? WHERE id=?").run(messages[e.sshCode]?e.sshCode:'collection_failed',now(),connectionId);audit(id,'resource.ssh.failed',host);}}
      finally{credential=null;jobs.delete(host);}
    });
    jobs.set(host,{controller,task});return publicRow(row(host));
  }
  function disconnect(id,host){requireManager(id);requireHost(host);const current=row(host);if(!current)fail(404,'연결 정보가 없습니다.');jobs.get(host)?.controller.abort();cache.delete(host);db.prepare("UPDATE server_ssh_connections SET status='disabled',credential=NULL,last_error=NULL,updated_at=? WHERE host=?").run(now(),host);audit(id,'resource.ssh.disconnect',host);return publicRow(row(host));}
  async function collect(signal){
    const rows=active(),results=[];let index=0;
    async function worker(){while(index<rows.length&&!stopped&&!signal?.aborted){
      const r=rows[index++],plan=JSON.parse(r.plan),previous=cache.get(r.host),started=now();
      if(previous&&started-previous.lastAttempt<plan.intervalSeconds*1000){results.push(previous.error?{host:r.host,error:true}:{host:r.host,sample:previous.sample});continue;}
      try{
        const value=parseSshSnapshot(await execute(JSON.parse(r.target),vault.open(r.id,r.credential),sshSnapshotScript(plan.collectGpu),AbortSignal.any([lifecycle.signal,...(signal?[signal]:[])])),r.host,r.hostname,now());
        if(stopped||row(r.host)?.id!==r.id||row(r.host)?.status!=='connected')continue;
        cache.set(r.host,{...value,lastAttempt:started});
        db.prepare('UPDATE server_ssh_connections SET last_seen=?,last_error=?,updated_at=? WHERE id=?').run(value.sample.reportedAt,plan.collectGpu&&value.facts.gpuState!=='ok'?'collection_failed':null,now(),r.id);
        results.push({host:r.host,sample:value.sample});
      }catch(e){if(stopped||row(r.host)?.id!==r.id||row(r.host)?.status!=='connected')continue;
        cache.set(r.host,{...previous,error:true,lastAttempt:started});db.prepare('UPDATE server_ssh_connections SET last_error=?,updated_at=? WHERE id=?').run(e.sshCode==='identity_changed'?'identity_changed':'collection_failed',now(),r.id);results.push({host:r.host,error:true});}
    }}
    await Promise.all([worker(),worker()]);return results;
  }
  function mergeSources(baseServer,baseGpu){
    const source=async signal=>{
      const [base,managed]=await Promise.allSettled([baseServer?baseServer(signal):[],collect(signal)]);
      if(stopped)return [];
      const hosts=new Set(active().map(r=>r.host));
      return [...(base.status==='fulfilled'?base.value:[]).filter(r=>!hosts.has(r.host)),...(managed.status==='fulfilled'?managed.value:[])];
    };
    Object.defineProperties(source,{hosts:{get:()=>[...new Set([...(baseServer?.hosts||[]),...active().map(r=>r.host)])]},catalog:{get:()=>baseServer?.catalog||[]}});
    const gpuSource=async signal=>{
      const rows=active().filter(r=>JSON.parse(r.plan).collectGpu),hosts=new Set(rows.map(r=>r.host));
      let base=[];try{if(baseGpu){base=await baseGpu(signal);normalizeGpuSnapshots(base,now());}}catch(e){base=[];if(!rows.length)throw e;}
      const managed=rows.map(r=>{const c=cache.get(r.host);return c?.gpu?{...c.gpu,ts:c.error?0:c.gpu.ts}:{host:r.host,ts:0,gpus:[]};});
      return [...base.filter(r=>!hosts.has(r.host)),...managed];
    };
    Object.defineProperty(gpuSource,'enabled',{get:()=>!!baseGpu||active().some(r=>JSON.parse(r.plan).collectGpu)});
    return {serverSource:source,gpuSource};
  }
  function mount(app){
    app.get('/api/resources/ssh',(req,res)=>res.json(view(req.user.id)));
    app.post('/api/resources/ssh/scan',async(req,res)=>res.json(await inspect(req.user.id,req.body)));
    app.post('/api/resources/ssh/connect',(req,res)=>res.status(202).json(connect(req.user.id,req.body)));
    app.post('/api/resources/ssh/:host/disconnect',(req,res)=>res.json(disconnect(req.user.id,req.params.host)));
  }
  return {view,inspect,connect,disconnect,collect,mergeSources,mount,async settle(){await Promise.allSettled([...jobs.values()].map(j=>j.task));},stop(){if(stopped)return;stopped=true;lifecycle.abort();scans.clear();cache.clear();for(const job of jobs.values())job.controller.abort();}};
}
