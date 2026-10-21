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
// Never advertise a native update until the corresponding immutable GitHub assets
// are public and match the installer evidence. This also keeps future publications
// from accidentally dropping the updater feed's release URL.
const repository='apple4ree/lab_chat',tag=`v${pkg.version}`;
const github=JSON.parse(execFileSync('gh',['api',`repos/${repository}/releases/tags/${tag}`],{encoding:'utf8'}));
const taggedCommit=JSON.parse(execFileSync('gh',['api',`repos/${repository}/commits/${tag}`],{encoding:'utf8'}));
assert.equal(taggedCommit.sha,commit,'Published tag differs from verified build');
assert.equal(github.draft,false,'Publish the GitHub release before advertising it');
assert.equal(github.tag_name,tag);
const releaseUrl=`https://github.com/${repository}/releases/tag/${tag}`;assert.equal(github.html_url,releaseUrl);
for(const file of files){
  const assets=github.assets.filter(a=>a.name===file.name);assert.equal(assets.length,1,'Missing or duplicate GitHub installer');
  assert.equal(assets[0].size,file.bytes);assert.equal(assets[0].digest,`sha256:${file.sha256}`,'GitHub installer checksum mismatch');
}
const directory='.data/desktop-releases';await mkdir(directory,{recursive:true,mode:0o700});
// Preflight every destination before copying any package. Published versions are immutable.
for(const file of files){
  const target=`${directory}/${file.name}`;
  try{const info=await lstat(target);assert(info.isFile()&&await fileHash(target)===file.sha256,'Existing release differs. Increment version before publishing.');}catch(e){if(e.code!=='ENOENT')throw e;}
}
for(const file of files){
  try{await copyFile(resolve(source,file.name),`${directory}/${file.name}`,constants.COPYFILE_EXCL|constants.COPYFILE_FICLONE);}catch(e){if(e.code!=='EEXIST'||await fileHash(`${directory}/${file.name}`)!==file.sha256)throw e;}
}
const manifest={version:pkg.version,createdAt:new Date().toISOString(),sourceCommit:commit,releaseUrl,files};
try{await copyFile(`${directory}/manifest.json`,`${directory}/manifest-before-${Date.now()}.json`,constants.COPYFILE_EXCL);}catch(e){if(e.code!=='ENOENT')throw e;}
await writeFile(`${directory}/manifest.json.next`,JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
await rename(`${directory}/manifest.json.next`,`${directory}/manifest.json`);console.log(JSON.stringify(manifest,null,2));
