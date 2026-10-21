import {lookup} from 'node:dns/promises';
import {request} from 'node:https';
import {BlockList,isIP} from 'node:net';
import {randomUUID,randomBytes} from 'node:crypto';
import {verifyPassword,rateLimiter} from './auth.mjs';

const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
export function domainOrigin(raw){
  if(typeof raw!=='string'||raw.length>253||/[\s\\]/.test(raw))fail(400,'HTTPS 도메인 주소를 입력해 주세요.');
  let u;try{u=new URL(raw);}catch{fail(400,'https://로 시작하는 도메인 주소를 입력해 주세요.');}
  if(u.protocol!=='https:'||u.port||u.username||u.password||u.pathname!=='/'||u.search||u.hash||isIP(u.hostname)||!u.hostname.includes('.')||!u.hostname.split('.').every(x=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(x)))fail(400,'경로·포트·계정 정보가 없는 HTTPS 도메인이 필요합니다.');
  return u.origin;
}
const blocked=new BlockList();
for(const [ip,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]])blocked.addSubnet(ip,prefix);
export const publicIPv4=address=>isIP(address)===4&&!blocked.check(address);

// Resolve once, reject private destinations, and pin the connection to that result.
// Cookies, authentication headers, redirects and proxy environment variables are never forwarded.
export async function probeDomain(raw,{resolveHost=lookup,requestHttps=request}={}){
  const origin=domainOrigin(raw),hostname=new URL(origin).hostname;
  let addresses,timer;
  try{addresses=await Promise.race([resolveHost(hostname,{family:4,all:true}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('DNS timeout')),4000);timer.unref();})]);}
  catch{fail(400,'새 도메인의 공인 IPv4 DNS 주소를 확인하지 못했습니다. DNS 설정을 확인해 주세요.');}
  finally{clearTimeout(timer);}
  if(!addresses.length||addresses.some(a=>!publicIPv4(a.address)))fail(400,'내부망 또는 예약 IP 주소로 연결되는 도메인은 사용할 수 없습니다.');
  return new Promise((resolve,reject)=>{
    const finishError=()=>reject(Object.assign(new Error('새 도메인의 HTTPS 연결을 확인하지 못했습니다. DNS·인증서·Tunnel 설정을 확인해 주세요.'),{status:400}));
    const req=requestHttps(new URL('/api/workspace/connection',origin),{
      agent:false,servername:hostname,signal:AbortSignal.timeout(6000),
      lookup:(_host,options,callback)=>callback(null,...(options.all?[[{address:addresses[0].address,family:4}]]:[addresses[0].address,4])),
      headers:{Accept:'application/json'},
    },res=>{
      if(res.statusCode!==200){res.resume();finishError();return;}
      const chunks=[];let bytes=0;
      res.on('data',chunk=>{bytes+=chunk.length;if(bytes>8192){res.destroy();finishError();}else chunks.push(chunk);});
      res.on('error',finishError);
      res.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{finishError();}});
    });
    req.on('error',finishError);req.end();
  });
}

export function createDomains({db,origin,mode,probe=probeDomain,audit}){
  const key='workspace_domains';
  db.prepare('INSERT OR IGNORE INTO app_meta VALUES (?,?)').run(key,JSON.stringify({workspaceId:randomUUID(),canonicalOrigin:origin,previousOrigins:[],revision:0,pending:null}));
  const read=()=>JSON.parse(db.prepare('SELECT value FROM app_meta WHERE key=?').get(key).value);
  const write=state=>db.prepare('UPDATE app_meta SET value=? WHERE key=?').run(JSON.stringify(state),key);
  const connection=()=>{const s=read();return {workspaceId:s.workspaceId,canonicalOrigin:s.canonicalOrigin,revision:s.revision};};
  const accepts=value=>{const s=read();return [s.canonicalOrigin,...s.previousOrigins].includes(value);};
  const status=()=>{const s=read();return {...connection(),previousOrigins:s.previousOrigins,pending:s.pending?{origin:s.pending.origin,verifiedAt:s.pending.verifiedAt,expiresAt:s.pending.verifiedAt+600000}:null,editable:mode==='local'};};
  let busy=false;
  async function exclusive(fn){if(busy)fail(409,'다른 주소 변경 작업이 진행 중입니다.');busy=true;try{return await fn();}finally{busy=false;}}
  function editable(){if(mode!=='local')fail(403,'체험 공간에서는 접속 주소를 변경할 수 없습니다.');}
  async function verify(target,state){
    const remote=await probe(target);
    if(remote?.workspaceId!==state.workspaceId||remote.revision!==state.revision||remote.canonicalOrigin!==state.canonicalOrigin)fail(400,'새 주소가 현재 연구실 서비스로 연결되지 않습니다. 동일한 채팅 서버로 연결해 주세요.');
  }
  function mount(app,admin){
    const limit=rateLimiter({limit:10});
    app.get('/api/admin/domain',(req,res)=>{admin(req);res.json(status());});
    app.post('/api/admin/domain/verify',(req,res,next)=>{try{admin(req);editable();next();}catch(e){next(e);}},limit,async(req,res)=>exclusive(async()=>{
      const target=domainOrigin(req.body.origin),s=read();
      if(target===s.canonicalOrigin)fail(400,'현재 주소와 다른 도메인을 입력해 주세요.');
      await verify(target,s);
      if(read().revision!==s.revision)fail(409,'대표 주소가 변경되었습니다. 다시 확인해 주세요.');
      s.pending={origin:target,verifiedAt:Date.now(),actorId:req.user.id,receipt:randomBytes(24).toString('hex')};write(s);
      audit(req.user.id,'domain.verify',target);res.json({...status(),receipt:s.pending.receipt});
    }));
    app.post('/api/admin/domain/activate',(req,res,next)=>{try{admin(req);editable();next();}catch(e){next(e);}},limit,async(req,res)=>exclusive(async()=>{
      const s=read(),p=s.pending;
      if(!p||p.actorId!==req.user.id||p.receipt!==req.body.receipt||Date.now()-p.verifiedAt>600000)fail(409,'새 주소를 다시 확인한 뒤 변경해 주세요.');
      if(req.body.confirmOrigin!==p.origin||req.body.keepOldDomain!==true)fail(400,'새 주소와 기존 주소 유지 안내를 확인해 주세요.');
      if(typeof req.body.password!=='string'||req.body.password.length>256||!await verifyPassword(req.body.password,req.user.password_hash))fail(403,'현재 관리자 비밀번호가 일치하지 않습니다.');
      await verify(p.origin,s);
      s.previousOrigins=[...new Set([...s.previousOrigins,s.canonicalOrigin])].filter(x=>x!==p.origin);
      s.canonicalOrigin=p.origin;s.revision++;s.pending=null;
      db.exec('BEGIN IMMEDIATE');try{
        const current=read();
        if(current.revision!==s.revision-1||current.pending?.receipt!==p.receipt)fail(409,'주소 설정이 변경되었습니다. 다시 확인해 주세요.');
        write(s);audit(req.user.id,'domain.activate',s.canonicalOrigin);db.exec('COMMIT');
      }catch(e){db.exec('ROLLBACK');throw e;}
      res.json(status());
    }));
  }
  return {connection,accepts,status,mount};
}
