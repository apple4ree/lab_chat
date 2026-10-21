import {randomUUID} from 'node:crypto';
import {transaction} from './db.mjs';
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const text=(v,label,max,required=false)=>{if(typeof v!=='string'||v.length>max||(required&&!v.trim())||/[\x00-\x1f\x7f]/.test(v))fail(400,`${label}을 확인해 주세요.`);return v.trim();};
const paragraph=(v,label,max)=>{if(typeof v!=='string'||v.length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v))fail(400,`${label}을 확인해 주세요.`);return v.trim();};
const optionalNumber=(v,label,{integer=false,max=1e8}={})=>{if(v===null||v===undefined||v==='')return null;if(typeof v!=='number'||!Number.isFinite(v)||v<=0||v>max||(integer&&!Number.isSafeInteger(v)))fail(400,`${label}을 확인해 주세요.`);return v;};
export function canManageResources(db,user){return user?.role==='admin'||!!(user?.id&&db.prepare('SELECT 1 FROM server_managers WHERE user_id=?').get(user.id));}
export function createResourceCatalog({db,gpu,source=null,now=Date.now}){
  const canManage=user=>canManageResources(db,user);
  const requireManager=user=>{if(!canManage(user))fail(403,'관리자 또는 서버 관리자만 자원을 관리할 수 있습니다.');};
  const audit=(user,action,id)=>db.prepare('INSERT INTO audit_log(actor_id,action,target_id) VALUES(?,?,?)').run(user.id,action,id);
  const owner=value=>{if(value===null||value===undefined||value==='')return null;if(typeof value!=='string'||!db.prepare("SELECT 1 FROM users WHERE id=? AND identity_provider!='system'").get(value))fail(400,'담당자를 확인해 주세요.');return value;};
  const server=host=>db.prepare('SELECT * FROM server_catalog WHERE host=?').get(host)||fail(404,'등록된 서버를 찾을 수 없습니다.');
  const device=id=>db.prepare('SELECT * FROM research_resources WHERE id=?').get(id)||fail(404,'등록된 GPU를 찾을 수 없습니다.');
  const version=(body,row)=>{if(!Number.isSafeInteger(body.version)||body.version!==row.version)fail(409,'다른 관리자가 정보를 변경했습니다. 새로고침 후 다시 저장해 주세요.');};
  function sync(){
    const view=gpu?.view()||{items:[],connection:'waiting'};
    const candidates=new Map((source?.catalog||[]).map(s=>[s.host,s]));
    for(const row of db.prepare('SELECT host FROM server_observations UNION SELECT host FROM research_resources').all())if(!candidates.has(row.host))candidates.set(row.host,{host:row.host});
    for(const g of view.items)if(!candidates.has(g.host))candidates.set(g.host,{host:g.host});
    transaction(db,()=>{
      const insert=db.prepare('INSERT OR IGNORE INTO server_catalog(host,label,hosting,note,created_at,updated_at) VALUES(?,?,?,?,?,?)');
      for(const s of candidates.values())insert.run(s.host,s.host,s.hosting||'unknown',s.note||'',now(),now());
      const gpuInsert=db.prepare('INSERT OR IGNORE INTO research_resources(id,host,gpu_index,label) VALUES(?,?,?,?)');
      for(const g of view.items)gpuInsert.run(randomUUID(),g.host,g.index,`${g.host} · GPU ${g.index}`);
    });return view;
  }
  const serverRows=()=>db.prepare('SELECT s.*,u.name AS owner_name FROM server_catalog s LEFT JOIN users u ON u.id=s.owner_id ORDER BY s.host').all();
  const gpuRows=()=>db.prepare('SELECT r.*,s.model AS declared_model,s.memory_gib AS declared_memory_gib,u.name AS owner_name FROM research_resources r LEFT JOIN resource_specs s ON s.resource_id=r.id LEFT JOIN users u ON u.id=r.owner_id ORDER BY r.host,r.gpu_index').all();
  function view(user){sync();return {canManageResources:canManage(user),servers:serverRows().map(s=>({...s,inventoryConnected:source?.hosts?.includes(s.host)||false})),gpus:gpuRows()};}
  function serverFields(body){
    if(!['local','cloud','unknown'].includes(body.hosting))fail(400,'서버 구분을 확인해 주세요.');
    return [text(body.label,'서버 이름',160,true),body.hosting,paragraph(body.note??'','서버 안내',2000),owner(body.ownerId),text(body.cpuModel??'','CPU 모델',180),optionalNumber(body.cpuCores,'CPU 코어',{integer:true,max:65536}),optionalNumber(body.memoryGiB,'RAM 용량'),optionalNumber(body.storageGiB,'저장장치 용량')];
  }
  function registerServer(user,body){
    requireManager(user);sync();const host=text(body.host,'서버 식별자',100,true);
    if(/[\s/\\?#]/.test(host)||host==='.'||host==='..')fail(400,'서버 식별자는 공백·경로 없이 입력해 주세요.');
    const fields=serverFields(body);
    return transaction(db,()=>{if(db.prepare('SELECT 1 FROM server_catalog WHERE host=?').get(host))fail(409,'이미 등록된 서버 식별자입니다. 기존 서버를 수정해 주세요.');if(db.prepare('SELECT count(*) n FROM server_catalog').get().n>=100)fail(409,'등록 가능한 서버 수에 도달했습니다.');
      db.prepare('INSERT INTO server_catalog(host,label,hosting,note,owner_id,cpu_model,cpu_cores,memory_gib,storage_gib,created_at,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(host,...fields,now(),now(),user.id);audit(user,'resource.server.create',host);return server(host);});
  }
  function updateServer(user,host,body){
    requireManager(user);return transaction(db,()=>{const row=server(host);version(body,row);if(body.host!==undefined&&body.host!==host)fail(400,'수집·예약 연결에 쓰이는 서버 식별자는 변경할 수 없습니다.');const fields=serverFields(body);
      db.prepare('UPDATE server_catalog SET label=?,hosting=?,note=?,owner_id=?,cpu_model=?,cpu_cores=?,memory_gib=?,storage_gib=?,updated_at=?,updated_by=?,version=version+1 WHERE host=?').run(...fields,now(),user.id,host);audit(user,'resource.server.update',host);return server(host);});
  }
  function gpuFields(body){
    if(typeof body.enabled!=='boolean')fail(400,'예약 허용 여부를 확인해 주세요.');
    const notes=body.notes??'';if(typeof notes!=='string'||notes.length>2000)fail(400,'장비 안내를 확인해 주세요.');
    return [text(body.label,'장비 이름',160,true),notes.trim(),owner(body.ownerId),body.enabled?1:0];
  }
  function setSpecs(id,body){
    if(!Object.hasOwn(body,'model')&&!Object.hasOwn(body,'memoryGiB'))return;
    const previous=db.prepare('SELECT * FROM resource_specs WHERE resource_id=?').get(id);
    const model=Object.hasOwn(body,'model')?text(body.model??'','GPU 모델',180):previous?.model||'';
    const memory=Object.hasOwn(body,'memoryGiB')?optionalNumber(body.memoryGiB,'GPU 메모리'):previous?.memory_gib??null;
    db.prepare('INSERT INTO resource_specs(resource_id,model,memory_gib) VALUES(?,?,?) ON CONFLICT(resource_id) DO UPDATE SET model=excluded.model,memory_gib=excluded.memory_gib').run(id,model,memory);
  }
  function registerGpu(user,body){
    requireManager(user);sync();const host=text(body.host,'서버 식별자',100,true),index=body.gpuIndex;
    if(!Number.isSafeInteger(index)||index<0)fail(400,'GPU 번호는 0 이상의 정수여야 합니다.');
    const fields=gpuFields(body);
    return transaction(db,()=>{server(host);if(db.prepare('SELECT 1 FROM research_resources WHERE host=? AND gpu_index=?').get(host,index))fail(409,'해당 서버의 GPU 번호가 이미 등록되어 있습니다.');
      if(db.prepare('SELECT count(*) n FROM research_resources WHERE host=?').get(host).n>=64||db.prepare('SELECT count(*) n FROM research_resources').get().n>=1024)fail(409,'등록 가능한 GPU 수에 도달했습니다.');
      const id=randomUUID();db.prepare('INSERT INTO research_resources(id,host,gpu_index,label,notes,owner_id,enabled) VALUES(?,?,?,?,?,?,?)').run(id,host,index,...fields);setSpecs(id,body);audit(user,'resource.gpu.create',id);return gpuRows().find(g=>g.id===id);});
  }
  function configureGpu(user,id,body){
    requireManager(user);return transaction(db,()=>{const row=device(id);version(body,row);
      if((body.host!==undefined&&body.host!==row.host)||(body.gpuIndex!==undefined&&body.gpuIndex!==row.gpu_index))fail(400,'예약과 수집에 연결된 서버·GPU 번호는 변경할 수 없습니다.');
      db.prepare('UPDATE research_resources SET label=?,notes=?,owner_id=?,enabled=?,version=version+1 WHERE id=?').run(...gpuFields(body),id);setSpecs(id,body);audit(user,'resource.configure',id);return gpuRows().find(g=>g.id===id);});
  }
  return {canManage,sync,serverRows,gpuRows,view,registerServer,updateServer,registerGpu,configureGpu};
}
export function mountResourceCatalog(app,catalog){
  app.get('/api/resources/catalog',(req,res)=>res.json(catalog.view(req.user)));
  app.post('/api/resources/servers',(req,res)=>res.status(201).json(catalog.registerServer(req.user,req.body)));
  app.put('/api/resources/servers/:host',(req,res)=>res.json(catalog.updateServer(req.user,req.params.host,req.body)));
  app.post('/api/resources/inventory',(req,res)=>res.status(201).json(catalog.registerGpu(req.user,req.body)));
}
