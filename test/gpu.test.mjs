import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {createApp} from '../server/app.mjs';
import {openDatabase,createUser} from '../server/db.mjs';
import {createGpuMonitor,normalizeGpuSnapshots,gpuHttpSource} from '../server/gpu.mjs';

const epoch=1792422000000;
const raw=(now,values={})=>[{host:'test-h200',ts:now/1000,gpus:[{index:0,name:'H200',util:75,mem_total:143360,mem_used:10000,temp:50,procs:[{pid:222,user:'shared',used_mem:10000,cmd:'private command must not leave source'}],...values}]}];
function database(){const dir=mkdtempSync(join(tmpdir(),'gpu-test-')),db=openDatabase(dir);createUser(db,{email:'admin@example.test',name:'관리자',role:'admin'});return {db,dir,close(){db.close();rmSync(dir,{recursive:true,force:true});}};}

test('GPU boundary distinguishes occupancy, missing data, stale and malformed inventory',()=>{
  const one=(data)=>normalizeGpuSnapshots(data,epoch)[0];
  assert.equal(one(raw(epoch)).status,'active');
  assert.equal(one(raw(epoch,{util:0})).status,'resident');
  assert.equal(one(raw(epoch,{util:0,mem_used:0})).status,'resident');
  assert.equal(one(raw(epoch,{util:0,mem_used:0,procs:[]})).status,'idle');
  assert.equal(one(raw(epoch,{util:undefined,mem_used:0,procs:[]})).status,'unknown');
  assert.equal(one(raw(epoch,{util:0,mem_used:undefined,procs:[]})).status,'unknown');
  assert.equal(one(raw(epoch,{util:0,mem_used:0,procs:undefined})).status,'unknown');
  assert.equal(one(raw(epoch-181000)).status,'offline');
  assert.equal(one(raw(epoch+61000)).status,'unknown');
  assert.equal(one(raw(epoch)).processes[0].cmd,undefined);
  assert.throws(()=>normalizeGpuSnapshots([...raw(epoch),...raw(epoch)],epoch),/Duplicate/);
  assert.throws(()=>normalizeGpuSnapshots({error:'oops'},epoch));
});

test('confirmed changes persist exactly once, survive restart, and ignore brief idle dips',async()=>{
  const d=database();let time=epoch,values={},frozenTs=null;
  const opts={db:d.db,source:async()=>raw(frozenTs??time,values),now:()=>time,autoStart:false};
  let monitor=createGpuMonitor(opts);
  const messages=()=>d.db.prepare('SELECT body FROM messages ORDER BY id').all().map(m=>m.body);
  try{
    await monitor.poll();assert.equal(messages().length,1);
    values={util:0,mem_used:0,procs:[]};time+=15000;await monitor.poll();
    values={};time+=15000;await monitor.poll();assert.equal(messages().length,1);
    values={util:0,mem_used:0,procs:[]};time+=15000;frozenTs=time;await monitor.poll();
    time+=60000;await monitor.poll();assert.equal(messages().length,1,'repeated old sample is not confirmed availability');
    frozenTs=null;await monitor.poll();assert.equal(messages().length,2);assert.match(messages()[1],/미사용 상태가 확인/);
    await monitor.poll();assert.equal(messages().length,2);
    await monitor.stop();monitor=createGpuMonitor(opts);time+=15000;await monitor.poll();time+=60000;await monitor.poll();assert.equal(messages().length,2,'restart must not duplicate event');
    frozenTs=time-181000;await monitor.poll();time+=60000;await monitor.poll();assert.equal(messages().length,3);assert.match(messages()[2],/보고 중단/);
    frozenTs=null;values={};time+=15000;await monitor.poll();time+=60000;await monitor.poll();assert.equal(messages().length,4);assert.match(messages()[3],/복구/);
  }finally{await monitor.stop();d.close();}
});

