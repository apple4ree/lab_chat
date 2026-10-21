// Isolated, reproducible management reads. Never opens the production database.
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {openDatabase,createUser,transaction} from '../server/db.mjs';
import {createResources} from '../server/resources.mjs';

const count=Number(process.argv[2]||6),iterations=200;
if(!Number.isSafeInteger(count)||count<1||count>1024)throw new Error('GPU count must be 1..1024');
const dir=mkdtempSync(join(tmpdir(),'lab-resource-measure-')),raw=openDatabase(dir),now=1800000000000;
const statements={};
const db=new Proxy(raw,{get(target,key){
  if(key==='prepare')return sql=>{
    const statement=target.prepare(sql);
    return new Proxy(statement,{get(s,k){const value=s[k];return typeof value==='function'?(...args)=>{statements[sql.split(/\s+/)[0]]=(statements[sql.split(/\s+/)[0]]||0)+1;return value.apply(s,args);}:value;}});
  };
  const value=target[key];return typeof value==='function'?value.bind(target):value;
}});
const user=createUser(raw,{email:'measure@example.test',name:'Measurement',role:'admin'});
const items=Array.from({length:count},(_,i)=>({host:`host-${Math.floor(i/64)}`,index:i%64,status:'idle',memoryTotalMiB:81920,memoryFreeMiB:81920,utilization:0}));
transaction(raw,()=>{
  const device=raw.prepare('INSERT INTO research_resources(id,host,gpu_index,label) VALUES(?,?,?,?)');
  const reservation=raw.prepare("INSERT INTO resource_reservations(resource_id,user_id,project,purpose,starts_at,ends_at,status,start_notified,created_at,updated_at) VALUES(?,?,?,?,?,?,'approved',1,?,?)");
  for(const [i,g] of items.entries()){
    device.run(`device-${i}`,g.host,g.index,`GPU ${i}`);
    reservation.run(`device-${i}`,user.id,'Measurement','Fixture',now-60000,now+3600000,now,now);
  }
});
const service=createResources({db,gpu:{view:()=>({items,connection:'connected'})},now:()=>now,autoStart:false});
function run(n){
  for(const k of Object.keys(statements))delete statements[k];
  const cpu=process.cpuUsage(),start=performance.now();let bytes=0;
  for(let i=0;i<n;i++)bytes+=Buffer.byteLength(JSON.stringify(service.list(user)));
  return {iterations:n,elapsedMs:performance.now()-start,cpuMs:Object.values(process.cpuUsage(cpu)).reduce((a,b)=>a+b,0)/1000,statements:{...statements},responseBytes:bytes/n};
}
try{const cold=run(1),warm=run(iterations);console.log(JSON.stringify({gpus:count,cold,warm,peakRssKiB:process.resourceUsage().maxRSS}));}
finally{service.stop();raw.close();rmSync(dir,{recursive:true,force:true});}
