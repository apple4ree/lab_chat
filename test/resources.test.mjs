import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createApp} from '../server/app.mjs';
import {openDatabase,createUser} from '../server/db.mjs';
import {createGpuMonitor,demoGpuSource} from '../server/gpu.mjs';
import {createResources} from '../server/resources.mjs';
import {createResourceSource,normalizeResourceData} from '../server/resource-source.mjs';

async function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'resources-test-'));
  const service=createApp({dataDir:dir,mode:'demo',gpuSource:demoGpuSource,gpuAutoStart:false});await service.gpu.poll();
  const server=service.app.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
  async function req(path,{cookie,body,method=body?'POST':'GET'}={}){
    const response=await fetch(`${base}/api${path}`,{method,headers:{'X-Lab-Request':'1',...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
    return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  const people=service.db.prepare("SELECT id,role FROM users WHERE identity_provider='demo' ORDER BY role,name").all();
  const accounts=[];for(const p of people)accounts.push({...p,...await req('/auth/demo',{body:{userId:p.id}})});
  const [admin,member,other]=accounts;
  const get=()=>req('/resources/management',{cookie:admin.cookie});
  const resource=(await get()).data.resources[0];
  const body={resourceId:resource.id,project:'테스트 프로젝트',purpose:'실험 검증',startsAt:Date.now()+3600000,endsAt:Date.now()+7200000,memoryGiB:8};
  return {service,dir,req,admin,member,other,resource,body,get,async close(){service.close();server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});}};
}

test('resource APIs require authentication and preserve member/admin authority and request validation',async()=>{
  const f=await fixture();try{
    for(const path of ['/resources/management','/resources/targets','/resources/quotas','/resources/usage','/resources/share','/resources/history'])assert.equal((await f.req(path)).status,401);
    const created=await f.req('/resources/reservations',{cookie:f.member.cookie,body:{...f.body,status:'allocated',userId:f.admin.id}});assert.equal(created.status,201);assert.equal(created.data.status,'pending');assert.equal(created.data.user_id,f.member.id);
    const path=`/resources/reservations/${created.data.id}`;
    assert.equal((await f.req(path+'/status',{cookie:f.member.cookie,body:{version:1,status:'approved'}})).status,403);
    assert.equal((await f.req(path,{method:'PUT',cookie:f.other.cookie,body:{...f.body,version:1}})).status,403);
    assert.equal((await f.req(path+'/status',{cookie:f.other.cookie,body:{version:1,status:'cancelled'}})).status,403);
    assert.equal((await f.req(`/resources/inventory/${f.resource.id}`,{method:'PUT',cookie:f.member.cookie,body:{...f.resource,enabled:false}})).status,403);
    assert.equal((await f.req('/resources/balances',{cookie:f.member.cookie,body:{provider:'openai',amount:10,currency:'USD',version:0}})).status,403);
    for(const invalid of [{startsAt:'tomorrow'},{endsAt:f.body.startsAt},{memoryGiB:10000},{project:''}])assert.equal((await f.req('/resources/reservations',{cookie:f.member.cookie,body:{...f.body,...invalid}})).status,400);
    assert.equal((await f.req(path+'/status',{cookie:f.admin.cookie,body:{version:1,status:'rejected',note:''}})).status,400);
    assert.equal((await f.req(path+'/status',{cookie:f.member.cookie,body:{version:1,status:'cancelled'}})).status,200);
  }finally{await f.close();}
});

test('approval is transactional, excludes overlapping bookings, allows adjacent periods and resets approval on edits',async()=>{
  const f=await fixture();try{
    const first=await f.req('/resources/reservations',{cookie:f.member.cookie,body:f.body});
    const second=await f.req('/resources/reservations',{cookie:f.other.cookie,body:f.body});
    const approve=r=>f.req(`/resources/reservations/${r.data.id}/status`,{cookie:f.admin.cookie,body:{version:1,status:'approved'}});
    const results=await Promise.all([approve(first),approve(second)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
    const winner=results.find(r=>r.status===200).data;
    assert.equal((await f.req('/resources/reservations',{cookie:f.member.cookie,body:f.body})).status,409);
    assert.equal((await f.req('/resources/reservations',{cookie:f.member.cookie,body:{...f.body,startsAt:f.body.endsAt,endsAt:f.body.endsAt+3600000}})).status,201);
    const edit=await f.req(`/resources/reservations/${winner.id}`,{method:'PUT',cookie:f.admin.cookie,body:{...f.body,project:'재검토',version:winner.version}});assert.equal(edit.status,200);assert.equal(edit.data.status,'pending');
    assert.equal((await f.req(`/resources/reservations/${winner.id}/status`,{cookie:f.admin.cookie,body:{version:winner.version,status:'approved'}})).status,409);
    const approved=await f.req(`/resources/reservations/${winner.id}/status`,{cookie:f.admin.cookie,body:{version:edit.data.version,status:'approved'}});assert.equal(approved.status,200);
    const assigned=await f.req(`/resources/reservations/${winner.id}/status`,{cookie:f.admin.cookie,body:{version:approved.data.version,status:'allocated'}});assert.equal(assigned.status,200);
    assert.equal((await f.req(`/resources/reservations/${winner.id}`,{method:'PUT',cookie:f.admin.cookie,body:{...f.body,version:assigned.data.version}})).status,409);
    const events=await f.req(`/resources/reservations/${winner.id}/events`,{cookie:f.member.cookie});assert.ok(events.data.some(e=>e.action==='updated'));
    const db=openDatabase(f.dir);assert.equal(db.prepare('SELECT status FROM resource_reservations WHERE id=?').get(winner.id).status,'allocated');db.close();
  }finally{await f.close();}
});

test('maintenance settings and manual balances use admin-only optimistic versions without writing upstream',async()=>{
  const f=await fixture();try{
    const config={version:1,label:'공용 학습 GPU',notes:'담당자에게 문의',ownerId:f.admin.id,enabled:false};
    assert.equal((await f.req(`/resources/inventory/${f.resource.id}`,{method:'PUT',cookie:f.admin.cookie,body:config})).status,200);
    assert.equal((await f.req(`/resources/inventory/${f.resource.id}`,{method:'PUT',cookie:f.admin.cookie,body:config})).status,409);
    assert.equal((await f.req('/resources/reservations',{cookie:f.member.cookie,body:f.body})).status,409);
    const b={provider:'openai',amount:24.5,currency:'USD',version:0};
    assert.equal((await f.req('/resources/balances',{cookie:f.admin.cookie,body:b})).status,200);
    assert.equal((await f.req('/resources/balances',{cookie:f.admin.cookie,body:b})).status,409);
    assert.equal((await f.req('/resources/balances',{cookie:f.admin.cookie,body:{...b,amount:-1,version:1}})).status,400);
    const usage=(await f.req('/resources/usage',{cookie:f.member.cookie})).data;assert.equal(usage.demo,true);assert.equal(usage.data.localBalances[0].amount,24.5);
    assert.equal((await f.get()).data.resources.find(r=>r.id===f.resource.id).label,config.label);
  }finally{await f.close();}
});

test('reservation start/end notifications persist once across restart; overdue requests expire without executing jobs',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'resource-clock-')),db=openDatabase(dir);let time=Date.now();
  const user=createUser(db,{email:'owner@example.test',name:'Owner',role:'admin'});
  const gpu=createGpuMonitor({db,source:demoGpuSource,autoStart:false});await gpu.poll();
  const options={db,gpu,now:()=>time,autoStart:false};let r=createResources(options);
  try{
    const id=r.list(user).resources[0].id;
    const request=r.create(user,{resourceId:id,project:'Timer',purpose:'test',startsAt:time+60000,endsAt:time+180000});r.transition(user,request.id,{version:1,status:'approved'});
    const pending=r.create(user,{resourceId:id,project:'Next',purpose:'test',startsAt:time+180000,endsAt:time+240000});
    time+=60000;r.tick();r.tick();assert.equal(r.events(request.id).filter(e=>e.action==='started').length,1);
    r.stop();r=createResources(options);r.tick();assert.equal(r.events(request.id).filter(e=>e.action==='started').length,1);
    time+=180000;r.tick();r.tick();assert.equal(r.events(request.id).filter(e=>e.action==='completed').length,1);assert.equal(r.events(pending.id).filter(e=>e.action==='expired').length,1);
    assert.equal(db.prepare("SELECT count(*) n FROM messages WHERE body LIKE '%예약 시작%'").get().n,1);
    r.stop();r=createResources(options);r.tick();assert.equal(r.events(request.id).filter(e=>e.action==='completed').length,1);
  }finally{r.stop();await gpu.stop();db.close();rmSync(dir,{recursive:true,force:true});}
});

