export class ApiError extends Error { constructor(public status:number,message:string){super(message);} }
export type ResponseCache={etag?:string;value?:unknown};
type ApiOptions=RequestInit&{retry?:boolean;timeoutMs?:number;cacheEntry?:ResponseCache};
export async function api<T>(path:string,options:ApiOptions={}):Promise<T>{
  const {retry,timeoutMs=15000,cacheEntry,...request}=options;
  const headers=new Headers(options.headers);
  headers.set('X-Lab-Request','1');
  if(cacheEntry?.etag&&cacheEntry.value!==undefined)headers.set('If-None-Match',cacheEntry.etag);
  if(options.body && !(options.body instanceof FormData)) headers.set('Content-Type','application/json');
  const canRetry=retry??(!request.method||request.method==='GET');
  for(let attempt=0;;attempt++){
    try{
      const timeout=AbortSignal.timeout(timeoutMs);
      const signal=request.signal?AbortSignal.any([request.signal,timeout]):timeout;
      const response=await fetch(`/api${path}`,{...request,signal,headers,credentials:'same-origin'});
      if(response.status===304&&cacheEntry?.value!==undefined)return cacheEntry.value as T;
      if(!response.ok){const data=await response.json().catch(()=>({error:'서버에 연결할 수 없습니다.'}));throw new ApiError(response.status,data.error);}
      const value=response.status===204?undefined as T:await response.json();
      if(cacheEntry){cacheEntry.etag=response.headers.get('ETag')??undefined;cacheEntry.value=value;}
      return value;
    }catch(error){
      const transient=error instanceof ApiError?[502,503,504].includes(error.status):error instanceof TypeError||(error instanceof DOMException&&error.name==='TimeoutError');
      if(request.signal?.aborted||!canRetry||attempt>=1||!transient)throw error;
      await new Promise<void>((resolve,reject)=>{
        const abort=()=>{clearTimeout(timer);reject(request.signal?.reason);};
        const timer=setTimeout(()=>{request.signal?.removeEventListener('abort',abort);resolve();},350+Math.random()*450);
        if(request.signal?.aborted){abort();return;}
        request.signal?.addEventListener('abort',abort,{once:true});
      });
    }
  }
}
export const post=<T,>(path:string,body:unknown={},options:ApiOptions={})=>api<T>(path,{...options,method:'POST',body:JSON.stringify(body)});
export type User={id:string;name:string;handle:string;role:string;email?:string};
export type Channel={id:string;name:string;topic:string;kind:'public'|'private'|'dm';created_by:string;members:User[];unread:number;mentions:number;last_read_id:number;latest_message_id?:number};
export type Message={id:number;revision?:number;channel_id:string;user_id:string;parent_id:number|null;body:string;deleted:number;pinned:number;created_at:string;edited_at:string|null;user:User;files:{id:string;name:string;size:number}[];reactions:{emoji:string;count:number;mine:number}[];reply_count:number;channel_name?:string};
export type Page={messages:Message[];hasMore:boolean};
export type AuthConfig={mode:'local'|'demo';needsSetup:boolean;demoUsers:User[]};
