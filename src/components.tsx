import {useEffect,useRef,useState,type ReactNode} from 'react';
import {X,Paperclip,Send,Smile,MessageSquare,Pin,Pencil,Trash2,FileText,AtSign,LoaderCircle,Check} from 'lucide-react';
import {api,post,type User,type Message} from './api';

export function Avatar({user,small=false}:{user:User;small?:boolean}){
  const color=user.name.split('').reduce((a,c)=>a+c.charCodeAt(0),0)%5;
  return <span className={`avatar color-${color} ${small?'small':''}`} aria-hidden="true">{user.name.slice(0,1)}</span>;
}
export function Dialog({title,children,onClose}:{title:string;children:ReactNode;onClose:()=>void}){
  const ref=useRef<HTMLDialogElement>(null);
  useEffect(()=>{ref.current?.showModal();},[]);
  return <dialog ref={ref} onCancel={onClose} onClick={e=>{if(e.target===ref.current)onClose();}}><div className="dialog-head"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="창 닫기"><X size={20}/></button></div>{children}</dialog>;
}
export function Body({text}:{text:string}){
  return <div className="message-body">{text.split(/(https?:\/\/[^\s<>]+|@[a-zA-Z0-9_-]+)/g).map((part,i)=>/^https?:\/\//.test(part)?<a key={i} href={part} target="_blank" rel="noopener noreferrer">{part}</a>:part.startsWith('@')?<span className="mention" key={i}>{part}</span>:part)}</div>;
}
export function MessageRow({message:m,me,onThread,onChange,onError,thread=false}:{message:Message;me:User;onThread:(m:Message)=>void;onChange:()=>void;onError:(e:unknown)=>void;thread?:boolean}){
  const [editing,setEditing]=useState(false),[draft,setDraft]=useState(m.body),[picker,setPicker]=useState(false),[confirmDelete,setConfirmDelete]=useState(false),[busy,setBusy]=useState(false);
  async function action(fn:()=>Promise<unknown>){setBusy(true);try{await fn();onChange();}catch(e){onError(e);}finally{setBusy(false);}}
  return <article className={`message ${m.pinned?'is-pinned':''}`} id={`message-${m.id}`} data-message-id={m.id}>
    <Avatar user={m.user}/><div className="message-content">
      {m.pinned===1&&<div className="pin-label"><Pin size={11}/> 고정된 메시지</div>}
      <div className="message-meta"><strong>{m.user.name}</strong>{m.user.role==='bot'&&<span className="pill">자동 알림</span>}<time dateTime={m.created_at} title={new Date(m.created_at).toLocaleString('ko-KR')}>{new Date(m.created_at).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit',hour12:false})}</time>{m.edited_at&&<span className="muted small-text">수정됨</span>}</div>
      {m.deleted?<p className="deleted">삭제된 메시지입니다.</p>:editing?<form className="edit-form" onSubmit={e=>{e.preventDefault();void action(async()=>{await api(`/messages/${m.id}`,{method:'PATCH',body:JSON.stringify({body:draft})});setEditing(false);});}}><textarea aria-label="메시지 수정" value={draft} onChange={e=>setDraft(e.target.value)} maxLength={16000}/><div className="form-actions"><button type="button" className="secondary" onClick={()=>setEditing(false)}>취소</button><button className="primary" disabled={busy}>저장</button></div></form>:<Body text={m.body}/>}
      {m.files.map(f=><a className="file-card" href={`/api/files/${f.id}`} key={f.id} download><span className="file-icon"><FileText size={22}/></span><span><strong>{f.name}</strong><small>{f.size<1048576?`${Math.ceil(f.size/1024)} KB`:`${(f.size/1048576).toFixed(1)} MB`} · 다운로드</small></span></a>)}
      {!!m.reactions.length&&<div className="reactions">{m.reactions.map(r=><button disabled={busy} className={r.mine?'mine':''} key={r.emoji} onClick={()=>void action(()=>post(`/messages/${m.id}/reactions`,{emoji:r.emoji}))} aria-label={`${r.emoji} 반응 ${r.count}개`} aria-pressed={!!r.mine}>{r.emoji}<span>{r.count}</span></button>)}</div>}
      {!thread&&m.reply_count>0&&<button className="thread-link" onClick={()=>onThread(m)}><MessageSquare size={14}/><b>답글 {m.reply_count}개</b><span>스레드 보기</span></button>}
    </div>
    {!m.deleted&&!editing&&<div className="message-actions"><button className="icon-button" title="반응 추가" aria-label="반응 추가" onClick={()=>setPicker(!picker)}><Smile size={16}/></button>{!thread&&<button className="icon-button" title="스레드 답글" aria-label="스레드 답글" onClick={()=>onThread(m)}><MessageSquare size={16}/></button>}<button className="icon-button" title={m.pinned?'고정 해제':'메시지 고정'} aria-label={m.pinned?'고정 해제':'메시지 고정'} onClick={()=>void action(()=>post(`/messages/${m.id}/pin`))}><Pin size={16}/></button>{m.user_id===me.id&&<button className="icon-button" aria-label="메시지 수정" onClick={()=>{setDraft(m.body);setEditing(true);}}><Pencil size={16}/></button>}{(m.user_id===me.id||me.role==='admin')&&<button className="icon-button" aria-label="메시지 삭제" onClick={()=>setConfirmDelete(true)}><Trash2 size={16}/></button>}</div>}
    {picker&&<div className="emoji-picker">{['👍','❤️','🎉','👀','🌱','✅'].map(emoji=><button key={emoji} aria-label={`${emoji} 추가`} onClick={()=>{setPicker(false);void action(()=>post(`/messages/${m.id}/reactions`,{emoji}));}}>{emoji}</button>)}</div>}
    {confirmDelete&&<Dialog title="메시지를 삭제할까요?" onClose={()=>setConfirmDelete(false)}><p>메시지 본문과 첨부파일이 대화에서 숨겨집니다. 스레드 답글은 남습니다.</p><div className="form-actions"><button className="secondary" onClick={()=>setConfirmDelete(false)}>취소</button><button className="danger" disabled={busy} onClick={()=>void action(async()=>{await api(`/messages/${m.id}`,{method:'DELETE'});setConfirmDelete(false);})}>삭제</button></div></Dialog>}
  </article>;
}

export function Composer({channelId,parentId,label,members,onSent,onError}:{channelId:string;parentId?:number;label:string;members:User[];onSent:(m:Message)=>void;onError:(e:unknown)=>void}){
  const [body,setBody]=useState(''),[file,setFile]=useState<File|null>(null),[busy,setBusy]=useState(false),[showMentions,setShowMentions]=useState(false),[emoji,setEmoji]=useState(false),[sent,setSent]=useState(false);
  const pendingSend=useRef<{body:string;file:File|null;id:string}|null>(null);
  const input=useRef<HTMLInputElement>(null),textarea=useRef<HTMLTextAreaElement>(null);
  useEffect(()=>{if(!sent)return;textarea.current?.focus();const timer=setTimeout(()=>setSent(false),1800);return()=>clearTimeout(timer);},[sent]);
  async function send(){
    if(busy||(!body.trim()&&!file))return;
    setBusy(true);setSent(false);
    if(!pendingSend.current||pendingSend.current.body!==body||pendingSend.current.file!==file)pendingSend.current={body,file,id:crypto.randomUUID()};
    const clientMessageId=pendingSend.current.id;
    try{
      let message:Message;
      if(file){const form=new FormData();form.set('file',file);form.set('body',body);form.set('clientMessageId',clientMessageId);if(parentId)form.set('parentId',String(parentId));message=await api<Message>(`/channels/${channelId}/files`,{method:'POST',body:form,retry:true,timeoutMs:120000});}
      else message=await post<Message>(`/channels/${channelId}/messages`,{body,parentId,clientMessageId},{retry:true});
      pendingSend.current=null;setBody('');setFile(null);setShowMentions(false);setEmoji(false);setSent(true);onSent(message);
    }catch(e){onError(e);}finally{setBusy(false);}
  }
  return <div className="composer-wrap"><form className="composer" onSubmit={e=>{e.preventDefault();void send();}}>
    <textarea ref={textarea} aria-label={parentId?'스레드 답글 입력':'메시지 입력'} placeholder={`${label}에 메시지 보내기`} value={body} maxLength={16000} disabled={busy} onChange={e=>setBody(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();void send();}}}/>
    {file&&<div className="attachment-preview"><FileText size={16}/><span>{file.name}</span><button type="button" className="icon-button" aria-label="첨부 취소" disabled={busy} onClick={()=>setFile(null)}><X size={14}/></button></div>}
    {showMentions&&<div className="mention-picker">{members.map(u=><button type="button" key={u.id} onClick={()=>{setBody(v=>v+`@${u.handle} `);setShowMentions(false);textarea.current?.focus();}}><Avatar user={u} small/><span>{u.name}<small>@{u.handle}</small></span></button>)}</div>}
    {emoji&&<div className="composer-emojis">{['👋','✨','🌱','👍','📚','🧪','✅','🎉'].map(e=><button type="button" key={e} onClick={()=>{setBody(v=>v+e);setEmoji(false);textarea.current?.focus();}}>{e}</button>)}</div>}
    <div className="composer-toolbar"><div><input type="file" ref={input} hidden onChange={e=>{const f=e.target.files?.[0];if(f){if(f.size>20*1024*1024)onError(new Error('파일은 20MB까지 첨부할 수 있습니다.'));else setFile(f);}e.target.value='';}}/><button type="button" className="icon-button" aria-label="파일 첨부" title="파일 첨부 · 최대 20MB" disabled={busy} onClick={()=>input.current?.click()}><Paperclip size={18}/></button><button type="button" className="icon-button" aria-label="이모지" onClick={()=>setEmoji(!emoji)}><Smile size={18}/></button><button type="button" className="icon-button" aria-label="구성원 멘션" onClick={()=>setShowMentions(!showMentions)}><AtSign size={18}/></button></div><button className="send-button" aria-label={parentId?'답글 보내기':'메시지 보내기'} disabled={busy||(!body.trim()&&!file)}>{busy?<LoaderCircle size={17} className="spin"/>:<Send size={17}/>}<span>보내기</span></button></div>
  </form><div className="composer-hint"><span className={sent?'send-confirmation':undefined} ><span role="status" aria-label="메시지 전송 상태" aria-live="polite">{sent?<><Check size={12}/>전송됨</>:null}</span>{!sent&&'대화가 쌓이면, 연구의 맥락이 됩니다.'}</span><span><b>Enter</b> 전송 · <b>Shift + Enter</b> 줄바꿈</span></div></div>;
}
