function installUpdates({app,dialog,config,getWindow}){
  let checking=false;
  return async function check(){
    if(!app.isPackaged||!config.signedRelease||config.updateUrl!=='https://chat.damilab.cc/desktop/updates'){
      await dialog.showMessageBox(getWindow(),{type:'info',title:'DAMI Chat 업데이트',message:`DAMI Chat ${app.getVersion()} · 사내 시험판`,detail:'현재 버전은 새 설치 파일을 받아 업데이트합니다. 자동 업데이트는 정식 배포 채널이 준비되면 제공됩니다.'});return;
    }
    if(checking)return;checking=true;
    try{
      const {autoUpdater}=require('electron-updater');autoUpdater.autoDownload=false;autoUpdater.autoInstallOnAppQuit=false;
      autoUpdater.setFeedURL({provider:'generic',url:config.updateUrl});
      // Avoid emitting unhandled provider errors; present a bounded message below.
      if(!autoUpdater.listenerCount('error'))autoUpdater.on('error',()=>{});
      const result=await autoUpdater.checkForUpdates();
      if(!result?.isUpdateAvailable){await dialog.showMessageBox(getWindow(),{message:'최신 버전을 사용하고 있습니다.'});return;}
      const answer=await dialog.showMessageBox(getWindow(),{message:`새 버전 ${result.updateInfo.version}을 다운로드할까요?`,buttons:['다운로드','나중에'],defaultId:0,cancelId:1});
      if(answer.response!==0)return;await autoUpdater.downloadUpdate();
      const restart=await dialog.showMessageBox(getWindow(),{message:'업데이트 준비가 끝났습니다.',detail:'작성 중인 메시지를 확인하고 앱을 재시작해 주세요.',buttons:['재시작하여 설치','나중에'],cancelId:1});
      if(restart.response===0)autoUpdater.quitAndInstall();
    }catch{await dialog.showMessageBox(getWindow(),{type:'error',message:'업데이트를 확인하지 못했습니다.',detail:'네트워크 연결을 확인한 뒤 다시 시도해 주세요.'});}
    finally{checking=false;}
  };
}
module.exports={installUpdates};
