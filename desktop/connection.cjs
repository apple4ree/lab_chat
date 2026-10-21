const {migratedOrigin,uuid}=require('./policy.cjs');

async function readConnection(origin,fetcher){
  const response=await fetcher(`${origin}/api/workspace/connection`,{redirect:'error',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(7000)});
  if(!response.ok)throw new Error('Workspace unavailable');
  const chunks=[];let bytes=0;
  if(!response.body)throw new Error('Missing workspace response');
  for await(const chunk of response.body){bytes+=chunk.length;if(bytes>8192)throw new Error('Workspace response too large');chunks.push(Buffer.from(chunk));}
  const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(!uuid.test(data?.workspaceId)||!Number.isSafeInteger(data.revision)||data.revision<0)throw new Error('Invalid workspace identity');
  return data;
}

// Only the currently trusted HTTPS origin may announce the next origin.
// No renderer-supplied URL or auth/session cookie crosses this boundary.
async function discoverConnection(origin,saved={},fetcher=fetch){
  const source=await readConnection(origin,fetcher);
  if(saved.workspaceId&&source.workspaceId!==saved.workspaceId)throw new Error('Workspace identity changed');
  if(Number.isSafeInteger(saved.revision)&&source.revision<saved.revision)throw new Error('Stale workspace configuration');
  if(source.canonicalOrigin!==origin){
    const target=migratedOrigin(source.canonicalOrigin);
    const destination=await readConnection(target,fetcher);
    if(destination.workspaceId!==source.workspaceId||destination.revision!==source.revision||destination.canonicalOrigin!==target)throw new Error('Destination workspace does not match');
  }
  return {origin:source.canonicalOrigin,workspaceId:source.workspaceId,revision:source.revision};
}
function savedConnection(value){
  try{if(!uuid.test(value?.workspaceId)||!Number.isSafeInteger(value.revision)||value.revision<0)return null;return {origin:migratedOrigin(value.origin),workspaceId:value.workspaceId,revision:value.revision};}catch{return null;}
}
module.exports={discoverConnection,savedConnection};
