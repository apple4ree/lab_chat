import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server/app.mjs';
import { openDatabase } from '../server/db.mjs';
import { createBackup } from '../scripts/backup.mjs';

const directory=mkdtempSync(join(tmpdir(),'.lab-chat-test-'));
const origin='http://127.0.0.1:4310',setupToken='test-setup-token',password=' test-password-123 ';
let service,server,base,alice,bob,charlie,publicId,privateId,secretId,secretFile,dmId;
async function request(path,{method='GET',body,cookie,originHeader=origin,headers={}}={}){
  const response=await fetch(base+'/api'+path,{method,headers:{'X-Lab-Request':'1',Origin:originHeader,...(cookie?{Cookie:cookie}:{}),...(body&&!(body instanceof FormData)?{'Content-Type':'application/json'}:{}),...headers},body:body instanceof FormData?body:body?JSON.stringify(body):undefined});
  const data=response.status===204?null:await response.json();
  return {status:response.status,data,cookie:response.headers.get('set-cookie')?.split(';')[0],headers:response.headers};
}
async function invite(admin,email,name){
  const invitation=await request('/admin/invites',{method:'POST',cookie:admin.cookie,body:{email}});assert.equal(invitation.status,201);
  const invite=new URLSearchParams(new URL(invitation.data.url).hash.slice(1)).get('invite');
  const user=await request('/auth/register',{method:'POST',body:{invite,email,name,password}});assert.equal(user.status,201);
  return {...user,invite};
}
before(async()=>{
  service=createApp({dataDir:directory,origin,setupToken,distDir:join(directory,'no-dist')});
  server=service.app.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{service.close();server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(directory,{recursive:true,force:true});});

test('authentication is required and first-admin setup requires the terminal code',async()=>{
  assert.equal((await request('/channels')).status,401);
  assert.equal((await request('/auth/setup',{method:'POST',body:{setupToken:'x'.repeat(16),email:'a@example.test',name:'A',password}})).status,403);
  assert.equal((await request('/auth/setup',{method:'POST',body:{setupToken:'한'.repeat(setupToken.length),email:'a@example.test',name:'A',password}})).status,403);
  alice=await request('/auth/setup',{method:'POST',body:{setupToken,email:'alice@example.test',name:'앨리스',password}});
  assert.equal(alice.status,201);assert.equal(alice.data.role,'admin');assert.match(alice.headers.get('set-cookie'),/HttpOnly/);assert.match(alice.headers.get('set-cookie'),/SameSite=Strict/);
  assert.equal((await request('/auth/config')).data.needsSetup,false);
  assert.equal((await request('/auth/setup',{method:'POST',body:{setupToken,email:'b@example.test',name:'B',password}})).status,409);
});
test('invitations are email-bound, single use, and admin-only',async()=>{
  bob=await invite(alice,'bob@example.test','보라');charlie=await invite(alice,'charlie@example.test','찬우');
  assert.equal((await request('/auth/register',{method:'POST',body:{invite:bob.invite,email:'bob2@example.test',name:'보라2',password}})).status,403);
  assert.equal((await request('/admin/invites',{method:'POST',cookie:bob.cookie,body:{}})).status,403);
  const i=await request('/admin/invites',{method:'POST',cookie:alice.cookie,body:{email:'bound@example.test'}});
  const code=new URLSearchParams(new URL(i.data.url).hash.slice(1)).get('invite');
  assert.equal((await request('/auth/register',{method:'POST',body:{invite:code,email:'wrong@example.test',name:'Wrong',password}})).status,403);
  const rows=service.db.prepare('SELECT * FROM sessions').all();assert.ok(rows.every(s=>!s.token_hash.includes(alice.cookie.split('=')[1])));
  const user=service.db.prepare('SELECT * FROM users WHERE id=?').get(alice.data.id);assert.ok(user.password_hash.startsWith('scrypt:'));assert.ok(!user.password_hash.includes(password));
});
test('password verification preserves whitespace and rejects forged browser origins',async()=>{
  assert.equal((await request('/auth/login',{method:'POST',body:{email:'alice@example.test',password:'wrong-password'}})).status,401);
  const login=await request('/auth/login',{method:'POST',body:{email:'ALICE@example.test',password}});assert.equal(login.status,200);
  assert.equal((await request('/channels',{method:'POST',cookie:alice.cookie,originHeader:'https://evil.example',body:{name:'evil'}})).status,403);
  assert.equal((await request('/channels',{method:'POST',cookie:alice.cookie,headers:{'X-Lab-Request':''},body:{name:'evil'}})).status,403);
  assert.equal((await request('/auth/demo',{method:'POST',body:{userId:alice.data.id}})).status,404);
});
test('public/private channels and DMs have server-enforced membership',async()=>{
  const channels=await request('/channels',{cookie:alice.cookie});publicId=channels.data[0].id;assert.equal(channels.data.length,2);
  const channel=await request('/channels',{method:'POST',cookie:alice.cookie,body:{name:'비공개-실험',kind:'private',memberIds:[bob.data.id]}});assert.equal(channel.status,201);privateId=channel.data.id;
  const otherChannels=await request('/channels',{cookie:charlie.cookie});assert.ok(!otherChannels.data.some(c=>c.id===privateId));
  assert.equal((await request(`/channels/${privateId}/messages`,{cookie:charlie.cookie})).status,404);
  assert.equal((await request(`/channels/${privateId}/messages`,{method:'POST',cookie:charlie.cookie,body:{body:'침입'}})).status,404);
  const dm=await request('/dms',{method:'POST',cookie:alice.cookie,body:{userId:bob.data.id}});dmId=dm.data.id;
  assert.equal((await request('/dms',{method:'POST',cookie:bob.cookie,body:{userId:alice.data.id}})).data.id,dmId);
  assert.equal((await request(`/channels/${dmId}/messages`,{cookie:charlie.cookie})).status,404);
  assert.equal((await request(`/channels/${privateId}/members`,{method:'POST',cookie:bob.cookie,body:{userId:charlie.data.id}})).status,403);
});
test('message creation, threads, mentions, unread counts and access-filtered search work',async()=>{
  const message=await request(`/channels/${privateId}/messages`,{method:'POST',cookie:alice.cookie,body:{body:`비밀실험 100% 완료 @${bob.data.handle}`}});assert.equal(message.status,201);secretId=message.data.id;
  const reply=await request(`/channels/${privateId}/messages`,{method:'POST',cookie:bob.cookie,body:{body:'재현 결과를 확인했습니다.',parentId:secretId}});assert.equal(reply.status,201);
  assert.equal((await request(`/messages/${secretId}/replies`,{cookie:bob.cookie})).data.messages[0].parent_id,secretId);
  assert.equal((await request(`/channels/${publicId}/messages`,{method:'POST',cookie:alice.cookie,body:{body:'잘못된 스레드',parentId:secretId}})).status,400);
  assert.equal((await request(`/channels/${privateId}/messages`,{method:'POST',cookie:alice.cookie,body:{body:'중첩 답글',parentId:reply.data.id}})).status,400);
  assert.equal((await request('/search?q=비밀실험',{cookie:bob.cookie})).data.messages.length,1);
  assert.equal((await request('/search?q=비밀실험',{cookie:charlie.cookie})).data.messages.length,0);
  assert.equal((await request('/search?q=%25',{cookie:alice.cookie})).data.messages.length,1);
  const channel=(await request('/channels',{cookie:bob.cookie})).data.find(c=>c.id===privateId);assert.equal(channel.unread,1);assert.equal(channel.mentions,1);
  assert.equal((await request('/mentions',{cookie:bob.cookie})).data[0].id,secretId);
  await request(`/channels/${privateId}/read`,{method:'POST',cookie:bob.cookie,body:{until:reply.data.id}});
  assert.equal((await request('/channels',{cookie:bob.cookie})).data.find(c=>c.id===privateId).unread,0);
});
test('file uploads preserve names, require channel permission, and download as attachments',async()=>{
  const data=new FormData();data.set('file',new Blob(['research-results'],{type:'text/plain'}),'실험-결과.txt');data.set('body','첨부 실험 결과');
  const upload=await request(`/channels/${privateId}/files`,{method:'POST',cookie:alice.cookie,body:data});assert.equal(upload.status,201);
  const file=upload.data.files[0];secretFile={...file,messageId:upload.data.id};assert.equal(file.name,'실험-결과.txt');
  const allowed=await fetch(base+`/api/files/${file.id}`,{headers:{Cookie:bob.cookie}});assert.equal(allowed.status,200);assert.match(allowed.headers.get('content-disposition'),/^attachment;/);assert.equal(await allowed.text(),'research-results');
  assert.equal((await request(`/files/${file.id}`,{cookie:charlie.cookie})).status,404);
  assert.equal((await request('/search?q=실험-결과.txt',{cookie:bob.cookie})).data.messages.length,1);
  assert.equal((await request('/search?q=실험-결과.txt',{cookie:charlie.cookie})).data.messages.length,0);
  const before=readdirSync(join(directory,'uploads')).length;
  const invalid=new FormData();invalid.set('file',new Blob(['bad']),'bad.txt');invalid.set('parentId','999999');
  assert.equal((await request(`/channels/${privateId}/files`,{method:'POST',cookie:alice.cookie,body:invalid})).status,404);
  assert.equal(readdirSync(join(directory,'uploads')).length,before);
});
test('preview enforces file membership, isolation, PDF bytes/ranges, and deletion',async()=>{
  const uploadFile=async(name,content)=>{
    const form=new FormData();form.set('file',new Blob([content]),name);
    const result=await request(`/channels/${privateId}/files`,{method:'POST',cookie:alice.cookie,body:form});assert.equal(result.status,201);return result.data;
  };
  const html=await uploadFile('보고서.HTML','<h1>연구 결과</h1><script>parent.pwned=true</script>');
  const file=html.files[0];assert.equal(file.previewKind,'html');
  const url=base+`/api/files/${file.id}/preview`;
  assert.equal((await fetch(url)).status,401);
  assert.equal((await fetch(url,{headers:{Cookie:charlie.cookie}})).status,404);
  const response=await fetch(url,{headers:{Cookie:bob.cookie}});
  assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/^text\/html/);
  assert.match(response.headers.get('content-disposition'),/^inline;/);
  assert.match(response.headers.get('content-security-policy'),/^sandbox; default-src 'none'/);
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.match(await response.text(),/연구 결과/);
  assert.equal((await fetch(url,{method:'HEAD',headers:{Cookie:bob.cookie}})).status,200);
  const pdf=await uploadFile('report.pdf','%PDF-1.4\nPDF test bytes');assert.equal(pdf.files[0].previewKind,'pdf');
  const range=await fetch(base+`/api/files/${pdf.files[0].id}/preview`,{headers:{Cookie:bob.cookie,Range:'bytes=0-4'}});
  assert.equal(range.status,206);assert.equal(range.headers.get('content-type'),'application/pdf');assert.equal(await range.text(),'%PDF-');
  for(const [name,content] of [['fake.pdf','<script>bad()</script>'],['report.svg','<svg/>'],['report.txt','text']]){
    const uploaded=await uploadFile(name,content);
    assert.equal((await fetch(base+`/api/files/${uploaded.files[0].id}/preview`,{headers:{Cookie:alice.cookie}})).status,415);
    const original=await fetch(base+`/api/files/${uploaded.files[0].id}`,{headers:{Cookie:alice.cookie}});assert.equal(original.status,200);assert.match(original.headers.get('content-disposition'),/^attachment;/);
  }
  await request(`/messages/${html.id}`,{method:'DELETE',cookie:alice.cookie});
  assert.equal((await fetch(url,{headers:{Cookie:alice.cookie}})).status,404);
});
test('edits, reaction toggles and pins enforce ownership and membership',async()=>{
  assert.equal((await request(`/messages/${secretId}`,{method:'PATCH',cookie:bob.cookie,body:{body:'unauthorized'}})).status,403);
  assert.equal((await request(`/messages/${secretId}/pin`,{method:'POST',cookie:charlie.cookie,body:{}})).status,404);
  await request(`/messages/${secretId}/reactions`,{method:'POST',cookie:bob.cookie,body:{emoji:'👍'}});
  assert.equal((await request(`/messages/${secretId}`,{cookie:bob.cookie})).data.reactions[0].mine,1);
  await request(`/messages/${secretId}/reactions`,{method:'POST',cookie:bob.cookie,body:{emoji:'👍'}});
  assert.equal((await request(`/messages/${secretId}`,{cookie:bob.cookie})).data.reactions.length,0);
  await request(`/messages/${secretId}/pin`,{method:'POST',cookie:alice.cookie,body:{}});
  assert.equal((await request(`/channels/${privateId}/pins`,{cookie:bob.cookie})).data[0].id,secretId);
  await request(`/messages/${secretId}`,{method:'PATCH',cookie:alice.cookie,body:{body:'수정된 비밀실험'}});
  assert.equal((await request('/mentions',{cookie:bob.cookie})).data.length,0);
});
test('SSE delivers updates to members and never broadcasts private channel identifiers to outsiders',async()=>{
  const abort=new AbortController();const timeout=setTimeout(()=>abort.abort(),5000);
  try{
    const stream=await fetch(base+'/api/events',{headers:{Cookie:charlie.cookie},signal:abort.signal});assert.equal(stream.status,200);
    const reader=stream.body.getReader();const first=await reader.read();assert.match(new TextDecoder().decode(first.value),/event: ready/);
    await request(`/channels/${privateId}/messages`,{method:'POST',cookie:alice.cookie,body:{body:'private event'}});
    await request(`/channels/${publicId}/messages`,{method:'POST',cookie:alice.cookie,body:{body:'public event'}});
    const chunk=new TextDecoder().decode((await reader.read()).value);assert.ok(chunk.includes(publicId));assert.ok(!chunk.includes(privateId));
    await reader.cancel();
  }finally{clearTimeout(timeout);abort.abort();}
});
test('history pagination returns the entire conversation without duplicate rows',async()=>{
  for(let i=0;i<83;i++)assert.equal((await request(`/channels/${publicId}/messages`,{method:'POST',cookie:alice.cookie,body:{body:`페이지 실험 ${i}`}})).status,201);
  const first=(await request(`/channels/${publicId}/messages`,{cookie:bob.cookie})).data;assert.equal(first.messages.length,80);assert.equal(first.hasMore,true);
  const second=(await request(`/channels/${publicId}/messages?before=${first.messages[0].id}`,{cookie:bob.cookie})).data;assert.equal(second.hasMore,false);
  assert.equal(new Set([...first.messages,...second.messages].map(m=>m.id)).size,84);
  const found=(await request('/search?q=페이지',{cookie:bob.cookie})).data;assert.equal(found.messages.length,80);assert.equal(found.hasMore,true);
});
test('deleted messages and attachments disappear from access and search while replies remain',async()=>{
  await request(`/messages/${secretFile.messageId}`,{method:'DELETE',cookie:alice.cookie});
  assert.equal((await request(`/files/${secretFile.id}`,{cookie:bob.cookie})).status,404);
  assert.equal((await request('/search?q=실험-결과.txt',{cookie:bob.cookie})).data.messages.length,0);
  await request(`/messages/${secretId}`,{method:'DELETE',cookie:alice.cookie});
  assert.equal((await request(`/messages/${secretId}`,{cookie:bob.cookie})).data.deleted,1);
  assert.equal((await request(`/messages/${secretId}/replies`,{cookie:bob.cookie})).data.messages.length,1);
});
test('a second connection sees durable messages, memberships and attachments',()=>{
  const reopened=openDatabase(directory);
  assert.equal(reopened.prepare('SELECT count(*) AS n FROM users').get().n,3);
  assert.equal(reopened.prepare('SELECT count(*) AS n FROM messages WHERE channel_id=?').get(publicId).n,84);
  assert.deepEqual(reopened.prepare('SELECT * FROM files ORDER BY id').all(),service.db.prepare('SELECT * FROM files ORDER BY id').all());reopened.close();
});
test('password change revokes older sessions; logout and invitation expiry are enforced',async()=>{
  const passwordChange=await request('/auth/password',{method:'POST',cookie:bob.cookie,body:{currentPassword:password,password:'new-test-password-123'}});assert.equal(passwordChange.status,204);
  assert.equal((await request('/me',{cookie:bob.cookie})).status,401);
  assert.equal((await request('/me',{cookie:passwordChange.cookie})).status,200);
  await request('/auth/logout',{method:'POST',cookie:passwordChange.cookie,body:{}});
  assert.equal((await request('/me',{cookie:passwordChange.cookie})).status,401);
  const invitation=await request('/admin/invites',{method:'POST',cookie:alice.cookie,body:{}});
  const expiredCode=new URLSearchParams(new URL(invitation.data.url).hash.slice(1)).get('invite');
  service.db.prepare('UPDATE invites SET expires_at=0 WHERE used_at IS NULL').run();
  assert.equal((await request('/auth/register',{method:'POST',body:{invite:expiredCode,email:'expired@example.test',name:'Expired',password}})).status,403);
  assert.equal((await request('/admin/overview',{cookie:charlie.cookie})).status,403);
  const overview=await request('/admin/overview',{cookie:alice.cookie});assert.equal(overview.status,200);assert.equal(overview.data.users,3);assert.ok(overview.data.audit.length>0);
});
test('backup snapshot reopens with all accounts, messages and byte-identical attachments',async()=>{
  const destination=join(directory,'snapshot');
  const summary=await createBackup(directory,destination);assert.equal(summary.users,3);assert.equal(summary.files,service.db.prepare('SELECT count(*) AS n FROM files').get().n);
  const manifest=JSON.parse(readFileSync(join(destination,'backup-manifest.json'),'utf8'));
  const restored=openDatabase(destination);assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  assert.equal(restored.prepare('SELECT count(*) AS n FROM messages').get().n,manifest.messages);
  assert.equal(restored.prepare('SELECT count(*) AS n FROM users').get().n,manifest.users);restored.close();
  for(const file of manifest.files)assert.deepEqual(readFileSync(join(destination,'uploads',file.name)),readFileSync(join(directory,'uploads',file.name)));
  await assert.rejects(()=>createBackup(directory,destination),/EEXIST/);
});
test('demo mode cannot reuse a real-account data directory',()=>{
  assert.throws(()=>createApp({dataDir:directory,mode:'demo'}),/separate data directories/);
});
test('oversized uploads are rejected and leave no orphan file',async()=>{
  const before=readdirSync(join(directory,'uploads')).length;
  const data=new FormData();data.set('file',new Blob([new Uint8Array(20*1024*1024+1)]),'too-large.bin');
  const response=await request(`/channels/${privateId}/files`,{method:'POST',cookie:alice.cookie,body:data});assert.equal(response.status,400);
  assert.equal(readdirSync(join(directory,'uploads')).length,before);
});
