const {join}=require('node:path');
const {createHash}=require('node:crypto');
const {createReadStream}=require('node:fs');
const {mkdir,lstat,open,rename,rm,readdir}=require('node:fs/promises');
const FEED='https://chat.damilab.cc/desktop/updates/latest.json';
const RELEASE='https://github.com/apple4ree/lab_chat/releases/download/';
const MAX_BYTES=1024*1024*1024;
function version(value){if(typeof value!=='string'||!/^\d{1,8}\.\d{1,8}\.\d{1,8}$/.test(value))throw new Error('Invalid version');return value.split('.').map(Number);}
function newer(a,b){const left=version(a),right=version(b);for(let i=0;i<3;i++){if(left[i]!==right[i])return left[i]>right[i];}return false;}
function selectUpdate(data,current,platform,arch){
  version(current);
  if(data?.version===null&&Array.isArray(data.files)&&!data.files.length)return null;
  if(!data||!Array.isArray(data.files)||data.files.length>10)throw new Error('Invalid update feed');
  version(data.version);if(!newer(data.version,current))return null;
  const os=platform==='win32'?'windows':platform==='darwin'?'macos':null;
  if(!os||!['x64','arm64'].includes(arch))throw new Error('Unsupported platform');
  const matches=data.files.filter(f=>f.platform===os&&f.arch===arch);
  if(matches.length!==1)throw new Error('No matching installer');
  const f=matches[0],extension=os==='windows'?'exe':'dmg';
  const name=`DAMI-Chat-${data.version}-${os==='windows'?'win':'mac'}-${arch}.${extension}`;
  if(f.name!==name||f.url!==`${RELEASE}v${data.version}/${name}`||!Number.isSafeInteger(f.bytes)||f.bytes<1||f.bytes>MAX_BYTES||!/^[a-f0-9]{64}$/.test(f.sha256)||f.nativeTested!==true)throw new Error('Invalid installer');
  return {version:data.version,name,url:f.url,bytes:f.bytes,sha256:f.sha256,extension};
}
async function readFeed(fetcher,signal){
  const response=await fetcher(FEED,{redirect:'error',credentials:'omit',cache:'no-store',signal,headers:{Accept:'application/json'}});
  if(!response.ok||!response.body)throw new Error('Update feed unavailable');
  const chunks=[];let length=0;
  for await(const chunk of response.body){length+=chunk.length;if(length>65536)throw new Error('Update feed too large');chunks.push(Buffer.from(chunk));}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function verified(path,file){
  try{
    const info=await lstat(path);if(!info.isFile()||info.size!==file.bytes)return false;
    const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);
    return hash.digest('hex')===file.sha256;
  }catch(e){if(e.code==='ENOENT')return false;throw e;}
}
async function download(file,directory,{fetcher=fetch,signal,progress=()=>{}}={}){
  await mkdir(directory,{recursive:true,mode:0o700});const destination=join(directory,file.name);
  // This directory is exclusively owned by the updater. Keep only the selected installer.
  for(const name of await readdir(directory)){
    if(name!==file.name&&/^DAMI-Chat-\d+\.\d+\.\d+-(?:win|mac)-(?:x64|arm64)\.(?:exe|dmg)(?:\.part)?$/.test(name))await rm(join(directory,name),{force:true});
  }
  if(await verified(destination,file)){progress(100);return destination;}
  await rm(destination,{force:true});
  let url=file.url,response;
  for(let redirects=0;redirects<=3;redirects++){
    response=await fetcher(url,{redirect:'manual',credentials:'omit',signal});
    if(![301,302,303,307,308].includes(response.status))break;
    await response.body?.cancel();
    const next=new URL(response.headers.get('location'),url);
    if(next.protocol!=='https:'||next.username||next.password||next.hash||next.hostname!=='release-assets.githubusercontent.com')throw new Error('Untrusted installer redirect');
    url=next.href;
  }
  if(response?.status!==200||!response.body)throw new Error('Installer unavailable');
  const length=response.headers.get('content-length');if(length!==null&&Number(length)!==file.bytes){await response.body.cancel();throw new Error('Installer size mismatch');}
  const partial=destination+'.part';let handle,complete=false;
  try{
    handle=await open(partial,'wx',0o600);const hash=createHash('sha256');let received=0,last=-1;
    for await(const chunk of response.body){
      signal?.throwIfAborted();received+=chunk.length;if(received>file.bytes)throw new Error('Installer too large');
      hash.update(chunk);await handle.writeFile(chunk);
      const percent=Math.floor(received/file.bytes*100);if(percent!==last){last=percent;progress(percent);}
    }
    if(received!==file.bytes||hash.digest('hex')!==file.sha256)throw new Error('Installer checksum mismatch');
    await handle.sync();await handle.close();handle=null;signal?.throwIfAborted();await rename(partial,destination);complete=true;return destination;
  }finally{if(handle)await handle.close();if(!complete)await rm(partial,{force:true});}
}
function installUpdates({app,dialog,shell,config,getWindow,onState=()=>{},fetcher=fetch,platform=process.platform,arch=process.arch}){
  let busy=false,stopped=false,controller,timer,interval;
  let state={phase:'idle',currentVersion:app.getVersion(),latestVersion:null,progress:null,format:null,error:null};
  const set=patch=>{state={...state,...patch};if(!stopped)onState({...state});};
  const message=options=>dialog.showMessageBox(getWindow(),{title:'DAMI Chat 업데이트',...options});
  async function check({interactive=true}={}){
    if(stopped||busy)return {...state};
    if(!app.isPackaged||!['win32','darwin'].includes(platform)||config.updateUrl!==FEED){
      if(interactive)await message({message:'설치된 Windows 또는 macOS 앱에서 업데이트를 확인해 주세요.'});return {...state};
    }
    busy=true;controller=new AbortController();
    try{
      set({phase:'checking',error:null,progress:null});
      const data=await readFeed(fetcher,AbortSignal.any([controller.signal,AbortSignal.timeout(15000)]));
      const file=selectUpdate(data,app.getVersion(),platform,arch);
      if(stopped)return {...state};
      if(!file){set({phase:'current',latestVersion:null});if(interactive)await message({message:'최신 버전을 사용하고 있습니다.'});return {...state};}
      set({phase:'available',latestVersion:file.version,format:file.extension});
      if(!interactive)return {...state};
      const answer=await message({type:'question',message:`새 버전 ${file.version}을 다운로드할까요?`,detail:platform==='darwin'?'다운로드를 확인한 뒤 DMG를 엽니다. DAMI Chat을 Applications 폴더로 옮겨 기존 앱을 교체하세요.':'다운로드를 확인한 뒤 Windows 설치 프로그램을 실행합니다. 기존 계정과 대화는 유지됩니다.',buttons:['다운로드','나중에'],defaultId:0,cancelId:1});
      if(answer.response!==0||stopped)return {...state};
      set({phase:'downloading',progress:0});
      const path=await download(file,join(app.getPath('userData'),'updates'),{fetcher,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15*60000)]),progress:p=>set({progress:p})});
      if(stopped)return {...state};set({phase:'ready',progress:100});
      const install=await message({message:'업데이트 파일 확인이 끝났습니다.',detail:`작성 중인 메시지는 먼저 보내거나 복사해 주세요. 앱이 종료됩니다.\n${platform==='darwin'?'DMG에서 DAMI Chat을 Applications로 옮기고 기존 앱을 교체한 뒤 다시 실행하세요.':'설치 안내를 마친 뒤 DAMI Chat을 다시 실행하세요.'}`,buttons:['앱 종료 후 설치 파일 열기','나중에'],defaultId:1,cancelId:1});
      if(install.response!==0||stopped)return {...state};
      if(!await verified(path,file))throw new Error('Installer changed before launch');
      const error=await shell.openPath(path);if(error)throw new Error('Installer launch failed');
      app.quit();
    }catch{
      if(!stopped){set({phase:'error',error:'업데이트를 완료하지 못했습니다. 연결을 확인하고 다시 시도해 주세요.'});if(interactive)await message({type:'error',message:state.error,detail:'파일 확인에 실패하면 설치 프로그램을 실행하지 않습니다.'});}
    }finally{busy=false;controller=null;}
    return {...state};
  }
  return {check,getState:()=>({...state}),start(){if(timer||interval||stopped)return;timer=setTimeout(()=>void check({interactive:false}),10000);timer.unref?.();interval=setInterval(()=>void check({interactive:false}),6*3600000);interval.unref?.();},stop(){stopped=true;clearTimeout(timer);clearInterval(interval);controller?.abort();}};
}
module.exports={installUpdates,selectUpdate,newer,download,FEED};
