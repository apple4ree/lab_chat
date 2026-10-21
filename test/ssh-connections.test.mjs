import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {openDatabase,createUser} from '../server/db.mjs';
import {createApp} from '../server/app.mjs';
import {createSshConnections,sshSnapshotScript,parseSshSnapshot} from '../server/ssh-connections.mjs';
import {createSshPlanner} from '../server/ssh-planner.mjs';
import {createSshVault} from '../server/ssh-vault.mjs';
import {validateEndpoint,validateCredential,runSshProcess} from '../server/ssh-transport.mjs';
import {createBackup} from '../scripts/backup.mjs';
const secret='test-password-never-in-model';
const target={address:'node.example.test',ip:'127.0.0.1',port:22,username:'researcher',key:'ssh-ed25519 AAAA',fingerprint:'SHA256:test'};
const snapshot=(time=Date.now(),hostname='test-node')=>JSON.stringify({platform:'Linux',python:[3,12,0],sample:{version:1,reportedAt:time,hostname,scope:'host',cpu:{logicalCores:32,model:'CPU'},memory:{totalBytes:1024**3,availableBytes:512*1024**2},disks:[]},gpu:{state:'ok',items:[{index:0,name:'GPU',mem_total:1024,mem_used:10,util:3,temp:40,procs:[]}]}});
const plan=async()=>({intervalSeconds:30,collectGpu:true,summary:'Linux CPU·RAM·GPU 수집'});
function setup(options={}){
  const dir=mkdtempSync(join(tmpdir(),'ssh-service-')),db=openDatabase(dir),admin=createUser(db,{email:'admin@test.invalid',name:'admin',role:'admin'}),member=createUser(db,{email:'member@test.invalid',name:'member'});
  db.prepare('INSERT INTO server_catalog(host,label,created_at,updated_at) VALUES(?,?,?,?)').run('node','node',Date.now(),Date.now());
  const service=createSshConnections({db,dataDir:dir,planner:plan,scan:async()=>target,execute:async()=>snapshot(),...options});
  return {dir,db,admin,member,service,async close(){service.stop();await service.settle();db.close();rmSync(dir,{recursive:true,force:true});}};
}
async function start(f,id=f.admin.id){const ticket=await f.service.inspect(id,{host:'node',...target});return f.service.connect(id,{host:'node',ticket:ticket.ticket,trustHostKey:true,credential:{type:'password',password:secret}});}
test('SSH onboarding verifies a second sample, encrypts credentials, feeds both monitors and survives restart/backup',async()=>{
  let time=Date.now(),calls=0,failed=false,facts;
  const f=setup({now:()=>time,planner:async value=>{facts=value;return plan();},execute:async(t,c)=>{calls++;assert.equal(c.password,secret);if(failed)throw new Error(secret);return snapshot(time);}});
  try{
    const begin=await start(f);assert.equal(begin.status,'probing');await f.service.settle();assert.equal(calls,2);
    const view=f.service.view(f.admin.id),row=f.db.prepare('SELECT * FROM server_ssh_connections').get();assert.equal(view.connections[0].status,'connected');assert.ok(!JSON.stringify(view).includes(secret));assert.ok(!JSON.stringify(facts).includes(secret));assert.ok(!JSON.stringify(facts).includes(target.username));assert.ok(!JSON.stringify(row).includes(secret));assert.equal(statSync(join(f.dir,'secrets/ssh-master.key')).mode&0o777,0o600);
    const base=Object.assign(async()=>[{host:'legacy',sample:JSON.parse(snapshot(time)).sample}],{hosts:['legacy'],catalog:[]});
    const merged=f.service.mergeSources(base,async()=>[{host:'legacy',ts:time/1000,gpus:[]}]);
    assert.deepEqual(merged.serverSource.hosts,['legacy','node']);assert.equal((await merged.serverSource())[1].sample.hostname,'test-node');assert.equal(calls,2,'first verified sample reused within interval');assert.equal((await merged.gpuSource())[1].gpus[0].mem_used,10);
    time+=31000;failed=true;assert.equal((await merged.serverSource())[1].error,true);assert.equal((await merged.gpuSource())[1].ts,0);assert.ok(!JSON.stringify(f.service.view(f.admin.id)).includes(secret));
    const backup=join(f.dir,'backup');await createBackup(f.dir,backup);assert.equal(statSync(join(backup,'secrets/ssh-master.key')).mode&0o777,0o600);
    assert.equal(createSshVault(backup,()=>true).open(row.id,row.credential).password,secret);
    f.service.stop();await f.service.settle();failed=false;time+=31000;
    const resumed=createSshConnections({db:f.db,dataDir:f.dir,planner:plan,now:()=>time,execute:async()=>snapshot(time)});try{assert.equal((await resumed.collect())[0].sample.hostname,'test-node');}finally{resumed.stop();}
  }finally{await f.close();}
});
test('role revocation between probe and planning prevents further work; cancellation and close prevent late DB writes',async()=>{
  let finish,calls=0;const f=setup({execute:()=>{calls++;return new Promise(r=>finish=r);}});
  try{
    f.db.prepare('INSERT INTO server_managers VALUES(?)').run(f.member.id);await start(f,f.member.id);await new Promise(r=>setImmediate(r));f.db.prepare('DELETE FROM server_managers WHERE user_id=?').run(f.member.id);finish(snapshot());await f.service.settle();assert.equal(calls,1);assert.equal(f.db.prepare('SELECT credential FROM server_ssh_connections').get().credential,null);assert.match(f.service.view(f.admin.id).connections[0].error,/권한/);
    await start(f);await new Promise(r=>setImmediate(r));f.service.disconnect(f.admin.id,'node');finish(snapshot());await f.service.settle();assert.equal(f.service.view(f.admin.id).connections[0].status,'disabled');
    await start(f);await new Promise(r=>setImmediate(r));f.service.stop();f.db.close();finish(snapshot());await f.service.settle();
  }finally{f.service.stop();try{f.db.close();}catch{}rmSync(f.dir,{recursive:true,force:true});}
});
test('tickets bind actor, host, expiry and explicit trust; duplicate requests and mismatched host identity fail closed',async()=>{
  let time=Date.now(),calls=0;const f=setup({now:()=>time,execute:async()=>snapshot(time,++calls===1?'first':'changed')});
  try{
    const body={host:'node',...target},ticket=await f.service.inspect(f.admin.id,body);
    f.db.prepare('INSERT INTO server_managers VALUES(?)').run(f.member.id);
    assert.throws(()=>f.service.connect(f.member.id,{host:'node',ticket:ticket.ticket,trustHostKey:true}),{status:409});
    assert.throws(()=>f.service.connect(f.admin.id,{host:'node',ticket:ticket.ticket,trustHostKey:false}),{status:409});
    time+=300001;assert.throws(()=>f.service.connect(f.admin.id,{host:'node',ticket:ticket.ticket,trustHostKey:true}),{status:409});
    const started=await start(f);assert.equal(started.status,'probing');await f.service.settle();assert.equal(f.service.view(f.admin.id).connections[0].status,'failed');assert.match(f.service.view(f.admin.id).connections[0].error,/호스트명/);
    const row=f.db.prepare('SELECT * FROM server_ssh_connections').get();assert.equal(row.credential,null);
    assert.throws(()=>parseSshSnapshot(snapshot(time-180000),'node',null,time));assert.throws(()=>parseSshSnapshot('not-json','node',null,time));
    f.db.prepare("UPDATE server_ssh_connections SET status='planning'").run();const restarted=createSshConnections({db:f.db,dataDir:f.dir});assert.equal(restarted.view(f.admin.id).connections[0].status,'failed');assert.match(restarted.view(f.admin.id).connections[0].error,/재시작/);restarted.stop();
  }finally{await f.close();}
});
test('vault rejects tampering, cross-connection ciphertext and missing key; endpoints reject command injection',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ssh-vault-'));
  try{
    const vault=createSshVault(dir,()=>false),cipher=vault.seal('one',{password:secret});assert.equal(vault.open('one',cipher).password,secret);assert.throws(()=>vault.open('two',cipher));const data=Buffer.from(cipher,'base64');data[30]^=1;assert.throws(()=>vault.open('one',data.toString('base64')));
    rmSync(join(dir,'secrets/ssh-master.key'));assert.throws(()=>createSshVault(dir,()=>true),/missing/);
    for(const address of ['-oProxyCommand=cat','$(touch /tmp/x)','host;id','https://host','user@host','host\nname'])assert.throws(()=>validateEndpoint({...target,address}));
    assert.throws(()=>validateEndpoint({...target,username:'root;id'}));assert.throws(()=>validateCredential({type:'password',password:'two\nlines'}));assert.equal(validateEndpoint({...target,address:'::1'}).address,'::1');
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('one failed or malformed legacy GPU provider does not hide verified SSH GPU measurements',async()=>{
  const f=setup();try{
    await start(f);await f.service.settle();
    for(const source of [async()=>{throw new Error('legacy outage');},async()=>({invalid:true})]){
      const merged=f.service.mergeSources(null,source),values=await merged.gpuSource();assert.equal(values.length,1);assert.equal(values[0].host,'node');assert.ok(values[0].ts>0);
      f.service.disconnect(f.admin.id,'node');await assert.rejects(merged.gpuSource());await start(f);await f.service.settle();
    }
  }finally{await f.close();}
});
test('real bounded process runner executes read-only snapshot, terminates on size/timeout and handles missing executable',async()=>{
  const value=parseSshSnapshot(await runSshProcess('/usr/bin/python3',['-'],{input:sshSnapshotScript(false)}),'local');assert.ok(value.sample.memory.totalBytes>0);assert.equal(value.facts.gpuState,'disabled');
  await assert.rejects(runSshProcess('/usr/bin/python3',['-c','print("x"*10000)'],{maxBytes:100}),{sshCode:'output_limit'});
  await assert.rejects(runSshProcess('/usr/bin/python3',['-c','import time; time.sleep(30)'],{timeoutMs:50}),{sshCode:'timeout'});
  await assert.rejects(runSshProcess('/does/not/exist',[]),{sshCode:'ssh_unavailable'});
});
test('setup SDK has isolated read-only scope, schema checks and no credential fields',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ssh-plan-'));let config,options,prompt,bad=false;
  writeFileSync(join(dir,'auth.json'),'{}');
  class Stub{constructor(c){config=c;}startThread(o){options=o;return {async run(p){prompt=p;return {items:bad?[{type:'command_execution'}]:[],finalResponse:JSON.stringify({supported:true,intervalSeconds:30,collectGpu:true,summary:'관측 기반 수집'})};}};}}
  try{const planner=createSshPlanner({directory:join(dir,'state'),authFile:join(dir,'auth.json'),codexPath:'/codex',CodexClass:Stub});await planner({platform:'Linux',python:[3,12,0],scope:'host',logicalCores:32,gpuState:'ok',gpuCount:1,password:secret,username:'private-user'});assert.ok(!prompt.includes(secret));assert.ok(!prompt.includes('private-user'));assert.equal(options.sandboxMode,'read-only');assert.equal(config.config.features.shell_tool,false);assert.match(config.config.model_instructions_file,/ssh-plan-instructions/);bad=true;await assert.rejects(planner({platform:'Linux',python:[3,12,0]}),/Unexpected tool/);}finally{rmSync(dir,{recursive:true,force:true});}
});
test('HTTP SSH endpoints require authentication, manager permission and CSRF; responses never echo submitted secrets',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ssh-api-')),origin='http://127.0.0.1:4310',app=createApp({dataDir:dir,mode:'demo',origin,gpuAutoStart:false,sshOptions:{planner:plan,scan:async()=>target,execute:async()=>snapshot()}}),server=app.app.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}/api`,request=(path,cookie,body,csrf=true)=>fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(csrf?{'X-Lab-Request':'1',Origin:origin}:{}),...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined});
  try{
    assert.equal((await request('/resources/ssh')).status,401);
    const admin=app.db.prepare("SELECT * FROM users WHERE role='admin'").get(),member=app.db.prepare("SELECT * FROM users WHERE role='member'").get();
    const ac=(await request('/auth/demo',null,{userId:admin.id})).headers.get('set-cookie').split(';')[0],mc=(await request('/auth/demo',null,{userId:member.id})).headers.get('set-cookie').split(';')[0];
    assert.equal((await request('/resources/ssh',mc)).status,403);assert.equal((await request('/resources/ssh/scan',ac,{host:'node',...target},false)).status,403);
    app.catalog.registerServer(admin,{host:'node',label:'Node',hosting:'local'});
    const ticket=await(await request('/resources/ssh/scan',ac,{host:'node',...target})).json();const connected=await request('/resources/ssh/connect',ac,{host:'node',ticket:ticket.ticket,trustHostKey:true,credential:{type:'password',password:secret}});assert.equal(connected.status,202);assert.ok(!(await connected.text()).includes(secret));await app.ssh.settle();await app.servers.poll();await app.gpu.poll();
    const view=await(await request('/resources/servers',ac)).json();assert.equal(view.items.find(x=>x.host==='node').sample.memory.availableBytes,512*1024**2);assert.equal(view.items.find(x=>x.host==='node').gpus[0].memoryFreeMiB,1014);
    assert.equal((await request('/resources/ssh/node/disconnect',mc,{})).status,403);const disconnect=await request('/resources/ssh/node/disconnect',ac,{});assert.equal(disconnect.status,200);assert.equal(app.db.prepare('SELECT credential FROM server_ssh_connections').get().credential,null);
  }finally{app.close();server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});}
});
