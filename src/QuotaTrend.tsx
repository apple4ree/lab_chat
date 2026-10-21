import {useEffect,useState} from 'react';
import {api} from './api';

type Account={id?:string;provider:string;account:string};
type Point={at:number;remaining:number|null;used:number|null;resetsAt:number|null;issue:string|null;breakReason:'error'|'gap'|'reset_or_change'|null};
type Trend={data:{account:string;from:number;to:number;startedAt:number|null;intervalMs:number;limited:boolean;points:Point[]};fetchedAt:number;demo:boolean;source:string};
const date=(v:number)=>new Date(v).toLocaleString('ko-KR');
const percent=(v:number|null)=>v===null?'—':`${v.toLocaleString('ko-KR',{maximumFractionDigits:2})}%`;

export function QuotaTrend({accounts,revision}:{accounts:Account[]|undefined;revision:number}){
  const [account,setAccount]=useState<Account|null>(null),[days,setDays]=useState('1'),[metric,setMetric]=useState<'remaining'|'used'>('remaining');
  const [result,setResult]=useState<Trend|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[refresh,setRefresh]=useState(0),[page,setPage]=useState(0);
  const [tableOpen,setTableOpen]=useState(false);
  // Preserve the selection while the parent refreshes its account list.
  useEffect(()=>{if(accounts)setAccount(current=>accounts.find(a=>a.id&&a.id===current?.id)||accounts.find(a=>a.id)||null);},[accounts]);
  const id=account?.id;
  useEffect(()=>{
    const controller=new AbortController();setResult(null);setError('');setPage(0);setBusy(!!id);
    if(id)api<Trend>(`/resources/quotas/history?${new URLSearchParams({account:id,days})}`,{signal:controller.signal}).then(value=>{if(!controller.signal.aborted)setResult(value);}).catch(e=>{if(!controller.signal.aborted)setError(e.message);}).finally(()=>{if(!controller.signal.aborted)setBusy(false);});
    return()=>controller.abort();
  },[id,days,revision,refresh]);
  const points=result?.data.points||[],valid=points.filter(p=>p[metric]!==null),last=valid.at(-1);
  const from=result?.data.from??0,to=result?.data.to??1;
  const x=(at:number)=>48+Math.max(0,Math.min(1,(at-from)/(to-from)))*700,y=(v:number)=>230-v*2;
  let previous:Point|null=null;const segments:string[]=[];
  for(const p of points){const v=p[metric];if(v===null){previous=null;continue;}segments.push(`${previous&&!p.breakReason?'L':'M'}${x(p.at)},${y(v)}`);previous=p;}
  const rows=points.slice(Math.max(0,points.length-(page+1)*50),Math.max(0,points.length-page*50)).reverse();
  return <section aria-label="CLI 사용량 추이">
    <div className="resource-section-title"><div><h2>CLI 사용량 추이</h2><p>주간 한도 대비 잔여율·사용률입니다. 토큰 수나 API 비용을 의미하지 않습니다.</p></div><button className="secondary" disabled={!id||busy} onClick={()=>setRefresh(r=>r+1)}>추이 새로고침</button></div>
    <div className="resource-controls">
      <label>추이 계정<select aria-label="추이 계정" value={id||''} onChange={e=>setAccount(accounts?.find(a=>a.id===e.target.value)||null)}>{(accounts||[account]).filter(a=>a?.id).map(a=><option key={a!.id} value={a!.id}>{a!.provider} · {a!.account}</option>)}</select></label>
      <label>추이 기간<select aria-label="추이 기간" value={days} onChange={e=>setDays(e.target.value)}><option value="1">최근 24시간</option><option value="3">최근 3일</option><option value="7">최근 7일</option></select></label>
      <label>추이 측정값<select aria-label="추이 측정값" value={metric} onChange={e=>setMetric(e.target.value as typeof metric)}><option value="remaining">잔여율 (%)</option><option value="used">사용률 (%)</option></select></label>
    </div>
    {error?<p role="alert" className="gpu-warning">{error}</p>:busy?<p className="inline-loading">추이를 불러오는 중…</p>:!id?<p>추이를 조회할 수 있는 계정이 없습니다.</p>:result&&<>
      <p className="gpu-footnote">{result.demo?'체험용 표본':'ERP 수집 이력'} · 약 15분 간격 · {points.length.toLocaleString()}개 기록<br/>수집 실패·30분 초과 공백·리셋 또는 한도 변경 구간은 선으로 연결하지 않습니다.</p>
      {result.data.limited&&<p className="gpu-warning">조회 한도인 11,000개 기록에 도달했습니다. 이후 기록이 누락되었을 수 있으므로 기간을 줄여 확인해 주세요.</p>}
      {last&&<p>마지막 유효 기록: {date(last.at)} · {metric==='remaining'?'잔여율':'사용률'} {percent(last[metric])}</p>}
      {points.length===0?<p>선택한 기간의 수집 기록이 없습니다. 사용량 0을 의미하지 않습니다.</p>:<>
        {!valid.length&&<p className="gpu-warning">선택한 기간에 유효한 한도 수치가 없습니다. 아래 표에서 수집 상태를 확인해 주세요.</p>}
        <svg className="resource-chart" viewBox="0 0 790 275" role="img" aria-label={`CLI 주간 한도 ${metric==='remaining'?'잔여율':'사용률'} 추이`}>
          {[0,25,50,75,100].map(v=><g key={v}><line x1="48" y1={y(v)} x2="748" y2={y(v)} stroke="#dbe5e5"/><text x="40" y={y(v)+4} textAnchor="end">{v}%</text></g>)}
          <path d={segments.join(' ')} fill="none" stroke="#087f78" strokeWidth="2"/>
          {valid.filter((p,i)=>valid.length<=1000||i===0||i===valid.length-1||p.breakReason).map(p=><circle key={p.at} cx={x(p.at)} cy={y(p[metric]!)} r="2.5" fill="#087f78"><title>{date(p.at)} · {percent(p[metric])}</title></circle>)}
          <text x="48" y="262">{date(from)}</text><text x="748" y="262" textAnchor="end">{date(to)}</text>
        </svg>
        <details className="resource-data" open={tableOpen} onToggle={e=>setTableOpen(e.currentTarget.open)}><summary>추이 수치·수집 상태 보기</summary><div className="resource-table-wrap"><table><thead><tr><th>수집 시각</th><th>잔여율</th><th>사용률</th><th>상태</th></tr></thead><tbody>{rows.map(p=><tr key={p.at}><td>{date(p.at)}</td><td>{percent(p.remaining)}</td><td>{percent(p.used)}</td><td>{p.issue||(p.breakReason==='reset_or_change'?'리셋·한도 변화':p.breakReason==='gap'?'수집 공백 이후':'정상')}</td></tr>)}</tbody></table></div><div className="resource-controls"><button className="secondary" disabled={page===0} onClick={()=>setPage(p=>p-1)}>더 최근 기록</button><span>{page+1} / {Math.max(1,Math.ceil(points.length/50))} 페이지</span><button className="secondary" disabled={(page+1)*50>=points.length} onClick={()=>setPage(p=>p+1)}>이전 기록</button></div></details>
      </>}
    </>}
  </section>;
}
