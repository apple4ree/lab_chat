import {test,expect} from '@playwright/test';

test('ERP quotas show used/remaining, hide obsolete resets, and refresh real collection jobs',async({page})=>{
  let reads=0,refreshes=0;
  await page.route('**/api/resources/quotas',route=>{
    reads++;const now=Date.now();
    return route.fulfill({json:{source:'erp',fetchedAt:now,demo:false,data:[
      {provider:'codex',account:'DAMI current',plan:'pro',stale:false,verified:true,fiveHourUnlimited:true,collecting:refreshes>0&&reads===2,reportedAt:now,fiveHour:{percent:null,resetsAt:null},sevenDay:{percent:37,resetsAt:now+86400000},servers:[{host:'monitor-dami-codex',lastSeen:now}]},
      {provider:'claude',account:'Unavailable account',plan:'max',stale:true,issue:'최근 수집에 실패했습니다.',reportedAt:1782732857000,fiveHour:{percent:null,resetsAt:1782732857000},sevenDay:{percent:null,resetsAt:null},servers:[]}
    ]}});
  });
  await page.route('**/api/resources/quotas/refresh',route=>{expect(route.request().method()).toBe('POST');refreshes++;return route.fulfill({status:202,json:{queued:refreshes===1}});});
  await page.goto('/');await page.getByRole('button',{name:/지민/}).click();await expect(page.getByText('대화가 이어지는 중')).toBeVisible();
  await page.locator('.sidebar').getByRole('button',{name:'연구 자원',exact:true}).click();await page.getByRole('button',{name:'AI 사용량·한도',exact:true}).click();
  await expect(page.getByText('5시간: 제한 없음 (ERP 표시)',{exact:true})).toBeVisible();await expect(page.getByText('주간: 37% 사용 · 63% 남음',{exact:true})).toBeVisible();
  const failed=page.locator('.resource-quota').filter({hasText:'Unavailable account'});await expect(failed).toContainText('최근 수집에 실패');await expect(failed).not.toContainText('리셋 예정');await expect(failed).toContainText('확인 불가');
  await page.getByRole('button',{name:'사용량 새로고침'}).click();await expect(page.getByRole('button',{name:'수집 결과 확인 중…'})).toBeDisabled();
  await expect(page.getByRole('status')).toContainText('일부 계정은 현재 한도를 확인할 수 없습니다');expect(reads).toBeGreaterThanOrEqual(3);
  await page.getByRole('button',{name:'사용량 새로고침'}).click();await expect(page.getByRole('status')).toContainText('마지막 수집 결과');await expect(page.getByRole('button',{name:'사용량 새로고침'})).toBeEnabled();
  expect(refreshes).toBe(2);
});
