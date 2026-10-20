import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createApp} from '../server/app.mjs';

test('HTTPS demo is closed by default; the shared gate covers HTML, auth, files and events',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'lab-chat-gate-'));
  assert.throws(()=>createApp({dataDir:dir,mode:'demo',origin:'https://demo.example.test'}),/require LAB_DEMO_GATE_HASH/);
  const credentials='demo:test-only-random-password';
  const service=createApp({dataDir:dir,mode:'demo',origin:'https://demo.example.test',demoGateHash:createHash('sha256').update(credentials).digest('hex')});
  const server=service.app.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
  try{
    for(const path of ['/','/api/auth/config','/api/files/any','/api/events']){
      const r=await fetch(base+path);assert.equal(r.status,401);assert.match(r.headers.get('www-authenticate'),/Basic/);
    }
    const headers={Authorization:'Basic '+Buffer.from(credentials).toString('base64')};
    const config=await fetch(base+'/api/auth/config',{headers}).then(r=>r.json());assert.equal(config.mode,'demo');
    const bad=await fetch(base+'/api/auth/config',{headers:{Authorization:'Basic '+Buffer.from('demo:wrong').toString('base64')}});assert.equal(bad.status,401);
    const login=await fetch(base+'/api/auth/demo',{method:'POST',headers:{...headers,'Content-Type':'application/json','X-Lab-Request':'1',Origin:'https://demo.example.test'},body:JSON.stringify({userId:config.demoUsers[0].id})});
    assert.equal(login.status,200);assert.match(login.headers.get('set-cookie'),/Secure/);
    const cookie=login.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(base+'/api/channels',{headers:{Cookie:cookie}})).status,401);
    assert.equal((await fetch(base+'/api/channels',{headers:{...headers,Cookie:cookie}})).status,200);
    const forged=await fetch(base+'/api/auth/demo',{method:'POST',headers:{...headers,'Content-Type':'application/json','X-Lab-Request':'1',Origin:'https://evil.example'},body:JSON.stringify({userId:config.demoUsers[0].id})});assert.equal(forged.status,403);
  }finally{service.close();server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});}
});
