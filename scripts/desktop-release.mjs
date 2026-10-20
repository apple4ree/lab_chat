import {readFile,lstat,open} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import assert from 'node:assert/strict';
export const desktopSources=['main.cjs','preload.cjs','policy.cjs','notifications.cjs','updates.cjs','release-config.json','offline.html','offline.js'];
const sharedChecks=['packaged-source-match','packaged-launch','isolated-renderer','production-login-screen'];
const targets=[
  {platform:'windows',arch:'x64',suffix:'win-x64.exe',checks:['installer-install','start-menu-shortcut','pe-x64','installer-uninstall']},
  {platform:'macos',arch:'arm64',suffix:'mac-arm64.dmg',checks:['dmg-verify','dmg-mount','applications-shortcut','application-copy','mach-o-architecture','framework-links','ad-hoc-signature']},
  {platform:'macos',arch:'x64',suffix:'mac-x64.dmg',checks:['dmg-verify','dmg-mount','applications-shortcut','application-copy','mach-o-architecture','framework-links','ad-hoc-signature']}
];
export async function fileHash(path){const hash=createHash('sha256');for await(const b of createReadStream(path))hash.update(b);return hash.digest('hex');}
export async function inspectInstallers({directory,version,commit,sourceSha256}){
  assert(/^[a-f0-9]{40}$/.test(commit),'Expected source commit is required');
  assert(/^\d+\.\d+\.\d+$/.test(version),'Invalid installer version');
  const files=[];
  for(const target of targets){
    const name=`DAMI-Chat-${version}-${target.suffix}`,path=join(directory,name),report=JSON.parse(await readFile(join(directory,`build-info-${target.platform}-${target.arch}.json`),'utf8'));
    assert.equal(report.schema,1);assert.equal(report.commit,commit,'Build commit mismatch');assert.equal(report.version,version);assert.equal(report.name,name);
    assert.equal(report.platform,target.platform);assert.equal(report.arch,target.arch);
    assert.equal(report.developerSigned,false);assert.equal(report.notarized,false);assert.equal(report.signing,target.platform==='macos'?'adhoc':'unsigned');
    assert.deepEqual(report.sourceSha256,sourceSha256,'Embedded application sources mismatch');
    assert(Array.isArray(report.checks)&&report.checks.every(check=>typeof check==='string'),'Invalid native checks');
    for(const check of [...sharedChecks,...target.checks])assert(report.checks?.includes(check),`Missing native check: ${check}`);
    const info=await lstat(path);assert(info.isFile(),'Installer must be a regular file');assert.equal(info.size,report.bytes);
    const sha256=await fileHash(path);assert.equal(sha256,report.sha256,'Installer checksum mismatch');
    const handle=await open(path,'r');
    try{
      if(target.platform==='windows'){
        const head=Buffer.alloc(64);await handle.read(head,0,64,0);assert.equal(head.toString('ascii',0,2),'MZ');
        const pe=Buffer.alloc(4);await handle.read(pe,0,4,head.readUInt32LE(0x3c));assert.equal(pe.toString('ascii'),'PE\0\0');
      }else{assert(info.size>=512);const footer=Buffer.alloc(4);await handle.read(footer,0,4,info.size-512);assert.equal(footer.toString('ascii'),'koly');}
    }finally{await handle.close();}
    files.push({name,platform:target.platform,arch:target.arch,bytes:info.size,sha256,signed:false,nativeTested:true});
  }
  return files;
}
