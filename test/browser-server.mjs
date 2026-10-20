import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createApp} from '../server/app.mjs';
import {demoGpuSource} from '../server/gpu.mjs';
const distDir=process.env.LAB_TEST_DIST_DIR?resolve(process.env.LAB_TEST_DIST_DIR):undefined;
const directory=mkdtempSync(join(tmpdir(),'lab-chat-browser-'));
const demo=createApp({distDir,dataDir:join(directory,'demo'),origin:'http://127.0.0.1:4311',mode:'demo',gpuSource:demoGpuSource});
const local=createApp({distDir,dataDir:join(directory,'local'),origin:'http://127.0.0.1:4312',setupToken:'browser-test-setup-code'});
const servers=[demo.app.listen(4311,'127.0.0.1'),local.app.listen(4312,'127.0.0.1')];
let closing=false;
function stop(){if(closing)return;closing=true;demo.close();local.close();for(const server of servers){server.closeAllConnections();server.close();}rmSync(directory,{recursive:true,force:true});}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
