import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {openDatabase,createUser} from '../server/db.mjs';
import {createApp} from '../server/app.mjs';
import {createServerMonitor,normalizeServerSample} from '../server/servers.mjs';
import {createServerSource} from '../server/server-source.mjs';
import {createIncidentAnalyzer,validateAnalysis} from '../server/incident-ai.mjs';
const epoch=1792580000000;
const sample=(time=epoch)=>({version:1,reportedAt:time,hostname:'test-node',scope:'container',bootId:'00000000-0000-0000-0000-000000000001',cpu:{model:'Test CPU',logicalCores:32,usagePercent:10,load1:1},memory:{totalBytes:1000,availableBytes:700,limitBytes:500,cgroupUsedBytes:150},disks:[{mount:'/',filesystem:'xfs',totalBytes:1000,availableBytes:300,usedBytes:650}],privateCommand:'secret'});
function setup(){const dir=mkdtempSync(join(tmpdir(),'server-monitor-')),db=openDatabase(dir);const admin=createUser(db,{email:'admin@example.test',name:'관리자',role:'admin'}),member=createUser(db,{email:'member@example.test',name:'구성원'});return {dir,db,admin,member,close(){db.close();rmSync(dir,{recursive:true,force:true});}};}
test('server inventory owns units and unknowns, drops sensitive fields, and masks stale capacities',async()=>{
  const d=setup();let time=epoch,fail=false;
  const source=Object.assign(async()=>fail?[{host:'node',error:true}]:[{host:'node',sample:sample(time)}],{hosts:['node'],catalog:[{host:'cloud',hosting:'cloud',note:'사용자 제공'}]});
  const m=createServerMonitor({db:d.db,source,now:()=>time,autoStart:false});
  try{
    const s=normalizeServerSample(sample());assert.equal(s.memory.usedBytes,300);assert.equal(s.memory.cgroupAvailableBytes,350);assert.equal(s.privateCommand,undefined);
    const invalid=sample();invalid.memory.availableBytes=1001;invalid.cpu.usagePercent=-1;assert.equal(normalizeServerSample(invalid).memory.availableBytes,null);assert.equal(normalizeServerSample(invalid).cpu.usagePercent,null);
    assert.throws(()=>normalizeServerSample(sample(epoch+61000),epoch));
    await m.poll();let v=m.view(d.admin.id);assert.equal(v.items.find(x=>x.host==='node').sample.memory.availableBytes,700);assert.equal(v.items.find(x=>x.host==='node').sample.bootId,undefined);assert.equal(v.items.find(x=>x.host==='cloud').hosting,'cloud');
    fail=true;time+=30000;await m.poll();v=m.view(d.admin.id);assert.equal(v.items.find(x=>x.host==='node').sample.memory.availableBytes,null);assert.equal(v.items.find(x=>x.host==='node').sample.disks[0].availableBytes,null);assert.equal(v.incidents.length,0);
  }finally{await m.stop();d.close();}
});
test('outage alerts and mentions are private, durable and deduplicated; recovery needs advancing samples; reboot is distinct',async()=>{
  const d=setup();let time=epoch,fail=false,stamp=null,boot=null;
  const source=Object.assign(async()=>fail?[]:[{host:'node',sample:{...sample(stamp??time),...(boot?{bootId:boot}:{})}}],{hosts:['node']});
  const opts={db:d.db,source,now:()=>time,autoStart:false};let m=createServerMonitor(opts);
  const count=()=>d.db.prepare('SELECT count(*) n FROM messages').get().n;
  try{
    await m.poll();assert.equal(count(),0);assert.ok(m.isManager(d.admin.id));assert.equal(m.isManager(d.member.id),false);
    fail=true;time+=180001;await m.poll();await m.poll();assert.equal(count(),1);assert.equal(m.view(d.admin.id).incidents.length,1);assert.equal(m.view(d.member.id).incidents.length,0);assert.equal(m.view(d.member.id).alertChannelId,null);
    assert.equal(d.db.prepare('SELECT count(*) n FROM mentions WHERE user_id=?').get(d.admin.id).n,1);assert.equal(d.db.prepare('SELECT count(*) n FROM memberships WHERE channel_id=? AND user_id=?').get(m.channelId(),d.member.id).n,0);
    await m.stop();m=createServerMonitor(opts);await m.poll();assert.equal(count(),1);
    fail=false;stamp=time;await m.poll();time+=30000;await m.poll();assert.equal(count(),1,'frozen sample is not recovery');stamp=time;await m.poll();assert.equal(count(),2);assert.ok(m.view(d.admin.id).incidents[0].resolved_at);
    time+=30000;stamp=time;boot='00000000-0000-0000-0000-000000000002';await m.poll();await m.poll();assert.equal(count(),3);assert.equal(m.view(d.admin.id).incidents[0].kind,'restart');
    m.setManager(d.admin.id,d.member.id,true);m.setManager(d.admin.id,d.admin.id,false);assert.equal(m.isManager(d.admin.id),false);assert.equal(d.db.prepare('SELECT count(*) n FROM memberships WHERE channel_id=? AND user_id=?').get(m.channelId(),d.admin.id).n,0);assert.throws(()=>m.setManager(d.admin.id,d.member.id,false),/최소 한 명/);
  }finally{await m.stop();d.close();}
});
test('alerts precede asynchronous AI, failures do not block monitoring, and close prevents late writes',async()=>{
  const d=setup();let time=epoch,fail=false,finish;
  const source=Object.assign(async()=>fail?[]:[{host:'node',sample:sample(time)}],{hosts:['node']});
  const m=createServerMonitor({db:d.db,source,now:()=>time,autoStart:false,analyze:()=>new Promise(r=>finish=r)});
  await m.poll();fail=true;time+=180001;await m.poll();assert.equal(d.db.prepare('SELECT count(*) n FROM messages').get().n,1);assert.equal(m.view(d.admin.id).incidents[0].analysis_status,'running');
  const stop=m.stop();d.close();finish({summary:'test',checks:['test']});await stop;
  const d2=setup();const m2=createServerMonitor({db:d2.db,source,now:()=>time,autoStart:false,analyze:async()=>{throw new Error('private upstream failure');}});
  try{await m2.poll();time+=180001;await m2.poll();await new Promise(r=>setImmediate(r));assert.equal(m2.view(d2.admin.id).incidents[0].analysis_status,'failed');assert.equal(d2.db.prepare('SELECT count(*) n FROM messages').get().n,2);assert.ok(!JSON.stringify(m2.view(d2.admin.id)).includes('private upstream'));}finally{await m2.stop();d2.close();}
});
test('server APIs enforce login, independent manager roles, and prevent generic channel membership bypass',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'server-api-'));const origin='http://127.0.0.1:4310';
  const source=Object.assign(async()=>[{host:'node',sample:sample(Date.now())}],{hosts:['node']});
  const app=createApp({dataDir:dir,origin,mode:'demo',serverSource:source,gpuAutoStart:false});const server=app.app.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}/api`;
  const request=(path,cookie,body)=>fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Lab-Request':'1',Origin:origin,...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined});
  try{
    assert.equal((await request('/resources/servers')).status,401);const users=app.db.prepare("SELECT * FROM users WHERE identity_provider='demo' ORDER BY role").all();const admin=users.find(u=>u.role==='admin'),member=users.find(u=>u.role==='member');
    const ac=(await request('/auth/demo',null,{userId:admin.id})).headers.get('set-cookie').split(';')[0],mc=(await request('/auth/demo',null,{userId:member.id})).headers.get('set-cookie').split(';')[0];
    await app.servers.poll();assert.equal((await request('/admin/server-managers',mc)).status,403);
    assert.equal((await request(`/channels/${app.servers.channelId()}/members`,ac,{userId:member.id})).status,403);
    assert.equal((await request(`/channels/${app.servers.channelId()}/messages`,mc)).status,404);
    assert.equal((await request('/admin/server-managers',ac,{userId:member.id,enabled:true})).status,200);
    assert.equal((await(await request('/resources/servers',mc)).json()).isServerManager,true);
    assert.equal((await(await request('/me',mc)).json()).role,'member');
    assert.equal((await request('/admin/server-managers',mc,{userId:admin.id,enabled:false})).status,403);
    assert.equal((await request('/admin/server-managers',ac,{userId:member.id,enabled:false})).status,200);
    assert.equal((await request(`/channels/${app.servers.channelId()}/messages`,mc)).status,404);
  }finally{app.close();server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});}
});
test('collector executes local read-only inventory, validates identity and rejects unsafe SSH targets',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'server-source-')),file=join(dir,'targets.json');
  try{writeFileSync(file,JSON.stringify([{host:'local',transport:'local'},{host:'cloud',transport:'gpu',hosting:'cloud'}]));const source=createServerSource(file);const values=await source(new AbortController().signal);assert.equal(values.length,1);assert.ok(values[0].sample.memory.totalBytes>0);assert.ok(!JSON.stringify(values).includes('privateCommand'));assert.equal(source.catalog[1].hosting,'cloud');
    writeFileSync(file,JSON.stringify([{host:'local',transport:'local',expectedHostname:'not-this-host'}]));assert.equal((await createServerSource(file)())[0].error,'collection_failed');
    writeFileSync(file,JSON.stringify([{host:'bad',transport:'ssh',sshAlias:'-oProxyCommand=bad',expectedHostname:'bad'}]));assert.throws(()=>createServerSource(file));
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('SDK adapter keeps credentials and tools out of prompts; malformed analysis fails closed',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'incident-ai-')),auth=join(dir,'login.json');writeFileSync(auth,'{}');let config,options,prompt;
  class Stub{constructor(c){config=c;}startThread(o){options=o;return {async run(p){prompt=p;return {items:[],finalResponse:JSON.stringify({summary:'원인 불명',checks:['수집기 확인']}),usage:{input_tokens:10,output_tokens:10}};}};}}
  try{const analyze=createIncidentAnalyzer({directory:join(dir,'state'),authFile:auth,codexPath:'/test/codex',CodexClass:Stub});const value=await analyze({host:'test',kind:'report_lost',source:'inventory',secret:'secret-token',logs:'private logs'});assert.equal(value.summary,'원인 불명');assert.equal(options.sandboxMode,'read-only');assert.equal(options.approvalPolicy,'never');assert.equal(options.webSearchMode,'disabled');assert.equal(config.config.features.shell_tool,false);assert.equal(config.config.features.hooks,false);assert.ok(!prompt.includes('secret-token'));assert.ok(!prompt.includes('private logs'));assert.equal(Object.keys(config.env).length,4);assert.throws(()=>validateAnalysis({summary:'x',checks:[]}));}finally{rmSync(dir,{recursive:true,force:true});}
});
