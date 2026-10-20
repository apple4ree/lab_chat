import { randomBytes, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt=promisify(scryptCallback);
export const hashToken = value => createHash('sha256').update(value).digest('hex');
export const token = () => randomBytes(32).toString('base64url');
export async function hashPassword(password) {
  const salt=randomBytes(16).toString('hex');
  const derived=await scrypt(password,salt,64);
  return `scrypt:${salt}:${derived.toString('hex')}`;
}
export async function verifyPassword(password,hash) {
  const [,salt,key]=(hash||'').split(':');
  // Keep the expensive work for unknown accounts too.
  const actual=await scrypt(password,salt||'00000000000000000000000000000000',64);
  const expected=Buffer.from(key||'00'.repeat(64),'hex');
  return actual.length===expected.length && timingSafeEqual(actual,expected) && Boolean(hash);
}
export function getSession(db,req) {
  const cookie=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('lab_session='));
  const value=cookie?.slice('lab_session='.length);
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  return db.prepare("SELECT u.*,s.token_hash AS session_hash FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.identity_provider!='system'").get(hashToken(value),Date.now())||null;
}
export function startSession(db,res,user,secure) {
  const value=token();
  db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
  db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hashToken(value),user.id,Date.now()+7*86400000);
  res.cookie('lab_session',value,{httpOnly:true,sameSite:'strict',secure,path:'/',maxAge:7*86400000});
}
export function rateLimiter({limit=20,windowMs=900000}={}) {
  const buckets=new Map();
  return (req,res,next)=>{
    const now=Date.now();
    for (const [key,value] of buckets) if (value.reset<=now) buckets.delete(key);
    const key=req.user?.id||req.ip;
    const bucket=buckets.get(key)||{count:0,reset:now+windowMs};
    if (buckets.size>10000 && !buckets.has(key)) return res.status(429).json({error:'요청이 많습니다. 잠시 후 다시 시도해 주세요.'});
    buckets.set(key,bucket);
    if (++bucket.count>limit) return res.status(429).json({error:'시도 횟수가 많습니다. 15분 후 다시 시도해 주세요.'});
    next();
  };
}
