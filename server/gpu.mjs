import {randomUUID} from 'node:crypto';
import {transaction,createChannel} from './db.mjs';
import {gpuClient} from './gpu-http.mjs';

const STALE_MS=180000;
const labels={active:'연산 중',resident:'메모리·작업 상주',idle:'미사용 관측',offline:'보고 중단',unknown:'확인 불가'};
const finite=(v,min,max)=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max;
const text=(v,max=100)=>typeof v==='string'?v.slice(0,max):'';

// The boundary owns units, uncertainty and identity. Missing measurements never mean idle.
export function normalizeGpuSnapshots(input,now=Date.now()){
  if(!Array.isArray(input)||input.length>100)throw new Error('Invalid GPU inventory');
  const items=[],keys=new Set();
  for(const host of input){
    if(!host||typeof host.host!=='string'||!host.host||host.host.length>100||!Array.isArray(host.gpus)||host.gpus.length>64)throw new Error('Invalid GPU host');
    const reportedAt=finite(host.ts,1,(now+60000)/1000)?host.ts*1000:null;
    for(const g of host.gpus){
      if(!g||!Number.isSafeInteger(g.index)||g.index<0)throw new Error('Invalid GPU index');
      const id=JSON.stringify([host.host,g.index]);
      if(keys.has(id)||items.length>=1024)throw new Error('Duplicate or excessive GPU inventory');
      keys.add(id);
      const total=finite(g.mem_total,1,1e8)?g.mem_total:null;
      const used=total!==null&&finite(g.mem_used,0,total)?g.mem_used:null;
      const util=finite(g.util,0,100)?g.util:null;
      const validProcs=Array.isArray(g.procs)&&g.procs.length<=1000&&g.procs.every(p=>p&&typeof p==='object');
      const procs=validProcs?g.procs.map(p=>({pid:Number.isSafeInteger(p.pid)&&p.pid>0?p.pid:null,user:text(p.user)||null,memoryMiB:finite(p.used_mem,0,1e8)?p.used_mem:null})):[];
      const status=!reportedAt?'unknown':now-reportedAt>STALE_MS?'offline':util===null||used===null||!validProcs?'unknown':util>0?'active':used>0||procs.length?'resident':'idle';
      items.push({id,host:host.host,index:g.index,name:text(g.name,180)||'GPU',reportedAt,utilization:util,memoryTotalMiB:total,memoryUsedMiB:used,memoryFreeMiB:total!==null&&used!==null?total-used:null,temperature:finite(g.temp,-20,150)?g.temp:null,processes:procs,status});
    }
  }
  return items.sort((a,b)=>a.host.localeCompare(b.host)||a.index-b.index);
}

export function gpuHttpSource(baseUrl){
  const read=gpuClient(baseUrl);
  return signal=>read('/api/state',{},signal);
}

export const demoGpuSource=async()=>[
  {host:'샘플-H200',ts:Date.now()/1000,gpus:[
    {index:0,name:'H200 · 샘플',util:72,mem_total:143360,mem_used:86016,temp:54,procs:[{pid:1234,user:'sample-researcher',used_mem:86016}]},
    {index:1,name:'H200 · 샘플',util:0,mem_total:143360,mem_used:0,temp:32,procs:[]},
    {index:2,name:'H200 · 샘플',util:0,mem_total:143360,mem_used:12288,temp:36,procs:[{pid:2345,user:'sample-user',used_mem:12288}]},
  ]},
  {host:'샘플-오프라인',ts:Date.now()/1000-600,gpus:[{index:0,name:'RTX PRO 6000 · 샘플',util:0,mem_total:98304,mem_used:0,temp:31,procs:[]}]},
];

