import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {desktopSources,inspectInstallers} from '../scripts/desktop-release.mjs';
const commit='a'.repeat(40),version='0.1.1',sourceSha256=Object.fromEntries(desktopSources.map(n=>[n,createHash('sha256').update(n).digest('hex')]));
// Synthetic containers exercise the publisher boundary; they are not runnable apps.
async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'native-publish-'));
 for(const [platform,arch] of [['windows','x64'],['macos','arm64'],['macos','x64']]){
  const windows=platform==='windows',name=`DAMI-Chat-${version}-${windows?'win':'mac'}-${arch}.${windows?'exe':'dmg'}`,bytes=Buffer.alloc(1024);
  if(windows){bytes.write('MZ');bytes.writeUInt32LE(64,60);bytes.write('PE\0\0',64,'ascii');}else bytes.write('koly',512,'ascii');
  const checks=['packaged-source-match','packaged-launch','isolated-renderer','production-login-screen','updater-bridge','update-reinstall-preserves-settings',...(windows?['installer-install','start-menu-shortcut','pe-x64','installer-uninstall']:['dmg-verify','dmg-mount','applications-shortcut','application-copy','mach-o-architecture','framework-links','ad-hoc-signature'])];
  const report={schema:1,commit,version,name,platform,arch,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),sourceSha256,checks,developerSigned:false,notarized:false,signing:windows?'unsigned':'adhoc'};
  await writeFile(join(directory,name),bytes);await writeFile(join(directory,`build-info-${platform}-${arch}.json`),JSON.stringify(report));
 }
 return {directory,version,commit,sourceSha256};
}
test('publisher accepts all three native artifacts only with matching source and completed native checks',async()=>{
 const options=await fixture();try{const files=await inspectInstallers(options);assert.equal(files.length,3);assert(files.every(f=>f.nativeTested&&!f.signed));assert(files[0].name.endsWith('.exe'));assert(files.slice(1).every(f=>f.name.endsWith('.dmg')));}finally{await rm(options.directory,{recursive:true,force:true});}
});
test('publisher rejects altered bytes, wrong source, missing installer verification, and symlink replacements',async()=>{
 for(const mutation of ['bytes','commit','source','checks','symlink']){
  const options=await fixture();try{
   const path=join(options.directory,'DAMI-Chat-0.1.1-win-x64.exe'),reportPath=join(options.directory,'build-info-windows-x64.json'),report=JSON.parse(await readFile(reportPath));
   if(mutation==='bytes'){const bytes=await readFile(path);bytes[100]=1;await writeFile(path,bytes);}
   if(mutation==='commit')report.commit='b'.repeat(40);
   if(mutation==='source')report.sourceSha256['main.cjs']='f'.repeat(64);
   if(mutation==='checks')report.checks=report.checks.filter(c=>c!=='installer-uninstall');
   if(mutation==='symlink'){await writeFile(join(options.directory,'other.exe'),await readFile(path));await rm(path);await symlink('other.exe',path);}
   await writeFile(reportPath,JSON.stringify(report));await assert.rejects(inspectInstallers(options),undefined,mutation);
  }finally{await rm(options.directory,{recursive:true,force:true});}
 }
});
