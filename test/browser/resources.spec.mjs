import {test,expect} from '@playwright/test';

async function open(page,name='지민'){
  await page.goto('/');await page.getByRole('button',{name:new RegExp(name)}).click();await expect(page.getByText('대화가 이어지는 중')).toBeVisible();
  if(page.viewportSize().width<761)await page.getByRole('button',{name:'채널 목록 열기'}).click();
  await page.locator('.sidebar').getByRole('button',{name:'연구 자원',exact:true}).click();
}
test('resource history supports multi-GPU selection, range/metric controls, tables, and missing selection',async({page})=>{
  const historyRequests=[];page.on('request',r=>{if(r.url().includes('/api/resources/history'))historyRequests.push(r);});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await open(page);await page.getByRole('button',{name:'사용 이력',exact:true}).click();
  await expect(page.getByRole('img',{name:'GPU 연산 사용률 이력'})).toBeVisible();await expect(page.locator('.resource-chart path')).toHaveCount(3);await expect(page.locator('.resource-chart path').first()).toBeVisible();
  expect(historyRequests).toHaveLength(1);expect(historyRequests[0].method()).toBe('POST');expect(historyRequests[0].postDataJSON().targets).toHaveLength(3);
  await page.getByLabel('측정값',{exact:true}).selectOption('memoryGiB');await page.getByLabel('이력 기간',{exact:true}).selectOption('week');
  await expect(page.getByRole('img',{name:'GPU 메모리 사용 이력'})).toBeVisible();await expect(page.locator('.resource-chart path')).toHaveCount(3);
  await page.getByText('수집 시각과 수치 표로 보기',{exact:true}).click();await expect(page.getByRole('cell',{name:'샘플-H200 · GPU 0',exact:true}).first()).toBeVisible();
  await page.getByRole('button',{name:'선택 해제',exact:true}).click();await expect(page.getByText('비교할 GPU를 선택해 주세요.',{exact:true})).toBeVisible();
  await page.getByRole('checkbox',{name:'샘플-H200 · GPU 1',exact:true}).check();await expect(page.locator('.resource-chart path')).toHaveCount(1);
  await expect(page.getByRole('cell',{name:'sample-researcher',exact:true})).toBeVisible();expect(errors).toEqual([]);
});

test('history cancels superseded selections and shows failures instead of old charts',async({page})=>{
  await open(page);await page.getByRole('button',{name:'사용 이력',exact:true}).click();await expect(page.locator('.resource-chart path')).toHaveCount(3);
  let release;const gate=new Promise(resolve=>{release=resolve;});
  await page.route('**/api/resources/history/batch',async route=>{
    if(route.request().postDataJSON().period==='month'){await gate;await route.continue().catch(()=>{});}
    else await route.continue();
  });
  const pending=page.waitForRequest(r=>r.url().endsWith('/history/batch')&&r.postDataJSON().period==='month');
  await page.getByLabel('이력 기간',{exact:true}).selectOption('month');await pending;
  await page.getByRole('button',{name:'선택 해제',exact:true}).click();release();
  await expect(page.locator('.resource-chart path')).toHaveCount(0);await expect(page.getByText('비교할 GPU를 선택해 주세요.',{exact:true})).toBeVisible();
  await page.unroute('**/api/resources/history/batch');
  await page.route('**/api/resources/history/batch',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'수집 서버 연결 실패'})}));
  await page.getByRole('checkbox',{name:'샘플-H200 · GPU 1',exact:true}).check();
  await expect(page.getByRole('alert')).toHaveText('수집 서버 연결 실패');await expect(page.locator('.resource-chart path')).toHaveCount(0);
});

