import {readFileSync} from 'node:fs';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const script=readFileSync(fileURLToPath(new URL('../scripts/server-snapshot.py',import.meta.url)),'utf8');
export function createServerSource(configFile){
  if(!configFile)return null;
  const targets=JSON.parse(readFileSync(configFile,'utf8'));
  if(!Array.isArray(targets)||!targets.length||targets.length>16)throw new Error('Invalid server targets');
  const names=new Set();
  for(const t of targets){
    if(!t||typeof t.host!=='string'||!t.host.trim()||t.host.length>100||names.has(t.host)||!['local','ssh','gpu'].includes(t.transport)||
      (t.transport==='ssh'&&(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(t.sshAlias)||typeof t.expectedHostname!=='string'||!t.expectedHostname)))throw new Error('Invalid server target');
    names.add(t.host);
  }
  const polled=targets.filter(t=>t.transport!=='gpu');
  const source=async signal=>{
    const output=[];let index=0;
    async function worker(){
      while(index<polled.length&&!signal?.aborted){
        const t=polled[index++];
        try{
          const command=t.transport==='local'?'python3':'ssh';
          const args=t.transport==='local'?['-']:['-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=5','-o','ConnectionAttempts=1',t.sshAlias,'python3 -'];
          const stdout=await new Promise((resolve,reject)=>{
            const child=execFile(command,args,{timeout:8000,maxBuffer:128*1024,signal,killSignal:'SIGKILL'},(err,out)=>err?reject(err):resolve(out));
            child.stdin.on('error',()=>{});child.stdin.end(script);
          });
          const sample=JSON.parse(stdout);
          if(t.expectedHostname&&sample.hostname!==t.expectedHostname)throw new Error('Host identity mismatch');
          output.push({host:t.host,sample});
        }catch{output.push({host:t.host,error:'collection_failed'});}
      }
    }
    await Promise.all([worker(),worker()]);return output;
  };
  source.hosts=polled.map(t=>t.host);
  source.catalog=targets.map(t=>({host:t.host,hosting:['cloud','local'].includes(t.hosting)?t.hosting:'unknown',note:typeof t.note==='string'?t.note.slice(0,250):''}));
  return source;
}