test('source outages are deduplicated, invalidate cached availability and interrupt confirmation',async()=>{
  const d=database();let time=epoch,fail=false,values={};
  const monitor=createGpuMonitor({db:d.db,source:async()=>{if(fail)throw new Error('private origin');return raw(time,values);},now:()=>time,autoStart:false});
  const messages=()=>d.db.prepare('SELECT body FROM messages ORDER BY id').all().map(m=>m.body);
  try{
    await monitor.poll();values={util:0,mem_used:0,procs:[]};time+=15000;await monitor.poll();
    fail=true;time+=15000;await monitor.poll();await monitor.poll();assert.equal(messages().length,2);assert.equal(monitor.view().items[0].status,'unknown');assert.equal(monitor.view().summary.idle,0);
    fail=false;time+=60000;await monitor.poll();assert.equal(messages().length,3);assert.match(messages()[2],/再|다시 연결/);
    time+=60000;await monitor.poll();assert.equal(messages().length,4);assert.match(messages()[3],/미사용 상태/);
    time+=50000;assert.equal(monitor.view().connection,'error');assert.equal(monitor.view().summary.idle,0);
  }finally{await monitor.stop();d.close();}
});

test('disappearing GPUs remain unknown; private channel conflicts are never broadened',async()=>{
  const d=database();let time=epoch,empty=false;
  const {createChannel}=await import('../server/db.mjs');const admin=d.db.prepare('SELECT id FROM users').get();
  createChannel(d.db,{name:'gpu-자원',kind:'private',creator:admin.id});
  const monitor=createGpuMonitor({db:d.db,source:async()=>empty?[]:raw(time),now:()=>time,autoStart:false});
  try{await monitor.poll();assert.equal(monitor.view().channelId,null);assert.equal(d.db.prepare("SELECT kind FROM channels WHERE name='gpu-자원'").get().kind,'private');empty=true;time+=15000;await monitor.poll();assert.equal(monitor.view().items.length,1);assert.equal(monitor.view().items[0].status,'unknown');}
  finally{await monitor.stop();d.close();}
});

test('authenticated API exposes only normalized fields; bot cannot authenticate or receive DMs',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'gpu-api-'));const origin='http://127.0.0.1:4310';
  const app=createApp({dataDir:dir,origin,mode:'demo',gpuSource:async()=>raw(Date.now()),gpuAutoStart:false});
  const server=app.app.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}/api`;
  const request=async(path,body,cookie)=>fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Lab-Request':'1',Origin:origin,...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined});
  try{
    assert.equal((await request('/resources/gpus')).status,401);
    await app.gpu.poll();const config=await(await request('/auth/config')).json();assert.equal(config.demoUsers.length,3);
    const login=await request('/auth/demo',{userId:config.demoUsers[0].id});const cookie=login.headers.get('set-cookie').split(';')[0];
    const data=await(await request('/resources/gpus',null,cookie)).json();assert.equal(data.items.length,1);assert.ok(!JSON.stringify(data).includes('private command'));assert.equal(data.demo,true);
    const users=await(await request('/users',null,cookie)).json();assert.equal(users.length,3);
    const bot=app.db.prepare("SELECT id FROM users WHERE identity_provider='system'").get();
    assert.equal((await request('/auth/demo',{userId:bot.id})).status,404);
    assert.equal((await request('/dms',{userId:bot.id},cookie)).status,400);
    const alerts=await(await request(`/channels/${data.channelId}/messages`,null,cookie)).json();assert.equal(alerts.messages[0].user.role,'bot');
    app.close();const reopened=createApp({dataDir:dir,origin,mode:'demo'});reopened.close();
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));app.close();rmSync(dir,{recursive:true,force:true});}
});

test('source reader rejects redirects, excessive bodies and cancellation',async()=>{
  let mode='ok';const server=createServer((_req,res)=>{if(mode==='redirect'){res.writeHead(302,{Location:'http://example.invalid/'});res.end();}else if(mode==='large'){res.end('x'.repeat(2*1024*1024+1));}else if(mode==='hang'){}else res.end(JSON.stringify(raw(epoch)));});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const source=gpuHttpSource(`http://127.0.0.1:${server.address().port}`);
  try{assert.equal((await source())[0].host,'test-h200');mode='redirect';await assert.rejects(()=>source());mode='large';await assert.rejects(()=>source(),/too large/);mode='hang';await assert.rejects(()=>source(AbortSignal.timeout(50)));}
  finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('shutdown during an in-flight source read performs no writes after database close',async()=>{
  const d=database();let resolveSource;
  const monitor=createGpuMonitor({db:d.db,source:()=>new Promise(r=>{resolveSource=r;}),autoStart:false});
  const poll=monitor.poll();const done=monitor.stop();d.close();resolveSource(raw(epoch));await poll;await done;
});