export function createGpuMonitor({db,source=null,emit=()=>{},history=null,demo=false,intervalMs=15000,settleMs=60000,now=Date.now,autoStart=true}){
  let stopped=false,timer=null,controller=null,pending=null;
  const saved=db.prepare("SELECT value FROM app_meta WHERE key='gpu_snapshot'").get();
  let snapshot=saved?JSON.parse(saved.value):{items:[],lastSuccessAt:null,checkedAt:null,connection:'waiting'};
  // Restart gaps do not establish continuous availability; retain stable states for deduplication.
  db.prepare("UPDATE gpu_observations SET candidate='',candidate_sample=NULL").run();
  const meta=(key,value)=>db.prepare('INSERT INTO app_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));
  const sourceEnabled=()=>!!source&&source.enabled!==false;
  function ensureChannel(){
    if(!sourceEnabled())return null;
    const owner=db.prepare("SELECT id FROM users WHERE role='admin' AND identity_provider!='system' ORDER BY created_at LIMIT 1").get();
    if(!owner)return null;
    return transaction(db,()=>{
      let id=db.prepare("SELECT value FROM app_meta WHERE key='gpu_channel_id'").get()?.value;
      if(id&&db.prepare('SELECT 1 FROM channels WHERE id=?').get(id))return id;
      const existing=db.prepare("SELECT id,kind FROM channels WHERE name='gpu-자원' AND kind!='dm'").get();
      // Never silently turn a pre-existing private channel into a public one.
      if(existing&&existing.kind!=='public')return null;
      let bot=db.prepare("SELECT id FROM users WHERE identity_provider='system' AND external_subject='gpu-monitor'").get();
      if(!bot){const bid=randomUUID();db.prepare('INSERT INTO users(id,email,name,handle,role,identity_provider,external_subject) VALUES (?,?,?,?,?,?,?)').run(bid,`gpu-${bid}@internal.invalid`,'GPU 알림',`gpu-${bid.slice(0,8)}`,'bot','system','gpu-monitor');bot={id:bid};}
      id=existing?.id||createChannel(db,{name:'gpu-자원',topic:'GPU 상태 변화와 예약·배정 알림 · 실제 작업 실행은 별도로 진행합니다.',creator:owner.id});
      db.prepare('INSERT OR IGNORE INTO memberships(channel_id,user_id) VALUES (?,?)').run(id,bot.id);
      db.prepare("INSERT INTO app_meta(key,value) VALUES ('gpu_channel_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(id);
      db.prepare('INSERT INTO messages(channel_id,user_id,body) VALUES (?,?,?)').run(id,bot.id,`${demo?'[체험용 샘플] ':''}GPU 상태 알림을 시작합니다.\n미사용 상태가 60초 이상 이어지거나 보고 중단·복구가 확인되면 알려드립니다. 메모리나 작업이 남아 있으면 미사용으로 분류하지 않습니다.\n‘미사용 관측’은 예약이나 독점 사용 권한을 보장하지 않습니다. 왼쪽 ‘연구 자원’에서 상태를 확인하세요.`);
      return id;
    });
  }
  function publish(channelId,body){
    if(!channelId)return;
    const bot=db.prepare("SELECT id FROM users WHERE identity_provider='system' AND external_subject='gpu-monitor'").get();
    if(bot)db.prepare('INSERT INTO messages(channel_id,user_id,body) VALUES (?,?,?)').run(channelId,bot.id,(demo?'[샘플] ':'')+body);
  }
  function transition(item,channelId,time){
    const before=db.prepare('SELECT * FROM gpu_observations WHERE id=?').get(item.id);
    const candidateSince=before?.candidate===item.status?before.candidate_since:time;
    const candidateSample=before?.candidate===item.status?before.candidate_sample:item.reportedAt;
    let stable=before?.stable||item.status;
    if(before&&stable!==item.status&&time-candidateSince>=settleMs&&(item.status==='offline'||item.status==='unknown'||(item.reportedAt!==null&&candidateSample!==null&&item.reportedAt-candidateSample>=settleMs))){
      const previous=stable;stable=item.status;
      const description=`${item.host} · GPU ${item.index}`;
      if(stable==='idle')publish(channelId,`🟢 ${description} — 미사용 상태가 확인됐습니다.\n사용률 0%, 메모리·작업 점유 없음. 사용 전 동료와 일정을 확인해 주세요.`);
      else if(stable==='offline'||stable==='unknown')publish(channelId,`⚠️ ${description} — ${labels[stable]}.\n현재 사용 가능 여부를 확인할 수 없습니다.`);
      else if(previous==='offline'||previous==='unknown')publish(channelId,`🔌 ${description} — 보고가 복구됐습니다. 현재 ${labels[stable]}.`);
    }
    db.prepare('INSERT INTO gpu_observations(id,stable,candidate,candidate_since,candidate_sample) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET stable=excluded.stable,candidate=excluded.candidate,candidate_since=excluded.candidate_since,candidate_sample=excluded.candidate_sample').run(item.id,stable,item.status,candidateSince,candidateSample);
  }
  async function collect(){
    if(stopped||!sourceEnabled())return;
    const previousChannelId=db.prepare("SELECT value FROM app_meta WHERE key='gpu_channel_id'").get()?.value;
    const previousMessageId=previousChannelId?db.prepare('SELECT coalesce(max(id),0) n FROM messages WHERE channel_id=?').get(previousChannelId).n:0;
    const channelId=ensureChannel();
    controller=new AbortController();
    const timeout=setTimeout(()=>controller?.abort(),5000);timeout.unref?.();
    try{
      const input=await source(controller.signal);
      if(stopped)return;
      const time=now(),items=normalizeGpuSnapshots(input,time),seen=new Set(items.map(x=>x.id));
      for(const item of snapshot.items)if(!seen.has(item.id))items.push({...item,status:'unknown'});
      if(items.length>1024)throw new Error('GPU inventory exceeds limit');
      transaction(db,()=>{
        history?.record(items,time);
        if(snapshot.connection==='error')publish(channelId,'🔌 GPU 상태 서비스에 다시 연결됐습니다. 장비별 최신 상태를 확인해 주세요.');
        for(const item of items)transition(item,channelId,time);
        snapshot={items,lastSuccessAt:time,checkedAt:time,connection:'ok'};meta('gpu_snapshot',snapshot);
      });
    }catch{
      if(stopped)return;
      transaction(db,()=>{
        history?.interrupt();
        if(snapshot.connection!=='error')publish(channelId,'⚠️ GPU 상태 서비스에 연결할 수 없습니다. 마지막 관측값은 현재 가용량으로 취급하지 않습니다.');
        snapshot={...snapshot,connection:'error',checkedAt:now()};meta('gpu_snapshot',snapshot);
        // Interrupt continuity: an outage cannot count toward a confirmed idle interval.
        db.prepare("UPDATE gpu_observations SET candidate='',candidate_since=?,candidate_sample=NULL").run(now());
      });
    }finally{clearTimeout(timeout);controller=null;if(!stopped&&channelId&&db.prepare('SELECT coalesce(max(id),0) n FROM messages WHERE channel_id=?').get(channelId).n!==previousMessageId)emit(channelId);}
  }
  function poll(){if(stopped)return Promise.resolve();if(pending)return pending;pending=collect().finally(()=>{pending=null;});return pending;}
  function view(){
    const time=now(),connection=!sourceEnabled()?'disabled':!snapshot.lastSuccessAt?snapshot.connection:snapshot.connection==='error'||time-snapshot.lastSuccessAt>45000?'error':snapshot.connection;
    const items=snapshot.items.map(item=>({...item,status:connection!=='ok'?'unknown':item.reportedAt&&time-item.reportedAt>STALE_MS?'offline':item.status}));
    return {configured:Boolean(source),demo,connection,checkedAt:snapshot.checkedAt,lastSuccessAt:snapshot.lastSuccessAt,channelId:db.prepare("SELECT value FROM app_meta WHERE key='gpu_channel_id'").get()?.value||null,items,summary:{hosts:new Set(items.map(i=>i.host)).size,total:items.length,...Object.fromEntries(Object.keys(labels).map(s=>[s,items.filter(i=>i.status===s).length]))}};
  }
  if(source&&autoStart){ensureChannel();void poll();timer=setInterval(()=>void poll(),intervalMs);timer.unref();}
  return {poll,view,ensureChannel,stop(){stopped=true;if(timer)clearInterval(timer);controller?.abort();return pending||Promise.resolve();}};
}
