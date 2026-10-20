const {URL}=require('node:url');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function workspaceURL(release,{packaged=true,developmentUrl}={}){
  const raw=!packaged&&developmentUrl?developmentUrl:release.workspaceUrl;
  const u=new URL(raw);
  const development=!packaged&&u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname);
  if(!development&&u.href!=='https://chat.damilab.cc/')throw new Error('Untrusted workspace URL');
  if(u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw new Error('Invalid workspace URL');
  return u.origin;
}
function sameOrigin(value,origin){try{const u=new URL(value);return u.origin===origin&&!u.username&&!u.password;}catch{return false;}}
function externalURL(raw){try{if(typeof raw!=='string'||raw.length>4096||/[\u0000-\u001f]/.test(raw))return null;const u=new URL(raw);return ['https:','http:','mailto:'].includes(u.protocol)&&!u.username&&!u.password?u.href:null;}catch{return null;}}
function parseState(input){
  if(!input||typeof input!=='object'||!Array.isArray(input.channels)||input.channels.length>1024)throw new Error('Invalid desktop state');
  if(input.userId===null){if(input.channels.length)throw new Error('Invalid signed-out state');return {userId:null,activeChannelId:null,channels:[]};}
  if(!uuid.test(input.userId)||!(input.activeChannelId===null||uuid.test(input.activeChannelId)))throw new Error('Invalid identity');
  const seen=new Set(),channels=input.channels.map(c=>{
    if(!c||!uuid.test(c.id)||seen.has(c.id))throw new Error('Invalid channel');seen.add(c.id);
    for(const key of ['unread','mentions','latestMessageId'])if(!Number.isSafeInteger(c[key])||c[key]<0||c[key]>Number.MAX_SAFE_INTEGER)throw new Error('Invalid count');
    return {id:c.id,unread:Math.min(c.unread,1000000),mentions:Math.min(c.mentions,1000000),latestMessageId:c.latestMessageId};
  });
  return {userId:input.userId,activeChannelId:input.activeChannelId,channels};
}
module.exports={workspaceURL,sameOrigin,externalURL,parseState,uuid};
