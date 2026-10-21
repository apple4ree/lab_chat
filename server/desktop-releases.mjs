import {readFile,lstat} from 'node:fs/promises';
import {join,resolve} from 'node:path';

export function mountDesktopReleases(app,directory){
  async function manifest(){
    if(!directory)return {version:null,files:[]};
    let raw;try{raw=await readFile(join(directory,'manifest.json'),'utf8');}catch(e){if(e.code==='ENOENT')return {version:null,files:[]};throw e;}
    const data=JSON.parse(raw);
    if(typeof data.version!=='string'||!Array.isArray(data.files)||data.files.length>10)throw new Error('Invalid desktop manifest');
    const releaseUrl=data.releaseUrl;
    if(releaseUrl!==undefined&&(!/^\d+\.\d+\.\d+$/.test(data.version)||releaseUrl!==`https://github.com/apple4ree/lab_chat/releases/tag/v${data.version}`))throw new Error('Invalid GitHub release URL');
    const downloadBase=releaseUrl?`https://github.com/apple4ree/lab_chat/releases/download/v${data.version}`:'/api/desktop/releases';
    const files=[];
    for(const f of data.files){
      if(typeof f.name!=='string'||!/^DAMI-Chat-[A-Za-z0-9._-]+\.(exe|zip|dmg)$/.test(f.name)||!['windows','macos'].includes(f.platform)||!['x64','arm64'].includes(f.arch)||!/^[a-f0-9]{64}$/.test(f.sha256))throw new Error('Invalid release file');
      if(releaseUrl&&!f.name.startsWith(`DAMI-Chat-${data.version}-`))throw new Error('GitHub release version mismatch');
      const info=await lstat(join(directory,f.name));if(!info.isFile()||info.size!==f.bytes)throw new Error('Release file mismatch');
      files.push({name:f.name,platform:f.platform,arch:f.arch,bytes:f.bytes,sha256:f.sha256,signed:f.signed===true,nativeTested:f.nativeTested===true,url:`${downloadBase}/${encodeURIComponent(f.name)}`});
    }
    return {version:data.version,releaseUrl,files};
  }
  app.get('/api/desktop/releases',async(_req,res)=>res.json(await manifest()));
  // Public update metadata contains only installers already published on GitHub.
  // The native main process fetches this without workspace cookies or login tokens.
  app.get('/desktop/updates/latest.json',async(_req,res)=>{
    const data=await manifest();
    res.set('Cache-Control','no-store');
    res.json(data.releaseUrl?{version:data.version,files:data.files.filter(f=>f.nativeTested&&/\.(exe|dmg)$/.test(f.name))}:{version:null,files:[]});
  });
  app.get('/api/desktop/releases/:name',async(req,res)=>{
    const file=(await manifest()).files.find(f=>f.name===req.params.name);
    if(!file)return res.status(404).json({error:'설치 파일을 찾을 수 없습니다.'});
    res.set('X-Content-Type-Options','nosniff');res.download(file.name,file.name,{root:resolve(directory),dotfiles:'deny'});
  });
}
