import {test,expect} from '@playwright/test';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createApp} from '../../server/app.mjs';

test('server inventory distinguishes cloud and container metrics, masks failures, and assigns independent manager roles',async({page})=>{
 const dir=mkdtempSync(join(tmpdir(),'server-browser-')),server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;let fail=false;
 const source=Object.assign(async()=>fail?[]:[{host:'local-server',sample:{version:1,reportedAt:Date.now(),hostname:'node',scope:'container',model:'Test server',os:'Linux',architecture:'x86_64',cpu:{model:'Test CPU',sockets:2,physicalCores:32,logicalCores:64,usagePercent:10,allowedCores:64},memory:{totalBytes:512*1024**3,availableBytes:400*1024**3,limitBytes:256*1024**3,cgroupUsedBytes:64*1024**3},disks:[{mount:'/data',filesystem:'xfs',totalBytes:1000*1024**3,availableBytes:200*1024**3,usedBytes:800*1024**3}]}}],{hosts:['local-server'],catalog:[{host:'cloud-h200',hosting:'cloud',note:'사용자 제공 정보'}]});
 const app=createApp({dataDir:dir,mode:'demo',origin,distDir:resolve(process.env.LAB_TEST_DIST_DIR||'dist'),serverSource:source,gpuAutoStart:false});server.on('request',app.app);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  await app.servers.poll();await page.goto(origin);await page.getByRole('button',{name:'지민 관리자'}).click();await page.locator('.sidebar').getByRole('button',{name:'연구 자원',exact:true}).click();await page.getByRole('button',{name:'서버 사양',exact:true}).click();
  const card=page.locator('.server-card').filter({hasText:'local-server'});await expect(card.getByText('400.0 GiB',{exact:true})).toBeVisible();await expect(page.getByText('클라우드 서버 · 사용자 제공 정보',{exact:false})).toBeVisible();await expect(card.getByText('2 소켓 · 32 코어 · 64 논리 CPU')).toBeVisible();await card.getByText('컨테이너 제한·사용량',{exact:true}).click();await expect(card.getByText('192.0 GiB',{exact:true})).toBeVisible();
  const role=page.locator('.server-manager-list').getByRole('checkbox',{name:/서연/});await expect(role).not.toBeChecked();await role.click();await expect(role).toBeChecked();const member=app.db.prepare("SELECT id,role FROM users WHERE name='서연'").get();expect(member.role).toBe('member');expect(app.servers.isManager(member.id)).toBe(true);await role.click();await expect(role).not.toBeChecked();expect(app.servers.isManager(member.id)).toBe(false);
  fail=true;await app.servers.poll();await page.getByRole('button',{name:'새로고침',exact:true}).click();await expect(card.getByText('400.0 GiB',{exact:true})).not.toBeVisible();await expect(card.getByText('512.0 GiB',{exact:true})).toBeVisible();
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(errors).toEqual([]);
 }finally{app.close();server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});}
});
