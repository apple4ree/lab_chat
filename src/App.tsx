import {useCallback,useEffect,useRef,useState} from 'react';
import {FlaskConical,Search,Plus,Hash,Lock,ChevronDown,MessageSquare,Home,Bell,Settings,LogOut,Users,Pin,X,Menu,ArrowRight,Check,Copy,ArrowLeft,WifiOff,LoaderCircle,ShieldCheck,FileText,Cpu} from 'lucide-react';
import {api,post,ApiError,type User,type AuthConfig,type Channel,type Message,type Page} from './api';
import {Auth} from './Auth';
import {GpuResources} from './GpuResources';
import {Avatar,Dialog,Composer,MessageRow,Body} from './components';
import {canMarkRead,clearDesktopSession,useDesktop} from './desktop';
import {DesktopDownloads} from './DesktopDownloads';
import {DesktopUpdateNotice} from './DesktopUpdateNotice';
import {DomainSettings,DomainNotice} from './DomainSettings';
import {useMessageArrival} from './motion';
import {useSync,mergeMessages,type SyncBatch} from './sync';

const channelName=(channel:Channel,me:User)=>channel.kind==='dm'?channel.members.filter(u=>u.id!==me.id).map(u=>u.name).join(', '):channel.name;
const channelIcon=(c:Channel,size=18)=>c.kind==='private'?<Lock size={size}/>:c.kind==='dm'?<MessageSquare size={size}/>:<Hash size={size}/>;
const dateLabel=(date:string)=>new Date(date).toLocaleDateString('ko-KR',{month:'long',day:'numeric',weekday:'long'});

export default function App(){
  const [config,setConfig]=useState<AuthConfig|null>(null),[me,setMe]=useState<User|null>(null),[ready,setReady]=useState(false),[error,setError]=useState('');
  const boot=useCallback(async()=>{setError('');try{setConfig(await api<AuthConfig>('/auth/config'));try{setMe(await api<User>('/me'));}catch(e){if(!(e instanceof ApiError)||e.status!==401)throw e;setMe(null);}setReady(true);}catch(e){setError((e as Error).message);}},[]);
  useEffect(()=>{void boot();},[boot]);
  useEffect(()=>{if(!me)clearDesktopSession();},[me]);
  if(error)return <div className="loading-page"><WifiOff/><h2>연결을 확인해 주세요</h2><p>{error}</p><button className="primary" onClick={()=>void boot()}>다시 연결</button></div>;
  if(!ready||!config)return <div className="loading-page"><FlaskConical size={36}/><p>연구실 공간을 열고 있어요…</p></div>;
  return <><DomainNotice/>{me?<Workspace me={me} config={config} onLogout={()=>{setMe(null);void boot();}}/>:<Auth config={config} onLogin={setMe}/>}</>;
}

