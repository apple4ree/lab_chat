import {test,expect} from '@playwright/test';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createApp} from '../../server/app.mjs';

test('server manager registers server and GPU, sees declared-only capacity, and edits equipment without becoming an admin',async({page})=>{
 const dir=mkdtempSync(join(tmpdir(),'catalog-ui-')),server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;
 const app=createApp({dataDir:dir,mode:'demo',origin,distDir:resolve(process.env.LAB_TEST_DIST_DIR||'dist'),gpuAutoStart:false});server.on('request',app.app);
 const admin=app.db.prepare("SELECT id FROM users WHERE role='admin'").get(),manager=app.db.prepare("SELECT id,role FROM users WHERE name='서연'").get();app.servers.setManager(admin.id,manager.id,true);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.goto(origin);await page.getByRole('button',{name:'서연 연구원'}).click();await page.locator('.sidebar').getByRole('button',{name:'연구 자원',exact:true}).click();await page.getByRole('button',{name:'서버 사양',exact:true}).click();await page.getByRole('button',{name:'자원 등록·관리',exact:true}).click();
  await page.getByLabel('서버 식별자',{exact:true}).fill('cloud-test');await page.getByLabel('서버 표시 이름',{exact:true}).fill('클라우드 연구 서버');await page.getByLabel('서버 구분',{exact:true}).selectOption('cloud');await page.getByLabel('CPU 모델 (등록 사양)').fill('Registered CPU');await page.getByLabel('RAM 전체 (GiB, 선택)').fill('256');await page.getByLabel('서버 안내',{exact:true}).fill('프로젝트 전용\n수집 연결 예정');await page.getByRole('button',{name:'서버 등록 저장',exact:true}).click();
  await expect(page.getByText('자원 정보를 저장했습니다.',{exact:false})).toBeVisible();const card=page.locator('.server-card').filter({hasText:'클라우드 연구 서버'});await expect(card.getByText('등록 사양 · 관리자 입력',{exact:true})).toBeVisible();await expect(card.getByText('등록 사양이며 현재 가용량을 의미하지 않습니다.',{exact:true})).toBeVisible();await expect(card.getByText('확인 대기',{exact:true})).toBeVisible();
  await page.getByLabel('자원 종류',{exact:true}).selectOption('gpu');await page.getByLabel('GPU 표시 이름',{exact:true}).fill('실험 GPU');await page.getByLabel('GPU 모델 (등록 사양)').fill('H200');await page.getByLabel('VRAM 전체 (GiB, 선택)').fill('140');await page.getByRole('button',{name:'GPU 등록 저장',exact:true}).click();await expect(card.getByText('등록 사양 · VRAM 140 GiB · 현재 상태 미수집')).toBeVisible();
  await page.getByRole('button',{name:'예약·배정',exact:true}).click();await page.getByRole('button',{name:'장비 설정 · 실험 GPU',exact:true}).click();await page.getByLabel('장비 이름',{exact:true}).fill('이름 변경 GPU');await page.getByRole('button',{name:'장비 설정 저장',exact:true}).click();await expect(page.getByRole('button',{name:'장비 설정 · 이름 변경 GPU',exact:true})).toBeVisible();expect(app.db.prepare('SELECT role FROM users WHERE id=?').get(manager.id).role).toBe('member');
  await page.getByRole('button',{name:'서버 사양',exact:true}).click();await page.getByRole('button',{name:'자원 등록·관리',exact:true}).click();await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(errors).toEqual([]);
 }finally{app.close();server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});}
});
