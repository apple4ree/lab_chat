import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeQuotaHistory,quotaHistoryQuery} from '../server/quota-history.mjs';

test('quota history preserves zero, masks failures and distinguishes gaps and reset/allowance changes',()=>{
  const since=1800000000,point=(offset,remaining,extra={})=>({at:since+offset,remaining,window:'weekly',resetsAt:since+86400,...extra});
  const raw={account:'a',period:10080,since,until:since+9000,intervalMinutes:15,startedAt:since,points:[
    point(0,100),point(900,90),point(1800,80,{error:'login_refresh_required',access_token:'secret'}),point(2700,70),
    point(3600,0),point(4500,100),point(5400,95,{resetsAt:since+2*86400}),point(8100,90),point(9000,NaN)]};
  const result=normalizeQuotaHistory(raw,{account:'a',since,now:raw.until*1000});
  assert.equal(result.points[0].used,0);assert.equal(result.points[4].remaining,0);assert.equal(result.points[4].used,100);
  assert.equal(result.points[2].remaining,null);assert.equal(result.points[2].issue,'로그인 갱신 필요');assert.equal(result.points[3].breakReason,'error');
  assert.equal(result.points[5].breakReason,'reset_or_change');assert.equal(result.points[6].breakReason,'reset_or_change');assert.equal(result.points[7].breakReason,'gap');
  assert.equal(result.points[8].remaining,null);assert.equal(JSON.stringify(result).includes('secret'),false);
  const capped=normalizeQuotaHistory({...raw,points:Array.from({length:11000},(_,i)=>point(i/2,50))},{account:'a',since,now:raw.until*1000});assert.equal(capped.limited,true);assert.equal(capped.points.length,11000);
  const unknown=normalizeQuotaHistory({...raw,points:[point(0,10,{error:'private raw error'})]},{account:'a',since,now:raw.until*1000});assert.equal(unknown.points[0].issue,'수집 실패');
  for(const patch of [{account:'wrong'},{period:300},{since:since-1},{until:Infinity},{points:Array(11001).fill(point(0,10))},{points:[point(-1,10)]},{points:[point(1,10),point(1,20)]}])assert.throws(()=>normalizeQuotaHistory({...raw,...patch},{account:'a',since,now:raw.until*1000}));
  for(const q of [{},{account:'a',days:30},{account:['a']},{account:'a',days:[1]},{account:'a',days:true}])assert.throws(()=>quotaHistoryQuery(q),{status:400});
  assert.deepEqual(quotaHistoryQuery({account:'a',days:'7'}),{account:'a',days:7});
});
