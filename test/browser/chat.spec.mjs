import {test,expect} from '@playwright/test';
import {mkdirSync} from 'node:fs';
const shot='docs/screenshots';
mkdirSync(shot,{recursive:true});
async function login(page,name='지민'){
  await page.goto('/');await page.getByRole('button',{name:new RegExp(name)}).click();
  await expect(page.getByText('대화가 이어지는 중')).toBeVisible();
  await page.locator('.channel-link').filter({hasText:'연구실-라운지'}).click();
  await expect(page.getByRole('heading',{name:'연구실-라운지',exact:true})).toBeVisible();
}
test('desktop: real-time messages, threads, reactions, uploads and search across two browser sessions',async({browser,page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1440,height:1000});await login(page);
  await page.locator('.message-list').evaluate(el=>{el.scrollTop=0;});await page.screenshot({path:`${shot}/desktop.png`,fullPage:true});
  const context=await browser.newContext();const other=await context.newPage();await login(other,'서연');
  await page.getByLabel('메시지 입력',{exact:true}).fill('브라우저 검증: 실시간 실험 결과 공유');await page.getByRole('button',{name:'메시지 보내기',exact:true}).click();
  await expect(other.getByText('브라우저 검증: 실시간 실험 결과 공유',{exact:true})).toBeVisible();
  const message=page.locator('article').filter({hasText:'브라우저 검증: 실시간 실험 결과 공유'});await message.hover();await message.getByRole('button',{name:'스레드 답글'}).click();
  await page.getByLabel('스레드 답글 입력').fill('스레드에서 재현 결과를 확인했습니다.');await page.getByRole('button',{name:'답글 보내기',exact:true}).click();
  await expect(page.getByText('스레드에서 재현 결과를 확인했습니다.',{exact:true})).toBeVisible();
  await page.screenshot({path:`${shot}/thread.png`,fullPage:true});
  await page.getByRole('button',{name:'스레드 닫기'}).click();
  await message.hover();await message.getByRole('button',{name:'반응 추가'}).click();await message.getByRole('button',{name:'✅ 추가',exact:true}).click();
  await expect(message.getByRole('button',{name:'✅ 반응 1개'})).toBeVisible();
  await page.locator('input[type=file]').setInputFiles({name:'browser-results.txt',mimeType:'text/plain',buffer:Buffer.from('browser file round trip')});await page.getByRole('button',{name:'메시지 보내기',exact:true}).click();
  const file=page.getByRole('link',{name:/browser-results.txt/});await expect(file).toBeVisible();
  const download=page.waitForEvent('download');await file.click();expect((await download).suggestedFilename()).toBe('browser-results.txt');
  await page.getByRole('button',{name:/대화, 파일, 연구 기록 검색/}).click();await page.getByRole('textbox',{name:'검색어'}).fill('실시간 실험');
  await expect(page.locator('.result-card')).toHaveCount(1);await page.locator('.result-card').click();await expect(page.getByRole('complementary',{name:'스레드'})).toBeVisible();
  await page.getByRole('button',{name:'스레드 닫기'}).click();await page.reload();await expect(page.getByText('대화가 이어지는 중')).toBeVisible();
  await page.locator('.channel-link').filter({hasText:'연구실-라운지'}).click();await expect(page.getByText('브라우저 검증: 실시간 실험 결과 공유',{exact:true})).toBeVisible();
  expect(errors).toEqual([]);await context.close();
});
test('private channel creation, membership, direct messages and mentions work in the UI',async({browser,page})=>{
  await login(page);await page.getByRole('button',{name:'채널 만들기',exact:true}).click();
  await page.getByLabel('채널 이름',{exact:true}).fill('브라우저-비공개');await page.getByLabel('채널 설명').fill('접근 권한 검증 채널');await page.getByRole('radio').nth(1).check();await page.getByRole('checkbox',{name:'서연'}).check();await page.getByRole('button',{name:'채널 만들기',exact:true}).last().click();
  await expect(page.getByRole('heading',{name:'브라우저-비공개',exact:true})).toBeVisible();await page.getByLabel('메시지 입력',{exact:true}).fill('비공개 메시지 @seoyeon');await page.getByRole('button',{name:'메시지 보내기',exact:true}).click();
  const context=await browser.newContext(),outside=await context.newPage();await login(outside,'도윤');await expect(outside.locator('.channel-link').filter({hasText:'브라우저-비공개'})).toHaveCount(0);
  const memberContext=await browser.newContext(),member=await memberContext.newPage();await login(member,'서연');await member.getByRole('navigation',{name:'주 메뉴'}).getByRole('button',{name:'내 멘션',exact:true}).click();await expect(member.locator('.result-card').filter({hasText:'비공개 메시지'})).toBeVisible();await member.getByRole('button',{name:'창 닫기'}).click();
  await page.getByRole('button',{name:'DM 시작'}).click();await page.getByRole('dialog').getByRole('button',{name:/서연/}).click();await expect(page.getByRole('heading',{name:'서연',exact:true})).toBeVisible();await page.getByLabel('메시지 입력',{exact:true}).fill('DM으로 공유하는 실험 일정');await page.getByRole('button',{name:'메시지 보내기',exact:true}).click();
  await expect(member.locator('.channel-link').filter({hasText:'지민'})).toBeVisible();await member.locator('.channel-link').filter({hasText:'지민'}).click();await expect(member.getByText('DM으로 공유하는 실험 일정',{exact:true})).toBeVisible();await context.close();await memberContext.close();
});
test('mobile navigation, composer and modal layouts stay within the viewport',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:390,height:844});await page.goto('/');await page.getByRole('button',{name:/지민/}).click();await page.getByRole('button',{name:'채널 목록 열기'}).click();await page.locator('.channel-link').filter({hasText:'연구실-라운지'}).click();
  await expect(page.getByLabel('메시지 입력',{exact:true})).toBeVisible();await page.screenshot({path:`${shot}/mobile.png`,fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.getByRole('button',{name:/대화, 파일, 연구 기록 검색/}).click();await expect(page.getByRole('dialog')).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.getByRole('button',{name:'창 닫기'}).click();
  await page.getByLabel('메시지 입력',{exact:true}).fill('모바일에서 보내는 메시지');await page.getByRole('button',{name:'메시지 보내기',exact:true}).click();await expect(page.getByText('모바일에서 보내는 메시지',{exact:true})).toBeVisible();expect(errors).toEqual([]);
});
test('local accounts: first admin, invitation, invited login, password change and logout',async({browser,page})=>{
  await page.goto('http://127.0.0.1:4312/');await page.getByLabel('최초 설정 코드').fill('browser-test-setup-code');await page.getByLabel('이름',{exact:true}).fill('관리자');await page.getByLabel('이메일',{exact:true}).fill('admin@example.test');await page.getByLabel('비밀번호',{exact:true}).fill('browser-test-password');await page.getByRole('button',{name:'연구실 공간 만들기'}).click();await expect(page.getByText('대화가 이어지는 중')).toBeVisible();
  await page.getByRole('button',{name:'설정',exact:true}).click();await page.getByLabel(/초대 이메일/).fill('invited@example.test');await page.getByRole('button',{name:'초대 링크 만들기'}).click();const url=await page.getByLabel('초대 링크',{exact:true}).inputValue();expect(url).toMatch(/4312\/#invite=/);
  const context=await browser.newContext(),invited=await context.newPage();await invited.goto(url);await invited.getByLabel('이름',{exact:true}).fill('초대연구원');await invited.getByRole('textbox',{name:/^이메일/}).fill('invited@example.test');await invited.getByLabel('비밀번호',{exact:true}).fill('invited-password-123');await invited.getByRole('button',{name:'가입하고 시작하기'}).click();await expect(invited.getByText('대화가 이어지는 중')).toBeVisible();
  await invited.getByRole('button',{name:'내 계정',exact:true}).click();await invited.getByLabel('현재 비밀번호').fill('invited-password-123');await invited.getByLabel('새 비밀번호',{exact:true}).fill('updated-password-123');await invited.getByLabel('새 비밀번호 확인',{exact:true}).fill('different-password-123');await invited.getByRole('button',{name:'비밀번호 변경',exact:true}).click();await expect(invited.getByRole('dialog').getByRole('alert')).toContainText('일치하지 않습니다');await invited.getByLabel('새 비밀번호 확인',{exact:true}).fill('updated-password-123');await invited.getByLabel('현재 비밀번호').fill('wrong-current-password');await invited.getByRole('button',{name:'비밀번호 변경',exact:true}).click();await expect(invited.getByRole('dialog').getByRole('alert')).toContainText('현재 비밀번호가 일치하지 않습니다');await invited.getByLabel('현재 비밀번호').fill('invited-password-123');await invited.getByRole('button',{name:'비밀번호 변경',exact:true}).click();await expect(invited.getByRole('dialog').getByRole('status')).toContainText('변경되었습니다');await invited.getByRole('button',{name:'로그아웃',exact:true}).click();await expect(invited.getByRole('button',{name:'로그인',exact:true})).toBeVisible();await invited.getByRole('textbox',{name:/^이메일/}).fill('invited@example.test');await invited.getByLabel('비밀번호',{exact:true}).fill('updated-password-123');await invited.getByRole('button',{name:'로그인',exact:true}).click();await expect(invited.getByText('대화가 이어지는 중')).toBeVisible();await context.close();
});
test('loaded older history remains present and updates after real-time changes',async({page})=>{
  await login(page);
  const headers={'X-Lab-Request':'1',Origin:'http://127.0.0.1:4311'};
  const created=await page.request.post('/api/channels',{headers,data:{name:'이전기록-검증'}});expect(created.status()).toBe(201);const {id}=await created.json();
  let firstId;
  for(let i=0;i<85;i++){
    const r=await page.request.post(`/api/channels/${id}/messages`,{headers,data:{body:`이전 기록 메시지 ${i}`}});expect(r.status()).toBe(201);if(i===0)firstId=(await r.json()).id;
  }
  await page.locator('.channel-link').filter({hasText:'이전기록-검증'}).click();
  await expect(page.locator('.message-list article')).toHaveCount(80);await page.getByRole('button',{name:'이전 메시지 불러오기'}).click();await expect(page.locator('.message-list article')).toHaveCount(85);
  await page.request.post(`/api/channels/${id}/messages`,{headers,data:{body:'실시간 추가된 새 기록'}});
  await expect(page.locator('.message-list article')).toHaveCount(86);await expect(page.getByText('이전 기록 메시지 0',{exact:true})).toHaveCount(1);
  await page.request.patch(`/api/messages/${firstId}`,{headers,data:{body:'과거 메시지 수정 확인'}});
  await expect(page.getByText('과거 메시지 수정 확인',{exact:true})).toHaveCount(1);await expect(page.getByText('이전 기록 메시지 0',{exact:true})).toHaveCount(0);
});
