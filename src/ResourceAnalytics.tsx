import {useEffect,useState,type ReactNode} from 'react';
import {api,post,type User} from './api';

type Envelope<T>={data:T;fetchedAt:number;demo:boolean};
export const date=(v:number|null)=>v?new Date(v).toLocaleString('ko-KR'):'기록 없음';
const number=(v:number|null|undefined)=>v===null||v===undefined?'—':v.toLocaleString('ko-KR',{maximumFractionDigits:2});
export function useResource<T>(path:string|null,revision=0){
  const [data,setData]=useState<T|null>(null),[error,setError]=useState('');
  useEffect(()=>{setData(null);setError('');if(!path)return;const c=new AbortController();api<T>(path,{signal:c.signal}).then(setData).catch(e=>{if(!c.signal.aborted)setError(e.message);});return()=>c.abort();},[path,revision]);
  return {data,error};
}
function State({error,loading,children}:{error:string;loading:boolean;children:ReactNode}){return error?<p role="alert" className="gpu-warning">{error}</p>:loading?<p className="inline-loading">불러오는 중…</p>:children;}
type Target={host:string;index:number};
type Point={at:number;utilization:number|null;memoryGiB:number|null;totalGiB:number|null};
type History=Envelope<Point[]>&{from:number;to:number;bucketMs:number};
const colors=['#087f78','#7854c5','#c36a16','#2475bf','#c34577','#596d2b'];

