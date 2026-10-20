import {gpuClient} from './gpu-http.mjs';

export const resourceFailure=(status,message)=>Object.assign(new Error(message),{status});
const number=(v,max=1e16)=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=max?v:null;
const text=(v,max=180)=>typeof v==='string'?v.slice(0,max):'';
const rows=(v,max=2000)=>{if(!Array.isArray(v)||v.length>max)throw new Error('Invalid resource rows');return v;};
const record=v=>{if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('Invalid resource record');return v;};
export function normalizeResourceData(kind,input,now=Date.now()) {
  if(kind==='targets')return rows(input,1024).map(r=>{
    record(r);if(!text(r.host)||r.host.length>100||!Number.isSafeInteger(r.gpu)||r.gpu<0)throw new Error('Invalid history target');
    return {host:r.host,index:r.gpu};
  });
  if(kind==='history')return rows(input,602).map(r=>{
    record(r);if(!number(r.ts))throw new Error('Invalid history time');
    const total=number(r.mem_total,1e8),used=number(r.mem_used,total??0);
    return {at:r.ts*1000,utilization:number(r.util,100),memoryGiB:used===null?null:used/1024,totalGiB:total===null?null:total/1024};
  }).sort((a,b)=>a.at-b.at);
  if(kind==='share')return rows(input).map(r=>{record(r);return {user:text(r.userId)||'미확인',hours:number(r.hours),percent:number(r.pct,100)};});
  if(kind==='quotas')return rows(record(input).accounts,200).map(r=>{
    record(r);const at=number(r.ts),stale=!at||at*1000>now+60000||now-at*1000>900000;
    const window=v=>({percent:stale?null:number(v?.percent,100),resetsAt:number(v?.resets_at)?v.resets_at*1000:null});
    return {provider:text(r.provider,30),account:text(r.email,254),plan:text(r.plan,80),reportedAt:at?at*1000:null,stale,
      fiveHour:window(r.five_hour),sevenDay:window(r.seven_day),servers:rows(r.servers||[],100).map(s=>({host:typeof s==='string'?text(s,100):text(s?.host,100),lastSeen:number(s?.last_seen)?s.last_seen*1000:null}))};
  });
  if(kind==='usage'){
    record(input);const members=record(input.members||{});
    const person=v=>text(Object.hasOwn(members,v)?members[v]:null)||(/^(openai|anthropic|google):/.test(v)?'미매핑 계정':text(v))||'미매핑 계정';
    const cost=r=>{record(r);return {costKRW:number(r.cost_krw),costUSD:number(r.cost_usd),tokens:number(r.tokens??(typeof r.in_tok==='number'&&typeof r.out_tok==='number'?r.in_tok+r.out_tok:null)),requests:number(r.requests)};};
    const groups=(key,label)=>rows(input[key]||[]).map(r=>({...cost(r),label:label(r)}));
    const balances={};for(const p of ['openai','anthropic','google']){
      const b=input.balances?.[p];balances[p]=b&&number(b.updated)>0?{amount:number(b.amount),currency:['USD','KRW'].includes(b.currency)?b.currency:null,updatedAt:b.updated*1000,source:'erp'}:null;
    }
    return {totals:cost(record(input.totals)),byProvider:groups('byProvider',r=>text(r.provider)),byModel:groups('byModel',r=>text(r.model)),
      byPerson:groups('byPerson',r=>person(r.person)),byDay:groups('byPersonDay',r=>`${text(r.day,10)} · ${person(r.person)}`),
      byDetail:groups('byPersonDetail',r=>`${person(r.person)} · ${text(r.provider,30)} · ${text(r.model,100)}`),balances,
      hasData:rows(input.byProvider||[]).length>0,from:number(input.fromTs)?input.fromTs*1000:null,to:number(input.toTs)?input.toTs*1000:null};
  }
  throw new Error('Unknown resource view');
}