test('history uses validated targets and bounded periods; demo keeps all analytics isolated',async()=>{
  const f=await fixture();try{
    const targets=await f.req('/resources/targets',{cookie:f.member.cookie});assert.equal(targets.data.demo,true);
    const t=targets.data.data[0];const q=new URLSearchParams({host:t.host,gpu:String(t.index),period:'month'});
    const history=await f.req('/resources/history?'+q,{cookie:f.member.cookie});assert.equal(history.status,200);assert.ok(history.data.data.length>1&&history.data.data.length<=301);assert.ok(history.data.bucketMs>=60000);assert.equal(history.data.data[1].at-history.data.data[0].at,history.data.bucketMs);
    assert.equal((await f.req('/resources/history?host=unregistered&gpu=0',{cookie:f.member.cookie})).status,404);
    assert.equal((await f.req('/resources/history?'+q+'&period=forever',{cookie:f.member.cookie})).status,400);
    assert.equal((await f.req('/resources/usage?days=1000000',{cookie:f.member.cookie})).status,400);
    assert.equal((await f.req('/resources/usage?provider=evil',{cookie:f.member.cookie})).status,400);
    const quotas=(await f.req('/resources/quotas',{cookie:f.member.cookie})).data.data;assert.equal(quotas[1].stale,true);assert.equal(quotas[1].fiveHour.percent,null);
    assert.ok((await f.req('/resources/share?days=7',{cookie:f.member.cookie})).data.data.length);
  }finally{await f.close();}
});

