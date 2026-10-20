// Publish only native installers whose CI evidence matches a pinned source commit.
import {readFile,mkdir,copyFile,lstat,writeFile,rename} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {desktopSources,fileHash,inspectInstallers} from './desktop-release.mjs';
const [source,commit]=process.argv.slice(2);
if(!source||!/^[a-f0-9]{40}$/.test(commit||''))throw new Error('Usage: node scripts/publish-desktop.mjs <artifact-directory> <40-character-source-commit>');
const fromGit=name=>execFileSync('git',['show',`${commit}:desktop/${name}`]);
const pkg=JSON.parse(fromGit('package.json')),current=JSON.parse(await readFile('desktop/package.json','utf8'));assert.equal(pkg.version,current.version,'Build version differs from checkout');
const sourceSha256=Object.fromEntries(desktopSources.map(name=>[name,createHash('sha256').update(fromGit(name)).digest('hex')]));
const files=await inspectInstallers({directory:resolve(source),version:pkg.version,commit,sourceSha256});
const directory='.data/desktop-releases';await mkdir(directory,{recursive:true,mode:0o700});
// Preflight every destination before copying any package. Published versions are immutable.
for(const file of files){
  const target=`${directory}/${file.name}`;
  try{const info=await lstat(target);assert(info.isFile()&&await fileHash(target)===file.sha256,'Existing release differs. Increment version before publishing.');}catch(e){if(e.code!=='ENOENT')throw e;}
}
for(const file of files){
  try{await copyFile(resolve(source,file.name),`${directory}/${file.name}`,constants.COPYFILE_EXCL);}catch(e){if(e.code!=='EEXIST'||await fileHash(`${directory}/${file.name}`)!==file.sha256)throw e;}
}
const manifest={version:pkg.version,createdAt:new Date().toISOString(),sourceCommit:commit,files};
try{await copyFile(`${directory}/manifest.json`,`${directory}/manifest-before-${Date.now()}.json`,constants.COPYFILE_EXCL);}catch(e){if(e.code!=='ENOENT')throw e;}
await writeFile(`${directory}/manifest.json.next`,JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
await rename(`${directory}/manifest.json.next`,`${directory}/manifest.json`);console.log(JSON.stringify(manifest,null,2));