// Shared bounded cache: includes every query input, never serves an expired result after failure.
export function createResourceSource({baseUrl,reader=baseUrl?gpuClient(baseUrl):null,demo=false,now=Date.now}={}){
  const cache=new Map(),pending=new Map(),controllers=new Set();let stopped=false;
  async function get(kind,params={}){
    if(stopped)throw resourceFailure(503,'자원 조회가 종료되었습니다.');
    if(!reader&&!demo)throw resourceFailure(503,'자원 이력 서비스가 연결되지 않았습니다.');
    const key=JSON.stringify([kind,params]),cached=cache.get(key);
    if(cached&&now()-cached.fetchedAt<30000)return cached;
    if(pending.has(key))return pending.get(key);
    if(pending.size>=8)throw resourceFailure(503,'조회가 많습니다. 잠시 후 다시 시도해 주세요.');
    const promise=(async()=>{
      const controller=new AbortController();controllers.add(controller);const timer=setTimeout(()=>controller.abort(),5000);timer.unref?.();
      try{
        const paths={targets:'/api/targets',history:'/api/history',share:'/api/erp/gpu_share',quotas:'/api/cli-quota',usage:'/api/usage/dashboard'};
        if(!paths[kind])throw new Error('Unknown view');
        const raw=demo?demoData(kind,params,now()):await reader(paths[kind],params,controller.signal);
        if(stopped)throw new Error('Stopped');
        const data={data:normalizeResourceData(kind,raw,now()),fetchedAt:now(),demo};
        if(cache.size>=128)cache.delete(cache.keys().next().value);
        cache.set(key,data);return data;
      }catch{throw resourceFailure(503,'자원 데이터를 불러오지 못했습니다. 현재 값은 확인할 수 없습니다.');}
      finally{clearTimeout(timer);controllers.delete(controller);}
    })();
    pending.set(key,promise);try{return await promise;}finally{pending.delete(key);}
  }
  return {get,stop(){stopped=true;for(const c of controllers)c.abort();cache.clear();}};
}

function demoData(kind,p,now){
  if(kind==='targets')return [0,1,2].map(gpu=>({host:'샘플-H200',gpu}));
  if(kind==='history')return Array.from({length:Math.min(301,Math.floor((Number(p.to)-Number(p.from))/Number(p.bucket))+1)},(_,i)=>({ts:Number(p.from)+Number(p.bucket)*i,util:Math.round(45+35*Math.sin(i/5+Number(p.gpu))),mem_used:45000+(i%60)*300,mem_total:143360}));
  if(kind==='share')return [{userId:'sample-researcher',hours:18,pct:75},{userId:'sample-user',hours:6,pct:25}];
  if(kind==='quotas')return {accounts:[{provider:'codex',email:'sample@example.test',plan:'샘플',ts:now/1000,five_hour:{percent:32,resets_at:now/1000+7200},seven_day:{percent:54,resets_at:now/1000+172800},servers:[{host:'샘플-H200',last_seen:now/1000}]},{provider:'claude',email:'old-sample@example.test',plan:'샘플',ts:now/1000-3600,five_hour:{percent:10},seven_day:{percent:20}}]};
  const all=[{provider:'openai',model:'sample-model-a',cost_krw:12000,cost_usd:8,in_tok:15000,out_tok:5000,requests:120},{provider:'anthropic',model:'sample-model-b',cost_krw:6000,cost_usd:4,in_tok:10000,out_tok:2000,requests:60}];
  const selected=all.filter(r=>!p.provider||p.provider==='all'||r.provider===p.provider);
  const total=selected.reduce((a,r)=>({cost_krw:a.cost_krw+r.cost_krw,cost_usd:a.cost_usd+r.cost_usd,tokens:a.tokens+r.in_tok+r.out_tok,requests:a.requests+r.requests}),{cost_krw:0,cost_usd:0,tokens:0,requests:0});
  return {totals:total,byProvider:selected,byModel:selected,byPerson:selected.map(r=>({...r,person:'샘플 연구자'})),byPersonDay:selected.map(r=>({...r,person:'샘플 연구자',day:new Date(now).toISOString().slice(0,10)})),byPersonDetail:selected.map(r=>({...r,person:'샘플 연구자'})),balances:{},members:{},fromTs:now/1000-Number(p.days||30)*86400,toTs:now/1000};
}