export function ResourceHistory(){
  const [period,setPeriod]=useState('day'),[metric,setMetric]=useState<'utilization'|'memoryGiB'>('utilization'),[selected,setSelected]=useState<string[]>([]),[series,setSeries]=useState<{label:string;result:History}[]>([]),[error,setError]=useState(''),[loading,setLoading]=useState(false),[revision,setRevision]=useState(0),[shareDays,setShareDays]=useState('7');
  const targets=useResource<Envelope<Target[]>>('/resources/targets',revision);
  const share=useResource<Envelope<{user:string;hours:number|null;percent:number|null}[]>>(`/resources/share?days=${shareDays}`,revision);
  useEffect(()=>{if(targets.data)setSelected(old=>old.length?old:targets.data!.data.slice(0,3).map(t=>JSON.stringify(t)));},[targets.data]);
  useEffect(()=>{
    const c=new AbortController();setSeries([]);setError('');if(!selected.length){setLoading(false);return;}setLoading(true);
    Promise.all(selected.map(async key=>{const t=JSON.parse(key) as Target;return {label:`${t.host} · GPU ${t.index}`,result:await api<History>(`/resources/history?${new URLSearchParams({host:t.host,gpu:String(t.index),period})}`,{signal:c.signal})};})).then(setSeries).catch(e=>{if(!c.signal.aborted)setError(e.message);}).finally(()=>{if(!c.signal.aborted)setLoading(false);});
    return()=>c.abort();
  },[selected,period,revision]);
  const from=series[0]?.result.from??0,to=series[0]?.result.to??1;
  const max=metric==='utilization'?100:Math.max(1,...series.flatMap(s=>s.result.data.map(p=>p.totalGiB??p.memoryGiB??0)));
  const x=(at:number)=>48+Math.max(0,Math.min(1,(at-from)/(to-from)))*700;
  const y=(v:number)=>230-Math.min(max,v)/max*200;
  return <div className="resource-panel">
    <div className="resource-section-title"><div><h2>GPU 사용 이력</h2><p>여러 GPU의 사용률과 메모리 추이를 비교합니다. 수집이 끊긴 구간은 선으로 연결하지 않습니다.</p></div><button className="secondary" onClick={()=>setRevision(r=>r+1)}>이력 새로고침</button></div>
    <div className="resource-controls"><label>이력 기간<select aria-label="이력 기간" value={period} onChange={e=>setPeriod(e.target.value)}><option value="hour">최근 1시간</option><option value="day">최근 24시간</option><option value="week">최근 7일</option><option value="month">최근 30일</option></select></label><label>측정값<select aria-label="측정값" value={metric} onChange={e=>setMetric(e.target.value as typeof metric)}><option value="utilization">연산 사용률 (%)</option><option value="memoryGiB">메모리 (GiB)</option></select></label><button className="secondary" onClick={()=>setSelected([])}>선택 해제</button></div>
    <State error={targets.error} loading={!targets.data}><fieldset className="resource-targets"><legend>비교할 GPU · 최대 6개</legend>{targets.data?.data.map(t=>{const key=JSON.stringify(t);return <label key={key}><input type="checkbox" checked={selected.includes(key)} disabled={!selected.includes(key)&&selected.length>=6} onChange={e=>setSelected(a=>e.target.checked?[...a,key]:a.filter(k=>k!==key))}/>{t.host} · GPU {t.index}</label>;})}{targets.data?.data.length===0&&<p>수집된 이력이 없습니다.</p>}</fieldset></State>
    <State error={error} loading={loading}>{!selected.length?<p className="empty-state">비교할 GPU를 선택해 주세요.</p>:<>
      <div className="resource-chart-legend">{series.map((s,i)=><span key={s.label}><i style={{background:colors[i]}}/>{s.label} · {s.result.data.length}개 집계점</span>)}</div>
      <svg className="resource-chart" viewBox="0 0 790 275" role="img" aria-label={metric==='utilization'?'GPU 연산 사용률 이력':'GPU 메모리 사용 이력'}>
        {[0,.25,.5,.75,1].map(f=><g key={f}><line x1="48" y1={y(max*f)} x2="748" y2={y(max*f)} stroke="#dbe5e5"/><text x="40" y={y(max*f)+4} textAnchor="end">{number(max*f)}</text></g>)}
        {series.map((s,i)=>{
          let last:Point|null=null;const segments:string[]=[];
          for(const p of s.result.data){const v=p[metric];if(v===null){last=null;continue;}segments.push(`${last&&p.at-last.at<=s.result.bucketMs*2.5?'L':'M'}${x(p.at)},${y(v)}`);last=p;}
          return <g key={s.label}><path d={segments.join(' ')} fill="none" stroke={colors[i]} strokeWidth="2"/>{s.result.data.filter(p=>p[metric]!==null).map((p,k)=><circle key={k} cx={x(p.at)} cy={y(p[metric]!)} r="2.5" fill={colors[i]}><title>{s.label} · {date(p.at)} · {number(p[metric])}{metric==='utilization'?'%':' GiB'}</title></circle>)}</g>;
        })}
        <text x="48" y="262">{from?date(from):''}</text><text x="748" y="262" textAnchor="end">{to>1?date(to):''}</text>
      </svg>
      {series.length>0&&series.every(s=>s.result.data.length===0)&&<p>선택한 기간에 수집된 데이터가 없습니다. 사용량 0을 의미하지 않습니다.</p>}
      <details className="resource-data"><summary>수집 시각과 수치 표로 보기</summary><div className="resource-table-wrap"><table><thead><tr><th>GPU</th><th>시각</th><th>사용률</th><th>메모리</th></tr></thead><tbody>{series.flatMap(s=>s.result.data.map((p,i)=><tr key={`${s.label}-${i}`}><td>{s.label}</td><td>{date(p.at)}</td><td>{number(p.utilization)}%</td><td>{number(p.memoryGiB)} GiB</td></tr>))}</tbody></table></div></details>
    </>}</State>
    <div className="resource-section-title"><div><h2>OS 계정별 GPU 사용 집계</h2><p>기존 수집기의 표본 기반 추정치입니다. 공용 계정은 개인별 사용량으로 구분할 수 없고, 공유 GPU는 중복 집계될 수 있습니다.</p></div><label>집계 기간<select aria-label="집계 기간" value={shareDays} onChange={e=>setShareDays(e.target.value)}>{[1,7,30,90].map(d=><option key={d} value={d}>{d}일</option>)}</select></label></div>
    <State error={share.error} loading={!share.data}><div className="resource-table-wrap"><table><thead><tr><th>OS 계정</th><th>추정 GPU 시간</th><th>표본 비중</th></tr></thead><tbody>{share.data?.data.map((r,i)=><tr key={i}><td>{r.user}</td><td>{number(r.hours)} 시간</td><td>{number(r.percent)}%</td></tr>)}</tbody></table>{share.data?.data.length===0&&<p>집계된 표본이 없습니다.</p>}</div></State>
  </div>;
}

