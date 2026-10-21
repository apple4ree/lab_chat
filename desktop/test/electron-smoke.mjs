// Run from the repository root: xvfb-run -a node desktop/test/electron-smoke.mjs <built-web-directory>
import {strict as assert} from 'node:assert';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {_electron as electron} from 'playwright';
import {createApp} from '../../server/app.mjs';
import {demoGpuSource} from '../../server/gpu.mjs';
const require=createRequire(import.meta.url),executablePath=require('electron');
const dir=mkdtempSync(join(tmpdir(),'dami-desktop-test-'));
const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;
const service=createApp({origin,dataDir:join(dir,'db'),distDir:resolve(process.argv[2]||'dist'),mode:'demo',gpuSource:demoGpuSource});server.on('request',service.app);
let app;const errors=[];const result={checkedAt:new Date().toISOString(),platform:process.platform,checks:[]};
async function launch(){
  app=await electron.launch({executablePath,args:['--no-sandbox',resolve('desktop')],env:{...process.env,LAB_DESKTOP_URL:origin,LAB_DESKTOP_USER_DATA:join(dir,'profile')},timeout:30000});
  const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));return page;
}
async function until(fn,label){for(let i=0;i<80;i++){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw new Error(label);}
try{
  let page=await launch();await page.getByRole('button',{name:/지민/}).click();await page.getByLabel('메시지 입력',{exact:true}).waitFor();
  const preferences=await app.evaluate(({BrowserWindow})=>{const p=BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();return {sandbox:p.sandbox,nodeIntegration:p.nodeIntegration,contextIsolation:p.contextIsolation,webSecurity:p.webSecurity};});
  assert.deepEqual(preferences,{sandbox:true,nodeIntegration:false,contextIsolation:true,webSecurity:true});
  assert.equal(await page.evaluate(()=>typeof window.require),'undefined');
  assert.equal(await page.evaluate(()=>window.damiDesktop.version),2);result.checks.push('isolated-renderer');
  const runningVersion=await app.evaluate(({app})=>app.getVersion());
  assert.equal((await page.evaluate(()=>window.damiDesktop.getUpdateState())).currentVersion,runningVersion);result.checks.push('updater-bridge');
  const config=await(await fetch(origin+'/api/auth/config')).json();const member=config.demoUsers.find(u=>u.role==='member');
  const login=await fetch(origin+'/api/auth/demo',{method:'POST',headers:{'X-Lab-Request':'1','Content-Type':'application/json'},body:JSON.stringify({userId:member.id})});const cookie=login.headers.get('set-cookie').split(';')[0];
  const channelResponse=await fetch(origin+'/api/channels',{method:'POST',headers:{Cookie:cookie,'X-Lab-Request':'1','Content-Type':'application/json'},body:JSON.stringify({name:'desktop-smoke'})});assert.equal(channelResponse.status,201);const target=await channelResponse.json();
  await page.locator('.channel-link').filter({hasText:'desktop-smoke'}).click();
  await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.show();w.focus();w.webContents.focus();});
  await page.getByLabel('메시지 입력',{exact:true}).click();
  await until(async()=>(await page.evaluate(id=>fetch('/api/channels').then(r=>r.json()).then(cs=>cs.find(c=>c.id===id).unread),target.id))===0,'initial channel not read');
  const totalBefore=await page.evaluate(()=>fetch('/api/channels').then(r=>r.json()).then(cs=>cs.reduce((sum,c)=>sum+c.unread,0)));
  await until(async()=>(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getTitle()))===(totalBefore?`(${totalBefore}) DAMI Chat`:'DAMI Chat'),'initial badge not synchronized');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].hide());
  const sent=await fetch(`${origin}/api/channels/${target.id}/messages`,{method:'POST',headers:{Cookie:cookie,'X-Lab-Request':'1','Content-Type':'application/json'},body:JSON.stringify({body:'desktop background notification test'})});assert.equal(sent.status,201);
  await until(async()=>(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getTitle()))===`(${totalBefore+1}) DAMI Chat`,'badge not updated while hidden');
  const unread=await page.evaluate(id=>fetch('/api/channels').then(r=>r.json()).then(cs=>cs.find(c=>c.id===id).unread),target.id);assert.ok(unread>0);result.checks.push('hidden-window-unread-and-badge');
  await app.evaluate(({BrowserWindow},id)=>{const w=BrowserWindow.getAllWindows()[0];w.show();w.focus();w.webContents.send('dami:navigate',id);},target.id);
  await until(async()=>(await page.evaluate(id=>fetch('/api/channels').then(r=>r.json()).then(cs=>cs.find(c=>c.id===id).unread),target.id))===0,'read not acknowledged on focus');result.checks.push('notification-channel-navigation');
  const pdf=await app.evaluate(async({BrowserWindow})=>Array.from(await BrowserWindow.getAllWindows()[0].webContents.printToPDF({})));
  for(const [name,type,content] of [['desktop-preview.html','text/html','<h1>Desktop HTML Preview</h1><script>parent.pwned=true</script>'],['desktop-preview.pdf','application/pdf',Buffer.from(pdf)]]){
    const form=new FormData();form.set('file',new Blob([content],{type}),name);
    const uploaded=await fetch(`${origin}/api/channels/${target.id}/files`,{method:'POST',headers:{Cookie:cookie,'X-Lab-Request':'1'},body:form});assert.equal(uploaded.status,201);
    await page.locator('.file-card').filter({hasText:name}).click();
    if(type==='text/html'){
      await page.frameLocator('.file-preview-panel iframe').getByRole('heading',{name:'Desktop HTML Preview'}).waitFor();
      assert.equal(await page.evaluate(()=>window.pwned),undefined);result.checks.push('isolated-html-preview');
    }else{
      await until(async()=>{
        for(const frame of page.frames())if(await frame.evaluate(()=>{const viewer=document.querySelector('pdf-viewer');return viewer?.loadState==='success'||viewer?.loadState_==='success';}).catch(()=>false))return true;
        return false;
      },'native PDF document did not finish loading');result.checks.push('native-pdf-preview');
    }
    await page.getByRole('button',{name:'미리보기 닫기'}).click();
  }
  await page.locator('.sidebar').getByRole('button',{name:'연구 자원',exact:true}).click();await page.getByRole('button',{name:'예약·배정',exact:true}).click();await page.getByRole('heading',{name:'GPU 예약·배정',exact:true}).waitFor();result.checks.push('gpu-resource-ui');
  mkdirSync('.data/deploy/evidence',{recursive:true});await page.screenshot({path:'.data/deploy/evidence/desktop-linux.png'});
  await app.close();app=null;page=await launch();await page.getByLabel('메시지 입력',{exact:true}).waitFor();result.checks.push('login-survives-restart');
  await page.evaluate(()=>fetch('/api/auth/logout',{method:'POST',headers:{'X-Lab-Request':'1'}}));await page.reload();await page.getByRole('button',{name:/지민/}).waitFor();
  await until(async()=>(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getTitle()))==='DAMI Chat','logout did not clear badge');result.checks.push('logout-clears-native-state');
  const state=await app.evaluate(({Notification})=>({nativeNotificationsSupported:Notification.isSupported()}));result.native=state;
  service.close();server.closeAllConnections();await new Promise(r=>server.close(r));
  await page.reload().catch(()=>{});await page.getByRole('heading',{name:'연구실에 연결하지 못했습니다'}).waitFor();result.checks.push('offline-recovery-screen');
  assert.deepEqual(errors,[]);result.pageErrors=errors;result.realWindowsMacTested=false;result.testSandboxFlag='Linux container launch used --no-sandbox; packaged app does not add this flag';
  writeFileSync('.data/deploy/evidence/desktop-smoke.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){
  console.log('Completed checks before failure',result.checks);
  if(app){const page=app.windows()[0];console.log('Desktop failure evidence',JSON.stringify({error:error.message,pageErrors:errors,native:await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];return {title:w.getTitle(),focused:w.isFocused(),visible:w.isVisible()};}).catch(()=>null),renderer:await page.evaluate(()=>({focused:document.hasFocus(),visibility:document.visibilityState})).catch(()=>null)}));}
  throw error;
}finally{if(app)await app.close();service.close();server.closeAllConnections();if(server.listening)await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});}
