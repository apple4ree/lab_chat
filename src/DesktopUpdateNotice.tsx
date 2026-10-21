import {useEffect,useState} from 'react';
import {api} from './api';
import type {DesktopUpdateState} from './desktop';

export function DesktopUpdateNotice({onDownload}:{onDownload:()=>void}){
  const desktop=window.damiDesktop;
  const [state,setState]=useState<DesktopUpdateState|null>(null),[legacyRelease,setLegacyRelease]=useState<string|null>(null);
  useEffect(()=>{
    if(!desktop)return;
    let active=true;
    if(desktop.getUpdateState){
      void desktop.getUpdateState().then(s=>{if(active)setState(s);}).catch(()=>{});
      const off=desktop.onUpdateState?.(s=>{if(active)setState(s);});
      return()=>{active=false;off?.();};
    }
    const controller=new AbortController();
    api<{version:string|null;files:unknown[]}>('/desktop/releases',{signal:controller.signal}).then(r=>{
      if(active&&r.version&&r.files.length&&/^\d+\.\d+\.\d+$/.test(r.version)){
        const [major,minor,patch]=r.version.split('.').map(Number);
        if(major>0||minor>1||(minor===1&&patch>=3))setLegacyRelease(r.version);
      }
    }).catch(()=>{});
    return()=>{active=false;controller.abort();};
  },[desktop]);
  if(!desktop)return null;
  if(legacyRelease)return <div className="desktop-update-notice" role="status"><span>업데이트 기능이 포함된 v{legacyRelease}이 나왔습니다. 이번 한 번 새 앱을 설치해 주세요.</span><button onClick={onDownload}>업데이트 설치 파일</button></div>;
  if(!state||!['available','downloading','ready','error'].includes(state.phase))return null;
  return <div className="desktop-update-notice" role="status"><span>{state.phase==='downloading'?`앱 업데이트 다운로드 중 · ${state.progress??0}%`:state.phase==='error'?state.error:`앱 ${state.latestVersion} ${state.phase==='ready'?'설치 준비 완료':'업데이트 가능'}`}</span><button disabled={state.phase==='downloading'} onClick={()=>void desktop.checkUpdates?.().then(setState).catch(()=>{})}>{state.phase==='downloading'?'다운로드 중':state.phase==='error'?'다시 확인':'업데이트'}</button></div>;
}
