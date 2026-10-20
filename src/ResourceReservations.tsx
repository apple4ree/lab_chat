import {useEffect,useState,type FormEvent} from 'react';
import {api,post,type User} from './api';
import {date,useResource} from './ResourceAnalytics';

type Resource={id:string;host:string;gpu_index:number;label:string;notes:string;owner_id:string|null;owner_name:string|null;enabled:number;version:number;observation:{status:string;memoryTotalMiB:number|null}|null;current:{id:number;project:string;ends_at:number;user_name:string}|null};
type Reservation={id:number;resource_id:string;resource_label:string;user_id:string;user_name:string;project:string;purpose:string;starts_at:number;ends_at:number;memory_gib:number|null;status:string;version:number};
type Management={resources:Resource[];reservations:Reservation[];nextBefore:number|null;serverTime:number};
type Event={id:number;action:string;note:string;actor_name:string|null;at:number};
const labels:Record<string,string>={pending:'신청',reviewing:'검토 중',approved:'승인',allocated:'배정',rejected:'반려',cancelled:'취소',completed:'기간 종료',expired:'미승인 만료',updated:'수정 후 재신청',started:'예약 시작'};
const terminal=['rejected','cancelled','completed','expired'];
const localInput=(time:number)=>{const d=new Date(time);return new Date(time-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};
function Events({id}:{id:number}){const {data,error}=useResource<Event[]>(`/resources/reservations/${id}/events`);return <div className="resource-event-list">{error&&<p role="alert">{error}</p>}{data?.map(e=><p key={e.id}><b>{labels[e.action]||e.action}</b> · {e.actor_name||'자동 처리'} · {date(e.at)}{e.note&&<span>{e.note}</span>}</p>)}</div>;}

export function ResourceReservations({me}:{me:User}){
  const [revision,setRevision]=useState(0),[status,setStatus]=useState('all'),[mine,setMine]=useState(false),[before,setBefore]=useState<number|null>(null),[form,setForm]=useState<Reservation|'new'|null>(null),[editingResource,setEditingResource]=useState<Resource|null>(null),[eventId,setEventId]=useState<number|null>(null),[error,setError]=useState(''),[success,setSuccess]=useState(''),[busy,setBusy]=useState(false),[decision,setDecision]=useState<{r:Reservation;status:string}|null>(null);
  const {data,error:loadError}=useResource<Management>(`/resources/management?status=${status}&mine=${mine?'1':'0'}${before?`&before=${before}`:''}`,revision);
  const people=useResource<User[]>(me.role==='admin'?'/users':null);
  useEffect(()=>{const id=setInterval(()=>{if(document.visibilityState==='visible'&&!form&&!editingResource&&!decision)setRevision(r=>r+1);},30000);return()=>clearInterval(id);},[form,editingResource,decision]);
  async function action(fn:()=>Promise<unknown>,message:string){setBusy(true);setError('');setSuccess('');try{await fn();setSuccess(message);setRevision(r=>r+1);setForm(null);setEditingResource(null);setDecision(null);setEventId(null);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  function submit(e:FormEvent<HTMLFormElement>){
    e.preventDefault();const f=new FormData(e.currentTarget),r=form!=='new'?form:null;
    const body={resourceId:f.get('resource'),project:f.get('project'),purpose:f.get('purpose'),startsAt:new Date(String(f.get('start'))).getTime(),endsAt:new Date(String(f.get('end'))).getTime(),memoryGiB:f.get('memory')?Number(f.get('memory')):null,version:r?.version};
    void action(()=>r?api(`/resources/reservations/${r.id}`,{method:'PUT',body:JSON.stringify(body)}):post('/resources/reservations',body),'예약 신청을 저장했습니다. 관리자 승인 후 일정이 확정됩니다.');
  }
  const currentForm=form&&form!=='new'?form:null;
  const tz=Intl.DateTimeFormat().resolvedOptions().timeZone;
  return <div className="resource-panel">
    <div className="resource-section-title"><div><h2>GPU 예약·배정</h2><p>신청 → 검토 → 승인 → 배정. 승인·배정된 예약은 GPU 한 개를 해당 시간 동안 예약합니다. 실제 작업 실행·종료는 별도로 진행하세요.</p></div><button className="primary" disabled={!data?.resources.some(r=>r.enabled)} onClick={()=>{setForm('new');setError('');setSuccess('');}}>예약 신청</button></div>
    <p className="info-banner">메신저 전용 예약 원장입니다. 기존 ERP의 예약과 자동 동기화되지 않습니다. 시간은 현재 기기의 시간대({tz})로 표시합니다.</p>
    {(error||loadError)&&<p role="alert" className="gpu-warning">{error||loadError}</p>}{success&&<p role="status" className="info-banner">{success}</p>}
    {form&&<form className="resource-form resource-form-box" aria-label="예약 신청서" onSubmit={submit} key={typeof form==='string'?'new':form.id}>
      <h3>{currentForm?`예약 #${currentForm.id} 수정`:'새 예약 신청'}</h3><p>기간이나 내용을 수정하면 기존 승인은 해제되고 다시 신청 상태가 됩니다.</p>
      <label>예약 GPU<select aria-label="예약 GPU" name="resource" defaultValue={currentForm?.resource_id} required>{data?.resources.filter(r=>r.enabled||r.id===currentForm?.resource_id).map(r=><option key={r.id} value={r.id} disabled={!r.enabled}>{r.label}{r.observation?.status==='offline'?' · 보고 중단':r.observation?.status==='unknown'?' · 상태 확인 불가':''}</option>)}</select></label>
      <label>프로젝트<input name="project" maxLength={120} defaultValue={currentForm?.project} placeholder="예: 영상 모델 학습" required/></label>
      <div className="resource-form-pair"><label>시작 시간<input name="start" type="datetime-local" defaultValue={localInput(currentForm?.starts_at??Date.now()+3600000)} required/></label><label>종료 시간<input name="end" type="datetime-local" defaultValue={localInput(currentForm?.ends_at??Date.now()+7200000)} required/></label></div>
      <label>필요 VRAM (GiB, 선택)<input name="memory" type="number" min="0.1" step="0.1" defaultValue={currentForm?.memory_gib??''}/></label>
      <label>사용 목적·근거<textarea name="purpose" maxLength={2000} defaultValue={currentForm?.purpose} placeholder="실험 내용과 필요한 시간을 적어 주세요." required/></label>
      <div className="resource-controls"><button className="primary" disabled={busy}>신청 저장</button><button type="button" className="secondary" onClick={()=>setForm(null)}>닫기</button></div>
    </form>}
    <h3>장비와 현재 예약</h3><div className="resource-inventory">{data?.resources.map(r=><article key={r.id}><div><h4>{r.label}</h4><p>{r.host} · GPU {r.gpu_index}{r.owner_name?` · 담당 ${r.owner_name}`:''}</p><p>{r.enabled?'예약 신청 가능':'점검·예약 중지'} · {r.observation?.status==='offline'?'보고 중단':r.observation?.status==='unknown'||!r.observation?'상태 확인 불가':'상태 수집 중'}</p>{r.notes&&<p className="resource-prewrap">{r.notes}</p>}{r.current?<p><b>현재 예약 #{r.current.id}</b> · {r.current.user_name} · {r.current.project} · {date(r.current.ends_at)}까지</p>:<p>현재 시간에 확정된 예약 없음</p>}</div>{me.role==='admin'&&<button className="secondary" onClick={()=>{setEditingResource(r);setError('');}}>장비 설정 · {r.label}</button>}</article>)}</div>
    {editingResource&&<form className="resource-form resource-form-box" aria-label="장비 설정" onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);void action(()=>api(`/resources/inventory/${editingResource.id}`,{method:'PUT',body:JSON.stringify({version:editingResource.version,label:f.get('label'),notes:f.get('notes'),ownerId:f.get('owner')||null,enabled:f.get('enabled')==='on'})}),'장비 설정을 저장했습니다. 기존 승인 예약은 유지되므로 필요하면 별도로 취소하세요.');}} key={editingResource.id}>
      <h3>장비 설정</h3><label>장비 이름<input name="label" maxLength={160} defaultValue={editingResource.label} required/></label><label>장비 담당자<select aria-label="장비 담당자" name="owner" defaultValue={editingResource.owner_id??''}><option value="">지정 없음</option>{people.data?.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select></label><label>장비 안내<textarea name="notes" maxLength={2000} defaultValue={editingResource.notes}/></label><label className="resource-check"><input type="checkbox" name="enabled" defaultChecked={Boolean(editingResource.enabled)}/>예약 신청·승인 허용</label><p>예약을 중지해도 기존 승인·배정 기록과 실행 중인 작업은 유지됩니다.</p><div className="resource-controls"><button className="primary" disabled={busy}>장비 설정 저장</button><button className="secondary" type="button" onClick={()=>setEditingResource(null)}>닫기</button></div>
    </form>}
    <div className="resource-section-title"><h3>예약 원장</h3><button className="secondary" onClick={()=>setRevision(r=>r+1)}>예약 새로고침</button></div>
    <div className="resource-controls"><label>예약 상태<select aria-label="예약 상태" value={status} onChange={e=>{setStatus(e.target.value);setBefore(null);}}><option value="all">전체</option>{Object.entries(labels).filter(([k])=>!['updated','started'].includes(k)).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label><label className="resource-check"><input type="checkbox" checked={mine} onChange={e=>{setMine(e.target.checked);setBefore(null);}}/>내 예약만</label></div>
    {!data&&!loadError&&<p>예약 목록을 불러오는 중…</p>}
    <div className="resource-bookings">{data?.reservations.map(r=>{
      const canEdit=(r.user_id===me.id||me.role==='admin')&&!terminal.includes(r.status)&&r.status!=='allocated'&&!(r.status==='approved'&&r.starts_at<=data.serverTime);
      const canCancel=(r.user_id===me.id||me.role==='admin')&&!terminal.includes(r.status);
      const transitions=me.role==='admin'?({pending:['reviewing','approved','rejected'],reviewing:['approved','rejected'],approved:['allocated']} as Record<string,string[]>)[r.status]||[]:[];
      return <article className="resource-booking" key={r.id}><div className="resource-section-title"><h4>#{r.id} · {r.project}</h4><span className={`reservation-status ${r.status}`}>{labels[r.status]}</span></div><p><b>{r.resource_label}</b> · {r.user_name}</p><p>{date(r.starts_at)} ~ {date(r.ends_at)}</p><p className="resource-prewrap">{r.purpose}</p>{r.memory_gib!==null&&<p>요청 VRAM {r.memory_gib} GiB · GPU 전체를 예약합니다.</p>}<div className="resource-controls">{canEdit&&<button className="secondary" onClick={()=>{setForm(r);setError('');}}>예약 수정</button>}{transitions.map(s=><button className="secondary" key={s} disabled={busy} onClick={()=>{setDecision({r,status:s});setError('');}}>{labels[s]} 처리</button>)}{canCancel&&<button className="secondary" onClick={()=>{setDecision({r,status:'cancelled'});setError('');}}>예약 취소</button>}<button className="secondary" onClick={()=>setEventId(eventId===r.id?null:r.id)}>처리 이력</button></div>
        {decision?.r.id===r.id&&<form className="resource-form" onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);void action(()=>post(`/resources/reservations/${r.id}/status`,{status:decision.status,version:decision.r.version,note:f.get('note')}),`${labels[decision.status]} 처리했습니다.`);}}><p>예약 #{r.id}를 ‘{labels[decision.status]}’ 상태로 변경합니다.</p><label>처리 사유<textarea name="note" maxLength={1000} required={decision.status==='rejected'}/></label><div className="resource-controls"><button className="primary" disabled={busy}>{labels[decision.status]} 확정</button><button className="secondary" type="button" onClick={()=>setDecision(null)}>닫기</button></div></form>}
        {eventId===r.id&&<Events id={r.id}/>}
      </article>;
    })}</div>{data?.reservations.length===0&&<p className="empty-state">선택한 조건의 예약이 없습니다.</p>}
    <div className="resource-controls">{data?.nextBefore&&<button className="secondary" onClick={()=>setBefore(data.nextBefore)}>이전 예약 50개</button>}{before&&<button className="secondary" onClick={()=>setBefore(null)}>최신 예약으로</button>}</div>
  </div>;
}
