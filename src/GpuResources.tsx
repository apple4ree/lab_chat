import {useEffect,useRef,useState} from 'react';
import {Cpu,RefreshCw,Bell,Menu,Server,Activity,Clock,AlertTriangle} from 'lucide-react';
import {api,type User,type ResponseCache} from './api';
import {ResourceHistory,ResourceAccounts} from './ResourceAnalytics';
import {ResourceReservations} from './ResourceReservations';

type Status='active'|'resident'|'idle'|'offline'|'unknown';
type Gpu={id:string;host:string;index:number;name:string;reportedAt:number|null;utilization:number|null;memoryTotalMiB:number|null;memoryUsedMiB:number|null;memoryFreeMiB:number|null;temperature:number|null;status:Status;processes:{pid:number|null;user:string|null;memoryMiB:number|null}[]};
type Inventory={configured:boolean;demo:boolean;connection:string;checkedAt:number|null;lastSuccessAt:number|null;channelId:string|null;items:Gpu[];summary:Record<string,number>};
const labels:Record<Status,string>={active:'연산 중',resident:'메모리·작업 상주',idle:'미사용 관측',offline:'보고 중단',unknown:'확인 불가'};
const gib=(value:number|null)=>value===null?'—':(value/1024).toFixed(1);
const stamp=(value:number|null)=>value?new Date(value).toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'}):'기록 없음';

