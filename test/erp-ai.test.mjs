import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createErpAiSource,normalizeErpQuotas} from '../server/erp-ai.mjs';
import {createApp} from '../server/app.mjs';

const snapshot=now=>({accounts:[{id:'account-a',label:'DAMI',provider:'codex',collector:'monitor-dami',verified:true,successAt:now/1000,error:null,job:'done',plan:'pro',fiveHourUnlimited:true,windows:[{name:'codex:primary',windowMinutes:10080,usedPercent:37,resetsAt:now/1000+86400}]}],collectors:[{id:'monitor-dami',lastSeen:now/1000}],secret:'do-not-forward',history:[{private:'do-not-forward'}]});
function fixture(fetchImpl,now=Date.now){
  const dir=mkdtempSync(join(tmpdir(),'erp-ai-test-')),sessionFile=join(dir,'session.json');
  writeFileSync(sessionFile,JSON.stringify({origin:'https://erp.example.test',cookie:'session=test-session'}),{mode:0o600});
  const usageSource={calls:0,get:async()=>{usageSource.calls++;return {legacy:true};},stop(){}};
  const source=createErpAiSource({sessionFile,usageSource,fetchImpl,now});
  return {dir,sessionFile,source,usageSource,close(){source.stop();rmSync(dir,{recursive:true,force:true});}};
}

test('ERP quota windows preserve weekly-only Codex, verification, failures and staleness',()=>{
  const now=Date.now(),input=snapshot(now),account=input.accounts[0];
  let q=normalizeErpQuotas(input,now)[0];assert.equal(q.fiveHour.percent,null);assert.equal(q.fiveHourUnlimited,true);assert.equal(q.sevenDay.percent,37);assert.equal(q.servers[0].lastSeen,now);assert.equal(q.account,'DAMI');assert.equal(q.secret,undefined);
  for(const patch of [{verified:false},{error:'login_required'},{successAt:now/1000-901},{successAt:now/1000+61}]){
    q=normalizeErpQuotas({...input,accounts:[{...account,...patch}]},now)[0];assert.equal(q.sevenDay.percent,null);assert.equal(q.sevenDay.resetsAt,null);assert.equal(q.fiveHourUnlimited,false);assert.ok(q.issue);
  }
  q=normalizeErpQuotas({...input,accounts:[{...account,provider:'claude',fiveHourUnlimited:false,windows:[{name:'five_hour',usedPercent:4},{name:'seven_day',usedPercent:87}]}]},now)[0];assert.equal(q.fiveHour.percent,4);assert.equal(q.sevenDay.percent,87);
  q=normalizeErpQuotas({...input,accounts:[{...account,windows:[...account.windows,...account.windows]}]},now)[0];assert.equal(q.sevenDay.percent,null);
});

test('shared ERP reads, refresh cooldown, session rotation and expired authentication never fall back',async()=>{
  let now=Date.now(),fail=false;const calls=[];
  const f=fixture(async(url,options)=>{calls.push({path:url.pathname,...options});if(fail)return new Response('private error',{status:401});return Response.json(options.method==='POST'?{ok:true,jobs:['job-one']}:snapshot(now),{headers:{'Set-Cookie':'session=renewed; Secure; HttpOnly'}});},()=>now);
  try{
    const [a,b]=await Promise.all([f.source.get('quotas'),f.source.get('quotas')]);assert.deepEqual(a,b);assert.equal(calls.length,1);assert.equal(a.source,'erp');assert.equal(JSON.stringify(a).includes('do-not-forward'),false);
    assert.equal(JSON.parse(readFileSync(f.sessionFile)).cookie,'session=renewed');assert.equal(statSync(f.sessionFile).mode&0o777,0o600);
    await Promise.all([f.source.refreshQuotas(),f.source.refreshQuotas()]);await f.source.refreshQuotas();assert.equal(calls.filter(c=>c.method==='POST').length,1);
    const request=calls.find(c=>c.method==='POST');assert.equal(request.path,'/api/ai/refresh');assert.equal(request.headers['X-DAMI-AI'],'1');assert.equal(request.redirect,'error');assert.equal(request.headers.Cookie,'session=renewed');
    await f.source.get('quotas');assert.equal(calls.filter(c=>c.method==='GET').length,2);
    now+=6000;fail=true;await assert.rejects(f.source.get('quotas'),/인증이 만료/);assert.equal(f.usageSource.calls,0);
    assert.deepEqual(await f.source.get('usage',{}),{legacy:true});assert.equal(f.usageSource.calls,1);
  }finally{f.close();}
});

test('ERP rejects malformed/oversized data, redirects, and aborts active reads on shutdown',async()=>{
  for(const response of [()=>Response.json({}),()=>new Response('x'.repeat(2*1024*1024+1)),()=>new Response('',{status:302,headers:{Location:'https://outside.example'}})]){
    const f=fixture(async()=>response());try{await assert.rejects(f.source.get('quotas'),e=>e.status===503&&!e.message.includes('private'));}finally{f.close();}
  }
  let started;const ready=new Promise(r=>{started=r;});
  const f=fixture(async(_url,{signal})=>new Promise((_,reject)=>{signal.addEventListener('abort',()=>reject(new Error('aborted')));started();}));
  const pending=f.source.get('quotas');await ready;f.source.stop();await assert.rejects(pending,/불러오지/);f.close();
});

test('chat HTTP routes require login and CSRF; refresh reaches ERP through the GPU source wrapper',async()=>{
  let refreshes=0;const f=fixture(async(_url,options)=>{if(options.method==='POST'){refreshes++;return Response.json({ok:true,jobs:[null]});}return Response.json(snapshot(Date.now()));});
  const service=createApp({dataDir:join(f.dir,'chat'),setupToken:'setup-test-code',resourceSource:f.source,gpuAutoStart:false});
  const server=service.app.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
  try{
    const path=base+'/api/resources/quotas/refresh';assert.equal((await fetch(path,{method:'POST',headers:{'X-Lab-Request':'1'}})).status,401);
    const login=await fetch(base+'/api/auth/setup',{method:'POST',headers:{'X-Lab-Request':'1','Content-Type':'application/json'},body:JSON.stringify({setupToken:'setup-test-code',email:'test@example.test',name:'Test',password:'test-password-123'})});assert.equal(login.status,201);
    const cookie=login.headers.getSetCookie()[0].split(';')[0];assert.equal((await fetch(path,{method:'POST',headers:{Cookie:cookie}})).status,403);
    const response=await fetch(path,{method:'POST',headers:{Cookie:cookie,'X-Lab-Request':'1'}});assert.equal(response.status,202);assert.equal((await response.json()).queued,false);assert.equal(refreshes,1);
    const quota=await(await fetch(base+'/api/resources/quotas',{headers:{Cookie:cookie}})).json();assert.equal(quota.source,'erp');assert.equal(quota.data[0].sevenDay.percent,37);
  }finally{service.close();server.closeAllConnections();await new Promise(r=>server.close(r));f.close();}
});
