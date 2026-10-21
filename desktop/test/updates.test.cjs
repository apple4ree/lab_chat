const {test}=require('node:test');
const assert=require('node:assert/strict');
const {mkdtemp,rm,readFile,writeFile,readdir}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {createHash}=require('node:crypto');
const {installUpdates,selectUpdate,newer,download,FEED}=require('../updates.cjs');
const bytes=Buffer.from('verified installer fixture');
function feed(platform='win32',arch='x64'){
 const mac=platform==='darwin',name=`DAMI-Chat-0.1.4-${mac?'mac':'win'}-${arch}.${mac?'dmg':'exe'}`;
 return {version:'0.1.4',files:[{name,platform:mac?'macos':'windows',arch,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),nativeTested:true,url:`https://github.com/apple4ree/lab_chat/releases/download/v0.1.4/${name}`}]};
}
const file=()=>selectUpdate(feed(),'0.1.3','win32','x64');
test('selection pins repository, architecture, format and version; never downgrades',()=>{
 assert(newer('0.1.10','0.1.9'));assert(!newer('0.1.3','0.1.3'));
 assert.equal(selectUpdate(feed(),'0.1.5','win32','x64'),null);
 assert.equal(selectUpdate({version:null,files:[]},'0.1.3','win32','x64'),null);
 assert.equal(selectUpdate(feed('darwin','arm64'),'0.1.3','darwin','arm64').extension,'dmg');
 for(const mutation of [f=>f.files[0].url='https://evil.test/setup.exe',f=>f.files[0].arch='arm64',f=>f.files[0].bytes=2**40,f=>f.files[0].sha256='bad',f=>f.files[0].nativeTested=false,f=>f.files.push(f.files[0])]){const data=feed();mutation(data);assert.throws(()=>selectUpdate(data,'0.1.3','win32','x64'));}
});
test('downloads verify size/hash, reuse verified bytes and remove only updater cache files',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'updater-test-'));let calls=0;
 try{
  await writeFile(join(dir,'keep.txt'),'unrelated');await writeFile(join(dir,'DAMI-Chat-0.1.1-win-x64.exe'),'obsolete');
  const fetcher=async()=>{calls++;return new Response(bytes);};
  const path=await download(file(),dir,{fetcher});assert.deepEqual(await readFile(path),bytes);
  assert.equal(await download(file(),dir,{fetcher}),path);assert.equal(calls,1);
  assert.deepEqual((await readdir(dir)).sort(),[file().name,'keep.txt'].sort());
  await writeFile(path,'corrupt');await download(file(),dir,{fetcher});assert.equal(calls,2);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('corrupt, oversized, incomplete, untrusted redirect or aborted downloads never become installers',async()=>{
 for(const kind of ['hash','size','partial','redirect','abort']){
  const dir=await mkdtemp(join(tmpdir(),'updater-bad-')),controller=new AbortController();
  try{
   const fetcher=async()=>{
    if(kind==='redirect')return new Response(null,{status:302,headers:{location:'http://evil.test/file'}});
    if(kind==='abort')controller.abort();
    return new Response(kind==='hash'?Buffer.alloc(bytes.length):kind==='size'?Buffer.alloc(bytes.length+1):kind==='partial'?bytes.subarray(0,2):bytes);
   };
   await assert.rejects(download(file(),dir,{fetcher,signal:controller.signal}));assert.deepEqual(await readdir(dir),[]);
  }finally{await rm(dir,{recursive:true,force:true});}
 }
});
test('GitHub redirect is allowed only on the exact HTTPS asset host',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'updater-redirect-'));const urls=[];
 try{
  await download(file(),dir,{fetcher:async url=>{urls.push(url);return urls.length===1?new Response(null,{status:302,headers:{location:'https://release-assets.githubusercontent.com/assets/fixture?signature=test'}}):new Response(bytes);}});
  assert.equal(urls.length,2);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('background checks only announce; interactive flows download and hand installer to the OS on Windows and Mac',async()=>{
 for(const platform of ['win32','darwin']){
  const dir=await mkdtemp(join(tmpdir(),'updater-flow-')),states=[],dialogs=[],opened=[];let quit=0,downloads=0;
  const updater=installUpdates({app:{isPackaged:true,getVersion:()=> '0.1.3',getPath:()=>dir,quit:()=>quit++},platform,arch:'x64',config:{updateUrl:FEED},getWindow:()=>null,onState:s=>states.push(s),dialog:{showMessageBox:async(_,options)=>{dialogs.push(options);return {response:0};}},shell:{openPath:async path=>{opened.push(path);return '';}},fetcher:async url=>{if(url===FEED)return Response.json(feed(platform));downloads++;return new Response(bytes);}});
  try{
   await updater.check({interactive:false});assert.equal(updater.getState().phase,'available');assert.equal(dialogs.length,0);assert.equal(downloads,0);
   await updater.check();assert.equal(opened.length,1);assert.equal(quit,1);assert.equal(updater.getState().phase,'ready');
   assert(states.some(s=>s.phase==='downloading'));assert(dialogs[1].detail.includes(platform==='darwin'?'Applications':'설치 안내'));
  }finally{updater.stop();await rm(dir,{recursive:true,force:true});}
 }
});
test('cancel, concurrent checks, checksum failure, launch failure and shutdown preserve install authority',async()=>{
 for(const scenario of ['cancel','concurrent','checksum','launch','stop']){
  const dir=await mkdtemp(join(tmpdir(),'updater-control-'));let openCount=0,quit=0,release,feedCalls=0;
  const wait=new Promise(r=>release=r);
  const updater=installUpdates({app:{isPackaged:true,getVersion:()=> '0.1.3',getPath:()=>dir,quit:()=>quit++},platform:'win32',arch:'x64',config:{updateUrl:FEED},getWindow:()=>null,
   dialog:{showMessageBox:async()=>({response:scenario==='cancel'?1:0})},shell:{openPath:async()=>{openCount++;return scenario==='launch'?'failed':'';}},
   fetcher:async url=>{if(url===FEED){feedCalls++;if(['concurrent','stop'].includes(scenario))await wait;return Response.json(feed());}return new Response(scenario==='checksum'?Buffer.alloc(bytes.length):bytes);}});
  try{
   const first=updater.check();
   if(scenario==='concurrent'){await updater.check();assert.equal(feedCalls,1);release();}
   if(scenario==='stop'){updater.stop();release();}
   await first;
   if(scenario==='concurrent'){assert.equal(openCount,1);assert.equal(quit,1);}
   else{assert.equal(quit,0);assert.equal(openCount,scenario==='launch'?1:0);}
  }finally{updater.stop();await rm(dir,{recursive:true,force:true});}
 }
});
