import {test,expect} from '@playwright/test';
async function open(page){await page.goto('/');await page.getByRole('button',{name:/지민/}).click();await page.locator('.sidebar').getByRole('button',{name:'연구 자원',exact:true}).click();await page.getByRole('button',{name:'AI 사용량·한도',exact:true}).click();return page.getByRole('region',{name:'CLI 사용량 추이'});}

test('CLI trend shows weekly account history, errors, reset gaps, metric/range controls and paged rows on mobile',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));const panel=await open(page);
  await expect(panel.getByRole('img',{name:'CLI 주간 한도 잔여율 추이'})).toBeVisible();
  expect((await panel.locator('svg path').getAttribute('d')).match(/M/g).length).toBeGreaterThan(1);
  await panel.getByLabel('추이 기간',{exact:true}).selectOption('3');await expect(panel.getByText(/288개 기록/)).toBeVisible();
  await panel.getByLabel('추이 측정값',{exact:true}).selectOption('used');await expect(panel.getByRole('img',{name:'CLI 주간 한도 사용률 추이'})).toBeVisible();
  await panel.getByText('추이 수치·수집 상태 보기',{exact:true}).click();await expect(panel.locator('tbody tr')).toHaveCount(50);
  await panel.getByRole('button',{name:'이전 기록',exact:true}).click();await expect(panel.getByText('2 / 6 페이지',{exact:true})).toBeVisible();await expect(panel.getByRole('cell',{name:'수집 시간 초과',exact:true})).toBeVisible();
  await panel.getByLabel('추이 계정',{exact:true}).selectOption('sample-claude');await expect(panel.getByRole('img')).toBeVisible();await expect(panel.getByText('1 / 6 페이지',{exact:true})).toBeVisible();
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(errors).toEqual([]);
});

test('CLI trend cancels superseded account reads and exposes empty data and source failures without old charts',async({page})=>{
  const panel=await open(page);await expect(panel.getByRole('img')).toBeVisible();
  let release;const gate=new Promise(r=>{release=r;});
  await page.route('**/api/resources/quotas/history?*',async route=>{
    const url=new URL(route.request().url());if(url.searchParams.get('days')==='7'){await gate;await route.continue().catch(()=>{});return;}
    const response=await route.fetch(),result=await response.json();result.data.points=[];await route.fulfill({json:result});
  });
  const pending=page.waitForRequest(r=>r.url().includes('/quotas/history?')&&r.url().includes('days=7'));
  await panel.getByLabel('추이 기간',{exact:true}).selectOption('7');await pending;
  await panel.getByLabel('추이 기간',{exact:true}).selectOption('3');release();
  await expect(panel.getByText('선택한 기간의 수집 기록이 없습니다. 사용량 0을 의미하지 않습니다.',{exact:true})).toBeVisible();await expect(panel.getByRole('img')).toHaveCount(0);
  await page.unroute('**/api/resources/quotas/history?*');await page.route('**/api/resources/quotas/history?*',route=>route.fulfill({status:503,json:{error:'ERP 연결 실패'}}));
  await panel.getByRole('button',{name:'추이 새로고침'}).click();await expect(panel.getByRole('alert')).toHaveText('ERP 연결 실패');await expect(panel.getByRole('img')).toHaveCount(0);
});
