import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

test('the real server process shuts down active SSE connections and leaves a consistent database',{timeout:15000},async()=>{
  const reserve=createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(r=>reserve.close(r));
  const directory=mkdtempSync(join(tmpdir(),'lab-chat-lifecycle-')),origin=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['server/index.mjs'],{cwd:process.cwd(),env:{...process.env,LAB_PORT:String(port),LAB_HOST:'127.0.0.1',LAB_ORIGIN:origin,LAB_AUTH_MODE:'local',LAB_DATA_DIR:directory,LAB_SETUP_TOKEN:'lifecycle-test-code'},stdio:['ignore','pipe','pipe']});
  const exited=once(child,'exit');let stderr='';child.stderr.on('data',chunk=>{stderr+=String(chunk);});
  const controller=new AbortController();
  try{
    await once(child.stdout,'data');
    const setup=await fetch(origin+'/api/auth/setup',{method:'POST',headers:{'Content-Type':'application/json','X-Lab-Request':'1',Origin:origin},body:JSON.stringify({setupToken:'lifecycle-test-code',name:'관리자',email:'lifecycle@example.test',password:'lifecycle-password'})});
    assert.equal(setup.status,201);const cookie=setup.headers.get('set-cookie').split(';')[0];
    const response=await fetch(origin+'/api/events',{headers:{Cookie:cookie},signal:controller.signal});const reader=response.body.getReader();await reader.read();
    child.kill('SIGTERM');assert.equal((await reader.read()).done,true);
    const [code,signal]=await exited;assert.equal(code,0,stderr);assert.equal(signal,null);
    const db=new DatabaseSync(join(directory,'lab-chat.sqlite'),{readOnly:true});assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n,1);db.close();
  }finally{
    controller.abort();if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}
    rmSync(directory,{recursive:true,force:true});
  }
});
