import {useEffect,useState} from 'react';
import {api,post} from './api';

type Connection={workspaceId:string;canonicalOrigin:string;revision:number};
type DomainStatus=Connection&{previousOrigins:string[];editable:boolean;pending:{origin:string;verifiedAt:number;expiresAt:number}|null;receipt?:string};
export function DomainSettings(){
  const [state,setState]=useState<DomainStatus|null>(null),[target,setTarget]=useState(''),[receipt,setReceipt]=useState(''),[password,setPassword]=useState(''),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  useEffect(()=>{api<DomainStatus>('/admin/domain').then(setState).catch(e=>setError(e.message));},[]);
  async function verify(){
    setBusy(true);setError('');setNotice('');setReceipt('');setPassword('');setConfirmed(false);
    try{const next=await post<DomainStatus>('/admin/domain/verify',{origin:target.trim()});setState(next);setReceipt(next.receipt||'');setTarget(next.pending!.origin);}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  async function activate(){
    setBusy(true);setError('');
    try{const next=await post<DomainStatus>('/admin/domain/activate',{receipt,password,confirmOrigin:target,keepOldDomain:confirmed});setState(next);setReceipt('');setTarget('');setConfirmed(false);setNotice('대표 접속 주소를 변경했습니다. 기존 주소에서도 계속 이용할 수 있습니다.');window.dispatchEvent(new Event('dami:domain-changed'));}
    catch(e){setError((e as Error).message);}finally{setPassword('');setBusy(false);}
  }
  return <section className="domain-settings" aria-label="접속 도메인 관리"><h3>접속 도메인 관리</h3>
    {state&&<><p className="small-text">현재 대표 주소 <strong>{state.canonicalOrigin}</strong></p><p className="muted small-text">새 도메인을 같은 채팅 서버에 연결한 뒤 대표 주소로 지정합니다. 계정·대화·파일은 그대로 유지됩니다.</p>
      {state.editable?<><details><summary>새 도메인 연결 준비</summary><ol><li>사용할 도메인을 소유하거나 관리 권한을 확보합니다.</li><li>DNS와 Cloudflare Tunnel에 새 호스트 이름을 추가해 현재 채팅 서버로 연결합니다. 기존 호스트 이름도 유지합니다.</li><li>아래에서 HTTPS 연결과 연구실 일치를 확인한 뒤 적용합니다.</li></ol><p className="small-text">DNS 등록과 인증서 발급은 도메인 제공 업체에서 진행합니다. 주소 변경은 서버·데이터 이전을 수행하지 않습니다.</p></details>
      <form onSubmit={e=>{e.preventDefault();void verify();}}><label>새 접속 주소<input type="url" required placeholder="https://chat.example.org" maxLength={253} value={target} disabled={busy} onChange={e=>{setTarget(e.target.value);setReceipt('');setConfirmed(false);setPassword('');setNotice('');}}/></label><button className="secondary" disabled={busy||!target}>{busy?'확인 중…':'새 주소 연결 확인'}</button></form>
      {receipt&&state.pending&&<form className="domain-confirm" onSubmit={e=>{e.preventDefault();void activate();}}><p role="status">같은 연구실 서비스로 연결됩니다. 확인 결과는 10분 동안 유효합니다.</p><p className="small-text">{state.canonicalOrigin} → <strong>{state.pending.origin}</strong></p><label>현재 관리자 비밀번호<input type="password" required autoComplete="current-password" maxLength={256} value={password} disabled={busy} onChange={e=>setPassword(e.target.value)}/></label><label className="domain-check"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e=>setConfirmed(e.target.checked)}/>기존 도메인을 계속 유지하고, 구버전 앱 사용자의 업데이트를 안내하겠습니다.</label><button className="primary" disabled={busy||!confirmed||!password}>대표 주소 변경 적용</button></form>}
      </>:<p className="info-banner">체험 공간에서는 접속 주소를 변경할 수 없습니다.</p>}
      {state.previousOrigins.length>0&&<p className="small-text muted">이전 주소: {state.previousOrigins.join(', ')}. 되돌리려면 이전 주소를 다시 확인하고 적용하세요.</p>}
      <p className="small-text muted">설치 앱의 주소 변경은 지원 버전에서 사용할 수 있습니다. 이전 버전은 새 주소를 브라우저에서 열 수 있습니다. 새 도메인에서는 다시 로그인합니다.</p>
    </>}{notice&&<p role="status" className="info-banner">{notice}</p>}{error&&<p role="alert" className="form-error">{error}</p>}
  </section>;
}

export function DomainNotice(){
  const [connection,setConnection]=useState<Connection|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{
    let alive=true;
    const refresh=()=>{if(document.visibilityState!=='hidden')void api<Connection>('/workspace/connection').then(x=>{if(alive)setConnection(x);}).catch(()=>{});};
    refresh();const interval=setInterval(refresh,60000);window.addEventListener('focus',refresh);window.addEventListener('dami:domain-changed',refresh);
    return ()=>{alive=false;clearInterval(interval);window.removeEventListener('focus',refresh);window.removeEventListener('dami:domain-changed',refresh);};
  },[]);
  if(!connection||connection.canonicalOrigin===location.origin)return null;
  // Display only a root HTTPS address, even if a malformed server response arrives.
  let target;try{const u=new URL(connection.canonicalOrigin);if(u.protocol!=='https:'||u.origin!==connection.canonicalOrigin)return null;target=u.origin;}catch{return null;}
  async function move(){setBusy(true);setError('');try{await window.damiDesktop!.changeWorkspace!();}catch{setError('새 주소로 연결하지 못했습니다. 기존 주소에서 계속 사용할 수 있습니다.');}finally{setBusy(false);}}
  return <aside className="domain-notice" aria-label="접속 주소 변경 안내"><strong>연구실 접속 주소가 변경되었습니다.</strong><span>{target}</span><p>기존 화면은 계속 사용할 수 있습니다. 새 주소에서는 다시 로그인해 주세요.</p>
    {window.damiDesktop?.changeWorkspace?<button className="primary" disabled={busy} onClick={()=>void move()}>앱을 새 주소로 연결</button>:<a className="secondary" href={target} target="_blank" rel="noopener noreferrer">새 주소를 브라우저에서 열기</a>}
    {window.damiDesktop&&!window.damiDesktop.changeWorkspace&&<p>이 앱 버전은 주소 변경을 지원하지 않습니다. 지원 버전으로 업데이트해 주세요.</p>}
    {error&&<p role="alert">{error}</p>}
  </aside>;
}
