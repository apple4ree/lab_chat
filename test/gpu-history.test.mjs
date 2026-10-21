import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {openDatabase,transaction} from '../server/db.mjs';
import {createGpuHistory} from '../server/gpu-history.mjs';
import {createGpuMonitor,normalizeGpuSnapshots} from '../server/gpu.mjs';
import {createApp} from '../server/app.mjs';

const epoch=Date.UTC(2026,9,21,12),DAY=86400000;
const raw=(at,users=['shared','shared'],util=50)=>[{host:'test-server',ts:at/1000,gpus:[{index:0,name:'test GPU',util,mem_used:1024,mem_total:8192,procs:users.map((user,i)=>({pid:i+1,user,used_mem:512,cmd:'not-for-history'}))}]}];
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'local-gpu-history-')),db=openDatabase(dir);
  let time=epoch;const h=createGpuHistory({db,now:()=>time});
  return {db,h,dir,at:t=>{time=t;},record:(t,users,util)=>transaction(db,()=>h.record(normalizeGpuSnapshots(raw(t,users,util),time),time)),
    query:(from=epoch-60000,to=time+60000,bucket=60)=>h.get('history',{host:'test-server',gpu:0,from:from/1000,to:to/1000,bucket}),
    close(){db.close();rmSync(dir,{recursive:true,force:true});}};
}

test('local history deduplicates samples, persists averages and counts each OS user once per GPU',()=>{
  const f=fixture();try{
    f.record(epoch);f.record(epoch);
    f.at(epoch+15000);f.record(epoch+15000,undefined,100);
    assert.equal(f.query().data.length,1);assert.equal(f.query().data[0].utilization,75);
    assert.equal(f.query().data[0].memoryGiB,1);
    const shares=f.h.get('share',{days:1}).data;
    assert.equal(shares.length,1);assert.equal(shares[0].hours,15/3600);assert.equal(shares[0].percent,100);
    assert.equal(f.db.prepare('SELECT samples FROM gpu_history_buckets WHERE resolution=60000').get().samples,2);
    const restored=createGpuHistory({db:f.db,now:()=>epoch+30000});
    transaction(f.db,()=>restored.record(normalizeGpuSnapshots(raw(epoch+30000),epoch+30000),epoch+30000));
    assert.equal(restored.get('share',{days:1}).data[0].hours,15/3600,'restart gap is excluded');
    assert.equal(restored.get('targets').data[0].host,'test-server');
    assert.equal(f.db.prepare('SELECT users_json FROM gpu_history_devices').get().users_json,'["shared"]');
  }finally{f.close();}
});

test('monitor collection excludes stale data, outages, missing devices and backward reports',async()=>{
  const f=fixture();let at=epoch,report=epoch,input=()=>raw(report);
  const monitor=createGpuMonitor({db:f.db,history:f.h,source:async()=>input(),now:()=>at,autoStart:false});
  try{
    await monitor.poll();report=at+=15000;f.at(at);await monitor.poll();
    input=()=>{throw new Error('collector down');};at+=15000;f.at(at);await monitor.poll();
    report=at+=15000;f.at(at);input=()=>raw(report);await monitor.poll();
    assert.equal(f.h.get('share',{days:1}).data[0].hours,15/3600);
    input=()=>[];at+=15000;f.at(at);await monitor.poll();
    report=at+=15000;f.at(at);input=()=>raw(report);await monitor.poll();
    report=epoch;at+=15000;f.at(at);await monitor.poll();
    report=epoch-300000;at+=15000;f.at(at);await monitor.poll();
    assert.equal(f.h.get('share',{days:1}).data[0].hours,15/3600);
    assert.equal(f.db.prepare('SELECT sum(samples) n FROM gpu_history_buckets WHERE resolution=60000').get().n,4);
  }finally{await monitor.stop();f.close();}
});

test('retention keeps compact long-term buckets and splits occupancy at UTC midnight',()=>{
  const f=fixture();try{
    const midnight=Date.UTC(2026,9,22);
    f.at(midnight-15000);f.record(midnight-15000,['a','b']);
    f.at(midnight+15000);f.record(midnight+15000,['a']);
    assert.equal(f.h.get('share',{days:1}).data.find(x=>x.user==='a').hours,15/3600);
    assert.equal(f.h.get('share',{days:1}).data.find(x=>x.user==='b').hours,15/3600);
    const later=midnight+8*DAY;f.at(later);f.record(later);
    assert.equal(f.db.prepare('SELECT count(*) n FROM gpu_history_buckets WHERE resolution=60000').get().n,1);
    assert.equal(f.db.prepare('SELECT count(*) n FROM gpu_history_buckets WHERE resolution=900000').get().n,3);
    assert.equal(f.query(midnight-DAY,midnight+DAY,600).bucketMs,900000);
    f.at(midnight+100*DAY);f.record(midnight+100*DAY);
    assert.equal(f.db.prepare('SELECT count(*) n FROM gpu_history_buckets').get().n,2);
    assert.equal(f.h.get('share',{days:90}).data.length,0);
  }finally{f.close();}
});

test('authenticated local APIs serve GPU history without calling the legacy history service',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'local-gpu-api-'));let report=Date.now()-120000;
  const calls=[];
  const service=createApp({dataDir:dir,setupToken:'isolated-setup',gpuSource:async()=>raw(report),gpuAutoStart:false,
    resourceSource:{get:async kind=>{calls.push(kind);return {data:[],fetchedAt:Date.now(),demo:false};},stop(){}}});
  const server=service.app.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}/api`;
  try{
    assert.equal((await fetch(base+'/resources/targets')).status,401);
    const setup=await fetch(base+'/auth/setup',{method:'POST',headers:{'Content-Type':'application/json','X-Lab-Request':'1'},body:JSON.stringify({setupToken:'isolated-setup',email:'isolated@example.test',name:'테스트',password:'isolated-password-only'})});
    assert.equal(setup.status,201);const headers={Cookie:setup.headers.get('set-cookie').split(';')[0]};
    await service.gpu.poll();report+=15000;await service.gpu.poll();
    for(const route of ['/resources/targets','/resources/history?host=test-server&gpu=0&period=day','/resources/share?days=7']){
      const response=await fetch(base+route,{headers});assert.equal(response.status,200);
      const result=await response.json();assert.equal(result.source,'lab-chat');assert.ok(result.data.length);
      assert.ok(!JSON.stringify(result).includes('not-for-history'));
    }
    assert.deepEqual(calls,[]);
    assert.equal((await fetch(base+'/resources/quotas',{headers})).status,200);assert.deepEqual(calls,['quotas']);
    const counts=service.db.prepare('SELECT count(*) n FROM users').get().n;
    assert.equal(service.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    assert.ok(counts>=1);
  }finally{service.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
});