test('analytics normalization preserves unknowns, strips command/credential fields, and handles actual CLI server strings',()=>{
  const now=Date.now();const q=normalizeResourceData('quotas',{accounts:[{provider:'codex',email:'sample@example.test',ts:now/1000,servers:['host-a'],five_hour:{percent:0},seven_day:{percent:null},access_token:'secret'}]},now)[0];
  assert.equal(q.fiveHour.percent,0);assert.equal(q.sevenDay.percent,null);assert.equal(q.servers[0].host,'host-a');assert.equal(q.access_token,undefined);
  const point=normalizeResourceData('history',[{ts:now/1000,util:null,mem_used:0,mem_total:null,cmd:'secret'}])[0];assert.equal(point.utilization,null);assert.equal(point.cmd,undefined);
  const usage=normalizeResourceData('usage',{totals:{},balances:{openai:{amount:0,updated:0}},byProvider:[]});assert.equal(usage.hasData,false);assert.equal(usage.totals.costKRW,null);assert.equal(usage.balances.openai,null);
  assert.throws(()=>normalizeResourceData('targets',[{host:'x',gpu:-1}]));
});

test('batch history API authenticates, bounds work, validates all targets and preserves legacy results',async()=>{
  const f=await fixture();try{
    const targets=(await f.req('/resources/targets',{cookie:f.member.cookie})).data.data;
    const request=body=>f.req('/resources/history/batch',{cookie:f.member.cookie,body});
    assert.equal((await f.req('/resources/history/batch',{body:{targets}})).status,401);
    for(const body of [{},{targets:[]},{targets:Array(7).fill(targets[0])},{targets:[targets[0],targets[0]]},{targets:[null]},{targets:[{...targets[0],index:'0'}]},{targets,period:'toString'},{targets,period:['day']}])assert.equal((await request(body)).status,400);
    assert.equal((await request({targets:[targets[0],{host:'unknown',index:0}]})).status,404);
    const result=await request({targets:[...targets].reverse(),period:'week'});assert.equal(result.status,200);
    assert.deepEqual(result.data.series.map(({host,index})=>({host,index})),[...targets].reverse());
    assert.equal(new Set(result.data.series.map(s=>s.result.to)).size,1);
    for(const s of result.data.series){
      const single=await f.req('/resources/history?'+new URLSearchParams({host:s.host,gpu:String(s.index),period:'week'}),{cookie:f.member.cookie});
      assert.equal(single.status,200);assert.equal(s.result.bucketMs,single.data.bucketMs);
      // The HTTP requests can straddle a 30-second boundary; compare exact data only in the same window.
      if(s.result.to===single.data.to)assert.deepEqual(s.result.data,single.data.data);
      assert.ok(s.result.data.length<=602);assert.equal(s.result.demo,true);
    }
  }finally{await f.close();}
});

