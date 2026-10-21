import {useEffect,useState} from 'react';
import {api,post} from './api';
import './ssh-connections.css';
type Connection={host:string;id:string;address:string;ip:string;port:number;username:string;fingerprint:string;status:string;hostname:string|null;plan:{intervalSeconds:number;collectGpu:boolean;summary:string}|null;lastSeen:number|null;error:string|null};
type State={plannerConfigured:boolean;connections:Connection[]};
type Ticket={ticket:string;ip:string;fingerprint:string;expiresAt:number};
const states:Record<string,string>={probing:'SSH 접속·사양 확인 중',planning:'Codex 수집 설정 판단 중',verifying:'첫 보고 검증 중',connected:'연결 완료',failed:'설정 중단',disabled:'연결 해제됨'};
export function SshConnections({onConnected}:{onConnected:()=>void}){
  const [data,setData]=useState<State|null>(null),[servers,setServers]=useState<{host:string;label:string}[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [host,setHost]=useState(''),[address,setAddress]=useState(''),[port,setPort]=useState('22'),[username,setUsername]=useState(''),[type,setType]=useState<'password'|'key'>('password'),[password,setPassword]=useState(''),[privateKey,setPrivateKey]=useState(''),[passphrase,setPassphrase]=useState('');
  const [ticket,setTicket]=useState<Ticket|null>(null),[trusted,setTrusted]=useState(false),[notice,setNotice]=useState(''),[disconnectHost,setDisconnectHost]=useState(''),[pollKick,setPollKick]=useState(0);
  useEffect(()=>{const controller=new AbortController();let running=false,lastFetch=0,activeJob=false;
    async function load(){if(running||document.visibilityState==='hidden'||Date.now()-lastFetch<(activeJob?2500:14000))return;running=true;lastFetch=Date.now();try{const value=await api<State>('/resources/ssh',{signal:controller.signal});setData(value);activeJob=value.connections.some(c=>['probing','planning','verifying'].includes(c.status));}catch(e){if(!controller.signal.aborted)setError((e as Error).message);}finally{running=false;}}
    void api<{servers:{host:string;label:string}[]}>('/resources/catalog',{signal:controller.signal}).then(d=>setServers(d.servers)).catch(e=>{if(!controller.signal.aborted)setError(e.message);});
    void load();const timer=setInterval(()=>void load(),3000);document.addEventListener('visibilitychange',load);
    return()=>{controller.abort();clearInterval(timer);document.removeEventListener('visibilitychange',load);};
  },[pollKick]);
  const resetTicket=()=>{setTicket(null);setTrusted(false);setError('');setNotice('');};
  async function scan(){setBusy(true);setError('');setNotice('');setTicket(null);setTrusted(false);try{setTicket(await post<Ticket>('/resources/ssh/scan',{host,address,port:Number(port),username},{timeoutMs:12000}));}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function connect(){if(!ticket||!trusted)return;setBusy(true);setError('');const credential=type==='password'?{type,password}:{type,privateKey,passphrase};setPassword('');setPrivateKey('');setPassphrase('');
    try{const connection=await post<Connection>('/resources/ssh/connect',{host,ticket:ticket.ticket,trustHostKey:true,credential});setData(d=>d?{...d,connections:[...d.connections.filter(c=>c.host!==host),connection]}:d);setTicket(null);setTrusted(false);setPollKick(v=>v+1);setNotice('설정을 시작했습니다. 이 창을 닫아도 서버에서 진행합니다. 완료까지 최대 2분이 걸릴 수 있습니다.');}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function disconnect(){setBusy(true);setError('');try{const connection=await post<Connection>(`/resources/ssh/${encodeURIComponent(disconnectHost)}/disconnect`);setData(d=>d?{...d,connections:d.connections.map(c=>c.host===connection.host?connection:c)}:d);setDisconnectHost('');setPollKick(v=>v+1);onConnected();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  const selected=data?.connections.find(c=>c.host===host),active=selected&&!['disabled','failed'].includes(selected.status);
  return <section className="ssh-panel" aria-label="SSH 자동 연결"><h3>SSH 연결·자동 수집</h3>
    <p className="muted">등록한 Linux 서버에 접속해 사양과 NVIDIA GPU를 확인합니다. Codex가 수집 설정을 판단한 뒤 새 보고를 검증합니다.</p>
    <p className="small-text">Python 3와 SSH 접속 권한이 필요합니다. 패키지·데몬 설치 없이 30~60초마다 수집하며, 접속 정보는 채팅 서버에 암호화해 저장합니다. Codex에는 비밀번호·키를 보내지 않습니다.</p>
    {data&&!data.plannerConfigured&&<p className="gpu-warning">Codex 설정 계정이 연결되지 않았습니다. 채팅 서버의 계정 연결 설정이 필요합니다.</p>}
    {error&&<p className="gpu-warning" role="alert">{error}</p>}{notice&&<p className="info-banner" role="status">{notice}</p>}
    <form onSubmit={e=>{e.preventDefault();void(ticket?connect():scan());}}>
      <fieldset disabled={busy||!data?.plannerConfigured}><legend>접속할 서버</legend><div className="ssh-fields">
        <label>등록된 서버<select aria-label="등록된 서버" value={host} required onChange={e=>{setHost(e.target.value);resetTicket();}}><option value="">서버 선택</option>{servers.map(s=><option key={s.host} value={s.host}>{s.label} ({s.host})</option>)}</select></label>
        <label>SSH 주소<input value={address} required maxLength={253} placeholder="예: 192.168.0.20" autoComplete="off" onChange={e=>{setAddress(e.target.value);resetTicket();}}/></label>
        <label>포트<input type="number" min="1" max="65535" required value={port} onChange={e=>{setPort(e.target.value);resetTicket();}}/></label>
        <label>SSH 사용자명<input value={username} required maxLength={64} autoComplete="off" onChange={e=>{setUsername(e.target.value);resetTicket();}}/></label>
      </div>
      {!servers.length&&<p>먼저 ‘자원 등록·관리’에서 서버를 등록해 주세요.</p>}
      {active&&<p className="info-banner">선택한 서버는 {states[selected.status]||selected.status} 상태입니다. 재설정하려면 아래에서 연결을 해제해 주세요.</p>}
      {!ticket&&<button className="secondary" disabled={!!active||!host} type="submit">1. 서버 키 확인</button>}
      {ticket&&<div className="ssh-trust"><strong>확인할 서버 키</strong><p>접속 IP: {ticket.ip}:{port}</p><code>{ticket.fingerprint}</code><p className="small-text">서버 담당자가 제공한 지문과 비교해 주세요. 주소만으로 서버 신원을 확인할 수 없습니다. 확인은 5분 동안 유효합니다.</p>
        <label className="ssh-check"><input type="checkbox" checked={trusted} onChange={e=>setTrusted(e.target.checked)}/>서버 키 지문을 확인했고 이 서버를 신뢰합니다.</label>
        <label>인증 방식<select aria-label="인증 방식" value={type} onChange={e=>{setType(e.target.value as 'password'|'key');setPassword('');setPrivateKey('');setPassphrase('');}}><option value="password">SSH 비밀번호</option><option value="key">SSH 개인 키</option></select></label>
        {type==='password'?<label>SSH 비밀번호<input type="password" value={password} required maxLength={4096} autoComplete="new-password" onChange={e=>setPassword(e.target.value)}/></label>:<><label>SSH 개인 키<textarea value={privateKey} required maxLength={16384} autoComplete="off" spellCheck={false} onChange={e=>setPrivateKey(e.target.value)}/></label><label>키 암호 (있는 경우)<input type="password" value={passphrase} maxLength={4096} autoComplete="new-password" onChange={e=>setPassphrase(e.target.value)}/></label></>}
        <button className="primary" type="submit" disabled={!trusted||!!active}>2. Codex 설정·연결 시작</button>
      </div>}
      </fieldset>
    </form>
    <div aria-live="polite">{data?.connections.map(c=><article className="ssh-connection" key={c.id}><div className="server-toolbar"><strong>{c.host} · {states[c.status]||c.status}</strong>{!['disabled','failed'].includes(c.status)&&<button className="secondary" disabled={busy} onClick={()=>setDisconnectHost(c.host)}>{c.status==='connected'?'연결 해제':'설정 취소'}</button>}</div>
      <p className="small-text">{c.username}@{c.address}:{c.port}{c.hostname&&` · 확인한 호스트: ${c.hostname}`}</p>
      {c.plan&&<><p>{c.plan.summary}</p><p className="small-text">{c.plan.intervalSeconds}초 간격 · CPU·RAM·디스크{c.plan.collectGpu?'·GPU':''}</p></>}
      {c.lastSeen&&<p className="small-text">마지막 정상 수집: {new Date(c.lastSeen).toLocaleString('ko-KR')}</p>}
      {c.error&&<p className="gpu-warning">{c.error}</p>}
      {c.status==='connected'&&<button className="secondary" onClick={onConnected}>자원 현황 새로고침</button>}
    </article>)}</div>
    {disconnectHost&&<div className="ssh-trust" role="alert"><p>{disconnectHost}의 SSH 수집을 중단하고 저장한 접속 인증 정보를 삭제합니다. 기존 사양·예약·이력은 유지됩니다. 다른 방식의 수집 연결은 유지될 수 있습니다.</p><div className="resource-controls"><button className="primary" disabled={busy} onClick={()=>void disconnect()}>연결 해제 확인</button><button className="secondary" onClick={()=>setDisconnectHost('')}>돌아가기</button></div></div>}
  </section>;
}
