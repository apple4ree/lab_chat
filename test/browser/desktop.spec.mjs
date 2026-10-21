import {test,expect} from '@playwright/test';
test('desktop download deep link survives login and stays available in the profile',async({page})=>{
  await page.goto('/#desktop-downloads');await page.getByRole('button',{name:/지민/}).click();
  await expect(page.getByRole('heading',{name:'데스크톱 앱 다운로드',exact:true})).toBeVisible();
  await expect(page.getByText('아직 배포된 설치 파일이 없습니다.',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'창 닫기',exact:true}).click();
  await page.getByRole('button',{name:'내 계정',exact:true}).click();await page.getByRole('button',{name:'데스크톱 앱 다운로드',exact:true}).click();
  await expect(page.getByRole('heading',{name:'데스크톱 앱 다운로드',exact:true})).toBeVisible();
});
for(const github of [false,true])test(`native releases show EXE and DMG installation instructions via ${github?'GitHub':'local downloads'}`,async({page})=>{
  const files=[['windows','x64','win-x64.exe'],['macos','arm64','mac-arm64.dmg'],['macos','x64','mac-x64.dmg']].map(([platform,arch,suffix])=>({name:`DAMI-Chat-0.1.1-${suffix}`,platform,arch,bytes:150000000,sha256:'a'.repeat(64),signed:false,nativeTested:true,url:`${github?'https://github.com/apple4ree/lab_chat/releases/download/v0.1.1':'/api/desktop/releases'}/DAMI-Chat-0.1.1-${suffix}`}));
  await page.route('**/api/desktop/releases',route=>route.fulfill({json:{version:'0.1.1',releaseUrl:github?'https://github.com/apple4ree/lab_chat/releases/tag/v0.1.1':undefined,files}}));
  await page.goto('/#desktop-downloads');await page.getByRole('button',{name:/지민/}).click();
  await expect(page.getByRole('link',{name:/Windows 설치 파일 \(\.exe\)/})).toHaveAttribute('href',files[0].url);
  await expect(page.getByRole('link',{name:/Mac 설치 파일 \(\.dmg\)/})).toHaveCount(2);
  await expect(page.getByText('설치·실행 자동 검증 완료',{exact:true})).toHaveCount(3);
  await expect(page.getByText(/EXE를 실행하고 설치 안내/)).toBeVisible();
  await expect(page.getByText(/DMG를 열고 DAMI Chat을 Applications/)).toHaveCount(2);
  await expect(page.getByText(/정식 개발자 서명·Apple 공증 전/)).toBeVisible();
  await expect(page.getByRole('link',{name:/앱 ZIP/})).toHaveCount(0);
  if(github){await expect(page.getByRole('link',{name:'GitHub Release 열기'})).toHaveAttribute('href','https://github.com/apple4ree/lab_chat/releases/tag/v0.1.1');await expect(page.getByRole('link',{name:/Windows 설치 파일/})).toHaveAttribute('target','_blank');}
});
