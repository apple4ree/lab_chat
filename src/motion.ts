import {useEffect,useLayoutEffect,useRef,type RefObject} from 'react';

// Track the loaded window, not component mounts: history, edits and refreshes
// must not replay arrival motion. IDs are monotonically increasing on the server.
export function useMessageArrival(
  list:RefObject<HTMLDivElement|null>,messages:readonly {id:number}[],scope:string,ready:boolean,
){
  const previous=useRef<{scope:string;lastId:number}|null>(null);
  const running=useRef(new Set<Animation>());
  useEffect(()=>{
    const preference=matchMedia('(prefers-reduced-motion: reduce)');
    const stop=()=>{for(const animation of running.current)animation.cancel();running.current.clear();};
    const changed=()=>{if(preference.matches)stop();};
    preference.addEventListener('change',changed);
    return()=>{preference.removeEventListener('change',changed);stop();};
  },[]);
  useLayoutEffect(()=>{
    if(!ready){previous.current=null;return;}
    const lastId=messages.at(-1)?.id??0,prior=previous.current;
    previous.current={scope,lastId:Math.max(prior?.scope===scope?prior.lastId:0,lastId)};
    if(!prior||prior.scope!==scope||matchMedia('(prefers-reduced-motion: reduce)').matches)return;
    // Bound work when reconnecting after a burst; never animate the full history.
    for(const message of messages.filter(m=>m.id>prior.lastId).slice(-6)){
      const element=list.current?.querySelector<HTMLElement>(`[data-message-id="${message.id}"]`);
      if(!element||!element.animate)continue;
      const animation=element.animate(
        [{opacity:.35,transform:'translateY(7px)'},{opacity:1,transform:'translateY(0)'}],
        {duration:220,easing:'cubic-bezier(.2,.8,.2,1)',id:'message-arrival'},
      );
      running.current.add(animation);
      const forget=()=>running.current.delete(animation);
      animation.onfinish=forget;animation.oncancel=forget;
    }
  },[list,messages,scope,ready]);
}
