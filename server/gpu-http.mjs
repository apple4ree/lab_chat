// A single bounded transport for the configured collector. Paths are chosen by server code only.
export function gpuClient(baseUrl) {
  const base=new URL(baseUrl);
  if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.search||base.hash)throw new Error('Invalid LAB_GPU_URL');
  return async function read(path,params={},signal) {
    const url=new URL(path,base);
    for(const [key,value] of Object.entries(params))url.searchParams.set(key,String(value));
    const response=await fetch(url,{signal,redirect:'error',headers:{Accept:'application/json'}});
    if(!response.ok)throw new Error('GPU source unavailable');
    let length=0;const chunks=[];
    if(!response.body)throw new Error('Empty GPU response');
    for await(const chunk of response.body){length+=chunk.byteLength;if(length>2*1024*1024)throw new Error('GPU response too large');chunks.push(chunk);}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };
}
