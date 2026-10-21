import {test,expect} from '@playwright/test';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from '../../server/app.mjs';

test('local GPU history renders its collection boundary and empty-data state without an external dashboard',async({page})=>{
  const dir=mkdtempSync(join(tmpdir(),'gpu-local-browser-')),server=createServer();
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`;
  let report=Date.now()-120000;
  const service=createApp({dataDir:dir,origin,setupToken:'isolated-browser-setup',gpuAutoStart:false,
    distDir:resolve(process.env.LAB_TEST_DIST_DIR||'dist'),
    gpuSource:async()=>[{host:'isolated-gpu',ts:report/1000,gpus:[{index:0,name:'Isolated GPU',util:25,mem_total:8192,mem_used:1024,procs:[{pid:1,user:'isolated-user',used_mem:1024}]}]}]});
  server.on('request',service.app);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  try{
    await page.goto(origin);
    await page.getByLabel('최초 설정 코드').fill('isolated-browser-setup');
    await page.getByLabel('이름',{exact:true}).fill('검증 관리자');
    await page.getByLabel('이메일',{exact:true}).fill('isolated@example.test');
    await page.getByLabel('비밀번호',{exact:true}).fill('isolated-browser-password');
    await page.getByRole('button',{name:'연구실 공간 만들기'}).click();
    await expect(page.getByText('대화가 이어지는 중')).toBeVisible();
    await page.locator('.sidebar').getByRole('button',{name:'연구 자원',exact:true}).click();
    await page.getByRole('button',{name:'사용 이력',exact:true}).click();
    await expect(page.getByText('첫 번째 유효한 GPU 보고를 기다리고 있습니다.',{exact:false})).toBeVisible();
    await service.gpu.poll();report+=15000;await service.gpu.poll();
    await page.getByRole('button',{name:'이력 새로고침'}).click();
    await expect(page.getByText('채팅 서버 자체 기록 · 수집 시작',{exact:false})).toBeVisible();
    await expect(page.locator('.resource-chart circle')).not.toHaveCount(0);
    await expect(page.getByRole('cell',{name:'isolated-user',exact:true})).toBeVisible();
    expect(await page.locator('iframe').count()).toBe(0);
    await page.setViewportSize({width:390,height:844});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  }finally{service.close();server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});}
});
