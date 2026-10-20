module.exports={
  appId:'cc.damilab.chat',productName:'DAMI Chat',asar:true,
  toolsets:{wine:'1.0.1'},
  directories:{output:'release',buildResources:'assets'},
  files:['main.cjs','preload.cjs','policy.cjs','notifications.cjs','updates.cjs','release-config.json','offline.html','offline.js','assets/*.png','package.json'],
  artifactName:'DAMI-Chat-${version}-${os}-${arch}.${ext}',
  publish:null,
  win:{target:[{target:'nsis',arch:['x64']}],icon:'assets/icon.ico',signExecutable:false},
  nsis:{oneClick:false,perMachine:false,allowToChangeInstallationDirectory:true,createDesktopShortcut:true,createStartMenuShortcut:true,deleteAppDataOnUninstall:false},
  mac:{target:['dmg'],icon:'assets/icon.icns',category:'public.app-category.social-networking',identity:'-',hardenedRuntime:true,notarize:false},
  linux:{target:['dir'],icon:'assets/icon.png',category:'Network'}
};
