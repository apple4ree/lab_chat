import {createResourceCatalog} from './resource-catalog.mjs';
import {transaction} from './db.mjs';
import {createResourceSource,resourceFailure} from './resource-source.mjs';

const fail=(status,message)=>{throw resourceFailure(status,message);};
const str=(v,label,max=200,min=1)=>{if(typeof v!=='string'||v.trim().length<min||v.length>max)fail(400,`${label}을 확인해 주세요.`);return v.trim();};
const positive=v=>{if(!Number.isSafeInteger(v)||v<1)fail(400,'번호 또는 버전을 확인해 주세요.');return v;};
const statusNames={pending:'신청',reviewing:'검토 중',approved:'승인',allocated:'배정',rejected:'반려',cancelled:'취소',completed:'기간 종료',expired:'미승인 만료',updated:'수정 후 재신청',started:'예약 시작'};
const terminal=new Set(['rejected','cancelled','completed','expired']);
const active=new Set(['approved','allocated']);

export function createResources({db,gpu,emit=()=>{},source=createResourceSource(),now=Date.now,autoStart=true,catalog=createResourceCatalog({db,gpu,now})}){
  let timer=null,stopped=false;
  db.prepare("UPDATE channels SET topic=? WHERE kind='public' AND id=(SELECT value FROM app_meta WHERE key='gpu_channel_id') AND topic=?").run('GPU 상태 변화와 예약·배정 알림 · 실제 작업 실행은 별도로 진행합니다.','GPU 상태 변화 알림과 사용 조율 · 예약·실행 제어는 제공하지 않습니다.');
  const audit=(actor,action,id)=>db.prepare('INSERT INTO audit_log(actor_id,action,target_id) VALUES (?,?,?)').run(actor,action,String(id));
  const admin=user=>{if(user.role!=='admin')fail(403,'관리자만 사용할 수 있습니다.');};
  const resource=id=>db.prepare('SELECT * FROM research_resources WHERE id=?').get(str(id,'자원',100))||fail(404,'자원을 찾을 수 없습니다.');
  const reservation=id=>db.prepare('SELECT * FROM resource_reservations WHERE id=?').get(positive(Number(id)))||fail(404,'예약을 찾을 수 없습니다.');
  const sync=()=>catalog.sync();
  function event(r,actor,action,note,channelId){
    db.prepare('INSERT INTO reservation_events(reservation_id,actor_id,action,note,at) VALUES (?,?,?,?,?)').run(r.id,actor,action,note,now());
    audit(actor,`resource.reservation.${action}`,r.id);
    const bot=db.prepare("SELECT id FROM users WHERE identity_provider='system' AND external_subject='gpu-monitor'").get();
    if(channelId&&bot){
      const label=resource(r.resource_id).label;
      const who=db.prepare('SELECT name FROM users WHERE id=?').get(r.user_id)?.name||'구성원';
      const time=t=>new Date(t).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
      db.prepare('INSERT INTO messages(channel_id,user_id,body) VALUES (?,?,?)').run(channelId,bot.id,`📅 예약 #${r.id} · ${statusNames[action]}\n${label} · ${who} · ${r.project}\n${time(r.starts_at)} ~ ${time(r.ends_at)} (한국 시간)\n예약은 일정 관리용이며 실제 GPU 작업을 실행하거나 종료하지 않습니다.`);
    }
  }
  function changed(channel){if(channel)emit(channel);}
  function checkAvailable(r,exclude=0){
    if(db.prepare("SELECT id FROM resource_reservations WHERE resource_id=? AND id!=? AND status IN ('approved','allocated') AND starts_at<? AND ends_at>? LIMIT 1").get(r.resource_id,exclude,r.ends_at,r.starts_at))fail(409,'승인 또는 배정된 예약과 시간이 겹칩니다. 다른 시간을 선택해 주세요.');
  }
  function fields(body){
    const r=resource(body.resourceId),starts=body.startsAt,ends=body.endsAt,time=now();
    if(!r.enabled)fail(409,'점검 중이거나 예약이 중지된 자원입니다.');
    if(!Number.isSafeInteger(starts)||!Number.isSafeInteger(ends)||starts<time-60000||ends<=starts||ends-starts>90*86400000||starts>time+366*86400000)fail(400,'예약 시간을 확인해 주세요. 시작은 현재 이후, 기간은 최대 90일입니다.');
    let memory=null;if(body.memoryGiB!==null&&body.memoryGiB!==undefined&&body.memoryGiB!==''){
      memory=body.memoryGiB;if(typeof memory!=='number'||!Number.isFinite(memory)||memory<=0||memory>100000)fail(400,'필요한 GPU 메모리를 확인해 주세요.');
      const gpuItem=gpu.view().items.find(g=>g.host===r.host&&g.index===r.gpu_index);
      const capacity=gpuItem?.memoryTotalMiB?gpuItem.memoryTotalMiB/1024:db.prepare('SELECT memory_gib FROM resource_specs WHERE resource_id=?').get(r.id)?.memory_gib;
      if(capacity&&memory>capacity)fail(400,'요청 메모리가 GPU의 전체 메모리보다 큽니다.');
    }
    return {resource_id:r.id,project:str(body.project,'프로젝트',120),purpose:str(body.purpose,'사용 목적·근거',2000),starts_at:starts,ends_at:ends,memory_gib:memory};
  }
  function tick(){
    if(stopped)return;
    const due=db.prepare("SELECT * FROM resource_reservations WHERE status IN ('pending','reviewing','approved','allocated') AND (ends_at<=? OR (status IN ('approved','allocated') AND starts_at<=? AND start_notified=0))").all(now(),now());
    if(!due.length)return;
    const channel=gpu.ensureChannel();
    transaction(db,()=>{
      for(const r of due){
        if(r.ends_at<=now()){
          const status=active.has(r.status)?'completed':'expired';
          db.prepare('UPDATE resource_reservations SET status=?,version=version+1,updated_at=? WHERE id=?').run(status,now(),r.id);event(r,null,status,'',channel);
        }else{db.prepare('UPDATE resource_reservations SET start_notified=1 WHERE id=?').run(r.id);event(r,null,'started','',channel);}
      }
    });changed(channel);
  }
  function list(user,query={}){
    tick();const view=sync(),time=now(),before=query.before===undefined?Number.MAX_SAFE_INTEGER:positive(Number(query.before));
    const status=query.status||'all';if(status!=='all'&&!Object.hasOwn(statusNames,status))fail(400,'예약 상태를 확인해 주세요.');
    const resources=db.prepare('SELECT r.*,u.name AS owner_name FROM research_resources r LEFT JOIN users u ON u.id=r.owner_id ORDER BY r.host,r.gpu_index').all().map(r=>({...r,
      observation:view.items.find(g=>g.host===r.host&&g.index===r.gpu_index)||null,
      current:db.prepare("SELECT b.id,b.project,b.ends_at,u.name AS user_name FROM resource_reservations b JOIN users u ON u.id=b.user_id WHERE b.resource_id=? AND b.status IN ('approved','allocated') AND b.starts_at<=? AND b.ends_at>? ORDER BY b.starts_at").get(r.id,time,time)||null}));
    const reservations=db.prepare(`SELECT b.*,r.label AS resource_label,u.name AS user_name FROM resource_reservations b JOIN research_resources r ON r.id=b.resource_id JOIN users u ON u.id=b.user_id WHERE b.id<? AND (?='all' OR b.status=?) AND (?=0 OR b.user_id=?) ORDER BY b.id DESC LIMIT 51`).all(before,status,status,query.mine==='1'?1:0,user.id);
    return {canManageResources:catalog.canManage(user),resources,reservations:reservations.slice(0,50),nextBefore:reservations.length>50?reservations[49].id:null,serverTime:time};
  }
  function create(user,body){
    sync();const channel=gpu.ensureChannel();
    const result=transaction(db,()=>{
      const f=fields(body);
      checkAvailable(f);
      const result=db.prepare("INSERT INTO resource_reservations(resource_id,user_id,project,purpose,starts_at,ends_at,memory_gib,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'pending',?,?)").run(f.resource_id,user.id,f.project,f.purpose,f.starts_at,f.ends_at,f.memory_gib,now(),now());
      const r=reservation(Number(result.lastInsertRowid));event(r,user.id,'pending','',channel);return r;
    });changed(channel);return result;
  }
  function update(user,id,body){
    const channel=gpu.ensureChannel();
    const result=transaction(db,()=>{
      const r=reservation(id);if(r.user_id!==user.id&&user.role!=='admin')fail(403,'본인의 예약만 수정할 수 있습니다.');
      if(positive(body.version)!==r.version)fail(409,'예약이 변경되었습니다. 새로고침 후 다시 시도해 주세요.');
      if(terminal.has(r.status)||r.status==='allocated'||(active.has(r.status)&&r.starts_at<=now()))fail(409,'종료되었거나 진행 중인 예약은 수정할 수 없습니다.');
      const f=fields(body);checkAvailable(f,r.id);
      db.prepare("UPDATE resource_reservations SET resource_id=?,project=?,purpose=?,starts_at=?,ends_at=?,memory_gib=?,status='pending',start_notified=0,version=version+1,updated_at=? WHERE id=?").run(f.resource_id,f.project,f.purpose,f.starts_at,f.ends_at,f.memory_gib,now(),r.id);
      const next=reservation(r.id);event(next,user.id,'updated',`이전: ${r.project} · ${new Date(r.starts_at).toISOString()} ~ ${new Date(r.ends_at).toISOString()}\n승인된 예약도 수정하면 재승인이 필요합니다.`,channel);return next;
    });changed(channel);return result;
  }
  function transition(user,id,body){
    const target=body.status,channel=gpu.ensureChannel();
    const result=transaction(db,()=>{
      const r=reservation(id);if(positive(body.version)!==r.version)fail(409,'예약이 변경되었습니다. 새로고침 후 다시 시도해 주세요.');
      if(terminal.has(r.status))fail(409,'종료된 예약은 변경할 수 없습니다.');
      if(target==='cancelled'){if(user.id!==r.user_id&&user.role!=='admin')fail(403,'본인의 예약만 취소할 수 있습니다.');}
      else{
        admin(user);const allowed={pending:['reviewing','approved','rejected'],reviewing:['approved','rejected'],approved:['allocated'],allocated:[]};
        if(!allowed[r.status]?.includes(target))fail(409,'현재 상태에서 수행할 수 없는 변경입니다.');
        if(r.ends_at<=now())fail(409,'예약 기간이 이미 종료되었습니다.');
        if(active.has(target)){if(!resource(r.resource_id).enabled)fail(409,'예약이 중지된 자원입니다.');checkAvailable(r,r.id);}
      }
      const note=str(body.note??'','처리 사유',1000,target==='rejected'?1:0);
      db.prepare('UPDATE resource_reservations SET status=?,version=version+1,updated_at=? WHERE id=?').run(target,now(),r.id);
      const next=reservation(r.id);event(next,user.id,target,note,channel);return next;
    });changed(channel);return result;
  }
  const configure=(user,id,body)=>catalog.configureGpu(user,id,body);
  const periods={hour:3600,day:86400,week:604800,month:2592000};
  function days(value){const n=Number(value??7);if(![1,7,30,90].includes(n))fail(400,'조회 기간을 확인해 주세요.');return n;}
  async function history(query){
    const span=periods[query.period||'day'];if(!span)fail(400,'이력 기간을 확인해 주세요.');
    const host=str(query.host,'서버',100),index=Number(query.gpu);if(!Number.isSafeInteger(index)||index<0)fail(400,'GPU 번호를 확인해 주세요.');
    const targets=(await source.get('targets')).data;
    if(!targets.some(t=>t.host===host&&t.index===index))fail(404,'이력을 조회할 수 없는 GPU입니다.');
    const to=Math.floor(now()/30000)*30,bucket=Math.max(60,Math.ceil(span/300));
    const result=await source.get('history',{host,gpu:index,from:to-span,to,bucket});
    return {...result,from:(to-span)*1000,to:to*1000,bucketMs:result.bucketMs??bucket*1000};
  }
  async function usage(query){
    const provider=query.provider||'all';if(!['all','openai','anthropic','google'].includes(provider))fail(400,'공급자를 확인해 주세요.');
    const result=await source.get('usage',{days:days(query.days??30),provider});
    const local=db.prepare('SELECT b.*,u.name AS updated_name FROM resource_balances b JOIN users u ON u.id=b.updated_by').all();
    return {...result,data:{...result.data,localBalances:local}};
  }
  function balance(user,body){
    admin(user);const p=body.provider;if(!['openai','anthropic','google'].includes(p)||!['USD','KRW'].includes(body.currency)||typeof body.amount!=='number'||!Number.isFinite(body.amount)||body.amount<0||body.amount>1e12)fail(400,'잔액과 통화를 확인해 주세요.');
    return transaction(db,()=>{
      const row=db.prepare('SELECT * FROM resource_balances WHERE provider=?').get(p);
      if(body.version!==(row?.version??0))fail(409,'잔액 기록이 변경되었습니다. 새로고침해 주세요.');
      db.prepare('INSERT INTO resource_balances(provider,amount,currency,updated_at,updated_by) VALUES (?,?,?,?,?) ON CONFLICT(provider) DO UPDATE SET amount=excluded.amount,currency=excluded.currency,updated_at=excluded.updated_at,updated_by=excluded.updated_by,version=version+1').run(p,body.amount,body.currency,now(),user.id);
      audit(user.id,'resource.balance.update',p);return db.prepare('SELECT * FROM resource_balances WHERE provider=?').get(p);
    });
  }
  if(autoStart){timer=setInterval(()=>{try{tick();}catch{console.error('Resource reservation timer failed');}},30000);timer.unref();}
  return {list,create,update,transition,configure,history,usage,balance,tick,
    targets:()=>source.get('targets'),share:q=>source.get('share',{days:days(q.days)}),quotas:()=>source.get('quotas'),refreshQuotas:()=>source.refreshQuotas?source.refreshQuotas():source.get('quotas'),
    events:id=>{const r=reservation(id);return db.prepare('SELECT e.*,u.name AS actor_name FROM reservation_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.reservation_id=? ORDER BY e.id DESC LIMIT 100').all(r.id);},
    stop(){stopped=true;if(timer)clearInterval(timer);source.stop();}};
}

