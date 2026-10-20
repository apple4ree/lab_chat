import {createApp} from '../server/app.mjs';
import {chromium} from 'playwright';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
const output=process.env.LAB_NETWORK_OUTPUT;
if(!output)throw new Error('Set LAB_NETWORK_OUTPUT to a new result file. LAB_TEST_DIST_DIR selects an isolated client build.');
const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const sourceDirty=!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim();
const dir=await mkdtemp(join(tmpdir(),'lab-chat-network-')),origin='http://127.0.0.1:4315';
const service=createApp({dataDir:dir,origin,mode:'demo',gpuAutoStart:false,distDir:resolve(process.env.LAB_TEST_DIST_DIR||'dist')});
const lounge=service.db.prepare("SELECT id FROM channels WHERE name='연구실-라운지'").get().id;
const other=service.db.prepare("SELECT id FROM channels WHERE kind='public' AND id!=? LIMIT 1").get(lounge).id;
const user=service.db.prepare("SELECT id FROM users WHERE name='서연'").get().id;
const insert=service.db.prepare('INSERT INTO messages(channel_id,user_id,body) VALUES (?,?,?)');
for(let n=0;n<160;n++)insert.run(lounge,user,`측정용 메시지 ${n}: `+'가상의 연구 결과 공유 문장. '.repeat(8));
const server=service.app.listen(4315,'127.0.0.1');
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true});
let phase='boot',events=[],pending=[];
try{
 const page=await browser.newPage();
 page.on('requestfinished',req=>{
  const url=new URL(req.url());if(!url.pathname.startsWith('/api/')||url.pathname==='/api/events')return;
  const label=phase;
  pending.push((async()=>{const response=await req.response();const body=response.status()===204?Buffer.alloc(0):await response.body();events.push({phase:label,path:url.pathname+url.search,method:req.method(),status:response.status(),decodedBytes:body.length});})().catch(error=>events.push({phase:label,path:url.pathname,method:req.method(),decodedBytes:null,bodyReadError:error.message.split('\n')[0]})));
 });
 await page.goto(origin);await page.getByRole('button',{name:/지민/}).click();
 await page.getByText('대화가 이어지는 중').waitFor();await page.locator('.channel-link').filter({hasText:'연구실-라운지'}).click();
 await page.locator('.message-list article').first().waitFor();await page.waitForTimeout(1200);
 phase='idle_32s';await page.waitForTimeout(32000);await Promise.all(pending);
 const headers={'X-Lab-Request':'1',Origin:origin};
 async function change(label,channel,body){phase=label;const response=await page.request.post(`${origin}/api/channels/${channel}/messages`,{headers,data:{body}});assert.equal(response.status(),201);await page.waitForTimeout(1400);await Promise.all(pending);}
 await change('one_message_same_channel_80_loaded',lounge,'한 건의 실시간 수신');
 phase='load_history';await page.getByRole('button',{name:'이전 메시지 불러오기'}).click();await page.waitForTimeout(1000);
 await change('one_message_same_channel_160_loaded',lounge,'과거 기록 로드 후 한 건의 수신');
 await change('one_message_other_channel_160_loaded',other,'현재 보고 있지 않은 채널의 수신');
 const phases={idle_32s:{requests:0,decodedBytes:0,byEndpoint:{}}};for(const event of events){const p=phases[event.phase]??={requests:0,decodedBytes:0,byEndpoint:{}};p.requests++;p.decodedBytes+=event.decodedBytes??0;p.byEndpoint[event.method+' '+event.path]=(p.byEndpoint[event.method+' '+event.path]??0)+1;}
 const result={at:new Date().toISOString(),sourceCommit,sourceDirty,scope:'Isolated localhost synthetic demo; one browser, no production writes, decoded API response bodies excluding headers/SSE/POST injector; not WAN latency or load capacity.',phases,events};
 await writeFile(output,JSON.stringify(result,null,2),{flag:'wx',mode:0o600});console.log(JSON.stringify(phases,null,2));
}finally{await browser.close();service.close();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
