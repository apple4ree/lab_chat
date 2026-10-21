import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,existsSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
export function createSshVault(dataDir,hasCredentials){
  const dir=join(dataDir,'secrets'),file=join(dir,'ssh-master.key');let key;
  function load(){
    if(key)return key;
    if(!existsSync(file)){
      if(hasCredentials())throw new Error('SSH encryption key is missing; restore it from the protected backup.');
      mkdirSync(dir,{recursive:true,mode:0o700});writeFileSync(file,randomBytes(32),{flag:'wx',mode:0o600});
    }
    const stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077))throw new Error('SSH encryption key must be a private regular file (0600).');
    key=readFileSync(file);if(key.length!==32)throw new Error('Invalid SSH encryption key.');return key;
  }
  // Fail before accepting connections if an existing vault cannot be decrypted.
  if(hasCredentials())load();
  return {
    seal(id,value){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',load(),iv);cipher.setAAD(Buffer.from(id));const payload=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),payload]).toString('base64');},
    open(id,value){const bytes=Buffer.from(value,'base64'),cipher=createDecipheriv('aes-256-gcm',load(),bytes.subarray(0,12));cipher.setAAD(Buffer.from(id));cipher.setAuthTag(bytes.subarray(12,28));return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString('utf8'));}
  };
}
