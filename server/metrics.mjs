import {monitorEventLoopDelay} from 'node:perf_hooks';
const limits=[5,10,25,50,100,250,500,1000,5000];
export function createMetrics(){
  const routes=new Map(),loop=monitorEventLoopDelay({resolution:20});
  loop.enable();
  const middleware=(req,res,next)=>{
    const start=performance.now();
    res.once('finish',()=>{
      // Route templates, never raw paths, IDs, queries, bodies or user names.
      const key=`${req.method} ${req.route?.path??'unmatched'}`;
      if(!routes.has(key)&&routes.size>=128)return;
      const metric=routes.get(key)??{requests:0,errors:0,responseBodyBytes:0,totalMs:0,buckets:Array(limits.length+1).fill(0)};
      const ms=performance.now()-start,index=limits.findIndex(n=>ms<=n);
      metric.requests++;metric.errors+=res.statusCode>=400?1:0;metric.totalMs+=ms;
      metric.responseBodyBytes+=Number(res.getHeader('Content-Length'))||0;
      metric.buckets[index<0?limits.length:index]++;routes.set(key,metric);
    });next();
  };
  const snapshot=()=>({
    scope:'Process-local counters since startup; bytes are response Content-Length before any proxy compression. Streaming bodies are not counted.',
    uptimeSeconds:process.uptime(),memory:process.memoryUsage(),cpuMicroseconds:process.cpuUsage(),
    eventLoopMs:{mean:Number.isFinite(loop.mean)?loop.mean/1e6:null,p95:loop.percentile(95)/1e6,max:loop.max/1e6},
    latencyBucketUpperBoundsMs:[...limits,null],
    routes:[...routes].map(([route,m])=>({route,...m,meanMs:m.totalMs/m.requests})),
  });
  return {middleware,snapshot,close:()=>loop.disable()};
}
