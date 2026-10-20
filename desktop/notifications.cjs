// State is per signed-in user. Opening/reloading an app establishes a baseline, not a burst of old alerts.
function createTracker(){
  let userId=null,highWater=new Map();
  return {update(state,{focused=false,enabled=true}={}){
    const changed=state.userId!==userId;
    if(changed){highWater.clear();userId=state.userId;}
    const previous=highWater;highWater=new Map();const alerts=[];
    for(const c of state.channels){
      const old=previous.get(c.id);highWater.set(c.id,Math.max(old??0,c.latestMessageId));
      if(!changed&&old!==undefined&&c.latestMessageId>old&&c.unread>0&&enabled&&!(focused&&state.activeChannelId===c.id))alerts.push(c);
    }
    return {userChanged:changed,unread:state.channels.reduce((n,c)=>n+c.unread,0),alerts:alerts.slice(-3)};
  }};
}
module.exports={createTracker};
