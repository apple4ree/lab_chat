import {test,expect} from '@playwright/test';

async function open(page){
  await page.goto('/');await page.getByRole('button',{name:/지민/}).click();
  await expect(page.getByText('대화가 이어지는 중')).toBeVisible();
  if((await page.viewportSize()).width<761)await page.getByRole('button',{name:'채널 목록 열기'}).click();
  await page.locator('.sidebar').getByRole('button',{name:'연구 자원',exact:true}).click();
  await expect(page.getByRole('heading',{name:'연구에 필요한 연산 자원'})).toBeVisible();
}
test('GPU inventory distinguishes resident work, filters resources, and opens the alert conversation',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1440,height:1000});await open(page);
  await expect(page.locator('.gpu-card')).toHaveCount(4);
  await expect(page.getByText('체험용 샘플 장비입니다.',{exact:false})).toBeVisible();
  const resident=page.locator('.gpu-card').filter({hasText:'메모리·작업 상주'});await expect(resident).toContainText('12.0 / 140.0');await resident.getByText('관측된 작업 1개').click();await expect(resident).toContainText('sample-user');
  const offline=page.locator('.gpu-card').filter({hasText:'보고 중단'});await expect(offline).toContainText('— / 96.0');
  await page.screenshot({path:'docs/screenshots/gpu-desktop.png',fullPage:true});
  await page.getByLabel('상태',{exact:true}).selectOption('idle');await expect(page.locator('.gpu-card')).toHaveCount(1);await expect(page.locator('.gpu-card')).toContainText('GPU 1');
  await page.getByRole('button',{name:'#gpu-자원 알림'}).click();await expect(page.getByRole('heading',{name:'gpu-자원',exact:true})).toBeVisible();await expect(page.getByText('GPU 상태 알림을 시작합니다.',{exact:false})).toBeVisible();await expect(page.getByText('자동 알림',{exact:true})).toBeVisible();
  await page.getByLabel('메시지 입력',{exact:true}).fill('GPU 사용 일정을 여기서 조율합니다.');await page.getByRole('button',{name:'메시지 보내기',exact:true}).click();await expect(page.getByText('GPU 사용 일정을 여기서 조율합니다.',{exact:true})).toBeVisible();expect(errors).toEqual([]);
});
test('GPU mobile view fits the screen and preserves navigation',async({page})=>{
  await page.setViewportSize({width:390,height:844});await open(page);await expect(page.locator('.gpu-card')).toHaveCount(4);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'docs/screenshots/gpu-mobile.png',fullPage:true});
  await page.getByLabel('서버',{exact:true}).selectOption('샘플-오프라인');await expect(page.locator('.gpu-card')).toHaveCount(1);await page.getByRole('button',{name:'채널 목록 열기'}).click();await page.locator('.channel-link').filter({hasText:'연구실-라운지'}).click();await expect(page.getByLabel('메시지 입력',{exact:true})).toBeVisible();
});
