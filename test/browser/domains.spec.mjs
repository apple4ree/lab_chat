import {test,expect} from '@playwright/test';
import {createApp} from '../../server/app.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {once} from 'node:events';

test('admin changes the domain through verification and password confirmation without navigating away or losing a draft',async({page})=>{
  const dir=mkdtempSync(join(tmpdir(),'domain-browser-')),target='https://new.example.org';let service,server;
  try{
    // Isolated app and DB; only the external HTTPS probe is substituted.
    service=createApp({dataDir:dir,origin:'http://127.0.0.1:4314',setupToken:'domain-setup',gpuAutoStart:false,distDir:resolve(process.env.LAB_TEST_DIST_DIR||'dist'),domainProbe:async()=>JSON.parse(service.db.prepare("SELECT value FROM app_meta WHERE key='workspace_domains'").get().value)});
    server=service.app.listen(4314,'127.0.0.1');await once(server,'listening');
    await page.goto('http://127.0.0.1:4314');await page.getByLabel('최초 설정 코드').fill('domain-setup');await page.getByLabel('이름',{exact:true}).fill('관리자');await page.getByLabel('이메일',{exact:true}).fill('domain@example.org');await page.getByLabel('비밀번호',{exact:true}).fill('test-password-123');await page.getByRole('button',{name:'연구실 공간 만들기'}).click();
    await page.getByLabel('메시지 입력',{exact:true}).fill('아직 보내지 않은 초안');
    await page.getByRole('button',{name:'설정',exact:true}).click();await page.getByLabel('새 접속 주소').fill(target);await page.getByRole('button',{name:'새 주소 연결 확인'}).click();
    await expect(page.getByText('같은 연구실 서비스로 연결됩니다.',{exact:false})).toBeVisible();
    const apply=page.getByRole('button',{name:'대표 주소 변경 적용'});await expect(apply).toBeDisabled();
    await page.getByLabel('현재 관리자 비밀번호').fill('incorrect');await page.getByLabel(/기존 도메인을 계속 유지/).check();await apply.click();await expect(page.getByRole('alert')).toContainText('비밀번호가 일치하지 않습니다');
    await page.getByLabel('현재 관리자 비밀번호').fill('test-password-123');await apply.click();await expect(page.getByText('대표 접속 주소를 변경했습니다.',{exact:false})).toBeVisible();
    await page.getByRole('button',{name:'창 닫기',exact:true}).click();await expect(page.getByLabel('메시지 입력',{exact:true})).toHaveValue('아직 보내지 않은 초안');
    await expect(page.getByRole('link',{name:'새 주소를 브라우저에서 열기'})).toHaveAttribute('href',target);await expect(page.getByRole('link',{name:'새 주소를 브라우저에서 열기'})).toHaveAttribute('target','_blank');
    await page.reload();await expect(page.getByLabel('접속 주소 변경 안내')).toBeVisible();
    await page.getByRole('button',{name:'설정',exact:true}).click();await expect(page.getByLabel('접속 도메인 관리')).toContainText(target);
  }finally{if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}service?.close();rmSync(dir,{recursive:true,force:true});}
});
test('demo shows domain settings read-only and member settings contain only their profile',async({page})=>{
  await page.goto('/');await page.getByRole('button',{name:/지민/}).click();await page.getByRole('button',{name:'설정',exact:true}).click();await expect(page.getByText('체험 공간에서는 접속 주소를 변경할 수 없습니다.')).toBeVisible();await expect(page.getByLabel('새 접속 주소')).toHaveCount(0);
});
