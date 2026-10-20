import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {createApp} from '../server/app.mjs';
test('desktop downloads require authentication, match the manifest and cannot expose arbitrary files or symlinks',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'desktop-download-')),release=join(dir,'.data','release');mkdirSync(release,{recursive:true});
  const name='DAMI-Chat-0.1.0-win-x64.zip',bytes=Buffer.from('fixture installer content'),sha256=createHash('sha256').update(bytes).digest('hex');
  writeFileSync(join(release,name),bytes);const manifest={version:'0.1.0',files:[{name,platform:'windows',arch:'x64',bytes:bytes.length,sha256,signed:false,nativeTested:false}]};writeFileSync(join(release,'manifest.json'),JSON.stringify(manifest));
  const service=createApp({dataDir:join(dir,'db'),mode:'demo',desktopReleaseDir:release}),server=service.app.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
  try{
    assert.equal((await fetch(base+'/api/desktop/releases')).status,401);assert.equal((await fetch(base+'/api/desktop/releases/'+name)).status,401);
    const user=service.db.prepare("SELECT id FROM users WHERE identity_provider='demo' LIMIT 1").get();
    const login=await fetch(base+'/api/auth/demo',{method:'POST',headers:{'X-Lab-Request':'1','Content-Type':'application/json'},body:JSON.stringify({userId:user.id})});const headers={Cookie:login.headers.get('set-cookie').split(';')[0]};
    const listing=await(await fetch(base+'/api/desktop/releases',{headers})).json();assert.equal(listing.files[0].sha256,sha256);assert.equal(listing.files[0].signed,false);
    const downloaded=await fetch(base+listing.files[0].url,{headers});assert.equal(downloaded.status,200);assert.match(downloaded.headers.get('content-disposition'),/attachment/);assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),bytes);
    const range=await fetch(base+listing.files[0].url,{headers:{...headers,Range:'bytes=0-3'}});assert.equal(range.status,206);assert.deepEqual(Buffer.from(await range.arrayBuffer()),bytes.subarray(0,4));
    assert.equal((await fetch(base+'/api/desktop/releases/manifest.json',{headers})).status,404);
    assert.equal((await fetch(base+'/api/desktop/releases/%2e%2e%2fpackage.json',{headers})).status,404);
    rmSync(join(release,name));writeFileSync(join(dir,'private'),bytes);symlinkSync(join(dir,'private'),join(release,name));
    const denied=await fetch(base+'/api/desktop/releases/'+name,{headers});assert.equal(denied.status,500);assert.ok(!(await denied.text()).includes('fixture installer'));
  }finally{service.close();server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});}
});
