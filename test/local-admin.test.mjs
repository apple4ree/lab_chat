import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createApp} from '../server/app.mjs';
import {provisionLocalAdmin} from '../server/local-admin.mjs';

test('operator-created login names preserve existing users, support admin login and cannot self-escalate',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'lab-admin-')),origin='http://127.0.0.1:4310';
  const service=createApp({dataDir:dir,origin,setupToken:'local-admin-test-code'});
  const server=service.app.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${server.address().port}/api`;
  async function request(path,body,cookie){return fetch(url+path,{method:body?'POST':'GET',headers:{Origin:origin,'X-Lab-Request':'1','Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined});}
  try{
    const setup=await request('/auth/setup',{setupToken:'local-admin-test-code',email:'original@example.test',name:'Original',password:'original-password'});assert.equal(setup.status,201);const original=await setup.json();
    const oldHash=service.db.prepare('SELECT password_hash FROM users WHERE id=?').get(original.id).password_hash;
    const admin=await provisionLocalAdmin(service.db,{username:'labadmin',name:'테스트 교수',password:'admin123!'});assert.equal(admin.created,true);
    assert.equal(service.db.prepare('SELECT name FROM users WHERE id=?').get(admin.id).name,'테스트 교수');
    await assert.rejects(()=>provisionLocalAdmin(service.db,{username:'labadmin',name:'다른 사용자',password:'admin123!'}),/already exists/);
    assert.equal((await provisionLocalAdmin(service.db,{username:'LABADMIN',password:'admin123!'})).created,false);
    await assert.rejects(()=>provisionLocalAdmin(service.db,{username:'labadmin',password:'different-password'}),/already exists/);
    assert.equal(service.db.prepare('SELECT password_hash FROM users WHERE id=?').get(original.id).password_hash,oldHash);
    assert.equal(service.db.prepare('SELECT count(*) n FROM memberships WHERE user_id=?').get(admin.id).n,2);
    assert.equal((await request('/auth/login',{login:'labadmin',password:'wrong-password',role:'admin'})).status,401);
    const login=await request('/auth/login',{login:'LABADMIN',password:'admin123!'});assert.equal(login.status,200);assert.equal((await login.json()).role,'admin');const cookie=login.headers.get('set-cookie').split(';')[0];
    assert.equal((await request('/admin/overview',null,cookie)).status,200);
    assert.equal((await request('/auth/login',{email:'original@example.test',password:'original-password'})).status,200);
    assert.equal((await request('/auth/login',{login:'Original',password:'original-password'})).status,401,'display name must not become an implicit login name');
    const invitation=await request('/admin/invites',{email:'member@example.test'},cookie);const inviteUrl=(await invitation.json()).url;const invite=new URLSearchParams(new URL(inviteUrl).hash.slice(1)).get('invite');
    const member=await request('/auth/register',{invite,email:'member@example.test',name:'Member',password:'member-password',role:'admin',login:'another-admin'});assert.equal((await member.json()).role,'member');
    assert.equal((await request('/admin/overview',null,member.headers.get('set-cookie').split(';')[0])).status,403);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));service.close();rmSync(dir,{recursive:true,force:true});}
});
