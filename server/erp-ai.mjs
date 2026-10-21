import {readFile,writeFile,rename} from 'node:fs/promises';
import {resourceFailure} from './resource-source.mjs';
import {normalizeQuotaHistory,quotaHistoryQuery} from './quota-history.mjs';

const numeric=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:null;
const text=v=>typeof v==='string'?v.slice(0,120):'';
const list=(value,max)=>{if(!Array.isArray(value)||value.length>max)throw new Error('Invalid ERP list');return value;};

export function normalizeErpQuotas(input,now=Date.now()){
  const collectors=new Map(list(input.collectors,100).map(c=>[c.id,c]));
  return list(input.accounts,200).map(account=>{
    const at=numeric(account.successAt),stale=!at||now-at*1000>900000||at*1000>now+60000;
    const verified=account.verified===true,error=Boolean(account.error),available=!stale&&verified&&!error;
    const windows=list(account.windows,20);
    const window=(name,minutes)=>{
      const candidates=windows.filter(w=>w.windowMinutes===minutes||w.name===name);
      const w=candidates.length===1?candidates[0]:null,percent=numeric(w?.usedPercent);
      return {percent:available&&percent!==null&&percent<=100?percent:null,resetsAt:available&&numeric(w?.resetsAt)?w.resetsAt*1000:null};
    };
    const collector=collectors.get(account.collector);
    return {id:text(account.id),provider:text(account.provider),account:text(account.label),plan:text(account.plan),reportedAt:at?at*1000:null,stale,verified,
      issue:!verified?'계정 연결 확인이 필요합니다.':error?'최근 수집에 실패했습니다. ERP에서 수집기·로그인 상태를 확인해 주세요.':stale?'보고 지연 · 현재 한도 확인 불가':null,
      fiveHour:window('five_hour',300),sevenDay:window('seven_day',10080),fiveHourUnlimited:available&&account.fiveHourUnlimited===true,
      collecting:['queued','running'].includes(account.job),
      servers:[{host:text(account.collector),lastSeen:numeric(collector?.lastSeen)?collector.lastSeen*1000:null}]};
  });
}