test('batch history resolves targets once, uses one time window and never masks upstream failure',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'history-batch-')),db=openDatabase(dir);let time=1800000000000,failHistory=false;
  const calls=[],targets=Array.from({length:6},(_,index)=>({host:'batch',index}));
  const source={async get(kind,params){calls.push({kind,params});time+=30001;if(kind==='targets')return {data:targets};if(failHistory&&params.gpu===3)throw Object.assign(new Error('unavailable'),{status:503});return {data:[],fetchedAt:time,demo:false,source:'fixture',bucketMs:900000};},stop(){}};
  const service=createResources({db,gpu:{view:()=>({items:[]})},source,now:()=>time,autoStart:false});
  try{
    const batch=await service.histories({targets,period:'week'});
    assert.equal(calls.filter(c=>c.kind==='targets').length,1);assert.equal(calls.filter(c=>c.kind==='history').length,6);
    assert.equal(new Set(batch.series.map(s=>s.result.to)).size,1);assert.equal(batch.series[0].result.bucketMs,900000);
    calls.length=0;await assert.rejects(service.histories({targets:[targets[0],{host:'missing',index:0}]}),{status:404});assert.equal(calls.length,1);
    failHistory=true;await assert.rejects(service.histories({targets}),{status:503});
  }finally{service.stop();db.close();rmSync(dir,{recursive:true,force:true});}
});

test('management associates active bookings with the correct device and advances at reservation boundaries',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'resource-current-')),db=openDatabase(dir);let time=1800000000000;
  const user=createUser(db,{email:'current@example.test',name:'Current',role:'admin'});
  const gpu=createGpuMonitor({db,source:demoGpuSource,autoStart:false});await gpu.poll();
  const service=createResources({db,gpu,now:()=>time,autoStart:false});
  try{
    const [a,b,c]=service.list(user).resources;
    const book=(resourceId,start,end)=>service.create(user,{resourceId,project:resourceId,purpose:'boundary',startsAt:start,endsAt:end});
    const first=book(a.id,time,time+60000),next=book(a.id,time+60000,time+120000),pending=book(b.id,time,time+120000);
    for(const r of [first,next])service.transition(user,r.id,{version:1,status:'approved'});
    let rows=service.list(user).resources;
    assert.equal(rows.find(r=>r.id===a.id).current.id,first.id);assert.equal(rows.find(r=>r.id===b.id).current,null);assert.equal(rows.find(r=>r.id===c.id).current,null);
    assert.equal(rows.find(r=>r.id===a.id).observation.index,a.gpu_index);
    service.transition(user,pending.id,{version:1,status:'approved'});service.transition(user,pending.id,{version:2,status:'allocated'});
    time+=60000;rows=service.list(user).resources;
    assert.equal(rows.find(r=>r.id===a.id).current.id,next.id);assert.equal(rows.find(r=>r.id===b.id).current.id,pending.id);
    time+=60000;assert.ok(service.list(user).resources.every(r=>r.current===null));
  }finally{service.stop();await gpu.stop();db.close();rmSync(dir,{recursive:true,force:true});}
});

test('shared analytics cache deduplicates work, never serves stale data after failures and aborts shutdown',async()=>{
  let time=Date.now(),calls=0,fail=false;
  const source=createResourceSource({now:()=>time,reader:async()=>{calls++;if(fail)throw new Error('internal secret');return [{host:'h',gpu:0}];}});
  await Promise.all([source.get('targets'),source.get('targets')]);assert.equal(calls,1);time+=30001;fail=true;await assert.rejects(source.get('targets'),/불러오지/);assert.equal(calls,2);source.stop();
  let signal;const pending=createResourceSource({reader:(_p,_q,s)=>{signal=s;return new Promise((_,reject)=>s.addEventListener('abort',()=>reject(new Error('abort'))));}});
  const request=pending.get('targets');pending.stop();assert.equal(signal.aborted,true);await assert.rejects(request,/불러오지/);
});
