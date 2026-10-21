import {useEffect,useRef} from 'react';
import type {Channel} from './api';

type DesktopState={userId:string|null;activeChannelId:string|null;channels:{id:string;unread:number;mentions:number;latestMessageId:number}[]};
declare global {
  interface Window {
    damiDesktop?:{version:number;changeWorkspace?:()=>Promise<boolean>;setState:(state:DesktopState)=>Promise<{unread:number}>;isActive?:()=>Promise<boolean>;onActivity?:(callback:(active:boolean)=>void)=>()=>void;onNavigate:(callback:(id:string)=>void)=>()=>void;retry:()=>Promise<boolean>};
  }
}
export function clearDesktopSession(){void window.damiDesktop?.setState({userId:null,activeChannelId:null,channels:[]}).catch(()=>{});}
export async function canMarkRead(){
  if(window.damiDesktop)return await window.damiDesktop.isActive?.().catch(()=>false)??false;
  return document.visibilityState==='visible';
}
export function useDesktop(userId:string,channels:Channel[],activeChannelId:string|null,navigate:(id:string)=>void){
  const current=useRef({channels,navigate});current.current={channels,navigate};
  useEffect(()=>window.damiDesktop?.onNavigate(id=>{if(current.current.channels.some(c=>c.id===id))current.current.navigate(id);}),[]);
  useEffect(()=>window.damiDesktop?.onActivity?.(active=>{if(active)window.dispatchEvent(new Event('focus'));}),[]);
  useEffect(()=>{
    void window.damiDesktop?.setState({userId,activeChannelId,channels:channels.map(c=>({id:c.id,unread:c.unread,mentions:c.mentions,latestMessageId:c.latest_message_id??0}))}).catch(()=>{});
  },[userId,channels,activeChannelId]);
}
