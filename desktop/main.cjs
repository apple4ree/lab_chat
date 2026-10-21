const {app,BrowserWindow,Menu,Tray,nativeImage,Notification,ipcMain,shell,dialog,session,screen}=require('electron');
const {join,resolve,basename}=require('node:path');
const {pathToFileURL}=require('node:url');
const {readFileSync,writeFileSync,renameSync,mkdirSync}=require('node:fs');
const release=require('./release-config.json');
const {workspaceURL,sameOrigin,externalURL,parseState}=require('./policy.cjs');
const {createTracker}=require('./notifications.cjs');
const {installUpdates}=require('./updates.cjs');
const {discoverConnection,savedConnection}=require('./connection.cjs');

app.setName('DAMI Chat');app.setAppUserModelId('cc.damilab.chat');app.enableSandbox();
if(!app.isPackaged&&process.env.LAB_DESKTOP_USER_DATA)app.setPath('userData',resolve(process.env.LAB_DESKTOP_USER_DATA));
let origin=workspaceURL(release,{packaged:app.isPackaged,developmentUrl:process.env.LAB_DESKTOP_URL});
const offline=pathToFileURL(join(__dirname,'offline.html')).href;
let win,tray,quitting=false,settings,unread=0,checkUpdates,pendingChannel=null;
const tracker=createTracker(),notifications=new Set();
const defaults={notifications:true,background:true,width:1280,height:860};
const settingsFile=join(app.getPath('userData'),'desktop-settings.json');
function loadSettings(){try{const s=JSON.parse(readFileSync(settingsFile,'utf8'));return {connection:savedConnection(s.connection),notifications:typeof s.notifications==='boolean'?s.notifications:true,background:typeof s.background==='boolean'?s.background:true,width:Number.isInteger(s.width)?Math.max(800,Math.min(2560,s.width)):1280,height:Number.isInteger(s.height)?Math.max(600,Math.min(1600,s.height)):860};}catch{return {...defaults};}}
function saveSettings(){mkdirSync(app.getPath('userData'),{recursive:true});writeFileSync(settingsFile+'.tmp',JSON.stringify(settings),{mode:0o600});renameSync(settingsFile+'.tmp',settingsFile);}
function trusted(event,allowOffline=false){
  if(!win||win.isDestroyed()||event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame)return false;
  return sameOrigin(event.senderFrame.url,origin)||(allowOffline&&event.senderFrame.url===offline);
}
function show(){if(!win||win.isDestroyed())return;win.show();if(win.isMinimized())win.restore();win.focus();}
function badges(count){
  unread=count;app.setBadgeCount(count);if(app.dock)app.dock.setBadge(count?String(Math.min(count,9999)):'');
  if(tray)tray.setToolTip(count?`DAMI Chat · 읽지 않은 메시지 ${count}개`:'DAMI Chat');
  if(win&&!win.isDestroyed()){
    win.setTitle(count?`(${count}) DAMI Chat`:'DAMI Chat');
    if(process.platform==='win32')win.setOverlayIcon(count?nativeImage.createFromPath(join(__dirname,'assets/unread.png')):null,count?`읽지 않은 메시지 ${count}개`:'');
  }
}
function clearNotifications(){for(const n of notifications)n.close();notifications.clear();}
function navigate(id){pendingChannel=id;show();deliverNavigation();}
function deliverNavigation(){if(pendingChannel&&win&&!win.isDestroyed()&&sameOrigin(win.webContents.getURL(),origin)){win.webContents.send('dami:navigate',pendingChannel);pendingChannel=null;}}
function menu(){
  const canLogin=app.isPackaged&&['darwin','win32'].includes(process.platform);
  const options=[{label:'DAMI Chat 열기',click:show},{type:'separator'},
    {label:'시스템 알림',type:'checkbox',checked:settings.notifications,click:item=>{settings.notifications=item.checked;saveSettings();if(!item.checked)clearNotifications();menu();}},
    {label:'창을 닫아도 계속 실행',type:'checkbox',checked:settings.background,enabled:Boolean(tray)||process.platform==='darwin',click:item=>{settings.background=item.checked;saveSettings();menu();}},
    {label:'컴퓨터 로그인 시 실행',type:'checkbox',enabled:canLogin,checked:canLogin&&app.getLoginItemSettings().openAtLogin,click:item=>app.setLoginItemSettings({openAtLogin:item.checked})},
    {label:'업데이트 확인',click:()=>void checkUpdates()},{type:'separator'},{label:'DAMI Chat 종료',accelerator:'CmdOrCtrl+Q',click:()=>app.quit()}];
  if(tray)tray.setContextMenu(Menu.buildFromTemplate(options));
  Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'DAMI Chat',submenu:options},{label:'편집',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},
    {label:'보기',submenu:[{label:'다시 연결',accelerator:'CmdOrCtrl+R',click:()=>void loadWorkspace()},{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'},{role:'togglefullscreen'},...(!app.isPackaged?[{role:'toggleDevTools'}]:[])]},
    {label:'창',submenu:[{role:'minimize'},{role:'close'}]}]));
}
let connecting=false;
async function loadWorkspace({ask=false}={}){
  if(connecting)return false;connecting=true;
  const previous=origin;let navigationStarted=false;
  try{
    let next;
    try{next=await discoverConnection(origin,settings.connection||{});}catch(error){if(ask)throw error;}
    if(ask&&(!next||next.origin===origin))return false;
    if(ask){const answer=await dialog.showMessageBox(win,{type:'question',buttons:['새 주소로 연결','취소'],defaultId:1,cancelId:1,message:'관리자가 변경한 주소로 연결할까요?',detail:`${origin}\n→ ${next.origin}\n\n전송하지 않은 메시지는 먼저 보내거나 복사해 주세요. 새 주소에서는 다시 로그인합니다.`});if(answer.response!==0)return false;}
    if(next)origin=next.origin;
    navigationStarted=true;
    try{await win.loadURL(origin);}catch(error){origin=previous;throw error;}
    if(next){settings.connection=next;saveSettings();}return true;
  }catch(error){
    if((!ask||navigationStarted)&&!quitting&&!win.isDestroyed())await win.loadURL(ask?origin:offline).catch(()=>{});
    if(ask)throw error;return false;
  }finally{connecting=false;}
}
async function openExternal(raw){const url=externalURL(raw);if(!url)return;try{await shell.openExternal(url);}catch{await dialog.showMessageBox(win,{message:'링크를 열지 못했습니다.'});}}

