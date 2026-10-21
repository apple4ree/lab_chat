const {test}=require('node:test');
const assert=require('node:assert/strict');
const {workspaceURL,sameOrigin,externalURL,parseState}=require('../policy.cjs');
const {createTracker}=require('../notifications.cjs');
const user='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',channel='33333333-3333-4333-8333-333333333333';
const state=(id,unread=1,userId=user)=>parseState({userId,activeChannelId:channel,channels:[{id:channel,unread,mentions:0,latestMessageId:id}]});
test('packaged bootstrap follows the bundled HTTPS config and ignores environment overrides',()=>{
  const config={workspaceUrl:'https://chat.damilab.cc'};
  assert.equal(workspaceURL(config,{developmentUrl:'http://evil.test'}),'https://chat.damilab.cc');
  assert.equal(workspaceURL({workspaceUrl:'https://new.example.org'}),'https://new.example.org');
  assert.equal(workspaceURL(config,{packaged:false,developmentUrl:'http://127.0.0.1:4311'}),'http://127.0.0.1:4311');
  for(const url of ['http://chat.damilab.cc','https://127.0.0.1','https://u:p@chat.damilab.cc','https://chat.damilab.cc/?token=x'])assert.throws(()=>workspaceURL({workspaceUrl:url}));
  assert.equal(sameOrigin('https://chat.damilab.cc/api/files/a','https://chat.damilab.cc'),true);
  assert.equal(sameOrigin('https://chat.damilab.cc@evil.test','https://chat.damilab.cc'),false);
});
test('external navigation and IPC state have bounded explicit contracts',()=>{
  for(const url of ['file:///etc/passwd','javascript:alert(1)','ms-settings:','data:text/html,x','https://u:p@example.test','https://example.test\n'])assert.equal(externalURL(url),null);
  assert.equal(externalURL('https://example.test/p'),'https://example.test/p');
  assert.throws(()=>parseState({userId:user,channels:[]}));
  assert.throws(()=>parseState({userId:null,channels:[{}]}));
  const s=state(10);assert.equal(s.channels[0].latestMessageId,10);
  assert.throws(()=>parseState({...s,channels:[s.channels[0],s.channels[0]]}));
  assert.throws(()=>parseState({...s,channels:[{...s.channels[0],unread:NaN}]}));
});
test('notification state suppresses old messages, own focused reads, reconnect duplicates and account crossover',()=>{
  const t=createTracker();assert.equal(t.update(state(10,5)).alerts.length,0);
  assert.equal(t.update(state(10,5)).alerts.length,0);
  assert.equal(t.update(state(11,6)).alerts.length,1);
  assert.equal(t.update(state(12,7),{focused:true}).alerts.length,0);
  assert.equal(t.update(state(13,8),{enabled:false}).alerts.length,0);
  assert.equal(t.update(state(13,8)).alerts.length,0);
  assert.equal(t.update(state(13,0)).unread,0);
  assert.equal(t.update(state(12,1)).alerts.length,0);
  assert.equal(t.update(state(20,3,other)).alerts.length,0);
  const signedOut=t.update(parseState({userId:null,channels:[]}));assert.equal(signedOut.unread,0);assert.equal(signedOut.userChanged,true);
  assert.equal(t.update(state(21,4)).alerts.length,0);
});
