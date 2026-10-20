import {test,expect} from '@playwright/test';
const headers={'X-Lab-Request':'1',Origin:'http://127.0.0.1:4311'};
async function login(page){
  await page.goto('/');await page.getByRole('button',{name:/지민/}).click();
  await expect(page.getByText('대화가 이어지는 중')).toBeVisible();
  await page.locator('.channel-link').filter({hasText:'연구실-라운지'}).click();
  await expect(page.locator('.message-list article').first()).toBeVisible();
}
test('a lost acknowledgement retries the same operation without a duplicate message',async({page})=>{
  await login(page);
  const keys=[];let dropped=false;
  await page.route('**/api/channels/*/messages',async route=>{
    if(route.request().method()!=='POST')return route.continue();
    keys.push(route.request().postDataJSON().clientMessageId);
    if(!dropped){dropped=true;const committed=await route.fetch();expect(committed.status()).toBe(201);return route.abort('failed');}
    return route.continue();
  });
  const body='응답 손실에도 한 번만 저장하는 메시지';
  await page.getByLabel('메시지 입력',{exact:true}).fill(body);
  await page.getByRole('button',{name:'메시지 보내기',exact:true}).click();
  await expect(page.locator('.send-confirmation')).toHaveText('전송됨');
  expect(keys).toHaveLength(2);expect(keys[0]).toBe(keys[1]);
  await expect(page.locator('.message-list .message-body').filter({hasText:body})).toHaveCount(1);
  const search=await page.request.get('/api/search?q='+encodeURIComponent(body));
  expect((await search.json()).messages).toHaveLength(1);
});

test('reconnection recovers offline edits and deletion; unrelated channels do not refetch the open history',async({page,context})=>{
  await login(page);
  const channels=await (await page.request.get('/api/channels')).json();
  const active=channels.find(c=>c.name==='연구실-라운지').id,other=channels.find(c=>c.name==='논문-리딩').id;
  const create=async body=>(await (await page.request.post(`/api/channels/${active}/messages`,{headers,data:{body}})).json());
  const edit=await create('연결 중단 전 본문'),deleted=await create('연결 중단 후 삭제할 본문');
  await expect(page.locator(`.message-list [data-message-id="${deleted.id}"]`)).toBeVisible();
  await context.setOffline(true);
  await page.request.patch(`/api/messages/${edit.id}`,{headers,data:{body:'연결 복구로 받은 수정 본문'}});
  await page.request.delete(`/api/messages/${deleted.id}`,{headers});
  await page.request.post(`/api/messages/${edit.id}/reactions`,{headers,data:{emoji:'✅'}});
  await context.setOffline(false);
  await expect(page.locator(`.message-list [data-message-id="${edit.id}"]`)).toContainText('연결 복구로 받은 수정 본문');
  await expect(page.locator(`.message-list [data-message-id="${edit.id}"]`)).toContainText('✅');
  await expect(page.locator(`.message-list [data-message-id="${deleted.id}"]`)).toContainText('삭제된 메시지입니다.');
  const requests=[];page.on('request',r=>{if(r.method()==='GET')requests.push(new URL(r.url()).pathname);});
  const synced=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/sync'&&r.status()===200);
  await page.request.post(`/api/channels/${other}/messages`,{headers,data:{body:'다른 채널의 변경만 처리'}});
  await synced;
  expect(requests).not.toContain(`/api/channels/${active}/messages`);
  expect(requests).not.toContain('/api/users');expect(requests).not.toContain('/api/channels');
});

test('a failed initial history fetch can recover on focus without a page reload',async({page})=>{
  await login(page);
  const created=await page.request.post('/api/channels',{headers,data:{name:'초기조회-복구'}});
  const {id}=await created.json();
  await page.request.post(`/api/channels/${id}/messages`,{headers,data:{body:'초기 조회 복구 확인'}});
  let fail=true,failures=0;
  await page.route(`**/api/channels/${id}/messages`,route=>{
    if(fail&&route.request().method()==='GET'){failures++;return route.fulfill({status:503,contentType:'application/json',body:'{"error":"temporary outage"}'});}
    return route.continue();
  });
  await page.locator('.channel-link').filter({hasText:'초기조회-복구'}).click();
  await expect(page.getByRole('button',{name:'대화 다시 불러오기'})).toBeVisible();
  expect(failures).toBe(2);
  fail=false;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.message-list .message-body').filter({hasText:'초기 조회 복구 확인'})).toHaveCount(1);
  await expect(page.getByRole('button',{name:'대화 다시 불러오기'})).toHaveCount(0);
});
