import {test,expect} from '@playwright/test';

async function open(page){
  await page.addInitScript(()=>{
    window.arrivals=[];
    const animate=Element.prototype.animate;
    Element.prototype.animate=function(frames,options){
      if(options?.id==='message-arrival')window.arrivals.push(this.dataset.messageId);
      return animate.call(this,frames,options);
    };
  });
  await page.goto('/');
  await page.getByRole('button',{name:/지민/}).click();
  await expect(page.getByText('대화가 이어지는 중')).toBeVisible();
  await page.locator('.channel-link').filter({hasText:'연구실-라운지'}).click();
  await expect(page.locator('.message-list article').first()).toBeVisible();
  await expect(page.locator('.inline-loading')).toHaveCount(0);
}
const headers={'X-Lab-Request':'1',Origin:'http://127.0.0.1:4311'};

test('arrival motion runs once for new messages; edits, reactions and channel return stay still',async({page})=>{
  await page.emulateMedia({reducedMotion:'no-preference'});
  await open(page);
  expect(await page.evaluate(()=>window.arrivals)).toEqual([]);
  const ids=await page.locator('.message-list article').evaluateAll(rows=>rows.map(r=>r.dataset.messageId));
  await page.getByLabel('메시지 입력',{exact:true}).fill('동작 검증 새 메시지');
  await page.getByRole('button',{name:'메시지 보내기',exact:true}).click();
  await expect(page.locator('.send-confirmation')).toHaveText('전송됨');
  await expect(page.getByLabel('메시지 입력',{exact:true})).toBeFocused();
  await expect.poll(()=>page.evaluate(()=>window.arrivals.length)).toBe(1);
  const id=await page.evaluate(()=>window.arrivals[0]);expect(ids).not.toContain(id);
  await page.request.patch(`/api/messages/${id}`,{headers,data:{body:'수정해도 다시 등장하지 않음'}});
  await expect(page.getByText('수정해도 다시 등장하지 않음',{exact:true})).toBeVisible();
  const message=page.locator(`.message-list [data-message-id="${id}"]`);
  await message.hover();await message.getByRole('button',{name:'반응 추가'}).click();
  await message.getByRole('button',{name:'✅ 추가',exact:true}).click();
  await expect(message.getByRole('button',{name:'✅ 반응 1개'})).toBeVisible();
  expect(await page.evaluate(()=>window.arrivals)).toEqual([id]);
  await message.hover();await message.getByRole('button',{name:'스레드 답글'}).click();
  await expect(page.locator('.thread-panel')).toBeVisible();
  await page.getByLabel('스레드 답글 입력').fill('새 답글 동작');
  await page.getByRole('button',{name:'답글 보내기',exact:true}).click();
  await expect(page.getByText('새 답글 동작',{exact:true})).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>window.arrivals.length)).toBe(2);
  await page.getByRole('button',{name:'스레드 닫기'}).click();
  await page.locator('.channel-link').filter({hasText:'gpu-자원'}).click();
  await expect(page.getByRole('heading',{name:'gpu-자원',exact:true})).toBeVisible();
  await page.locator('.channel-link').filter({hasText:'연구실-라운지'}).click();
  await expect(page.getByText('수정해도 다시 등장하지 않음',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>window.arrivals.length)).toBe(2);
});

test('reduced motion disables entrances and transitions; failed sends retain the draft',async({page})=>{
  await page.emulateMedia({reducedMotion:'reduce'});
  await open(page);
  await page.getByRole('button',{name:/대화, 파일, 연구 기록 검색/}).click();
  const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(el=>({
    animation:getComputedStyle(el).animationName,
    backdrop:getComputedStyle(el,'::backdrop').animationName,
    transition:getComputedStyle(el.querySelector('button')).transitionDuration,
  }))).toEqual({animation:'none',backdrop:'none',transition:'0s'});
  await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);
  await page.route('**/api/channels/*/messages',route=>route.request().method()==='POST'
    ?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'전송 테스트 오류'})})
    :route.continue());
  await page.getByLabel('메시지 입력',{exact:true}).fill('실패해도 남아 있는 초안');
  await page.getByRole('button',{name:'메시지 보내기',exact:true}).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByLabel('메시지 입력',{exact:true})).toHaveValue('실패해도 남아 있는 초안');
  await expect(page.locator('.send-confirmation')).toHaveCount(0);
  await page.unroute('**/api/channels/*/messages');
  await page.getByRole('button',{name:'메시지 보내기',exact:true}).click();
  await expect(page.getByText('실패해도 남아 있는 초안',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>window.arrivals)).toEqual([]);
  // The OS preference can change while the app stays open.
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.getByLabel('메시지 입력',{exact:true}).fill('설정 변경 후 새 메시지');
  await page.getByRole('button',{name:'메시지 보내기',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.arrivals.length)).toBe(1);
});
