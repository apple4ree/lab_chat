export class ApiError extends Error { constructor(public status:number,message:string){super(message);} }
export async function api<T>(path:string,options:RequestInit={}):Promise<T>{
  const headers=new Headers(options.headers);
  headers.set('X-Lab-Request','1');
  if(options.body && !(options.body instanceof FormData)) headers.set('Content-Type','application/json');
  const response=await fetch(`/api${path}`,{...options,headers,credentials:'same-origin'});
  if(!response.ok){const data=await response.json().catch(()=>({error:'서버에 연결할 수 없습니다.'}));throw new ApiError(response.status,data.error);}
  return response.status===204?undefined as T:response.json();
}
export const post=<T,>(path:string,body:unknown={})=>api<T>(path,{method:'POST',body:JSON.stringify(body)});
export type User={id:string;name:string;handle:string;role:string;email?:string};
export type Channel={id:string;name:string;topic:string;kind:'public'|'private'|'dm';created_by:string;members:User[];unread:number;mentions:number;last_read_id:number;latest_message_id?:number};
export type Message={id:number;channel_id:string;user_id:string;parent_id:number|null;body:string;deleted:number;pinned:number;created_at:string;edited_at:string|null;user:User;files:{id:string;name:string;size:number}[];reactions:{emoji:string;count:number;mine:number}[];reply_count:number;channel_name?:string};
export type Page={messages:Message[];hasMore:boolean};
export type AuthConfig={mode:'local'|'demo';needsSetup:boolean;demoUsers:User[]};