// ERP credentials remain server-side; only fixed quota/history endpoints are callable.
// The saved session is renewed by ERP responses. No account password is stored here.
export function createErpAiSource({sessionFile,usageSource,fetchImpl=fetch,now=Date.now}){
  let cached=null,pending=null,refreshing=null,lastRefresh=-Infinity,lastRefreshResult=null,generation=0,stopped=false,persist=Promise.resolve();
  const controllers=new Set();
  const historyCache=new Map(),historyPending=new Map();
  async function request(operation='state',params={}){
    if(stopped)throw resourceFailure(503,'AI 조회가 종료되었습니다.');
    const controller=new AbortController();controllers.add(controller);
    const timer=setTimeout(()=>controller.abort(),10000);timer.unref?.();
    try{
      const config=JSON.parse(await readFile(sessionFile,'utf8'));
      const origin=new URL(config.origin);
      if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash||typeof config.cookie!=='string'||!/^session=[^;\s]+$/.test(config.cookie))throw new Error('Invalid ERP configuration');
      const paths={state:'/api/ai/state',refresh:'/api/ai/refresh',history:'/api/ai/usage-history'};
      if(!Object.hasOwn(paths,operation))throw new Error('Unknown ERP operation');
      const url=new URL(paths[operation],origin);if(operation==='history')url.search=new URLSearchParams(params);
      const refresh=operation==='refresh';
      const response=await fetchImpl(url,{
        method:refresh?'POST':'GET',redirect:'error',signal:controller.signal,
        headers:{Cookie:config.cookie,'User-Agent':'DAMI-Chat/1.0',Accept:'application/json',...(refresh?{'Content-Type':'application/json','X-DAMI-AI':'1'}:{})},...(refresh?{body:'{}'}:{})});
      if([401,403].includes(response.status))throw resourceFailure(503,'ERP AI 연결 인증이 만료되었거나 접근이 거부되었습니다. 관리자에게 연결 갱신을 요청해 주세요.');
      if(!response.ok)throw new Error('ERP unavailable');
      let length=0;const chunks=[];
      if(!response.body)throw new Error('Empty ERP response');
      for await(const chunk of response.body){length+=chunk.byteLength;if(length>2*1024*1024){controller.abort();throw new Error('ERP response too large');}chunks.push(chunk);}
      const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const cookie=response.headers.getSetCookie().find(c=>c.startsWith('session='))?.split(';')[0];
      if(cookie&&/^session=[^;\s]+$/.test(cookie)){
        // Serialize atomic session rotation, including overlapping refresh/read requests.
        persist=persist.catch(()=>{}).then(async()=>{if(stopped)return;await writeFile(sessionFile+'.next',JSON.stringify({origin:origin.origin,cookie}),{mode:0o600});await rename(sessionFile+'.next',sessionFile);});
        await persist;
      }
      if(stopped)throw new Error('Stopped');
      return result;
    }catch(error){if(error.status===503)throw error;throw resourceFailure(503,'현재 ERP AI 데이터를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');}
    finally{clearTimeout(timer);controllers.delete(controller);}
  }
  async function get(kind,params){
    if(kind==='quotaHistory')return history(params);
    if(kind!=='quotas')return usageSource.get(kind,params);
    if(stopped)throw resourceFailure(503,'AI 조회가 종료되었습니다.');
    if(cached&&now()-cached.fetchedAt<5000)return cached;
    if(pending)return pending;
    const version=generation;
    pending=(async()=>{const raw=await request();const result={data:normalizeErpQuotas(raw,now()),fetchedAt:now(),demo:false,source:'erp'};if(version===generation)cached=result;return result;})().catch(error=>{if(error.status)throw error;throw resourceFailure(503,'ERP AI 응답 형식을 확인할 수 없습니다.');});
    try{return await pending;}finally{pending=null;}
  }
  async function history(query){
    const {account,days}=quotaHistoryQuery(query);
    // Validate against current account inventory even when a history result is cached.
    const accounts=await get('quotas');
    if(!accounts.data.some(a=>a.id===account&&['codex','claude'].includes(a.provider)))throw resourceFailure(404,'이력을 조회할 수 없는 계정입니다.');
    const key=JSON.stringify([account,days]),hit=historyCache.get(key);
    if(hit&&now()-hit.fetchedAt<30000)return hit;
    if(historyPending.has(key))return historyPending.get(key);
    if(historyPending.size>=4)throw resourceFailure(503,'추이 조회가 많습니다. 잠시 후 다시 시도해 주세요.');
    const version=generation,since=Math.floor(now()/30000)*30-days*86400;
    const work=(async()=>{
      const raw=await request('history',{account,period:'10080',since:String(since)});
      const result={data:normalizeQuotaHistory(raw,{account,since,now:now()}),source:'erp',demo:false,fetchedAt:now()};
      if(!stopped&&version===generation){if(historyCache.size>=8)historyCache.delete(historyCache.keys().next().value);historyCache.set(key,result);}
      return result;
    })().catch(error=>{if(error.status)throw error;throw resourceFailure(503,'ERP 사용량 추이 응답을 확인할 수 없습니다.');});
    historyPending.set(key,work);try{return await work;}finally{historyPending.delete(key);}
  }
  async function refreshQuotas(){
    if(stopped)throw resourceFailure(503,'AI 조회가 종료되었습니다.');
    if(refreshing)return refreshing;
    if(now()-lastRefresh<30000)return {...lastRefreshResult,retryAfterMs:30000-(now()-lastRefresh)};
    refreshing=(async()=>{const response=await request('refresh');if(response.ok!==true)throw resourceFailure(503,'AI 수집 요청을 처리하지 못했습니다.');const jobs=list(response.jobs,200);lastRefresh=now();generation++;cached=null;historyCache.clear();await pending?.catch(()=>{});cached=null;lastRefreshResult={queued:jobs.some(job=>typeof job==='string'&&job.length>0),retryAfterMs:30000};return lastRefreshResult;})().catch(error=>{if(error.status)throw error;throw resourceFailure(503,'AI 수집 요청을 처리하지 못했습니다.');});
    try{return await refreshing;}finally{refreshing=null;}
  }
  return {get,refreshQuotas,stop(){stopped=true;generation++;cached=null;historyCache.clear();for(const controller of controllers)controller.abort();usageSource.stop();}};
}
