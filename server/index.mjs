import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.mjs';
import {gpuHttpSource,demoGpuSource} from './gpu.mjs';
import {createResourceSource} from './resource-source.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const host=process.env.LAB_HOST||'127.0.0.1';
const port=Number(process.env.LAB_PORT||4310);
const mode=process.env.LAB_AUTH_MODE||'local';
const origin=process.env.LAB_ORIGIN||`http://${host}:${port}`;
if(mode==='demo'&&(!['127.0.0.1','localhost','::1'].includes(host)||process.env.NODE_ENV==='production')) throw new Error('Demo mode is restricted to local development.');
if(!['127.0.0.1','localhost','::1'].includes(host)&&!process.env.LAB_ORIGIN) throw new Error('Set LAB_ORIGIN before listening on a network interface.');
const dataDir=resolve(root,process.env.LAB_DATA_DIR||`.data/${mode}`);
const service=createApp({dataDir,origin,mode,setupToken:process.env.LAB_SETUP_TOKEN,distDir:resolve(root,'dist'),demoGateHash:process.env.LAB_DEMO_GATE_HASH,gpuSource:mode==='demo'?demoGpuSource:process.env.LAB_GPU_URL?gpuHttpSource(process.env.LAB_GPU_URL):null,resourceSource:mode==='demo'?null:createResourceSource({baseUrl:process.env.LAB_GPU_URL}),desktopReleaseDir:resolve(root,'.data/desktop-releases')});
const server=service.app.listen(port,host,()=>{
  console.log(`Lab Chat: ${origin} (${mode})`);
  console.log(`Data: ${dataDir}`);
  if(mode==='local'&&!service.db.prepare('SELECT 1 FROM users LIMIT 1').get()) console.log(`First-admin setup code: ${service.setupToken}`);
});
let stopping=false;
function stop(){
  if(stopping)return;stopping=true;
  void service.gpu.stop();
  service.resources.stop();
  service.closeStreams();
  const deadline=setTimeout(()=>server.closeAllConnections(),10000);deadline.unref();
  server.close(()=>{clearTimeout(deadline);service.close();});
}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
