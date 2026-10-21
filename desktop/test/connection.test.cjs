const {test}=require('node:test');
const assert=require('node:assert/strict');
const {discoverConnection,savedConnection}=require('../connection.cjs');
const source='https://old.example.org',target='https://new.example.org',workspaceId='11111111-1111-4111-8111-111111111111';
const record={workspaceId,canonicalOrigin:target,revision:1};
test('desktop verifies the source and destination and retains the new address across restarts',async()=>{
  const calls=[];const fetcher=async(url,options)=>{calls.push(url);assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');return Response.json(record);};
  const result=await discoverConnection(source,{workspaceId,revision:0},fetcher);
  assert.deepEqual(calls,[source+'/api/workspace/connection',target+'/api/workspace/connection']);
  assert.deepEqual(savedConnection(result),{origin:target,workspaceId,revision:1});
  const restartCalls=[];await discoverConnection(result.origin,result,async url=>{restartCalls.push(url);return Response.json(record);});assert.deepEqual(restartCalls,[target+'/api/workspace/connection']);
});
test('desktop rejects a different workspace, stale config, malformed URLs and mismatched destinations',async()=>{
  await assert.rejects(discoverConnection(source,{workspaceId:'22222222-2222-4222-8222-222222222222'},async()=>Response.json(record)));
  await assert.rejects(discoverConnection(source,{revision:2},async()=>Response.json(record)));
  for(const canonicalOrigin of ['http://new.example.org','https://user:pass@new.example.org','https://new.example.org/path','https://127.0.0.1','file:///tmp/app'])await assert.rejects(discoverConnection(source,{},async()=>Response.json({...record,canonicalOrigin})));
  await assert.rejects(discoverConnection(source,{},async url=>Response.json(url.startsWith(source)?record:{...record,workspaceId:'22222222-2222-4222-8222-222222222222'})));
  await assert.rejects(discoverConnection(source,{},async()=>new Response('x'.repeat(8193))));
  assert.equal(savedConnection({origin:target,workspaceId,revision:-1}),null);
});
