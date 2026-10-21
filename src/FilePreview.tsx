import {useEffect,useRef,useState} from 'react';
import {Download,LoaderCircle,X} from 'lucide-react';
import type {Attachment} from './api';

export type PreviewSelection={file:Attachment;messageId:number;channelId:string};

export function FilePreview({file,onClose,onDisable}:{file:Attachment;onClose:()=>void;onDisable:()=>void}){
  const [ready,setReady]=useState(false),[loaded,setLoaded]=useState(false),[error,setError]=useState(''),[attempt,setAttempt]=useState(0);
  const close=useRef<HTMLButtonElement>(null);
  const url=`/api/files/${encodeURIComponent(file.id)}/preview`;
  useEffect(()=>{close.current?.focus();},[]);
  useEffect(()=>{
    const controller=new AbortController();setReady(false);setLoaded(false);setError('');
    // HEAD checks permissions/type without downloading a second copy of the document.
    fetch(url,{method:'HEAD',credentials:'same-origin',cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])}).then(response=>{
      if(!response.ok)throw new Error(response.status===401?'로그인 후 다시 열어 주세요.':response.status===404?'삭제되었거나 접근할 수 없는 파일입니다.':response.status===415?'이 파일은 미리볼 수 없습니다. 원본을 다운로드해 확인해 주세요.':'파일을 불러오지 못했습니다.');
      if(!controller.signal.aborted)setReady(true);
    }).catch(e=>{if(!controller.signal.aborted)setError(e instanceof TypeError||e.name==='TimeoutError'?'연결을 확인하고 다시 시도해 주세요.':e.message);});
    return()=>controller.abort();
  },[url,attempt]);
  return <aside className="file-preview-panel" aria-label="첨부파일 미리보기" onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();onClose();}}}>
    <header><div><h2>파일 미리보기</h2><p title={file.name}>{file.name}</p></div><button ref={close} className="icon-button" aria-label="미리보기 닫기" onClick={onClose}><X size={20}/></button></header>
    <div className="file-preview-toolbar"><a href={`/api/files/${file.id}`} download><Download size={15}/> 원본 다운로드</a><button onClick={onDisable}>미리보기 끄기</button></div>
    {file.previewKind==='html'&&<p className="file-preview-note">HTML의 글·표·스타일을 표시합니다. 스크립트와 외부 자료는 실행·로드하지 않습니다.</p>}
    <div className="file-preview-content">
      {error?<div className="file-preview-status" role="alert"><p>{error}</p><button className="secondary" onClick={()=>setAttempt(n=>n+1)}>다시 시도</button></div>:<>
        {!loaded&&<div className="file-preview-status" role="status"><LoaderCircle className="spin" size={22}/> 파일 불러오는 중…</div>}
        {ready&&<iframe key={`${file.id}:${attempt}`} title={`${file.name} 미리보기`} src={url} sandbox={file.previewKind==='html'?'':undefined} referrerPolicy="no-referrer" onLoad={()=>setLoaded(true)} onError={()=>setError('파일을 표시하지 못했습니다. 원본을 다운로드해 확인해 주세요.')}/>}
      </>}
    </div>
    {file.previewKind==='pdf'&&<p className="file-preview-note">PDF가 표시되지 않으면 원본 다운로드로 열어 주세요.</p>}
  </aside>;
}
