import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {createApp} from '../server/app.mjs';
import {transaction} from '../server/db.mjs';
import {createSync,streamWriter} from '../server/sync.mjs';

async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'lab-network-test-'));
  let service=createApp({dataDir:directory,mode:'demo',gpuAutoStart:false});
  let server=service.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  let base=`http://127.0.0.1:${server.address().port}`;
  const people=service.db.prepare("SELECT * FROM users ORDER BY name").all();
  const owner=people.find(p=>p.name==='지민'),member=people.find(p=>p.name==='서연'),outside=people.find(p=>p.name==='도윤');
  async function request(path,{user=owner,method='GET',body,headers={}}={}){
    let cookie=cookies.get(user.id);
    if(!cookie){const login=await fetch(base+'/api/auth/demo',{method:'POST',headers:{'X-Lab-Request':'1','Content-Type':'application/json'},body:JSON.stringify({userId:user.id})});cookie=login.headers.get('set-cookie').split(';')[0];cookies.set(user.id,cookie);}
    const response=await fetch(base+'/api'+path,{method,headers:{Cookie:cookie,'X-Lab-Request':'1',...(body&&!(body instanceof FormData)?{'Content-Type':'application/json'}:{}),...headers},body:body instanceof FormData?body:body?JSON.stringify(body):undefined});
    return {status:response.status,data:[204,304].includes(response.status)?null:await response.json(),headers:response.headers};
  }
  const cookies=new Map();
  async function restart(){
    service.close();server.closeAllConnections();await new Promise(r=>server.close(r));
    service=createApp({dataDir:directory,mode:'demo',gpuAutoStart:false});
    server=service.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;
  }
  t.after(async()=>{service.close();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(directory,{recursive:true,force:true});});
  const channel=service.db.prepare("SELECT id FROM channels WHERE name='연구실-라운지'").get().id;
  return {request,restart,get service(){return service;},directory,owner,member,outside,channel};
}

test('durable cursor recovers edits, deletions, reactions and replies across restart without exposing private changes',async t=>{
  const f=await fixture(t),q=f.request;
  const privateId=(await q('/channels',{method:'POST',body:{name:'sync-private',kind:'private',memberIds:[f.member.id]}})).data.id;
  const start=(await q('/sync')).data;
  const m=(await q(`/channels/${f.channel}/messages`,{method:'POST',body:{body:'original'}})).data;
  await q(`/messages/${m.id}`,{method:'PATCH',body:{body:'edited'}});
  await q(`/messages/${m.id}/reactions`,{method:'POST',body:{emoji:'✅'}});
  const reply=(await q(`/channels/${f.channel}/messages`,{method:'POST',body:{body:'reply',parentId:m.id}})).data;
  const deleted=(await q(`/channels/${f.channel}/messages`,{method:'POST',body:{body:'delete me'}})).data;
  await q(`/messages/${deleted.id}`,{method:'DELETE'});
  await q(`/channels/${privateId}/messages`,{method:'POST',body:{body:'private-only'}});
  await f.restart();
  const result=(await q(`/sync?cursor=${start.cursor}&channelId=${f.channel}&threadId=${m.id}`)).data;
  assert.equal(result.reset,false);assert.equal(result.users,undefined);
  assert.equal(result.messages.find(x=>x.id===m.id).body,'edited');
  assert.equal(result.messages.find(x=>x.id===m.id).reactions[0].mine,1);
  assert.equal(result.messages.find(x=>x.id===m.id).reply_count,1);
  assert.equal(result.messages.find(x=>x.id===deleted.id).deleted,1);
  assert(result.threadMessages.some(x=>x.id===reply.id));
  const outsider=(await q(`/sync?cursor=${start.cursor}&channelId=${privateId}`,{user:f.outside})).data;
  assert.equal(outsider.messages.length,0);assert(!outsider.channels.some(c=>c.id===privateId));
  const noChanges=(await q(`/sync?cursor=${result.cursor}&channelId=${f.channel}`)).data;
  assert.equal(noChanges.messages.length,0);assert.equal(noChanges.channels.length,0);
});

