import {useState} from 'react';
import {ArrowRight,FlaskConical,ShieldCheck,MessagesSquare,Search} from 'lucide-react';
import {post,type AuthConfig,type User} from './api';
import {Avatar} from './components';

export function Auth({config,onLogin}:{config:AuthConfig;onLogin:(u:User)=>void}){
  const invite=new URLSearchParams(location.hash.slice(1)).get('invite');
  const [name,setName]=useState(''),[email,setEmail]=useState(''),[password,setPassword]=useState(''),[setupToken,setSetupToken]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const type=config.needsSetup?'setup':invite?'register':'login';
  const title=type==='setup'?'우리 연구실의 첫 공간 만들기':type==='register'?'연구실 초대가 도착했어요':'다시, 함께하는 연구로';
  async function login(userId?:string){
    setBusy(true);setError('');
    try{const user=await post<User>(`/auth/${userId?'demo':type}`,userId?{userId}:type==='login'?{login:email,password}:{name,email,password,setupToken,invite});history.replaceState(null,'',location.pathname+(location.hash==='#desktop-downloads'?'#desktop-downloads':''));onLogin(user);}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  return <div className="auth-page"><section className="auth-story"><div className="brand"><span className="brand-mark"><FlaskConical size={25}/></span>lab<span className="brand-light">chat</span></div><div><div className="eyebrow">A SPACE FOR YOUR NEXT DISCOVERY</div><h1>좋은 연구는<br/>좋은 대화에서.</h1><p>질문을 나누고, 실험을 기록하고,<br/>서로의 발견을 이어 가는 우리만의 공간.</p><div className="auth-features"><span><MessagesSquare size={18}/> 프로젝트별 대화</span><span><Search size={18}/> 쌓여 가는 연구 기록</span><span><ShieldCheck size={18}/> 연구실 구성원만의 공간</span></div></div><small>LAB CHAT / YOUR RESEARCH, CONNECTED.</small><div className="orb orb-one"/><div className="orb orb-two"/></section>
    <main className="auth-panel"><div className="auth-box"><span className="pill">{config.mode==='demo'?'로컬 체험 공간':'연구실 워크스페이스'}</span><h2>{config.mode==='demo'?'함께 둘러볼까요?':title}</h2><p className="muted">{config.mode==='demo'?'체험 계정을 골라 채널과 스레드를 사용해 보세요. 실제 연구실 데이터와 분리된 공간입니다.':type==='setup'?'첫 계정은 관리자가 됩니다. 서버 터미널의 최초 설정 코드를 준비해 주세요.':type==='register'?'초대받은 이메일로 계정을 만들어 주세요.':'연구실 계정으로 로그인해 대화를 이어 가세요.'}</p>
    {config.mode==='demo'?<div className="demo-accounts">{config.demoUsers.map(u=><button key={u.id} disabled={busy} onClick={()=>void login(u.id)}><Avatar user={u}/><span><strong>{u.name}</strong><small>{u.role==='admin'?'관리자':'연구원'}</small></span><ArrowRight size={19}/></button>)}</div>:<form onSubmit={e=>{e.preventDefault();void login();}}>
      {type==='setup'&&<label>최초 설정 코드<input value={setupToken} onChange={e=>setSetupToken(e.target.value)} required autoComplete="off" placeholder="서버 터미널에 표시된 코드"/></label>}
      {type!=='login'&&<label>이름<input value={name} onChange={e=>setName(e.target.value)} required maxLength={60} autoComplete="name" placeholder="연구실에서 사용하는 이름"/></label>}
      <label>{type==='login'?'이메일 또는 아이디':'이메일'}<input type={type==='login'?'text':'email'} value={email} onChange={e=>setEmail(e.target.value)} autoComplete="username" required placeholder={type==='login'?'이메일 또는 아이디를 입력해 주세요':'name@your-lab.ac.kr'}/></label>
      <label>비밀번호<input type="password" value={password} onChange={e=>setPassword(e.target.value)} autoComplete={type==='login'?'current-password':'new-password'} minLength={type==='login'?1:10} maxLength={256} required placeholder={type==='login'?'비밀번호를 입력해 주세요':'10자 이상 입력해 주세요'}/></label>
      <button className="primary auth-submit" disabled={busy}>{busy?'연결 중…':type==='login'?'로그인':type==='setup'?'연구실 공간 만들기':'가입하고 시작하기'}<ArrowRight size={18}/></button>
    </form>}
    {error&&<p role="alert" className="form-error">{error}</p>}
    <div className="auth-footnote"><ShieldCheck size={15}/>{config.mode==='demo'?'샘플 대화와 체험 계정만 사용합니다.':'가입은 관리자 초대로 진행합니다.'}</div>
    </div></main></div>;
}