function Workspace({me,config,onLogout}:{me:User;config:AuthConfig;onLogout:()=>void}){
  const [channels,setChannels]=useState<Channel[]>([]),[users,setUsers]=useState<User[]>([]),[selected,setSelected]=useState(''),[messages,setMessages]=useState<Message[]>([]),[hasMore,setHasMore]=useState(false),[loading,setLoading]=useState(true),[loadingOlder,setLoadingOlder]=useState(false);
  const [gpuOpen,setGpuOpen]=useState(false);
  const [tick,setTick]=useState(0),[error,setError]=useState(''),[dialog,setDialog]=useState<string|null>(null),[thread,setThread]=useState<Message|null>(null),[mobileNav,setMobileNav]=useState(false);
  const list=useRef<HTMLDivElement>(null),selectedRef=useRef(selected),scrollToEnd=useRef(true),historyPages=useRef(1),readAck=useRef(new Map<string,number>()),channelsRef=useRef(channels);
  selectedRef.current=selected;channelsRef.current=channels;
  useMessageArrival(list,messages,selected,!loading&&!gpuOpen);
  const channel=channels.find(c=>c.id===selected);
  const [threadDelta,setThreadDelta]=useState<Message[]>([]),[snapshotFailed,setSnapshotFailed]=useState(false);
  useFailedSnapshotRecovery(snapshotFailed,()=>setTick(t=>t+1));
  useDesktop(me.id,channels,gpuOpen?null:selected||null,choose);
  useEffect(()=>{if(location.hash==='#desktop-downloads')setDialog('desktop');},[]);
  const handleError=useCallback((e:unknown)=>{if(e instanceof ApiError&&e.status===401){onLogout();return;}setError(e instanceof Error?e.message:'요청을 처리하지 못했습니다.');},[onLogout]);
  const markRead=useCallback(async(id:string,until:number)=>{
    if(!until||!await canMarkRead())return;
    const known=Math.max(readAck.current.get(id)??0,channelsRef.current.find(c=>c.id===id)?.last_read_id??0);
    if(until<=known)return;
    readAck.current.set(id,until);
    try{await post(`/channels/${id}/read`,{until});setChannels(cs=>cs.map(c=>c.id===id?{...c,last_read_id:Math.max(c.last_read_id,until),...((c.latest_message_id??0)<=until?{unread:0,mentions:0}:{})}:c));}
    catch(error){if(readAck.current.get(id)===until)readAck.current.delete(id);handleError(error);}
  },[handleError]);
  function applyBatch(batch:SyncBatch,requested:string|null){
    if(batch.removedChannelIds.includes(selected)){setSelected('');setMessages([]);setThread(null);}
    setChannels(existing=>{
      const values=new Map((batch.reset||batch.users?[]:existing).map(c=>[c.id,c]));
      for(const c of batch.channels){const read=readAck.current.get(c.id)??0;values.set(c.id,{...c,last_read_id:Math.max(c.last_read_id,read),...((c.latest_message_id??0)<=read?{unread:0,mentions:0}:{})});}
      for(const id of batch.removedChannelIds)values.delete(id);
      return [...values.values()];
    });
    if(batch.users)setUsers(batch.users);
    if(batch.reset){readAck.current.clear();setMessages([]);setThreadDelta([]);setTick(t=>t+1);}
    else if(requested===selected){
      const nearBottom=!list.current||list.current.scrollHeight-list.current.scrollTop-list.current.clientHeight<160;
      if(batch.messages.length){setMessages(ms=>mergeMessages(ms,batch.messages));if(nearBottom||scrollToEnd.current)requestAnimationFrame(()=>{if(list.current)list.current.scrollTop=list.current.scrollHeight;});scrollToEnd.current=false;}
      if(batch.threadMessages.length)setThreadDelta(previous=>mergeMessages(previous.filter(m=>m.id===thread?.id||m.parent_id===thread?.id),batch.threadMessages));
    }
  }
  const {connected,refresh}=useSync({channelId:gpuOpen?null:selected||null,threadId:thread?.id??null,onBatch:applyBatch,onError:handleError});
  useEffect(()=>{if(channels.length)setSelected(id=>channels.some(c=>c.id===id)?id:channels[0].id);},[channels]);
  useEffect(()=>{
    const read=()=>{if(!gpuOpen&&selected)void markRead(selected,messages.at(-1)?.id??0);};
    read();window.addEventListener('focus',read);document.addEventListener('visibilitychange',read);
    return()=>{window.removeEventListener('focus',read);document.removeEventListener('visibilitychange',read);};
  },[selected,messages,gpuOpen,markRead]);
  useEffect(()=>{const handler=(e:KeyboardEvent)=>{if((e.ctrlKey||e.metaKey)&&e.key==='k'){e.preventDefault();setDialog('search');}};window.addEventListener('keydown',handler);return()=>window.removeEventListener('keydown',handler);},[]);
  useEffect(()=>{if(!error)return;const timer=setTimeout(()=>setError(''),9000);return()=>clearTimeout(timer);},[error]);
  useEffect(()=>{setMessages([]);setLoading(true);scrollToEnd.current=true;historyPages.current=1;},[selected]);
  useEffect(()=>{
    if(!selected||gpuOpen)return;
    let live=true;setSnapshotFailed(false);
    const controller=new AbortController();
    const loadWindow=async()=>{
      const data=await api<Page>(`/channels/${selected}/messages`,{signal:controller.signal});
      for(let n=1;n<historyPages.current&&data.hasMore;n++){
        const older=await api<Page>(`/channels/${selected}/messages?before=${data.messages[0].id}`,{signal:controller.signal});
        data.messages=[...older.messages,...data.messages];data.hasMore=older.hasMore;
      }
      return data;
    };
    loadWindow().then(async data=>{
      if(!live)return;
      const nearBottom=!list.current||list.current.scrollHeight-list.current.scrollTop-list.current.clientHeight<160;
      setMessages(ms=>mergeMessages(ms,data.messages));setHasMore(data.hasMore);setLoading(false);
      if(scrollToEnd.current||nearBottom){requestAnimationFrame(()=>{if(list.current)list.current.scrollTop=list.current.scrollHeight;});scrollToEnd.current=false;}

    }).catch(e=>{if(live&&e.name!=='AbortError'){setLoading(false);setSnapshotFailed(true);handleError(e);}});
    return()=>{live=false;controller.abort();};
  },[selected,tick,handleError,gpuOpen]);
  function choose(id:string){setGpuOpen(false);if(id!==selected)setThread(null);setSelected(id);setMobileNav(false);setDialog(null);}
  async function older(){
    if(!messages[0]||loadingOlder)return;setLoadingOlder(true);
    const requested=selected,oldHeight=list.current?.scrollHeight||0,oldTop=list.current?.scrollTop||0;
    try{const page=await api<Page>(`/channels/${selected}/messages?before=${messages[0].id}`);if(selectedRef.current!==requested)return;historyPages.current+=1;setMessages(v=>mergeMessages(v,page.messages));setHasMore(page.hasMore);requestAnimationFrame(()=>{if(list.current)list.current.scrollTop=oldTop+list.current.scrollHeight-oldHeight;});}catch(e){handleError(e);}finally{setLoadingOlder(false);}
  }
  async function jump(message:Message){
    choose(message.channel_id);
    try{const root=message.parent_id?await api<Message>(`/messages/${message.parent_id}`):message;setThread(root);}catch(e){handleError(e);}
  }
  async function startDm(user:User){try{const {id}=await post<{id:string}>('/dms',{userId:user.id});refresh();choose(id);}catch(e){handleError(e);}}
  const notifications=channels.reduce((n,c)=>n+c.mentions,0);
  return <div className="workspace">
    <DesktopUpdateNotice onDownload={()=>setDialog('desktop')}/>
    <header className="topbar"><button className="brand brand-button" onClick={()=>channels[0]&&choose(channels[0].id)}><span className="brand-mark"><FlaskConical size={21}/></span>lab<span className="brand-light">chat</span></button><button className="global-search" onClick={()=>setDialog('search')}><Search size={17}/><span>대화, 파일, 연구 기록 검색</span><kbd>⌘ / Ctrl K</kbd></button><div className="topbar-right"><span className="workspace-tag">{config.mode==='demo'?'DEMO WORKSPACE':'RESEARCH WORKSPACE'}</span><button className="profile-top" aria-label="내 계정" onClick={()=>setDialog('profile')}><Avatar user={me} small/></button></div></header>
    <div className="workspace-body"><nav className="rail" aria-label="주 메뉴"><button className="rail-item active" aria-label="홈" onClick={()=>{setGpuOpen(false);setDialog(null);setMobileNav(true);}}><Home size={22}/><span>홈</span></button><button className="rail-item" aria-label="내 멘션" onClick={()=>setDialog('mentions')}><Bell size={22}/><span>멘션</span>{notifications>0&&<i>{notifications}</i>}</button><button className="rail-item" aria-label="검색" onClick={()=>setDialog('search')}><Search size={22}/><span>검색</span></button><button className={`rail-item ${gpuOpen?'active':''}`} aria-label="연구 자원" onClick={()=>{setGpuOpen(true);setThread(null);setMobileNav(false);}}><Cpu size={22}/><span>자원</span></button><div className="rail-spacer"/><button className="rail-item" aria-label="설정" onClick={()=>setDialog(me.role==='admin'?'admin':'profile')}><Settings size={22}/><span>설정</span></button></nav>
    {mobileNav&&<button className="sidebar-scrim" aria-label="채널 목록 닫기" onClick={()=>setMobileNav(false)}/>}
    <aside className={`sidebar ${mobileNav?'show':''}`}><div className="workspace-heading"><div><h1>우리 연구실 <ChevronDown size={15}/></h1><p><span className={`status-dot ${connected?'':'offline'}`}/>{connected?'대화가 이어지는 중':'다시 연결하는 중…'}</p></div><button className="icon-button light" aria-label="새 채널" onClick={()=>setDialog('channel')}><Plus size={19}/></button></div>
      <div className="sidebar-scroll"><button className={`sidebar-shortcut ${gpuOpen?'selected':''}`} onClick={()=>{setGpuOpen(true);setThread(null);setMobileNav(false);}}><Cpu size={17}/>연구 자원</button><button className="sidebar-shortcut" onClick={()=>setDialog('mentions')}><Bell size={17}/>내 멘션 {notifications>0&&<span className="count-badge">{notifications}</span>}</button><div className="sidebar-label"><span><ChevronDown size={13}/> 채널</span><button className="icon-button light" aria-label="채널 만들기" onClick={()=>setDialog('channel')}><Plus size={15}/></button></div>
      {channels.filter(c=>c.kind!=='dm').map(c=><button key={c.id} className={`channel-link ${c.id===selected&&!gpuOpen?'selected':''} ${c.unread?'unread':''}`} onClick={()=>choose(c.id)}>{channelIcon(c,17)}<span>{c.name}</span>{c.unread>0&&<b>{c.unread>99?'99+':c.unread}</b>}</button>)}
      <button className="add-channel" onClick={()=>setDialog('channel')}><Plus size={16}/>채널 추가</button><div className="sidebar-label dm-label"><span><ChevronDown size={13}/> 다이렉트 메시지</span><button className="icon-button light" aria-label="DM 시작" onClick={()=>setDialog('dm')}><Plus size={15}/></button></div>
      {channels.filter(c=>c.kind==='dm').map(c=>{const other=c.members.find(u=>u.id!==me.id)||me;return <button key={c.id} className={`channel-link dm-link ${c.id===selected&&!gpuOpen?'selected':''}`} onClick={()=>choose(c.id)}><Avatar user={other} small/><span>{channelName(c,me)}</span>{c.unread>0&&<b>{c.unread}</b>}</button>;})}
      {!channels.some(c=>c.kind==='dm')&&<p className="sidebar-hint">동료에게 첫 인사를 건네 보세요.</p>}<button className="add-channel" onClick={()=>setDialog('dm')}><Plus size={16}/>대화 시작</button></div>
      <div className="sidebar-note"><span>✳</span><div><strong>작은 발견도, 함께.</strong><p>오늘의 질문을 남겨 보세요.</p></div></div><button className="sidebar-profile" onClick={()=>setDialog('profile')}><Avatar user={me}/><span><strong>{me.name}</strong><small>{me.role==='admin'?'워크스페이스 관리자':'연구실 구성원'}</small></span><Settings size={16}/></button>
    </aside>
    <main className="conversation">
      {gpuOpen?<GpuResources me={me} onChannel={choose} onMenu={()=>setMobileNav(true)} onError={handleError}/>:channel?<><header className="channel-header"><button className="mobile-menu icon-button" aria-label="채널 목록 열기" onClick={()=>setMobileNav(true)}><Menu size={21}/></button><div className="channel-heading" key={channel.id}><h2>{channelIcon(channel,23)}{channelName(channel,me)}</h2><p>{channel.kind==='dm'?'우리 사이의 대화와 아이디어':channel.topic||'함께 이야기를 시작해 보세요'}</p></div><button className="member-stack" aria-label="채널 구성원" onClick={()=>setDialog('members')}><span>{channel.members.slice(0,3).map(u=><Avatar user={u} small key={u.id}/>)}</span><b>{channel.members.length}</b></button></header>
      <div className="channel-tabs"><button className="active"><MessageSquare size={15}/> 메시지</button><button onClick={()=>setDialog('pins')}><Pin size={15}/> 고정 메시지</button><span>{channel.kind==='private'?<><Lock size={12}/> 비공개 채널</>:channel.kind==='dm'?<><Lock size={12}/> 두 사람만의 대화</>:<><Hash size={13}/> 연구실 공개 채널</>}</span></div>
      <div className="message-list" ref={list} aria-label="채널 메시지">
        {snapshotFailed&&<button className="load-older" onClick={()=>setTick(t=>t+1)}>대화 다시 불러오기</button>}{loading?<div className="inline-loading"><LoaderCircle className="spin" size={22}/> 대화 불러오는 중</div>:<>{hasMore?<button className="load-older" disabled={loadingOlder} onClick={()=>void older()}>{loadingOlder?'불러오는 중…':'이전 메시지 불러오기'}</button>:<div className="channel-intro"><div className="intro-icon">{channelIcon(channel,30)}</div><h2>{channelName(channel,me)}<span>의 시작</span></h2><p>{channel.kind==='dm'?'생각을 나누고 함께 다음 걸음을 정해 보세요.':channel.topic||'이 채널에서 새로운 대화를 시작해 보세요.'}</p>{config.mode==='demo'&&<span className="demo-notice">지금 보이는 대화는 체험용 샘플입니다.</span>}</div>}
        {messages.map((m,i)=><div key={m.id}>{(i===0||dateLabel(messages[i-1].created_at)!==dateLabel(m.created_at))&&<div className="date-divider"><span>{dateLabel(m.created_at)}</span></div>}<MessageRow message={m} me={me} onThread={setThread} onChange={refresh} onError={handleError}/></div>)}
        {!messages.length&&<div className="empty-conversation"><span>👋</span><p>첫 메시지로 공간을 채워 보세요.</p></div>}</>}
      </div><Composer key={channel.id} channelId={channel.id} label={channel.kind==='dm'?channelName(channel,me):`#${channel.name}`} members={channel.members} onError={handleError} onSent={message=>{scrollToEnd.current=true;setMessages(ms=>mergeMessages(ms,[message]));requestAnimationFrame(()=>{if(list.current)list.current.scrollTop=list.current.scrollHeight;});refresh();}}/>
      </>:<div className="loading-page"><LoaderCircle className="spin"/><p>채널을 준비하고 있어요.</p></div>}
    </main>
    {!gpuOpen&&thread&&channel&&<ThreadPanel key={`${thread.id}:${tick}`} parent={thread} channel={channel} me={me} delta={threadDelta} onRead={markRead} onClose={()=>setThread(null)} onChange={refresh} onError={handleError}/>}
    </div>
    {error&&<div className="toast" role="alert"><span>{error}</span><button className="icon-button" aria-label="알림 닫기" onClick={()=>setError('')}><X size={16}/></button></div>}
    {dialog==='channel'&&<CreateChannel users={users} me={me} onClose={()=>setDialog(null)} onCreated={id=>{refresh();choose(id);}}/>}
    {dialog==='dm'&&<Dialog title="동료에게 메시지 보내기" onClose={()=>setDialog(null)}><div className="user-list">{users.filter(u=>u.id!==me.id).map(u=><button key={u.id} onClick={()=>void startDm(u)}><Avatar user={u}/><span><strong>{u.name}</strong><small>@{u.handle}</small></span><ArrowRight size={18}/></button>)}{users.length===1&&<p className="muted">아직 다른 구성원이 없습니다. 관리자 설정에서 동료를 초대해 주세요.</p>}</div></Dialog>}
    {dialog==='members'&&channel&&<Members channel={channel} users={users} me={me} onClose={()=>setDialog(null)} onChange={refresh} onError={handleError}/>}
    {dialog==='search'&&<SearchDialog me={me} onClose={()=>setDialog(null)} onJump={m=>void jump(m)}/>}
    {(dialog==='pins'||dialog==='mentions')&&<MessageCollection kind={dialog} channel={channel} me={me} onClose={()=>setDialog(null)} onJump={m=>void jump(m)}/>}
    {dialog==='admin'&&<Admin config={config} onClose={()=>setDialog(null)}/>}
    {dialog==='desktop'&&<DesktopDownloads onClose={()=>{setDialog(null);if(location.hash==='#desktop-downloads')history.replaceState(null,'',location.pathname);}}/>}
    {dialog==='profile'&&<Profile onDesktop={()=>setDialog('desktop')} me={me} config={config} onClose={()=>setDialog(null)} onLogout={async()=>{try{await post('/auth/logout');onLogout();}catch(e){handleError(e);}}}/>}
  </div>;
}

