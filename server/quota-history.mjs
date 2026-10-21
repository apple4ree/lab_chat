const invalid=()=>{throw new Error('Invalid quota history response');};
const seconds=v=>typeof v==='number'&&Number.isFinite(v)&&v>0&&v<8640000000000?v:null;
const percent=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=100?v:null;
const issues={timeout:'수집 시간 초과',provider_timeout:'수집 시간 초과',login_required:'로그인 필요',login_refresh_required:'로그인 갱신 필요',query_rate_limited:'조회 제한',window_unavailable:'주간 한도 미보고',identity_mismatch:'계정 불일치',account_changed:'계정 변경',scope_or_access_denied:'접근 권한 확인 필요'};

export function quotaHistoryQuery(query){
  const account=query?.account,days=query?.days??1;
  if(typeof account!=='string'||!account.length||account.length>120||typeof days!=='number'&&typeof days!=='string'||![1,3,7].includes(Number(days)))throw Object.assign(new Error('계정과 조회 기간(1·3·7일)을 확인해 주세요.'),{status:400});
  return {account,days:Number(days)};
}

// Normalize once at the source boundary. No raw errors, identities or credentials
// are forwarded. A discontinuity is not interpreted as consumed quota.
export function normalizeQuotaHistory(raw,{account,since,now=Date.now()}){
  if(!raw||raw.account!==account||raw.period!==10080||raw.since!==since||!seconds(raw.until)||raw.until<since||raw.until>now/1000+60||raw.intervalMinutes!==15||!Array.isArray(raw.points)||raw.points.length>11000)invalid();
  const points=raw.points.map(p=>{
    if(!p||!seconds(p.at)||p.at<since||p.at>raw.until)invalid();
    const remaining=p.error?null:percent(p.remaining),resetsAt=seconds(p.resetsAt);
    return {at:p.at*1000,remaining,used:remaining===null?null:100-remaining,resetsAt:resetsAt===null?null:resetsAt*1000,
      issue:p.error?(Object.hasOwn(issues,p.error)?issues[p.error]:'수집 실패'):remaining===null?'측정값 없음':null,
      window:typeof p.window==='string'?p.window:null,resetEvent:!!p.resetEvent};
  }).sort((a,b)=>a.at-b.at);
  let previous=null;
  const data=points.map(p=>{
    if(previous&&previous.at===p.at)invalid();
    let breakReason=null;
    if(previous){
      if(p.remaining===null||previous.remaining===null)breakReason='error';
      else if(p.at-previous.at>30*60000)breakReason='gap';
      else if(p.resetEvent||p.window!==previous.window||p.remaining>previous.remaining||
        (p.resetsAt!==null&&previous.resetsAt!==null&&Math.abs(p.resetsAt-previous.resetsAt)>60000)||
        (previous.resetsAt!==null&&previous.at<previous.resetsAt&&p.at>=previous.resetsAt))breakReason='reset_or_change';
    }
    previous=p;
    return {at:p.at,remaining:p.remaining,used:p.used,resetsAt:p.resetsAt,issue:p.issue,breakReason};
  });
  return {account,from:since*1000,to:raw.until*1000,startedAt:seconds(raw.startedAt)?raw.startedAt*1000:null,intervalMs:900000,limited:raw.points.length===11000,points:data};
}
