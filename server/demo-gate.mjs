import {createHash,timingSafeEqual} from 'node:crypto';

export function createDemoGate(expectedHash){
  if(!/^[a-f0-9]{64}$/.test(expectedHash))throw new Error('Invalid demo gate configuration.');
  const expected=Buffer.from(expectedHash,'hex');
  return (req,res,next)=>{
    const header=req.get('authorization')||'';
    if(header.startsWith('Basic ')&&header.length<512){
      const supplied=Buffer.from(header.slice(6),'base64');
      const digest=createHash('sha256').update(supplied).digest();
      if(timingSafeEqual(digest,expected))return next();
    }
    res.set({'WWW-Authenticate':'Basic realm="Lab Chat Demo", charset="UTF-8"','Cache-Control':'no-store'});
    res.status(401).type('text/plain').send('Lab Chat demo access requires the shared access credentials.');
  };
}
