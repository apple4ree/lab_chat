import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once,EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {createApp} from '../server/app.mjs';
import {domainOrigin,probeDomain,publicIPv4} from '../server/domains.mjs';

const origin='https://old.example.org',target='https://new.example.org',password='test-password-123';
async function fixture(t){
  const directory=mkdtempSync(join(tmpdir(),'lab-domain-'));let remote,probes=0;
  const service=createApp({dataDir:directory,origin,setupToken:'setup',gpuAutoStart:false,distDir:join(directory,'none'),domainProbe:async()=>{probes++;return remote||service.db.prepare("SELECT value FROM app_meta WHERE key='workspace_domains'").get()&&JSON.parse(service.db.prepare("SELECT value FROM app_meta WHERE key='workspace_domains'").get().value);}});
  const server=service.app.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));service.close();rmSync(directory,{recursive:true,force:true});});
  async function request(path,{body,cookie,source=origin}={}){const r=await fetch(base+'/api'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Lab-Request':'1',Origin:source,...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
  const admin=await request('/auth/setup',{body:{setupToken:'setup',email:'admin@example.org',name:'Admin',password}});assert.equal(admin.status,201);
  return {service,request,admin,remote:value=>{remote=value;},probes:()=>probes};
}
test('admin verifies, confirms, changes and restores a domain; cookies are not transferred, invites and CSRF follow approved origins',async t=>{
  const {request,admin,service,probes}=await fixture(t);
  const initial=await request('/workspace/connection');assert.equal(initial.status,200);assert.deepEqual(Object.keys(initial.data).sort(),['canonicalOrigin','revision','workspaceId']);
  assert.equal((await request('/admin/domain')).status,401);
  assert.equal((await request('/admin/invites',{cookie:admin.cookie,source:target,body:{}})).status,403);
  const verified=await request('/admin/domain/verify',{cookie:admin.cookie,body:{origin:target}});assert.equal(verified.status,200);assert.ok(verified.data.receipt);
  assert.equal((await request('/workspace/connection')).data.canonicalOrigin,origin);
  assert.equal((await request('/admin/domain',{cookie:admin.cookie})).data.receipt,undefined);
  const body={receipt:verified.data.receipt,confirmOrigin:target,keepOldDomain:true,password};
  assert.equal((await request('/admin/domain/activate',{cookie:admin.cookie,body:{...body,password:'incorrect'}})).status,403);
  assert.equal((await request('/admin/domain/activate',{cookie:admin.cookie,body:{...body,keepOldDomain:false}})).status,400);
  const changed=await request('/admin/domain/activate',{cookie:admin.cookie,body});assert.equal(changed.status,200);assert.equal(changed.data.canonicalOrigin,target);assert.equal(probes(),2);
  assert.equal((await request('/admin/domain/activate',{cookie:admin.cookie,body})).status,409);
  const invitation=await request('/admin/invites',{cookie:admin.cookie,source:target,body:{}});assert.equal(invitation.status,201);assert.ok(invitation.data.url.startsWith(target));
  assert.equal((await request('/admin/invites',{cookie:admin.cookie,source:origin,body:{}})).status,201);
  assert.equal((await request('/admin/invites',{cookie:admin.cookie,source:'https://evil.example.org',body:{}})).status,403);
  const restored=await request('/admin/domain/verify',{cookie:admin.cookie,body:{origin}});assert.equal(restored.status,200);
  assert.equal((await request('/admin/domain/activate',{cookie:admin.cookie,body:{...body,receipt:restored.data.receipt,confirmOrigin:origin}})).status,200);
  assert.equal((await request('/workspace/connection')).data.revision,2);
  assert.equal(service.db.prepare("SELECT count(*) n FROM audit_log WHERE action='domain.activate'").get().n,2);
});
test('members cannot change domains and unrelated, stale or expired targets never activate',async t=>{
  const f=await fixture(t),{request,admin}=f;
  const invite=await request('/admin/invites',{cookie:admin.cookie,body:{}});
  const member=await request('/auth/register',{body:{invite:new URLSearchParams(new URL(invite.data.url).hash.slice(1)).get('invite'),email:'member@example.org',name:'Member',password}});
  assert.equal((await request('/admin/domain',{cookie:member.cookie})).status,403);
  assert.equal((await request('/admin/domain/verify',{cookie:member.cookie,body:{origin:target}})).status,403);assert.equal(f.probes(),0);
  f.remote({workspaceId:'other',canonicalOrigin:origin,revision:0});assert.equal((await request('/admin/domain/verify',{cookie:admin.cookie,body:{origin:target}})).status,400);
  f.remote(null);const v=await request('/admin/domain/verify',{cookie:admin.cookie,body:{origin:target}});
  const row=JSON.parse(f.service.db.prepare("SELECT value FROM app_meta WHERE key='workspace_domains'").get().value);row.pending.verifiedAt-=600001;
  f.service.db.prepare("UPDATE app_meta SET value=? WHERE key='workspace_domains'").run(JSON.stringify(row));
  assert.equal((await request('/admin/domain/activate',{cookie:admin.cookie,body:{receipt:v.data.receipt,password,keepOldDomain:true,confirmOrigin:target}})).status,409);
  assert.equal((await request('/workspace/connection')).data.canonicalOrigin,origin);
});
test('public probe rejects private DNS and redirects, pins DNS, limits response size and sends no credentials',async()=>{
  for(const value of ['http://a.example.org','https://u:p@a.example.org','https://a.example.org/path','https://127.0.0.1','https://a.example.org:8443','https://a.example.org/#x','https://a.example.org\\@evil.org'])assert.throws(()=>domainOrigin(value));
  for(const ip of ['127.0.0.1','10.2.3.4','169.254.169.254','100.64.0.1','192.168.1.1','198.18.0.1','224.0.0.1','::1'])assert.equal(publicIPv4(ip),false,ip);
  for(const ip of ['127.0.0.1','169.254.169.254'])await assert.rejects(probeDomain(target,{resolveHost:async()=>[{address:ip}],requestHttps:()=>assert.fail('must not connect')}),/내부망/);
  function https(status,payload){return (url,options,callback)=>{assert.equal(url.origin,target);assert.deepEqual(options.headers,{Accept:'application/json'});assert.equal(options.agent,false);options.lookup('ignored',{all:true},(err,rows)=>assert.deepEqual(rows,[{address:'1.1.1.1',family:4}]));const req=new EventEmitter();req.end=()=>{const response=Readable.from([Buffer.from(payload)]);response.statusCode=status;callback(response);};return req;};}
  const options={resolveHost:async()=>[{address:'1.1.1.1'}]};
  assert.deepEqual(await probeDomain(target,{...options,requestHttps:https(200,'{"ok":true}')}),{ok:true});
  await assert.rejects(probeDomain(target,{...options,requestHttps:https(302,'{}')}));
  await assert.rejects(probeDomain(target,{...options,requestHttps:https(200,'x'.repeat(8193))}));
});