// Retry failed snapshots on connectivity/focus changes without periodic full reloads.
function useFailedSnapshotRecovery(failed:boolean,retry:()=>void){
  const action=useRef(retry);action.current=retry;
  useEffect(()=>{
    if(!failed)return;
    const recover=()=>{if(document.visibilityState==='visible')action.current();};
    window.addEventListener('online',recover);window.addEventListener('focus',recover);document.addEventListener('visibilitychange',recover);
    return()=>{window.removeEventListener('online',recover);window.removeEventListener('focus',recover);document.removeEventListener('visibilitychange',recover);};
  },[failed]);
}

function ThreadPanel({parent,channel,me,delta,onRead,onClose,onChange,onError}:{parent:Message;channel:Channel;me:User;delta:Message[];onRead:(id:string,until:number)=>Promise<void>;onClose:()=>void;onChange:()=>void;onError:(e:unknown)=>void}){
  const [loaded,setLoaded]=useState(false),[root,setRoot]=useState(parent),[replies,setReplies]=useState<Message[]>([]),[hasMore,setHasMore]=useState(false),[busy,setBusy]=useState(false);const list=useRef<HTMLDivElement>(null);
  const [snapshotFailed,setSnapshotFailed]=useState(false),[attempt,setAttempt]=useState(0);
  useFailedSnapshotRecovery(snapshotFailed,()=>setAttempt(n=>n+1));
  useMessageArrival(list,replies,String(parent.id),loaded);
  useEffect(()=>{let live=true;setSnapshotFailed(false);const controller=new AbortController();Promise.all([api<Message>(`/messages/${parent.id}`,{signal:controller.signal}),api<Page>(`/messages/${parent.id}/replies`,{signal:controller.signal})]).then(([r,p])=>{if(live){setRoot(old=>(old.revision??0)>(r.revision??0)?old:r);setReplies(old=>mergeMessages(old,p.messages));setHasMore(p.hasMore);setLoaded(true);requestAnimationFrame(()=>{if(list.current)list.current.scrollTop=list.current.scrollHeight;});}}).catch(e=>{if(live){setSnapshotFailed(true);onError(e);}});return()=>{live=false;controller.abort();};},[parent.id,onError,attempt]);
  useEffect(()=>{
    const r=delta.find(m=>m.id===parent.id);if(r)setRoot(old=>(old.revision??0)>(r.revision??0)?old:r);
    const changed=delta.filter(m=>m.parent_id===parent.id);
    if(changed.length){const bottom=!list.current||list.current.scrollHeight-list.current.scrollTop-list.current.clientHeight<120;setReplies(old=>mergeMessages(old,changed));if(bottom)requestAnimationFrame(()=>{if(list.current)list.current.scrollTop=list.current.scrollHeight;});}
  },[delta,parent.id]);
  useEffect(()=>{const read=()=>void onRead(parent.channel_id,replies.at(-1)?.id??0);read();window.addEventListener('focus',read);document.addEventListener('visibilitychange',read);return()=>{window.removeEventListener('focus',read);document.removeEventListener('visibilitychange',read);};},[parent.channel_id,replies,onRead]);
  async function older(){setBusy(true);try{const page=await api<Page>(`/messages/${parent.id}/replies?before=${replies[0].id}`);setReplies(r=>mergeMessages(r,page.messages));setHasMore(page.hasMore);}catch(e){onError(e);}finally{setBusy(false);}}
  return <aside className="thread-panel" aria-label="스레드"><header><div><h2>스레드</h2><span>{channelName(channel,me)}</span></div><button className="icon-button" aria-label="스레드 닫기" onClick={onClose}><X size={20}/></button></header><div className="thread-list" ref={list}>{snapshotFailed&&<button className="load-older" onClick={()=>setAttempt(n=>n+1)}>답글 다시 불러오기</button>}<MessageRow message={root} me={me} onThread={()=>{}} onChange={onChange} onError={onError} thread/><div className="reply-divider">답글 {root.reply_count}개</div>{hasMore&&<button className="load-older" disabled={busy} onClick={()=>void older()}>이전 답글 불러오기</button>}{replies.map(m=><MessageRow key={m.id} message={m} me={me} onThread={()=>{}} onChange={onChange} onError={onError} thread/>)}</div><Composer channelId={parent.channel_id} parentId={parent.id} label="스레드" members={channel.members} onError={onError} onSent={message=>{setReplies(r=>mergeMessages(r,[message]));onChange();}}/></aside>;
}

