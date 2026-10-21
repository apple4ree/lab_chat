import {test,expect} from '@playwright/test';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createApp} from '../../server/app.mjs';

test('server manager confirms fingerprint, starts setup, reads verified inventory, reloads and disconnects on mobile',async({page})=>{
  const dir=mkdtempSync(join(tmpdir(),'ssh-ui-')),server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;
  let releasePlan,receivedCredential;const app=createApp({dataDir:dir,mode:'demo',origin,distDir:resolve(process.env.LAB_TEST_DIST_DIR||'dist'),gpuAutoStart:false,sshOptions:{
    scan:async endpoint=>({...endpoint,ip:'192.0.2.10',key:'ssh-ed25519 AAAA',fingerprint:'SHA256:test-server-fingerprint'}),
    planner:async()=>new Promise(r=>releasePlan=()=>r({intervalSeconds:30,collectGpu:false,summary:'CPU·RAM·디스크를 30초마다 수집합니다.'})),
    execute:async(target,credential)=>{receivedCredential=credential;return JSON.stringify({platform:'Linux',python:[3,12,3],sample:{version:1,reportedAt:Date.now(),hostname:'test-node',scope:'host',cpu:{logicalCores:32},memory:{totalBytes:256*1024**3,availableBytes:128*1024**3},disks:[]},gpu:{state:'absent',items:[]}});}
  }});server.on('request',app.app);
  const admin=app.db.prepare("SELECT * FROM users WHERE role='admin'").get(),manager=app.db.prepare("SELECT * FROM users WHERE name='서연'").get();app.servers.setManager(admin.id,manager.id,true);app.catalog.registerServer(admin,{host:'test-node',label:'테스트 서버',hosting:'local'});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  async function open(){await page.locator('.sidebar').getByRole('button',{name:'연구 자원',exact:true}).click();await page.getByRole('button',{name:'서버 사양',exact:true}).click();await page.getByRole('button',{name:'SSH 연결·자동 설정',exact:true}).click();}
  try{
    await page.goto(origin);await page.getByRole('button',{name:'서연 연구원'}).click();await open();
    await page.getByLabel('등록된 서버',{exact:true}).selectOption('test-node');await page.getByLabel('SSH 주소',{exact:true}).fill('192.0.2.10');await page.getByLabel('SSH 사용자명',{exact:true}).fill('researcher');await page.getByRole('button',{name:'1. 서버 키 확인',exact:true}).click();
    await expect(page.getByText('SHA256:test-server-fingerprint',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'2. Codex 설정·연결 시작'})).toBeDisabled();
    await page.getByLabel('서버 키 지문을 확인했고 이 서버를 신뢰합니다.').check();await page.getByLabel('SSH 비밀번호',{exact:true}).fill('fixture-browser-password');await page.getByRole('button',{name:'2. Codex 설정·연결 시작'}).click();
    await expect(page.getByRole('status').filter({hasText:'설정을 시작했습니다.'})).toBeVisible();await expect.poll(()=>typeof releasePlan).toBe('function');expect(receivedCredential.password).toBe('fixture-browser-password');expect(await page.content()).not.toContain('fixture-browser-password');
    releasePlan();await app.ssh.settle();await app.servers.poll();await expect(page.getByText('test-node · 연결 완료',{exact:true})).toBeVisible();await page.getByRole('button',{name:'자원 현황 새로고침',exact:true}).click();await expect(page.locator('.server-card').filter({hasText:'테스트 서버'}).getByText('보고 중',{exact:true})).toBeVisible();
    await page.reload();await open();await expect(page.getByText('test-node · 연결 완료',{exact:true})).toBeVisible();
    await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.getByRole('button',{name:'연결 해제',exact:true}).click();await expect(page.getByRole('button',{name:'연결 해제 확인',exact:true})).toBeVisible();await page.getByRole('button',{name:'연결 해제 확인',exact:true}).click();await expect(page.getByText('test-node · 연결 해제됨',{exact:true})).toBeVisible();expect(app.db.prepare('SELECT credential FROM server_ssh_connections').get().credential).toBeNull();expect(errors).toEqual([]);
  }finally{releasePlan?.();app.close();await app.ssh.settle();server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});}
});