test('retrying text and file sends commits one message and rejects a reused key with different content',async t=>{
  const f=await fixture(t),q=f.request;
  const body={body:'one logical send',clientMessageId:'test-send-00000001'};
  const results=await Promise.all([q(`/channels/${f.channel}/messages`,{method:'POST',body}),q(`/channels/${f.channel}/messages`,{method:'POST',body})]);
  assert(results.every(r=>r.status===201));assert.equal(results[0].data.id,results[1].data.id);
  assert.equal((await q(`/channels/${f.channel}/messages`,{method:'POST',body:{...body,body:'conflicting'}})).status,409);
  await f.restart();
  assert.equal((await q(`/channels/${f.channel}/messages`,{method:'POST',body})).data.id,results[0].data.id);
  const upload=async text=>{const form=new FormData();form.set('body','attachment');form.set('clientMessageId','test-file-00000001');form.set('file',new Blob([text]),'result.txt');return q(`/channels/${f.channel}/files`,{method:'POST',body:form});};
  const first=await upload('same bytes'),second=await upload('same bytes');
  assert.equal(first.status,201);assert.equal(second.data.id,first.data.id);
  assert.equal((await upload('different bytes')).status,409);
  assert.equal((await readdir(join(f.directory,'uploads'))).length,1);
  assert.equal(f.service.db.prepare('SELECT count(*) n FROM send_requests').get().n,2);
});

test('transaction rollback leaves no phantom change; retention and malformed cursors fall back to a snapshot',async t=>{
  const f=await fixture(t),sync=createSync(f.service.db),cursor=sync.cursor();
  assert.throws(()=>transaction(f.service.db,()=>{f.service.db.prepare('UPDATE messages SET body=? WHERE id=1').run('rolled back');throw new Error('rollback');}));
  assert.equal(sync.cursor(),cursor);
  const insert=f.service.db.prepare("INSERT INTO sync_changes(kind) VALUES('user')");
  transaction(f.service.db,()=>{for(let n=0;n<20200;n++)insert.run();});
  assert(f.service.db.prepare('SELECT count(*) n FROM sync_changes').get().n<=20127);
  assert.equal(sync.read(cursor).reset,true);assert.equal(sync.read('invalid').reset,true);
  assert.equal(sync.read(sync.cursor()).reset,false);
  const current=(await f.request('/sync')).data.cursor;
  transaction(f.service.db,()=>{for(let n=0;n<501;n++)insert.run();});
  assert.equal((await f.request('/sync?cursor='+current)).data.reset,true);
});

test('membership revocation removes cached channels, and repeated read positions do not grow the journal',async t=>{
  const f=await fixture(t),q=f.request;
  const id=(await q('/channels',{method:'POST',body:{name:'revoked',kind:'private',memberIds:[f.member.id]}})).data.id;
  const before=(await q('/sync',{user:f.member})).data.cursor;
  f.service.db.prepare('DELETE FROM memberships WHERE channel_id=? AND user_id=?').run(id,f.member.id);
  const changes=(await q(`/sync?cursor=${before}&channelId=${id}`,{user:f.member})).data;
  assert(changes.removedChannelIds.includes(id));assert.equal(changes.messages.length,0);
  const until=(await q(`/channels/${f.channel}/messages`)).data.messages.at(-1).id;
  await q(`/channels/${f.channel}/read`,{method:'POST',body:{until}});
  const cursor=createSync(f.service.db).cursor();
  await q(`/channels/${f.channel}/read`,{method:'POST',body:{until}});
  assert.equal(createSync(f.service.db).cursor(),cursor);
});

test('slow streams coalesce invalidations, drain once, and disconnect at the byte limit',()=>{
  const res=new EventEmitter();Object.assign(res,{writableLength:0,destroyed:false,writableEnded:false});
  const written=[];res.write=text=>{written.push(text);return false;};res.destroy=()=>{res.destroyed=true;res.emit('close');};
  const writer=streamWriter(res);
  writer.write('first');for(let n=0;n<1000;n++)writer.write('next');
  assert.deepEqual(written,['first']);
  res.write=text=>{written.push(text);return true;};res.emit('drain');
  assert.equal(written.length,2);assert.match(written[1],/event: refresh/);
  res.writableLength=65537;writer.write('over limit');assert.equal(res.destroyed,true);
  assert.equal(res.listenerCount('drain'),0);
});

test('GPU conditional reads preserve freshness and metrics are administrator-only without user payloads',async t=>{
  const f=await fixture(t),q=f.request;
  const first=await q('/resources/gpus');
  assert.equal(first.status,200);assert(first.headers.get('etag'));
  const second=await q('/resources/gpus',{headers:{'If-None-Match':first.headers.get('etag')}});
  assert.equal(second.status,304);assert.equal(second.data,null);
  assert.equal(second.headers.get('cache-control'),'no-store');
  assert.equal((await q('/admin/metrics',{user:f.member})).status,403);
  await q('/search?q=not-a-metric-label');
  const metrics=await q('/admin/metrics');
  assert.equal(metrics.status,200);assert(metrics.data.routes.some(r=>r.route==='GET /api/search'||r.route==='GET /search'));
  assert(!JSON.stringify(metrics.data).includes('not-a-metric-label'));
  assert(metrics.data.sync.retainedChanges>0);
});