type Quota={provider:string;account:string;plan:string;stale:boolean;reportedAt:number|null;fiveHour:{percent:number|null;resetsAt:number|null};sevenDay:{percent:number|null;resetsAt:number|null};servers:{host:string;lastSeen:number|null}[]};
type Cost={label?:string;costKRW:number|null;costUSD:number|null;tokens:number|null;requests:number|null};
type Balance={amount:number|null;currency:string|null;updatedAt:number;source:string};
type LocalBalance={provider:string;amount:number;currency:string;updated_at:number;updated_name:string;version:number};
type Usage={totals:Cost;byProvider:Cost[];byModel:Cost[];byPerson:Cost[];byDay:Cost[];byDetail:Cost[];balances:Record<string,Balance|null>;localBalances:LocalBalance[];hasData:boolean;from:number|null;to:number|null};
function CostTable({title,rows}:{title:string;rows:Cost[]}){return <details className="resource-data" open><summary>{title}</summary><div className="resource-table-wrap"><table><thead><tr><th>항목</th><th>비용 (KRW)</th><th>토큰</th><th>요청</th></tr></thead><tbody>{rows.map((r,i)=><tr key={i}><td>{r.label}</td><td>{number(r.costKRW)}</td><td>{number(r.tokens)}</td><td>{number(r.requests)}</td></tr>)}</tbody></table>{!rows.length&&<p>집계 데이터가 없습니다.</p>}</div></details>;}
export function ResourceAccounts({me}:{me:User}){
  const [days,setDays]=useState('30'),[provider,setProvider]=useState('all'),[revision,setRevision]=useState(0),[editing,setEditing]=useState<string|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const quotas=useResource<Envelope<Quota[]>>('/resources/quotas',revision);
  const usage=useResource<Envelope<Usage>>(`/resources/usage?days=${days}&provider=${provider}`,revision);
  useEffect(()=>{const id=setInterval(()=>{if(document.visibilityState==='visible'&&!editing)setRevision(r=>r+1);},60000);return()=>clearInterval(id);},[editing]);
  return <div className="resource-panel">
    <div className="resource-section-title"><div><h2>CLI 구독 한도</h2><p>Codex·Claude의 마지막 수집값입니다. 15분 이상 지난 값은 현재 한도로 표시하지 않습니다.</p></div><button className="secondary" onClick={()=>setRevision(r=>r+1)}>사용량 새로고침</button></div>
    <State error={quotas.error} loading={!quotas.data}><div className="resource-quota-grid">{quotas.data?.data.map((q,i)=><article className="resource-quota" key={i}><h3>{q.provider} <span>{q.plan}</span></h3><p>{q.account}</p>{q.stale&&<p className="gpu-warning">보고 지연 · 현재 한도 확인 불가</p>}{[['5시간',q.fiveHour],['주간',q.sevenDay]].map(([label,raw])=>{const w=raw as Quota['fiveHour'];return <div key={label as string}><b>{label as string}: {number(w.percent)}%</b><div className="gpu-meter"><i style={{width:`${w.percent??0}%`}}/></div><small>리셋 예정 {date(w.resetsAt)}</small></div>;})}<p>마지막 수집 {date(q.reportedAt)}</p><small>연결 서버: {q.servers.map(s=>`${s.host} (${date(s.lastSeen)})`).join(', ')||'보고 없음'}</small></article>)}</div>{quotas.data?.data.length===0&&<p>수집된 구독 계정이 없습니다.</p>}</State>
    <div className="resource-section-title"><div><h2>API 사용량·비용</h2><p>기존 수집 서버의 집계입니다. 청구서 확정 금액과 다를 수 있으며, 집계 없음은 실제 사용량 0을 뜻하지 않습니다.</p></div></div>
    <div className="resource-controls"><label>비용 기간<select aria-label="비용 기간" value={days} onChange={e=>setDays(e.target.value)}>{[1,7,30,90].map(d=><option key={d} value={d}>최근 {d}일</option>)}</select></label><label>공급자<select aria-label="공급자" value={provider} onChange={e=>setProvider(e.target.value)}><option value="all">전체</option>{['openai','anthropic','google'].map(p=><option key={p}>{p}</option>)}</select></label></div>
    <State error={usage.error} loading={!usage.data}>{usage.data&&<>
      <p className="resource-muted">집계 범위 {date(usage.data.data.from)} ~ {date(usage.data.data.to)} · 조회 {date(usage.data.fetchedAt)}</p>
      {!usage.data.data.hasData?<p className="info-banner">선택한 기간·공급자의 집계 데이터가 없습니다.</p>:<div className="gpu-summary"><div><strong>{number(usage.data.data.totals.costKRW)}</strong><span>집계 비용 (KRW)</span></div><div><strong>{number(usage.data.data.totals.tokens)}</strong><span>토큰</span></div><div><strong>{number(usage.data.data.totals.requests)}</strong><span>요청</span></div></div>}
      <CostTable title="공급자별" rows={usage.data.data.byProvider}/><CostTable title="모델별" rows={usage.data.data.byModel}/><CostTable title="사용자별" rows={usage.data.data.byPerson}/><CostTable title="일자·사용자별 (UTC)" rows={usage.data.data.byDay}/><CostTable title="사용자·공급자·모델 상세" rows={usage.data.data.byDetail}/>
      <h2>수동 잔액 기록</h2><p>공급자 콘솔에서 확인한 값을 기록합니다. 메신저에서 수정한 값은 이 서비스에만 저장되며, 기존 ERP의 기록과 구분됩니다.</p>
      {error&&<p role="alert" className="gpu-warning">{error}</p>}
      <div className="resource-quota-grid">{['openai','anthropic','google'].map(p=>{
        const upstream=usage.data!.data.balances[p],local=usage.data!.data.localBalances.find(b=>b.provider===p);
        return <article className="resource-quota" key={p}><h3>{p}</h3><p>ERP 기록: {upstream?`${number(upstream.amount)} ${upstream.currency} · ${date(upstream.updatedAt)}`:'기록 없음'}</p><p>메신저 기록: {local?`${number(local.amount)} ${local.currency} · ${date(local.updated_at)} · ${local.updated_name}`:'기록 없음'}</p>{me.role==='admin'&&<button className="secondary" onClick={()=>{setEditing(editing===p?null:p);setError('');}}>잔액 기록 수정 · {p}</button>}{editing===p&&<form className="resource-form" onSubmit={async e=>{e.preventDefault();const f=new FormData(e.currentTarget);setBusy(true);setError('');try{await post('/resources/balances',{provider:p,amount:Number(f.get('amount')),currency:f.get('currency'),version:local?.version??0});setEditing(null);setRevision(r=>r+1);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}><label>잔액<input name="amount" type="number" min="0" max="1000000000000" step="0.01" defaultValue={local?.amount??upstream?.amount??''} required/></label><label>통화<select aria-label="통화" name="currency" defaultValue={local?.currency??upstream?.currency??'USD'}><option>USD</option><option>KRW</option></select></label><button className="primary" disabled={busy}>잔액 저장</button></form>}</article>;
      })}</div>
    </>}</State>
  </div>;
}
