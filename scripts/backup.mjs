import {DatabaseSync,backup} from 'node:sqlite';
import {mkdir,copyFile,writeFile,stat,chmod} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
async function sha256(path){const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');}

export async function createBackup(sourceDirectory,destinationDirectory){
  const source=resolve(sourceDirectory),destination=resolve(destinationDirectory);
  if(!(await stat(join(source,'lab-chat.sqlite'))).isFile())throw new Error('Source database is missing.');
  // A new, exclusive destination prevents overwriting a previous backup.
  await mkdir(destination,{mode:0o700});
  const live=new DatabaseSync(join(source,'lab-chat.sqlite'),{readOnly:true});
  try{await backup(live,join(destination,'lab-chat.sqlite'));}finally{live.close();}
  await chmod(join(destination,'lab-chat.sqlite'),0o600);
  const snapshot=new DatabaseSync(join(destination,'lab-chat.sqlite'),{readOnly:true});
  let files,counts;
  try{
    if(snapshot.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw new Error('Snapshot integrity check failed.');
    files=snapshot.prepare('SELECT storage_name,size FROM files ORDER BY storage_name').all();
    counts={users:snapshot.prepare('SELECT count(*) AS n FROM users').get().n,messages:snapshot.prepare('SELECT count(*) AS n FROM messages').get().n};
  }finally{snapshot.close();}
  await mkdir(join(destination,'uploads'),{mode:0o700});
  const manifest=[];
  for(const file of files){
    if(!/^[a-f0-9-]{36}$/.test(file.storage_name))throw new Error('Unexpected storage name in database.');
    const target=join(destination,'uploads',file.storage_name);
    await copyFile(join(source,'uploads',file.storage_name),target);await chmod(target,0o600);
    const size=(await stat(target)).size;
    if(size!==file.size)throw new Error('Attachment size mismatch.');
    manifest.push({name:file.storage_name,size,sha256:await sha256(target)});
  }
  const result={version:1,createdAt:new Date().toISOString(),...counts,files:manifest,databaseSha256:await sha256(join(destination,'lab-chat.sqlite'))};
  await writeFile(join(destination,'backup-manifest.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600,flag:'wx'});
  return {destination,users:counts.users,messages:counts.messages,files:files.length};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [, ,source,destination]=process.argv;
  if(!source||!destination){console.error('Usage: npm run backup -- <data-directory> <new-backup-directory>');process.exitCode=1;}
  else try{console.log(JSON.stringify(await createBackup(source,destination),null,2));}catch(error){console.error(error.message);process.exitCode=1;}
}
