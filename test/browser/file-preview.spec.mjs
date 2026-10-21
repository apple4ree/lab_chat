import {test,expect} from '@playwright/test';

const headers={'X-Lab-Request':'1',Origin:'http://127.0.0.1:4311'};
async function setup(page){
  await page.goto('/');await page.getByRole('button',{name:/지민/}).click();
  await expect(page.getByText('대화가 이어지는 중')).toBeVisible();
  const name=`preview-${Date.now()}`;
  const response=await page.request.post('/api/channels',{headers,data:{name}});
  expect(response.status()).toBe(201);const channel={...await response.json(),name};
  await page.locator('.channel-link').filter({hasText:channel.name}).click();return channel;
}
async function upload(page,channel,name,mimeType,buffer,parentId){
  const response=await page.request.post(`/api/channels/${channel.id}/files`,{headers,multipart:{file:{name,mimeType,buffer:Buffer.from(buffer)},...(parentId?{parentId:String(parentId)}:{})}});
  expect(response.status()).toBe(201);return response.json();
}
test('HTML preview is isolated, toggles persist, threads keep drafts, deletion closes it',async({page})=>{
  await page.setViewportSize({width:1440,height:1000});const channel=await setup(page);
  const requests=[],blocked=[];page.on('response',r=>{if(r.url().includes('preview-attack'))requests.push(r.url());});page.on('requestfailed',r=>{if(r.url().includes('preview-attack'))blocked.push(r.failure()?.errorText);});
  const html='<h1>Research Preview</h1><style>h1{color:rgb(12,34,56)}</style><script>parent.document.body.dataset.pwned="yes";fetch("/preview-attack-script")</script><img src="/preview-attack-image"><iframe src="/preview-attack-frame"></iframe><form action="/preview-attack-form"><button>send</button></form>';
  const message=await upload(page,channel,'research.html','text/html',html);
  const card=page.locator('.message-list .file-card').filter({hasText:'research.html'});
  await card.click();const panel=page.getByRole('complementary',{name:'첨부파일 미리보기'});
  await expect(panel).toBeVisible();const frame=page.frameLocator('.file-preview-panel iframe');
  await expect(frame.getByRole('heading',{name:'Research Preview'})).toBeVisible();
  await expect(frame.getByRole('heading')).toHaveCSS('color','rgb(12, 34, 56)');
  expect(await page.evaluate(()=>document.body.dataset.pwned)).toBeUndefined();expect(requests).toEqual([]);expect(blocked.some(reason=>/csp/i.test(reason))).toBe(true);
  await panel.getByRole('button',{name:'미리보기 끄기'}).click();await expect(panel).toHaveCount(0);
  await expect(page.getByRole('switch',{name:'첨부파일 미리보기'})).not.toBeChecked();
  await page.reload();await page.locator('.channel-link').filter({hasText:channel.name}).click();
  await expect(page.getByRole('switch',{name:'첨부파일 미리보기'})).not.toBeChecked();
  const downloaded=page.waitForEvent('download');await card.click();expect((await downloaded).suggestedFilename()).toBe('research.html');await expect(panel).toHaveCount(0);
  await page.getByRole('switch',{name:'첨부파일 미리보기'}).click();
  const row=page.locator(`#message-${message.id}`);await row.hover();await row.getByRole('button',{name:'스레드 답글'}).click();
  await page.getByLabel('스레드 답글 입력').fill('draft remains');
  await page.locator('.thread-panel .file-card').click();await expect(panel).toBeVisible();
  const reads=[];page.on('request',request=>{if(request.method()==='POST'&&request.url().endsWith(`/channels/${channel.id}/read`))reads.push(request.postDataJSON().until);});
  const reply=await upload(page,channel,'reply.html','text/html','<h1>Unread reply</h1>',message.id);
  await expect(page.locator('.thread-panel .file-card').filter({hasText:'reply.html'})).toHaveCount(1);
  expect(reads).not.toContain(reply.id);
  await page.getByRole('button',{name:'미리보기 닫기'}).click();await expect(page.getByLabel('스레드 답글 입력')).toHaveValue('draft remains');
  await expect.poll(()=>reads.includes(reply.id)).toBe(true);
  await page.getByRole('button',{name:'스레드 닫기'}).click();await card.click();
  await page.request.delete(`/api/messages/${message.id}`,{headers});await expect(panel).toHaveCount(0);
});

test('PDF native viewer, invalid PDF retry, and mobile panel',async({page,browser})=>{
  const channel=await setup(page);const source=await browser.newPage();await source.setContent('<h1>PDF Research Results</h1>');const pdf=await source.pdf();await source.close();
  await upload(page,channel,'results.pdf','application/pdf',pdf);
  await page.locator('.file-card').filter({hasText:'results.pdf'}).click();
  const panel=page.getByRole('complementary',{name:'첨부파일 미리보기'});
  await expect(panel.locator('iframe')).toHaveAttribute('src',/\/preview$/);
  // Chromium's PDF extension reports success only after the document is parsed.
  await expect.poll(async()=>{
    for(const frame of page.frames()){
      const loaded=await frame.evaluate(()=>{const viewer=document.querySelector('pdf-viewer');return viewer?.loadState==='success'||viewer?.loadState_==='success';}).catch(()=>false);
      if(loaded)return true;
    }
    return false;
  }).toBe(true);
  await page.getByRole('button',{name:'미리보기 닫기'}).click();
  await upload(page,channel,'broken.pdf','application/pdf','<html>not a PDF</html>');
  await page.locator('.file-card').filter({hasText:'broken.pdf'}).click();
  await expect(panel.getByRole('alert')).toContainText('미리볼 수 없습니다');await expect(panel.locator('iframe')).toHaveCount(0);
  await panel.getByRole('button',{name:'다시 시도'}).click();await expect(panel.getByRole('alert')).toBeVisible();
  await panel.getByRole('button',{name:'미리보기 닫기'}).click();
  await upload(page,channel,'mobile.htm','text/html','<h1>Mobile preview</h1>');
  await page.setViewportSize({width:390,height:844});await page.locator('.file-card').filter({hasText:'mobile.htm'}).click();
  await expect(page.frameLocator('.file-preview-panel iframe').getByRole('heading',{name:'Mobile preview'})).toBeVisible();
  await expect.poll(async()=>Math.round((await panel.boundingBox()).x)).toBe(0);expect((await panel.boundingBox()).width).toBeCloseTo(390,1);
  await panel.getByRole('button',{name:'미리보기 닫기'}).click();await expect(page.getByLabel('메시지 입력',{exact:true})).toBeVisible();
});
