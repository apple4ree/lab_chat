import {spawn} from 'node:child_process';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

export const sshError=(code)=>Object.assign(new Error(code),{sshCode:code});
export function validateEndpoint(body){
  const address=body?.address,port=body?.port,username=body?.username;
  if(typeof address!=='string'||address.length>253||(!isIP(address)&&! /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(address))||!Number.isSafeInteger(port)||port<1||port>65535||typeof username!=='string'||! /^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(username))throw sshError('invalid_endpoint');
  return {address,port,username};
}
export function validateCredential(body){
  if(body?.type==='password'&&typeof body.password==='string'&&body.password.length>0&&body.password.length<=4096&&!/[\r\n\0]/.test(body.password))return {type:'password',password:body.password};
  if(body?.type==='key'&&typeof body.privateKey==='string'&&body.privateKey.length<=16384&&/^-----BEGIN (OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----/.test(body.privateKey)&&typeof(body.passphrase??'')==='string'&&(body.passphrase??'').length<=4096&&!/[\r\n\0]/.test(body.passphrase??''))return {type:'key',privateKey:body.privateKey,passphrase:body.passphrase||''};
  throw sshError('invalid_credential');
}
// All children have bounded output/time, an owned process group, and close-before-cleanup.
export function runSshProcess(command,args,{input='',env,signal,timeoutMs=12000,maxBytes=262144}={}){
  return new Promise((resolve,reject)=>{
    if(signal?.aborted)return reject(sshError('cancelled'));
    const child=spawn(command,args,{env,stdio:['pipe','pipe','pipe'],detached:true});
    const chunks=[];let size=0,failure=null,terminating=false;
    const kill=code=>{failure??=code;if(terminating||child.exitCode!==null||child.signalCode!==null)return;terminating=true;try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}};
    const abort=()=>kill('cancelled');signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>kill('timeout'),timeoutMs);timer.unref();
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>maxBytes)kill('output_limit');else chunks.push(chunk);});
    child.stderr.on('data',chunk=>{size+=chunk.length;if(size>maxBytes)kill('output_limit');});
    child.stdin.on('error',()=>{});child.stdin.end(input);
    child.on('error',()=>{failure='ssh_unavailable';});
    child.on('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);if(failure||code!==0)reject(sshError(failure||'ssh_failed'));else resolve(Buffer.concat(chunks).toString('utf8'));});
  });
}
const safeEnv=()=>({PATH:'/usr/bin:/bin',LANG:'C',HOME:tmpdir()});
export async function scanHost(endpoint,signal){
  const {address,port,username}=validateEndpoint(endpoint);
  // Resolve once, then authenticate the exact scanned IP/key. No DNS re-resolution during login.
  let timer;const resolved=await Promise.race([lookup(address),new Promise((_,reject)=>{timer=setTimeout(()=>reject(sshError('timeout')),5000);timer.unref();})]).finally(()=>clearTimeout(timer));
  if(signal?.aborted)throw sshError('cancelled');
  const output=await runSshProcess('/usr/bin/ssh-keyscan',['-T','5','-p',String(port),'-t','ed25519,ecdsa,rsa',resolved.address],{signal,timeoutMs:7000,maxBytes:32768,env:safeEnv()});
  const keys=output.split('\n').filter(l=>!l.startsWith('#')).map(l=>l.trim().split(/\s+/)).filter(p=>p.length===3&&/^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa)$/.test(p[1])&&/^[A-Za-z0-9+/=]+$/.test(p[2]));
  const key=keys.find(k=>k[1]==='ssh-ed25519')||keys[0];if(!key)throw sshError('host_key_missing');
  return {address,port,username,ip:resolved.address,key:`${key[1]} ${key[2]}`,fingerprint:`SHA256:${createHash('sha256').update(Buffer.from(key[2],'base64')).digest('base64').replace(/=+$/,'')}`};
}
export async function executeSnapshot(target,credential,script,signal){
  const dir=await mkdtemp(join(tmpdir(),'lab-ssh-'));
  try{
    const known=join(dir,'known_hosts'),secret=join(dir,'secret'),askpass=join(dir,'askpass');
    await writeFile(known,`lab-chat-pinned ${target.key}\n`,{mode:0o600});
    await writeFile(secret,credential.type==='password'?credential.password:credential.passphrase||'',{mode:0o600});
    await writeFile(askpass,'#!/bin/sh\nexec /bin/cat "$LAB_SSH_SECRET_FILE"\n',{mode:0o700});
    const args=['-F','/dev/null','-T','-o','StrictHostKeyChecking=yes','-o',`UserKnownHostsFile=${known}`,'-o','GlobalKnownHostsFile=/dev/null','-o','HostKeyAlias=lab-chat-pinned','-o','UpdateHostKeys=no','-o','IdentityAgent=none','-o','IdentitiesOnly=yes','-o','ForwardAgent=no','-o','ClearAllForwardings=yes','-o','PermitLocalCommand=no','-o','ProxyCommand=none','-o','ConnectTimeout=5','-o','ConnectionAttempts=1','-o','NumberOfPasswordPrompts=1','-o','ServerAliveInterval=4','-o','ServerAliveCountMax=1'];
    if(credential.type==='key'){
      const key=join(dir,'identity');await writeFile(key,credential.privateKey.endsWith('\n')?credential.privateKey:credential.privateKey+'\n',{mode:0o600});
      args.push('-i',key,'-o','PreferredAuthentications=publickey');
    }else args.push('-o','PubkeyAuthentication=no','-o','PreferredAuthentications=password');
    args.push('-p',String(target.port),'-l',target.username,target.ip,'python3 -');
    return await runSshProcess('/usr/bin/ssh',args,{input:script,signal,env:{...safeEnv(),DISPLAY:'lab-chat',SSH_ASKPASS_REQUIRE:'force',SSH_ASKPASS:askpass,LAB_SSH_SECRET_FILE:secret}});
  }finally{await rm(dir,{recursive:true,force:true});}
}
