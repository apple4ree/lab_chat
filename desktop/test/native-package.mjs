// Native CI only. Installs a fresh package in an owned temporary directory;
// opens the public login screen without credentials or production mutations.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile,writeFile,mkdtemp,mkdir,readdir,lstat,readlink,access} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {_electron as electron} from 'playwright';
const require=createRequire(import.meta.url),asar=require('@electron/asar');
const arch=process.argv[2],platform=process.platform==='win32'?'windows':process.platform==='darwin'?'macos':null;
assert(platform&&arch===process.arch,'Run on the matching native OS and architecture');
assert(/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA||''),'CI source commit is required');
const pkg=JSON.parse(await readFile('desktop/package.json','utf8'));
if(process.env.GITHUB_REF?.startsWith('refs/tags/'))assert.equal(process.env.GITHUB_REF,`refs/tags/desktop-v${pkg.version}`);
const name=`DAMI-Chat-${pkg.version}-${platform==='windows'?'win':'mac'}-${arch}.${platform==='windows'?'exe':'dmg'}`;
const installer=resolve('desktop/release',name),temp=await mkdtemp(join(tmpdir(),'dami-native-'));
const checks=[];let app,mounted=false,executable,archive,installDirectory,mountDirectory;
import {desktopSources as sources} from '../../scripts/desktop-release.mjs';
async function sha256(path){const h=createHash('sha256');for await(const b of createReadStream(path))h.update(b);return h.digest('hex');}
const run=(command,args)=>execFileSync(command,args,{encoding:'utf8',timeout:180000,stdio:['ignore','pipe','pipe']});
async function exists(path){try{await access(path);return true;}catch{return false;}}
try{
  if(platform==='windows'){
    installDirectory=join(temp,'installed');
    run('powershell.exe',['-NoProfile','-NonInteractive','-File',resolve('desktop/test/windows-installer.ps1'),'-Executable',installer,'-InstallDirectory',installDirectory]);
    executable=join(installDirectory,'DAMI Chat.exe');archive=join(installDirectory,'resources/app.asar');await access(executable);checks.push('installer-install');
    await access(join(process.env.APPDATA,'Microsoft/Windows/Start Menu/Programs/DAMI Chat.lnk'));checks.push('start-menu-shortcut');
    const binary=await readFile(executable),offset=binary.readUInt32LE(0x3c);assert.equal(binary.toString('ascii',offset,offset+4),'PE\0\0');assert.equal(binary.readUInt16LE(offset+4),0x8664);checks.push('pe-x64');
  }else{
    run('hdiutil',['verify',installer]);checks.push('dmg-verify');
    mountDirectory=join(temp,'mount');await mkdir(mountDirectory);
    run('hdiutil',['attach',installer,'-mountpoint',mountDirectory,'-readonly','-nobrowse','-quiet']);mounted=true;checks.push('dmg-mount');
    assert.equal(await readlink(join(mountDirectory,'Applications')),'/Applications');checks.push('applications-shortcut');
    installDirectory=join(temp,'Applications/DAMI Chat.app');await mkdir(join(temp,'Applications'));
    run('ditto',[join(mountDirectory,'DAMI Chat.app'),installDirectory]);checks.push('application-copy');
    executable=join(installDirectory,'Contents/MacOS/DAMI Chat');archive=join(installDirectory,'Contents/Resources/app.asar');
    const binary=await readFile(executable);assert.equal(binary.readUInt32LE(0),0xfeedfacf);assert.equal(binary.readUInt32LE(4),arch==='arm64'?0x100000c:0x1000007);checks.push('mach-o-architecture');
    const link=join(installDirectory,'Contents/Frameworks/Electron Framework.framework/Versions/Current');assert((await lstat(link)).isSymbolicLink());assert.equal(await readlink(link),'A');checks.push('framework-links');
    run('codesign',['--verify','--deep','--strict',installDirectory]);checks.push('ad-hoc-signature');
  }
  const sourceSha256={};
  for(const name of sources){const content=await readFile(join('desktop',name));assert.deepEqual(asar.extractFile(archive,name),content);sourceSha256[name]=createHash('sha256').update(content).digest('hex');}
  assert.equal(JSON.parse(asar.extractFile(archive,'package.json')).version,pkg.version);
  assert(!asar.listPackage(archive).some(n=>/\/(\.data|\.env|server)(\/|$)/.test(n)));checks.push('packaged-source-match');
  app=await electron.launch({executablePath:executable,timeout:60000});
  const window=await app.firstWindow();window.setDefaultTimeout(45000);
  const state=await app.evaluate(({app,BrowserWindow})=>({packaged:app.isPackaged,version:app.getVersion(),preferences:(()=>{const p=BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();return {sandbox:p.sandbox,nodeIntegration:p.nodeIntegration,contextIsolation:p.contextIsolation};})()}));
  assert.equal(state.packaged,true);assert.equal(state.version,pkg.version);checks.push('packaged-launch');
  assert.deepEqual(state.preferences,{sandbox:true,nodeIntegration:false,contextIsolation:true});assert.equal(await window.evaluate(()=>typeof window.require),'undefined');checks.push('isolated-renderer');
  await window.getByRole('textbox',{name:'이메일 또는 아이디'}).waitFor();assert.equal(new URL(window.url()).origin,'https://chat.damilab.cc');checks.push('production-login-screen');
  await window.screenshot({path:`desktop/release/native-${platform}-${arch}.png`});
  await app.close();app=null;
  if(platform==='windows'){
    const uninstallers=(await readdir(installDirectory)).filter(n=>/^Uninstall.*\.exe$/.test(n));assert.equal(uninstallers.length,1);
    run('powershell.exe',['-NoProfile','-NonInteractive','-File',resolve('desktop/test/windows-installer.ps1'),'-Executable',join(installDirectory,uninstallers[0])]);
    for(let i=0;i<60&&await exists(executable);i++)await new Promise(r=>setTimeout(r,500));assert(!await exists(executable));checks.push('installer-uninstall');
  }
  const report={schema:1,version:pkg.version,commit:process.env.GITHUB_SHA,runId:process.env.GITHUB_RUN_ID,platform,arch,runner:process.env.ImageOS||process.env.RUNNER_OS,checkedAt:new Date().toISOString(),name,bytes:(await lstat(installer)).size,sha256:await sha256(installer),sourceSha256,checks,developerSigned:false,notarized:false,signing:platform==='macos'?'adhoc':'unsigned'};
  await writeFile(`desktop/release/build-info-${platform}-${arch}.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{
  if(app)await app.close();
  if(mounted)run('hdiutil',['detach',mountDirectory,'-quiet']);
}