export function mountResources(app,service){
  app.get('/api/resources/management',(req,res)=>res.json(service.list(req.user,req.query)));
  app.post('/api/resources/reservations',(req,res)=>res.status(201).json(service.create(req.user,req.body)));
  app.put('/api/resources/reservations/:id',(req,res)=>res.json(service.update(req.user,req.params.id,req.body)));
  app.post('/api/resources/reservations/:id/status',(req,res)=>res.json(service.transition(req.user,req.params.id,req.body)));
  app.get('/api/resources/reservations/:id/events',(req,res)=>res.json(service.events(req.params.id)));
  app.put('/api/resources/inventory/:id',(req,res)=>res.json(service.configure(req.user,req.params.id,req.body)));
  app.get('/api/resources/targets',async(_req,res)=>res.json(await service.targets()));
  app.get('/api/resources/history',async(req,res)=>res.json(await service.history(req.query)));
  app.get('/api/resources/share',async(req,res)=>res.json(await service.share(req.query)));
  app.post('/api/resources/quotas/refresh',async(_req,res)=>res.status(202).json(await service.refreshQuotas()));
  app.get('/api/resources/quotas',async(_req,res)=>res.json(await service.quotas()));
  app.get('/api/resources/usage',async(req,res)=>res.json(await service.usage(req.query)));
  app.post('/api/resources/balances',(req,res)=>res.json(service.balance(req.user,req.body)));
}