test('members request reservations; admins review, approve, assign, and record audited decisions',async({page,browser})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await open(page,'서연');await page.getByRole('button',{name:'예약·배정',exact:true}).click();
  await expect(page.getByRole('button',{name:/장비 설정 ·/})).toHaveCount(0);
  await page.getByRole('button',{name:'예약 신청',exact:true}).click();await page.getByLabel('프로젝트',{exact:true}).fill('브라우저 검증 실험');await page.getByLabel('사용 목적·근거',{exact:true}).fill('모델 재현 실험용 예약');await page.getByLabel('예약 GPU',{exact:true}).selectOption({label:'샘플-H200 · GPU 1'});await page.getByRole('button',{name:'신청 저장',exact:true}).click();
  const booking=page.locator('.resource-booking').filter({hasText:'브라우저 검증 실험'});await expect(booking.locator('.reservation-status')).toHaveText('신청');await expect(booking.getByRole('button',{name:'승인 처리'})).toHaveCount(0);
  const admin=await browser.newPage();try{
    await open(admin);await admin.getByRole('button',{name:'예약·배정',exact:true}).click();
    const card=admin.locator('.resource-booking').filter({hasText:'브라우저 검증 실험'});
    for(const [button,confirmed,label] of [['검토 중 처리','검토 중 확정','검토 중'],['승인 처리','승인 확정','승인'],['배정 처리','배정 확정','배정']]){
      await card.getByRole('button',{name:button,exact:true}).click();await card.getByLabel('처리 사유',{exact:true}).fill('검토 완료');await card.getByRole('button',{name:confirmed,exact:true}).click();await expect(card.locator('.reservation-status')).toHaveText(label);
    }
    await card.getByRole('button',{name:'처리 이력',exact:true}).click();await expect(card.locator('.resource-event-list')).toContainText('검토 완료');
    await admin.screenshot({path:'docs/screenshots/resource-reservations.png',fullPage:true});
    await page.getByRole('button',{name:'예약 새로고침',exact:true}).click();await expect(booking.locator('.reservation-status')).toHaveText('배정');await expect(booking.getByRole('button',{name:'예약 수정',exact:true})).toHaveCount(0);
    await booking.getByRole('button',{name:'예약 취소',exact:true}).click();await booking.getByRole('button',{name:'취소 확정',exact:true}).click();await expect(booking.locator('.reservation-status')).toHaveText('취소');
  }finally{await admin.close();}
  expect(errors).toEqual([]);
});

test('AI account data labels stale quotas, filters costs, and persists admin manual balance records',async({page})=>{
  await open(page);await page.getByRole('button',{name:'AI 사용량·한도',exact:true}).click();
  await expect(page.getByText('보고 지연 · 현재 한도 확인 불가',{exact:true})).toBeVisible();await expect(page.getByText('주간: 54% 사용 · 46% 남음',{exact:true})).toBeVisible();
  await expect(page.locator('.resource-quota').filter({has:page.getByRole('heading',{name:/^codex /})}).getByText(/^5시간:/)).toHaveCount(0);await expect(page.locator('.resource-quota').filter({has:page.getByRole('heading',{name:/^claude /})}).getByText('5시간: 확인 불가',{exact:true})).toBeVisible();
  await page.getByLabel('공급자',{exact:true}).selectOption('google');await expect(page.getByText('선택한 기간·공급자의 집계 데이터가 없습니다.',{exact:true})).toBeVisible();
  await page.getByLabel('공급자',{exact:true}).selectOption('openai');await expect(page.getByRole('cell',{name:'sample-model-a',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'잔액 기록 수정 · openai',exact:true}).click();await page.getByLabel('잔액',{exact:true}).fill('123.45');await page.getByRole('button',{name:'잔액 저장',exact:true}).click();await expect(page.getByText('메신저 기록: 123.45 USD',{exact:false})).toBeVisible();
  await page.screenshot({path:'docs/screenshots/resource-accounts.png',fullPage:true});
});

test('all resource views and reservation form fit mobile width without exposing admin controls to members',async({page})=>{
  await page.setViewportSize({width:390,height:844});await open(page,'도윤');
  for(const tab of ['사용 이력','예약·배정','AI 사용량·한도']){
    await page.getByRole('button',{name:tab,exact:true}).click();
    if(tab==='사용 이력')await expect(page.locator('.resource-chart path')).toHaveCount(3);
    if(tab==='예약·배정'){await page.getByRole('button',{name:'예약 신청',exact:true}).click();await expect(page.getByRole('form',{name:'예약 신청서'})).toBeVisible();}
    if(tab==='AI 사용량·한도'){await expect(page.getByText('주간: 54% 사용 · 46% 남음',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:/잔액 기록 수정/})).toHaveCount(0);}
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
  await page.screenshot({path:'docs/screenshots/resource-mobile.png',fullPage:true});
});