function CreateChannel({users,me,onClose,onCreated}:{users:User[];me:User;onClose:()=>void;onCreated:(id:string)=>void}){
  const [name,setName]=useState(''),[topic,setTopic]=useState(''),[kind,setKind]=useState('public'),[members,setMembers]=useState<string[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  async function submit(){setBusy(true);try{const {id}=await post<{id:string}>('/channels',{name,topic,kind,memberIds:members});onCreated(id);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  return <Dialog title="새로운 대화 공간 만들기" onClose={onClose}><form onSubmit={e=>{e.preventDefault();void submit();}}><label>채널 이름<input value={name} onChange={e=>setName(e.target.value)} required maxLength={60} placeholder="예: 프로젝트-알파"/></label><label>채널 설명<input value={topic} onChange={e=>setTopic(e.target.value)} maxLength={250} placeholder="어떤 이야기를 나누는 곳인가요?"/></label><div className="visibility-options"><label className={kind==='public'?'chosen':''}><input type="radio" name="visibility" checked={kind==='public'} onChange={()=>setKind('public')}/><Hash size={19}/><span><b>공개</b><small>연구실 구성원 모두 참여</small></span></label><label className={kind==='private'?'chosen':''}><input type="radio" name="visibility" checked={kind==='private'} onChange={()=>setKind('private')}/><Lock size={19}/><span><b>비공개</b><small>선택한 구성원만 참여</small></span></label></div>{kind==='private'&&<fieldset><legend>초대할 구성원</legend>{users.filter(u=>u.id!==me.id).map(u=><label className="checkbox-label" key={u.id}><input type="checkbox" checked={members.includes(u.id)} onChange={e=>setMembers(v=>e.target.checked?[...v,u.id]:v.filter(id=>id!==u.id))}/>{u.name}</label>)}</fieldset>}{error&&<p className="form-error" role="alert">{error}</p>}<div className="form-actions"><button type="button" className="secondary" onClick={onClose}>취소</button><button className="primary" disabled={busy}>채널 만들기</button></div></form></Dialog>;
}
function Members({channel,users,me,onClose,onChange,onError}:{channel:Channel;users:User[];me:User;onClose:()=>void;onChange:()=>void;onError:(e:unknown)=>void}){
  const [add,setAdd]=useState('');const canAdd=channel.kind==='private'&&(channel.created_by===me.id||me.role==='admin');
  return <Dialog title={`구성원 ${channel.members.length}명`} onClose={onClose}><div className="user-list">{channel.members.map(u=><div className="user-item" key={u.id}><Avatar user={u}/><span><strong>{u.name}</strong><small>@{u.handle}</small></span><span className="pill">{u.role==='admin'?'관리자':'구성원'}</span></div>)}</div>{canAdd&&<form onSubmit={async e=>{e.preventDefault();try{await post(`/channels/${channel.id}/members`,{userId:add});setAdd('');onChange();}catch(error){onError(error);}}}><label>구성원 추가<select value={add} required onChange={e=>setAdd(e.target.value)}><option value="">구성원 선택</option>{users.filter(u=>!channel.members.some(m=>m.id===u.id)).map(u=><option value={u.id} key={u.id}>{u.name}</option>)}</select></label><button className="primary" disabled={!add}>추가</button></form>}</Dialog>;
}

function ResultCard({m,onClick}:{m:Message;onClick:()=>void}){return <button className="result-card" onClick={onClick}><div className="result-location"><Hash size={13}/>{m.channel_name||'대화'}<span>{dateLabel(m.created_at)}</span></div><div className="result-person"><Avatar user={m.user} small/><strong>{m.user.name}</strong>{m.parent_id&&<span className="pill">스레드 답글</span>}</div><div className="result-body">{m.body}</div>{m.files.map(f=><span className="result-file" key={f.id}><FileText size={14}/>{f.name}</span>)}</button>;}
function SearchDialog({onClose,onJump}:{me:User;onClose:()=>void;onJump:(m:Message)=>void}){
  const [query,setQuery]=useState(''),[result,setResult]=useState<Page|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);const version=useRef(0);
  useEffect(()=>{const current=++version.current;setResult(null);setError('');setBusy(!!query.trim());if(!query.trim())return;const timer=setTimeout(()=>{api<Page>(`/search?q=${encodeURIComponent(query.trim())}`).then(p=>{if(current===version.current)setResult(p);}).catch(e=>{if(current===version.current)setError(e.message);}).finally(()=>{if(current===version.current)setBusy(false);});},300);return()=>clearTimeout(timer);},[query]);
  async function more(){if(!result?.messages.length)return;const current=version.current;setBusy(true);try{const p=await api<Page>(`/search?q=${encodeURIComponent(query.trim())}&before=${result.messages.at(-1)?.id}`);if(current===version.current)setResult(r=>({messages:[...(r?.messages||[]),...p.messages],hasMore:p.hasMore}));}catch(e){setError((e as Error).message);}finally{if(current===version.current)setBusy(false);}}
  return <Dialog title="연구실 기록 검색" onClose={onClose}><div className="search-field"><Search size={20}/><input aria-label="검색어" value={query} onChange={e=>setQuery(e.target.value)} placeholder="키워드 또는 파일 이름을 입력하세요" maxLength={200} autoFocus/></div><p className="small-text muted">접근할 수 있는 채널과 DM의 전체 기록에서 검색합니다.</p><div className="search-results">{!query.trim()?<div className="empty-state"><Search size={28}/><p>다시 찾고 싶은 대화가 있나요?</p></div>:busy&&!result?<div className="inline-loading"><LoaderCircle className="spin"/> 검색 중…</div>:result?.messages.length===0?<div className="empty-state"><p>일치하는 기록이 없습니다.</p><small>다른 키워드로 검색해 보세요.</small></div>:result?.messages.map(m=><ResultCard key={m.id} m={m} onClick={()=>onJump(m)}/>)}{result?.hasMore&&<button className="load-older" disabled={busy} onClick={()=>void more()}>검색 결과 더 보기</button>}</div>{error&&<p role="alert" className="form-error">{error}</p>}</Dialog>;
}
function MessageCollection({kind,channel,onClose,onJump}:{kind:string;channel?:Channel;me:User;onClose:()=>void;onJump:(m:Message)=>void}){
  const [messages,setMessages]=useState<Message[]|null>(null),[error,setError]=useState('');
  useEffect(()=>{api<Message[]>(kind==='pins'?`/channels/${channel?.id}/pins`:'/mentions').then(setMessages).catch(e=>setError(e.message));},[kind,channel?.id]);
  return <Dialog title={kind==='pins'?'고정 메시지':'나를 부른 대화'} onClose={onClose}><p className="small-text muted">{kind==='pins'?'최근 고정 메시지 최대 100개':'최근 멘션 최대 100개'}</p><div className="search-results">{messages===null?<p>불러오는 중…</p>:!messages.length?<div className="empty-state"><Bell size={28}/><p>{kind==='pins'?'아직 고정한 메시지가 없습니다.':'아직 멘션된 대화가 없습니다.'}</p></div>:messages.map(m=><ResultCard key={m.id} m={m} onClick={()=>onJump(m)}/>)}</div>{error&&<p className="form-error" role="alert">{error}</p>}</Dialog>;
}

type Overview={users:number;channels:number;messages:number;fileBytes:number;audit:{id:number;actor:string;action:string;created_at:string}[]};
function Admin({config,onClose}:{config:AuthConfig;onClose:()=>void}){
  const [email,setEmail]=useState(''),[link,setLink]=useState(''),[error,setError]=useState(''),[copied,setCopied]=useState(false),[overview,setOverview]=useState<Overview|null>(null),[busy,setBusy]=useState(false);
  useEffect(()=>{api<Overview>('/admin/overview').then(setOverview).catch(e=>setError(e.message));},[]);
  return <Dialog title="워크스페이스 관리" onClose={onClose}>{overview&&<div className="admin-stats"><div><b>{overview.users}</b><span>구성원</span></div><div><b>{overview.channels}</b><span>채널 / DM</span></div><div><b>{overview.messages}</b><span>메시지</span></div></div>}<h3>동료 초대하기</h3><p className="muted small-text">초대 링크는 7일 동안 유효하며 한 번만 사용할 수 있습니다.</p>{config.mode==='demo'?<p className="info-banner">체험 공간에서는 초대 가입을 사용할 수 없습니다. 일반 실행 모드에서 관리자 계정을 만들어 주세요.</p>:<form onSubmit={async e=>{e.preventDefault();setError('');setBusy(true);try{const data=await post<{url:string}>('/admin/invites',{email});setLink(data.url);setCopied(false);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}><label>초대 이메일 <span className="muted">(선택)</span><input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="지정하면 해당 이메일만 가입 가능"/></label><button className="primary" disabled={busy}><Plus size={16}/>초대 링크 만들기</button></form>}{link&&<div className="invite-result"><label>초대 링크<input value={link} readOnly onFocus={e=>e.target.select()}/></label><button className="secondary" onClick={async()=>{try{await navigator.clipboard.writeText(link);setCopied(true);}catch{setError('링크를 선택해 직접 복사해 주세요.');}}}>{copied?<Check size={16}/>:<Copy size={16}/>} {copied?'복사됨':'복사'}</button></div>}<DomainSettings/><h3>최근 관리 기록</h3><div className="audit-list">{overview?.audit.slice(0,12).map(a=><div key={a.id}><strong>{a.actor||'시스템'}</strong><span>{({'auth.login':'로그인','auth.register':'초대 가입','workspace.setup':'최초 설정','invite.create':'초대 생성','channel.create':'채널 생성','channel.add_member':'구성원 추가','message.delete':'메시지 삭제','auth.password_change':'비밀번호 변경','domain.verify':'새 도메인 확인','domain.activate':'접속 도메인 변경'} as Record<string,string>)[a.action]||a.action}</span><time>{new Date(a.created_at).toLocaleString('ko-KR')}</time></div>)}{!overview?.audit.length&&<p className="muted">기록이 없습니다.</p>}</div>{error&&<p role="alert" className="form-error">{error}</p>}</Dialog>;
}
function Profile({me,config,onClose,onLogout,onDesktop}:{me:User;config:AuthConfig;onClose:()=>void;onLogout:()=>void;onDesktop:()=>void}){
  const [current,setCurrent]=useState(''),[password,setPassword]=useState(''),[confirmation,setConfirmation]=useState(''),[message,setMessage]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  async function changePassword(){
    setMessage('');setError('');
    if(password!==confirmation){setError('새 비밀번호와 확인 입력이 일치하지 않습니다.');return;}
    setBusy(true);
    try{await post('/auth/password',{currentPassword:current,password});setCurrent('');setPassword('');setConfirmation('');setMessage('비밀번호가 변경되었습니다. 다른 기기는 로그아웃됩니다.');}
    catch(e){setError((e as Error).message);}
    finally{setBusy(false);}
  }
  return <Dialog title="내 계정" onClose={onClose}>
    <div className="profile-detail"><Avatar user={me}/><div><h3>{me.name}</h3><p>@{me.handle}</p></div><span className="pill">{me.role==='admin'?'관리자':'구성원'}</span></div>
    {config.mode==='local'&&<form onSubmit={e=>{e.preventDefault();void changePassword();}}>
      <h3>비밀번호 변경</h3>
      <p className="small-text muted">새 비밀번호는 10자 이상 입력하세요. 변경하면 다른 기기는 로그아웃됩니다.</p>
      <label>현재 비밀번호<input type="password" value={current} onChange={e=>setCurrent(e.target.value)} required maxLength={256} autoComplete="current-password" disabled={busy}/></label>
      <label>새 비밀번호<input type="password" value={password} onChange={e=>setPassword(e.target.value)} required minLength={10} maxLength={256} autoComplete="new-password" disabled={busy}/></label>
      <label>새 비밀번호 확인<input type="password" value={confirmation} onChange={e=>setConfirmation(e.target.value)} required minLength={10} maxLength={256} autoComplete="new-password" disabled={busy}/></label>
      {error&&<p role="alert" className="form-error">{error}</p>}
      <button className="secondary" disabled={busy}>{busy?'변경 중…':'비밀번호 변경'}</button>
    </form>}
    {message&&<p role="status" className="info-banner">{message}</p>}
    <button className="secondary" onClick={onDesktop}>데스크톱 앱 다운로드</button>
    <div className="profile-footer"><span><ShieldCheck size={15}/> {config.mode==='demo'?'체험 계정':'임시 연구실 계정'}</span><button className="secondary" onClick={onLogout}><LogOut size={16}/> 로그아웃</button></div>
  </Dialog>;
}
