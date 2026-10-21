import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createApp} from '../server/app.mjs';
const newServer={host:'manual-cloud',label:'클라우드 학습 서버',hosting:'cloud',note:'등록 사양\n실시간 미연결',cpuModel:'Test CPU',cpuCores:32,memoryGiB:128,storageGiB:1024};
const newGpu={host:'manual-cloud',gpuIndex:0,label:'학습 GPU',model:'H200',memoryGiB:140,enabled:true};
async function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'catalog-'));let reports=[];
 const service=createApp({dataDir:dir,mode:'demo',gpuAutoStart:false,gpuSource:async()=>reports});const server=service.app.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}/api`;
 async function req(path,cookie,body,method=body?'POST':'GET'){const r=await fetch(base+path,{method,headers:{'X-Lab-Request':'1','Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 const users=service.db.prepare("SELECT id,role FROM users WHERE identity_provider='demo' ORDER BY role,name").all();const cookies=[];for(const u of users)cookies.push({...u,...await req('/auth/demo',null,{userId:u.id})});const [admin,manager,member]=cookies;
 await req('/admin/server-managers',admin.cookie,{userId:manager.id,enabled:true});
 return {service,req,admin,manager,member,setReports(v){reports=v;},async close(){service.close();server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});}};
}
test('catalog HTTP API allows admins and server managers, rejects ordinary users and revoked roles',async()=>{
 const f=await fixture();try{
  assert.equal((await f.req('/resources/catalog')).status,401);
  assert.equal((await f.req('/resources/servers',f.member.cookie,newServer)).status,403);
  assert.equal((await f.req('/resources/servers',f.manager.cookie,newServer)).status,201);
  assert.equal((await f.req('/resources/servers',f.admin.cookie,newServer)).status,409);
  assert.equal((await f.req('/resources/inventory',f.member.cookie,newGpu)).status,403);
  const gpu=await f.req('/resources/inventory',f.manager.cookie,newGpu);assert.equal(gpu.status,201);
  assert.equal((await f.req('/resources/inventory',f.admin.cookie,newGpu)).status,409);
  assert.equal((await f.req('/resources/inventory/'+gpu.data.id,f.manager.cookie,{...newGpu,version:1,enabled:false},'PUT')).status,200);
  assert.equal((await f.req('/resources/inventory/'+gpu.data.id,f.manager.cookie,{...newGpu,version:1},'PUT')).status,409);
  const catalog=await f.req('/resources/catalog',f.member.cookie);assert.equal(catalog.status,200);assert.equal(catalog.data.canManageResources,false);assert.equal(catalog.data.servers[0].memory_gib,128);
  assert.equal((await f.req('/resources/balances',f.manager.cookie,{provider:'openai',amount:1,currency:'USD',version:0})).status,403);
  assert.equal((await f.req('/admin/server-managers',f.manager.cookie,{userId:f.member.id,enabled:true})).status,403);
  await f.req('/admin/server-managers',f.admin.cookie,{userId:f.admin.id,enabled:true});await f.req('/admin/server-managers',f.admin.cookie,{userId:f.manager.id,enabled:false});
  assert.equal((await f.req('/resources/servers/manual-cloud',f.manager.cookie,{...newServer,version:1},'PUT')).status,403);
  assert.equal((await f.req('/resources/inventory/'+gpu.data.id,f.manager.cookie,{...newGpu,version:2},'PUT')).status,403);
 }finally{await f.close();}
});
test('manual registration stays unobserved, discovery reuses identities, edits preserve reservations and declared facts',async()=>{
 const f=await fixture();try{
  await f.req('/resources/servers',f.manager.cookie,newServer);const gpu=(await f.req('/resources/inventory',f.manager.cookie,newGpu)).data;
  const manual=(await f.req('/resources/servers',f.member.cookie)).data.items.find(s=>s.host===newServer.host);
  assert.equal(manual.status,'unknown');assert.equal(manual.sample,null);assert.equal(manual.declared.memoryGiB,128);assert.equal(manual.gpus[0].memoryFreeMiB,null);assert.equal(manual.gpus[0].declaredMemoryGiB,140);
  const booking={resourceId:gpu.id,project:'등록 GPU 예약',purpose:'독립 원장 검증',startsAt:Date.now()+3600000,endsAt:Date.now()+7200000,memoryGiB:16};
  assert.equal((await f.req('/resources/reservations',f.member.cookie,{...booking,memoryGiB:141})).status,400);
  const reservation=(await f.req('/resources/reservations',f.member.cookie,booking)).data;
  assert.equal((await f.req(`/resources/reservations/${reservation.id}/status`,f.admin.cookie,{version:1,status:'approved'})).status,200);
  f.setReports([{host:newServer.host,ts:Date.now()/1000,gpus:[{index:0,name:'Observed GPU',mem_total:81920,mem_used:1000,util:1,procs:[]}]}]);await f.service.gpu.poll();await f.service.servers.poll();
  const current=(await f.req('/resources/catalog',f.manager.cookie)).data;assert.equal(current.gpus.length,1);assert.equal(current.gpus[0].id,gpu.id);assert.equal(current.gpus[0].label,newGpu.label);
  const observed=(await f.req('/resources/servers',f.member.cookie)).data.items.find(s=>s.host===newServer.host);assert.equal(observed.gpus[0].name,'Observed GPU');assert.equal(observed.gpus[0].memoryTotalMiB,81920);assert.equal(observed.declared.memoryGiB,128);
  const changed=await f.req('/resources/servers/'+newServer.host,f.manager.cookie,{...newServer,version:1,label:'바뀐 이름'},'PUT');assert.equal(changed.status,200);
  assert.equal((await f.req('/resources/servers/'+newServer.host,f.manager.cookie,{...newServer,version:1},'PUT')).status,409);
  assert.equal((await f.req('/resources/servers/'+newServer.host,f.manager.cookie,{...newServer,version:2,host:'renamed'},'PUT')).status,400);
  await f.req('/resources/inventory/'+gpu.id,f.manager.cookie,{...newGpu,version:1,enabled:false},'PUT');
  const managed=(await f.req('/resources/management',f.member.cookie)).data;assert.equal(managed.resources[0].id,gpu.id);assert.equal(managed.reservations[0].status,'approved');assert.equal(managed.resources[0].enabled,0);
  assert.equal((await f.req('/resources/reservations',f.member.cookie,{...booking,startsAt:booking.endsAt,endsAt:booking.endsAt+3600000})).status,409);
  assert.ok(f.service.db.prepare("SELECT 1 FROM audit_log WHERE action='resource.server.create' AND actor_id=?").get(f.manager.id));
 }finally{await f.close();}
});
test('invalid inventory inputs fail atomically; configuration seed never overwrites operator edits',async()=>{
 const f=await fixture();try{
  for(const invalid of [{host:'../../etc'},{cpuCores:1.5},{memoryGiB:-5},{hosting:'somewhere'},{ownerId:f.service.db.prepare("SELECT id FROM users WHERE identity_provider='system'").get()?.id||'missing'}])assert.equal((await f.req('/resources/servers',f.admin.cookie,{...newServer,...invalid})).status,400);
  await f.req('/resources/servers',f.admin.cookie,newServer);
  for(const invalid of [{host:'not-registered'},{gpuIndex:-1},{gpuIndex:1.5},{memoryGiB:-1},{enabled:'true'}])assert.ok([400,404].includes((await f.req('/resources/inventory',f.admin.cookie,{...newGpu,...invalid})).status));
  assert.equal((await f.req('/resources/catalog',f.admin.cookie)).data.gpus.length,0);
  const before=f.service.db.prepare('SELECT count(*) n FROM audit_log').get().n;
  assert.equal((await f.req('/resources/servers/manual-cloud',f.admin.cookie,{...newServer,version:1,memoryGiB:'512'},'PUT')).status,400);
  assert.equal(f.service.db.prepare('SELECT count(*) n FROM audit_log').get().n,before);
  const {createResourceCatalog}=await import('../server/resource-catalog.mjs');const source={catalog:[{host:'manual-cloud',hosting:'local',note:'old config'}],hosts:['manual-cloud']};
  createResourceCatalog({db:f.service.db,gpu:f.service.gpu,source}).sync();const row=f.service.db.prepare('SELECT * FROM server_catalog WHERE host=?').get('manual-cloud');assert.equal(row.hosting,'cloud');assert.equal(row.note,newServer.note);
 }finally{await f.close();}
});
