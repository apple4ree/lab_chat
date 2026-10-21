import {useEffect,useState} from 'react';
import {api} from './api';
import {Dialog} from './components';
const format=(name:string)=>name.endsWith('.exe')?'exe':name.endsWith('.dmg')?'dmg':'zip';
function instructions(name:string,platform:string){
  if(format(name)==='exe')return 'EXE를 실행하고 설치 안내를 따르세요. 설치 후 시작 메뉴에서 DAMI Chat을 열 수 있습니다.';
  if(format(name)==='dmg')return 'DMG를 열고 DAMI Chat을 Applications 폴더로 끌어다 놓으세요. macOS 13 이상에서 사용할 수 있습니다.';
  return platform==='windows'?'압축을 폴더 전체로 풀고 DAMI Chat.exe를 실행하세요.':'압축을 풀고 DAMI Chat.app을 응용 프로그램 폴더로 옮기세요.';
}
type Release={version:string|null;releaseUrl?:string;files:{name:string;platform:string;arch:string;bytes:number;sha256:string;signed:boolean;nativeTested:boolean;url:string}[]};
export function DesktopDownloads({onClose}:{onClose:()=>void}){
  const [data,setData]=useState<Release|null>(null),[error,setError]=useState('');
  useEffect(()=>{const c=new AbortController();api<Release>('/desktop/releases',{signal:c.signal}).then(setData).catch(e=>{if(!c.signal.aborted)setError(e.message);});return()=>c.abort();},[]);
  return <Dialog title="데스크톱 앱 다운로드" onClose={onClose}><p>웹에서 사용하는 계정으로 로그인하세요. 대화·파일·연구 자원을 같은 서버에서 공유합니다.</p>
    {error&&<p role="alert" className="form-error">{error}</p>}
    {!data&&!error&&<p>설치 파일을 확인하고 있습니다…</p>}
    {data?.releaseUrl&&<p>설치 파일은 GitHub에서 다운로드합니다. <a href={data.releaseUrl} target="_blank" rel="noopener noreferrer">GitHub Release 열기</a></p>}
    {data?.files.some(f=>!f.signed)&&<p className="info-banner">사내 시험판 {data.version}입니다. 정식 개발자 서명·Apple 공증 전이므로 운영체제에서 확인되지 않은 앱으로 표시되거나 실행이 제한될 수 있습니다.</p>}
    {data?.files.map(f=><div className="desktop-download" key={f.name}><h3>{f.platform==='windows'?'Windows · 64비트':f.arch==='arm64'?'macOS · Apple Silicon (M 시리즈)':'macOS · Intel'}</h3><p>{instructions(f.name,f.platform)}</p><a className="primary" href={f.url} target={data.releaseUrl?'_blank':undefined} rel="noopener noreferrer" download={!data.releaseUrl}>{format(f.name)==='exe'?'Windows 설치 파일 (.exe)':format(f.name)==='dmg'?'Mac 설치 파일 (.dmg)':'앱 ZIP'} 다운로드 · {(f.bytes/1048576).toFixed(0)} MB</a>{f.nativeTested&&<p className="small-text muted">설치·실행 자동 검증 완료</p>}<details><summary>파일 확인용 SHA-256</summary><code>{f.sha256}</code></details></div>)}
    {data?.files.length===0&&<p>아직 배포된 설치 파일이 없습니다.</p>}
    {window.damiDesktop?.checkUpdates&&<button className="secondary" onClick={()=>void window.damiDesktop?.checkUpdates?.()}>설치된 앱 업데이트 확인</button>}
    <p className="small-text muted">v0.1.3부터 앱 실행 후와 6시간마다 새 버전을 확인합니다. 앱 메뉴의 ‘업데이트 확인’으로 다운로드·파일 검증·설치를 진행할 수 있습니다. Mac은 DMG에서 Applications로 옮겨 교체합니다. 이전 버전은 이번 한 번 새 설치 파일로 업데이트해 주세요.</p>
  </Dialog>;
}