if(!app.requestSingleInstanceLock()){app.quit();}else{
  app.on('second-instance',show);app.on('activate',show);
  app.on('before-quit',()=>{quitting=true;clearNotifications();});
  app.on('window-all-closed',()=>app.quit());
  app.whenReady().then(()=>{
    settings=loadSettings();
    if(settings.connection&&!( !app.isPackaged&&process.env.LAB_DESKTOP_URL))origin=settings.connection.origin;
    const display=screen.getPrimaryDisplay().workAreaSize;
    const sess=session.fromPartition('persist:dami-workspace');
    sess.setPermissionRequestHandler((wc,p,callback,details)=>callback(Boolean(wc&&sameOrigin(wc.getURL(),origin)&&sameOrigin(details.requestingUrl,origin)&&p==='clipboard-sanitized-write')));
    sess.setPermissionCheckHandler((wc,p,requestOrigin)=>Boolean(wc&&sameOrigin(wc.getURL(),origin)&&sameOrigin(requestOrigin,origin)&&p==='clipboard-sanitized-write'));
    win=new BrowserWindow({width:Math.min(settings.width,display.width),height:Math.min(settings.height,display.height),minWidth:800,minHeight:600,show:false,title:'DAMI Chat',backgroundColor:'#f5f8f1',icon:join(__dirname,'assets/icon.png'),
      webPreferences:{preload:join(__dirname,'preload.cjs'),partition:'persist:dami-workspace',nodeIntegration:false,nodeIntegrationInWorker:false,contextIsolation:true,sandbox:true,webSecurity:true,allowRunningInsecureContent:false,webviewTag:false,backgroundThrottling:false}});
    checkUpdates=installUpdates({app,dialog,config:release,getWindow:()=>win});
    try{const icon=nativeImage.createFromPath(join(__dirname,'assets',process.platform==='darwin'?'trayTemplate.png':'icon.png')).resize({width:20,height:20});if(process.platform==='darwin')icon.setTemplateImage(true);tray=new Tray(icon);tray.on('click',show);tray.on('double-click',show);}catch{tray=null;}
    menu();badges(0);
    win.on('ready-to-show',show);win.on('page-title-updated',event=>{event.preventDefault();});
    for(const event of ['show','hide','focus','blur','minimize','restore'])win.on(event,()=>{if(sameOrigin(win.webContents.getURL(),origin))win.webContents.send('dami:activity',win.isVisible()&&win.isFocused()&&!win.isMinimized());});
    win.on('close',event=>{
      if(!quitting&&settings.background&&(tray||process.platform==='darwin')){event.preventDefault();win.hide();return;}
      if(!win.isMaximized()){const [width,height]=win.getSize();settings.width=width;settings.height=height;saveSettings();}
    });
    win.webContents.setWindowOpenHandler(details=>{void openExternal(details.url);return {action:'deny'};});
    win.webContents.on('will-navigate',(event,url)=>{if(!sameOrigin(url,origin)&&url!==offline){event.preventDefault();void openExternal(url);}});
    win.webContents.on('will-redirect',(event,url)=>{if(!sameOrigin(url,origin))event.preventDefault();});
    win.webContents.on('will-attach-webview',event=>event.preventDefault());
    win.webContents.on('did-fail-load',(_event,code,_description,url,isMainFrame)=>{if(isMainFrame&&code!==-3&&url!==offline&&!quitting)void win.loadURL(offline).catch(()=>{});});
    sess.on('will-download',(event,item,wc)=>{
      if(wc!==win.webContents||!item.getURLChain().every(url=>sameOrigin(url,origin))){event.preventDefault();return;}
      item.setSaveDialogOptions({defaultPath:join(app.getPath('downloads'),basename(item.getFilename()).replace(/[\\/:*?"<>|]/g,'_'))});
    });
    ipcMain.handle('dami:retry',event=>{if(!trusted(event,true))throw new Error('Untrusted sender');void loadWorkspace();return true;});
    ipcMain.handle('dami:change-workspace',event=>{if(!trusted(event))throw new Error('Untrusted sender');return loadWorkspace({ask:true});});
    ipcMain.handle('dami:active',event=>{if(!trusted(event))throw new Error('Untrusted sender');return win.isVisible()&&win.isFocused()&&!win.isMinimized();});
    ipcMain.handle('dami:state',(event,input)=>{
      if(!trusted(event))throw new Error('Untrusted sender');const state=parseState(input);
      const result=tracker.update(state,{focused:win.isFocused()&&win.isVisible(),enabled:settings.notifications});
      if(result.userChanged||!result.unread)clearNotifications();badges(result.unread);
      for(const c of result.alerts){
        if(!Notification.isSupported())continue;
        if(notifications.size>=10){const old=notifications.values().next().value;old.close();notifications.delete(old);}
        const notice=new Notification({title:'DAMI Chat',body:`새 메시지가 도착했습니다. 읽지 않은 메시지 ${c.unread}개`,icon:join(__dirname,'assets/icon.png'),silent:false});
        notifications.add(notice);notice.on('click',()=>navigate(c.id));notice.on('close',()=>notifications.delete(notice));notice.on('failed',()=>notifications.delete(notice));notice.show();
      }
      deliverNavigation();return {unread:result.unread};
    });
    void loadWorkspace();
  }).catch(()=>{dialog.showErrorBox('DAMI Chat','앱을 시작하지 못했습니다. 다시 실행해 주세요.');app.quit();});
}
