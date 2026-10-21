import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanHost,executeSnapshot} from '../server/ssh-transport.mjs';
import {sshSnapshotScript,parseSshSnapshot} from '../server/ssh-connections.mjs';
test('real OpenSSH pins host keys, authenticates password/encrypted key, collects and rejects mismatched key before authentication',{skip:!process.env.LAB_SSH_TEST_PYTHONPATH,timeout:30000},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ssh-real-'));
  const child=spawn(process.env.LAB_SSH_TEST_PYTHON||'python3',['test/fixtures/ssh-server.py',dir],{env:{PATH:process.env.PATH,PYTHONPATH:process.env.LAB_SSH_TEST_PYTHONPATH},detached:true,stdio:['ignore','pipe','pipe']});
  const exited=once(child,'exit');let errors='';child.stderr.on('data',d=>errors+=d);
  try{
    const data=await Promise.race([once(child.stdout,'data').then(([d])=>JSON.parse(d.toString())),exited.then(()=>{throw new Error(errors);})]);
    const target=await scanHost({address:'127.0.0.1',port:data.port,username:'fixture'});assert.match(target.fingerprint,/^SHA256:/);
    const output=await executeSnapshot(target,{type:'password',password:'fixture-only-password'},sshSnapshotScript(false));assert.ok(parseSshSnapshot(output,'fixture').sample.memory.totalBytes>0);
    const key=readFileSync(join(dir,'client-key'),'utf8');const result=await executeSnapshot(target,{type:'key',privateKey:key,passphrase:'fixture-key-passphrase'},sshSnapshotScript(false));assert.equal(parseSshSnapshot(result,'fixture').facts.platform,'Linux');
    await assert.rejects(executeSnapshot(target,{type:'password',password:'incorrect'},sshSnapshotScript(false)),{sshCode:'ssh_failed'});
    const count=readFileSync(join(dir,'events'),'utf8');await assert.rejects(executeSnapshot({...target,key:'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhY'},{type:'password',password:'fixture-only-password'},sshSnapshotScript(false)),{sshCode:'ssh_failed'});assert.equal(readFileSync(join(dir,'events'),'utf8'),count);
  }finally{try{process.kill(-child.pid,'SIGKILL');}catch{}await exited;rmSync(dir,{recursive:true,force:true});}
});
