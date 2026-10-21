import {test,expect} from '@playwright/test';
async function login(page){await page.goto('/');await page.getByRole('button',{name:/지민/}).click();await expect(page.getByText('대화가 이어지는 중')).toBeVisible();}
test('old installed clients see the one-time upgrade notice and installer choices',async({page})=>{
 await page.addInitScript(()=>{window.damiDesktop={version:1,setState:async()=>({unread:0}),isActive:async()=>true,onNavigate:()=>()=>{},retry:async()=>true};});
 await page.route('**/api/desktop/releases',route=>route.fulfill({json:{version:'0.1.3',releaseUrl:'https://github.com/apple4ree/lab_chat/releases/tag/v0.1.3',files:[{name:'DAMI-Chat-0.1.3-win-x64.exe',platform:'windows',arch:'x64',bytes:1000,sha256:'a'.repeat(64),signed:false,nativeTested:true,url:'https://github.com/apple4ree/lab_chat/releases/download/v0.1.3/DAMI-Chat-0.1.3-win-x64.exe'}]}}));
 await login(page);await expect(page.getByText('이번 한 번 새 앱을 설치해 주세요.',{exact:false})).toBeVisible();
 await page.getByRole('button',{name:'업데이트 설치 파일'}).click();await expect(page.getByRole('link',{name:/Windows 설치 파일/})).toBeVisible();
});
test('new installed clients show native update progress without exposing a download URL to IPC',async({page})=>{
 await page.addInitScript(()=>{
  const available={phase:'available',currentVersion:'0.1.3',latestVersion:'0.1.4',progress:null,format:'exe',error:null};
  let listener;
  window.damiDesktop={version:2,setState:async()=>({unread:0}),isActive:async()=>true,onNavigate:()=>()=>{},retry:async()=>true,getUpdateState:async()=>available,onUpdateState:fn=>{listener=fn;return()=>{};},checkUpdates:async()=>{const state={...available,phase:'downloading',progress:42};listener?.(state);return state;}};
 });
 await login(page);await expect(page.getByText('앱 0.1.4 업데이트 가능',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'업데이트',exact:true}).click();await expect(page.getByText('앱 업데이트 다운로드 중 · 42%',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'다운로드 중',exact:true})).toBeDisabled();
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
