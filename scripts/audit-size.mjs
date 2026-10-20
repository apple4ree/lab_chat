// Dependency-free size gate. Inspect only assets referenced by the current HTML,
// so retained deployment assets do not count against the current client budget.
import {readFile,readdir,lstat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {gzipSync} from 'node:zlib';
const args=process.argv.slice(2),dist=resolve(args.includes('--dist')?args[args.indexOf('--dist')+1]:'dist');
const html=await readFile(join(dist,'index.html'),'utf8');
const assets=[...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g)].map(m=>m[1]))];
if(!assets.length)throw new Error('No current JS/CSS assets found.');
const files=[];
for(const path of assets){const bytes=await readFile(join(dist,path));files.push({path,bytes:bytes.length,gzipBytes:gzipSync(bytes).length});}
const budget={js:140*1024,css:20*1024},totals={js:0,css:0};
for(const file of files)totals[file.path.endsWith('.js')?'js':'css']+=file.gzipBytes;
const result={scope:'Referenced initial JS/CSS, gzip comparison only; not actual CDN transfer.',files,gzipBytes:totals,budget};
if(args.includes('--storage')){
  const storage=[];
  async function size(path,seen=new Set()){
    let info;try{info=await lstat(path);}catch(e){if(e.code==='ENOENT')return 0;throw e;}
    if(info.isSymbolicLink())return 0;
    if(info.isDirectory()){let sum=0;for(const name of await readdir(path))sum+=await size(join(path,name),seen);return sum;}
    const id=`${info.dev}:${info.ino}`;if(seen.has(id))return 0;seen.add(id);return info.size;
  }
  for(const path of ['dist','node_modules','desktop/node_modules','desktop/release','desktop/release-windows','.data/installer-builds','.data/desktop-releases'])
    storage.push({path,logicalBytes:await size(path)});
  result.storage=storage;result.storageScope='Logical file sizes; shared copy-on-write blocks are not subtracted. No files deleted.';
}
console.log(JSON.stringify(result,null,2));
if(totals.js>budget.js||totals.css>budget.css){console.error('Initial client size budget exceeded. Inspect imports/build output before raising the budget.');process.exitCode=1;}
