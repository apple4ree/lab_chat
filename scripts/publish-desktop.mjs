// Publishes only explicitly named desktop packages to the authenticated download directory.
import {readFile,mkdir,copyFile,stat,writeFile,rename} from 'node:fs/promises';
import {createReadStream,constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const verified=spawnSync('python3',['scripts/verify-desktop-packages.py'],{stdio:'inherit'});
if(verified.error||verified.status!==0)throw new Error('Desktop package verification failed; nothing published.');
const pkg=JSON.parse(await readFile('desktop/package.json','utf8'));
const directory='.data/desktop-releases';await mkdir(directory,{recursive:true,mode:0o700});
async function hash(path){const h=createHash('sha256');for await(const b of createReadStream(path))h.update(b);return h.digest('hex');}
const files=[];
for(const [platform,arch,suffix] of [['windows','x64','win-x64.zip'],['macos','arm64','mac-arm64.zip'],['macos','x64','mac-x64.zip']]){
  const name=`DAMI-Chat-${pkg.version}-${suffix}`,source=`desktop/release/${name}`,target=`${directory}/${name}`;
  const info=await stat(source),sha256=await hash(source);
  try{await copyFile(source,target,constants.COPYFILE_EXCL);}catch(e){if(e.code!=='EEXIST'||await hash(target)!==sha256)throw new Error('Existing release differs. Increment the version before publishing.');}
  files.push({name,platform,arch,bytes:info.size,sha256,signed:false,nativeTested:false});
}
await writeFile(`${directory}/manifest.json.next`,JSON.stringify({version:pkg.version,createdAt:new Date().toISOString(),files},null,2),{mode:0o600});
await rename(`${directory}/manifest.json.next`,`${directory}/manifest.json`);console.log(JSON.stringify({directory,files},null,2));