export function GpuResources({me,onChannel,onMenu,onError}:{me:User;onChannel:(id:string)=>void;onMenu:()=>void;onError:(e:unknown)=>void}){
  const [tab,setTab]=useState('live');
  const snapshot=useRef<ResponseCache>({});
  const [data,setData]=useState<Inventory|null>(null),[filter,setFilter]=useState('all'),[host,setHost]=useState('all'),[loading,setLoading]=useState(false),[error,setError]=useState(''),[refresh,setRefresh]=useState(0);
  useEffect(()=>{
    let live=true,controller:AbortController|null=null;
    async function load(){
      if(document.visibilityState==='hidden')return;
      controller?.abort();controller=new AbortController();setLoading(true);
      try{const next=await api<Inventory>('/resources/gpus',{signal:controller.signal,cacheEntry:snapshot.current});if(live){setData(next);setError('');}}
      catch(e){if(live&&(e as Error).name!=='AbortError'){setError('GPU 현황을 불러오지 못했습니다. 마지막 화면은 최신 상태가 아닙니다.');onError(e);}}
      finally{if(live)setLoading(false);}
    }
    void load();const timer=setInterval(()=>void load(),15000);const focus=()=>void load();document.addEventListener('visibilitychange',focus);
    return()=>{live=false;controller?.abort();clearInterval(timer);document.removeEventListener('visibilitychange',focus);};
  },[refresh,onError]);
  const items=data?.items||[],hosts=[...new Set(items.map(i=>i.host))],visible=items.filter(i=>(host==='all'||i.host===host)&&(filter==='all'||i.status===filter));
  return <section className="gpu-resources" aria-label="GPU 자원 현황">
    <header className="channel-header"><button className="mobile-menu icon-button" aria-label="채널 목록 열기" onClick={onMenu}><Menu size={21}/></button><div className="channel-heading"><h2><Cpu size={23}/>연구 자원</h2><p>GPU 상태를 확인하고, 동료와 사용을 조율하세요.</p></div><button className="icon-button" aria-label="GPU 현황 새로고침" disabled={loading} onClick={()=>setRefresh(n=>n+1)}><RefreshCw size={18} className={loading?'spin':''}/></button></header>
    <div className="gpu-scroll">
      <div className="gpu-title"><div><span className="gpu-eyebrow">RESEARCH RESOURCES</span><h1>연구에 필요한 연산 자원</h1><p>장비의 마지막 관측값입니다. 미사용 표시는 예약이나 독점 사용 권한을 보장하지 않습니다.</p></div>{data?.channelId&&<button className="secondary" onClick={()=>onChannel(data.channelId!)}><Bell size={16}/>#gpu-자원 알림</button>}</div>
      {data?.demo&&<p className="info-banner">체험용 샘플 장비입니다. 실제 연구실 GPU나 작업 정보와 연결되지 않습니다.</p>}
      <nav className="resource-tabs" aria-label="자원 관리 메뉴">{[['live','GPU 현황'],['history','사용 이력'],['reservations','예약·배정'],['accounts','AI 사용량·한도']].map(([key,label])=><button key={key} aria-current={tab===key?'page':undefined} onClick={()=>setTab(key)}>{label}</button>)}</nav>
      {tab==='history'?<ResourceHistory/>:tab==='reservations'?<ResourceReservations me={me}/>:tab==='accounts'?<ResourceAccounts me={me}/>:<>
      {error&&<p className="gpu-warning" role="alert"><AlertTriangle size={18}/>{error}</p>}
      {data&&!data.configured&&<div className="gpu-warning"><AlertTriangle size={18}/><span>아직 GPU 상태 서비스가 연결되지 않았습니다. 관리자에게 연결을 요청해 주세요.</span></div>}
      {data?.configured&&data.connection!=='ok'&&<div className="gpu-warning" role="status"><AlertTriangle size={18}/><span>{data.connection==='waiting'?'첫 GPU 상태를 기다리고 있습니다.':'GPU 상태 서비스와 연결이 끊겼습니다. 마지막 값을 현재 가용량으로 취급하지 마세요.'}</span></div>}
      {!data&&!error?<p className="inline-loading">GPU 현황을 불러오는 중…</p>:<>
        <div className="gpu-summary"><div><Server size={19}/><strong>{data?.summary.hosts??0}<small>대</small></strong><span>등록 서버</span></div><div><Cpu size={19}/><strong>{data?.summary.total??0}<small>개</small></strong><span>등록 GPU</span></div><div className="gpu-available"><Activity size={19}/><strong>{error?'—':data?.summary.idle??0}<small>개</small></strong><span>미사용 관측</span></div><div><Clock size={19}/><strong>{error?'—':(data?.summary.offline??0)+(data?.summary.unknown??0)}<small>개</small></strong><span>보고 중단·확인 불가</span></div></div>
        <div className="gpu-controls"><label>서버<select aria-label="서버" value={host} onChange={e=>setHost(e.target.value)}><option value="all">전체 서버</option>{hosts.map(h=><option key={h}>{h}</option>)}</select></label><label>상태<select aria-label="상태" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">전체 상태</option>{Object.entries(labels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label><span>조회 {stamp(data?.checkedAt??null)} · 15초마다 갱신</span></div>
        <div className="gpu-grid">{visible.map(g=>{
          const outdated=Boolean(error)||g.status==='offline'||g.status==='unknown',status=error?'unknown':g.status;
          const utilization=outdated?null:g.utilization,used=outdated?null:g.memoryUsedMiB,total=g.memoryTotalMiB;
          return <article className={`gpu-card gpu-${status}`} key={g.id}><div className="gpu-card-top"><span className="gpu-host">{g.host}</span><span className={`gpu-status ${status}`}>{labels[status]}</span></div><h3>GPU {g.index}<span>{g.name}</span></h3><div className="gpu-metrics"><div><span>연산 사용률</span><b>{utilization===null?'—':`${utilization}%`}</b><div className="gpu-meter"><i style={{width:`${utilization??0}%`}}/></div></div><div><span>메모리 사용 / 전체</span><b>{gib(used)} / {gib(total)} <small>GiB</small></b><div className="gpu-meter memory"><i style={{width:`${used!==null&&total?Math.min(100,used/total*100):0}%`}}/></div></div></div><div className="gpu-detail-line"><span>남은 VRAM <b>{gib(outdated?null:g.memoryFreeMiB)} GiB</b></span><span>온도 <b>{outdated||g.temperature===null?'—':`${g.temperature}°C`}</b></span></div>
            {!outdated&&<details className="gpu-processes"><summary>관측된 작업 {g.processes.length}개</summary>{g.processes.length?<><p>OS 계정이며 연구실 구성원과 일치하지 않을 수 있습니다.</p>{g.processes.slice(0,30).map((p,i)=><div key={`${p.pid}-${i}`}><strong>{p.user||'사용자 미확인'}</strong><span>PID {p.pid??'—'}</span><span>{gib(p.memoryMiB)} GiB</span></div>)}{g.processes.length>30&&<p>외 {g.processes.length-30}개 작업</p>}</>:<p>현재 보고된 GPU 프로세스가 없습니다.</p>}</details>}
            <footer><Clock size={13}/><span>마지막 수집 {stamp(g.reportedAt)}</span></footer></article>;
        })}</div>{data&&visible.length===0&&<div className="empty-state"><Cpu size={30}/><p>{items.length?'선택한 조건의 GPU가 없습니다.':'아직 보고된 GPU가 없습니다.'}</p></div>}
        <div className="gpu-footnote"><strong>상태를 읽는 방법</strong><p>연산이 0%여도 메모리나 작업이 남으면 ‘메모리·작업 상주’입니다. 3분 이상 보고가 없으면 ‘보고 중단’이며, 장애 원인은 별도 확인이 필요합니다. 안정적으로 확인된 미사용 전환·보고 중단·복구는 #gpu-자원에 한 번씩 기록됩니다.</p></div>
      </>}
      </>}
    </div>
  </section>;
}
