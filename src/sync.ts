import {useEffect,useRef,useState,useCallback} from 'react';
import {api,type Channel,type User,type Message} from './api';

export type SyncBatch={cursor:string;reset:boolean;channels:Channel[];removedChannelIds:string[];users?:User[];messages:Message[];threadMessages:Message[]};
export function mergeMessages(current:Message[],incoming:Message[]){
  const values=new Map(current.map(m=>[m.id,m]));
  for(const message of incoming){
    const prior=values.get(message.id);
    if(!prior||(message.revision??0)>=(prior.revision??0))values.set(message.id,message);
  }
  return [...values.values()].sort((a,b)=>a.id-b.id);
}

// One connection and one in-flight sync per workspace. Cursors live only in
// this authenticated component, and never survive logout/account changes.
export function useSync({channelId,threadId,onBatch,onError}:{
  channelId:string|null;threadId:number|null;
  onBatch:(batch:SyncBatch,channelId:string|null)=>void;onError:(error:unknown)=>void;
}){
  const [connected,setConnected]=useState(false);
  const current=useRef({channelId,threadId,onBatch,onError});
  current.current={channelId,threadId,onBatch,onError};
  const scheduleRef=useRef<()=>void>(()=>{});
  const refresh=useCallback(()=>scheduleRef.current(),[]);
  useEffect(()=>{
    let cursor:string|undefined,parked:string|undefined,hidden=false,live=true,pending=false,busy=false,failures=0;
    let timer:ReturnType<typeof setTimeout>|undefined,reconcile:ReturnType<typeof setTimeout>|undefined;
    let controller:AbortController|undefined;
    const schedule=(delay=60)=>{
      pending=true;
      if(!live||busy||timer)return;
      timer=setTimeout(()=>{timer=undefined;void run();},delay);
    };
    const run=async()=>{
      if(!live||busy)return;
      busy=true;pending=false;
      const scope=current.current;
      const isHidden=document.visibilityState==='hidden';
      if(isHidden&&!hidden){parked=cursor;hidden=true;}
      if(!isHidden&&hidden){cursor=parked;parked=undefined;hidden=false;}
      const params=new URLSearchParams();
      if(cursor)params.set('cursor',cursor);
      if(scope.channelId&&!isHidden)params.set('channelId',scope.channelId);
      if(scope.threadId&&!isHidden)params.set('threadId',String(scope.threadId));
      controller=new AbortController();
      try{
        const batch=await api<SyncBatch>(`/sync?${params}`,{signal:controller.signal});
        if(!live)return;
        if(scope.channelId!==current.current.channelId||scope.threadId!==current.current.threadId){pending=true;return;}
        cursor=batch.cursor;failures=0;
        if(batch.reset||batch.users||batch.channels.length||batch.removedChannelIds.length||batch.messages.length||batch.threadMessages.length)
          current.current.onBatch(batch,isHidden?null:scope.channelId);
      }catch(error){
        if(!live)return;
        current.current.onError(error);failures=Math.min(failures+1,5);pending=true;
      }finally{
        busy=false;controller=undefined;
        if(pending&&live)schedule(failures?Math.min(30000,1000*2**failures)+Math.random()*1000:60);
      }
    };
    scheduleRef.current=()=>schedule();
    const events=new EventSource('/api/events');
    events.addEventListener('ready',()=>{setConnected(true);schedule();});
    events.addEventListener('refresh',event=>{
      let next:string|undefined;
      try{next=JSON.parse((event as MessageEvent).data).cursor;}catch{/* Legacy invalidation. */}
      if(!next||next!==cursor)schedule();
    });
    events.onerror=()=>setConnected(false);
    const focus=()=>{if(document.visibilityState==='visible')schedule();};
    const changed=()=>{if(document.visibilityState==='hidden'&&!hidden){parked=cursor;hidden=true;}else focus();};
    document.addEventListener('visibilitychange',changed);window.addEventListener('focus',focus);window.addEventListener('online',focus);
    const check=()=>{reconcile=setTimeout(()=>{if(document.visibilityState==='visible')schedule();check();},120000+Math.random()*30000);};
    check();schedule(0);
    return()=>{live=false;scheduleRef.current=()=>{};clearTimeout(timer);clearTimeout(reconcile);controller?.abort();events.close();document.removeEventListener('visibilitychange',changed);window.removeEventListener('focus',focus);window.removeEventListener('online',focus);};
  },[]);
  useEffect(()=>{refresh();},[channelId,threadId,refresh]);
  return {connected,refresh};
}
