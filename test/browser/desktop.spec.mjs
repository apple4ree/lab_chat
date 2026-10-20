import {test,expect} from '@playwright/test';
test('desktop download deep link survives login and stays available in the profile',async({page})=>{
  await page.goto('/#desktop-downloads');await page.getByRole('button',{name:/지민/}).click();
  await expect(page.getByRole('heading',{name:'데스크톱 앱 다운로드',exact:true})).toBeVisible();
  await expect(page.getByText('아직 배포된 설치 파일이 없습니다.',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'창 닫기',exact:true}).click();
  await page.getByRole('button',{name:'내 계정',exact:true}).click();await page.getByRole('button',{name:'데스크톱 앱 다운로드',exact:true}).click();
  await expect(page.getByRole('heading',{name:'데스크톱 앱 다운로드',exact:true})).toBeVisible();
});
