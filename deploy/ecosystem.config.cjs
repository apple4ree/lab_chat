const path=require('node:path');
const root=path.resolve(__dirname,'..');
const common={cwd:root,exec_mode:'fork',instances:1,autorestart:true,restart_delay:1000,kill_timeout:12000,time:true};
module.exports={apps:[
  {...common,name:'lab-chat',script:'server/index.mjs',interpreter:'/home/dgu/.config/nvm/versions/node/v24.15.0/bin/node',node_args:[`--env-file=${root}/.data/deploy/local.env`],out_file:`${root}/.data/run/local.log`,error_file:`${root}/.data/run/local-error.log`},
  {...common,name:'lab-chat-demo',script:'server/index.mjs',interpreter:'/home/dgu/.config/nvm/versions/node/v24.15.0/bin/node',node_args:[`--env-file=${root}/.data/deploy/demo.env`],out_file:`${root}/.data/run/demo.log`,error_file:`${root}/.data/run/demo-error.log`},
  {...common,name:'lab-chat-tunnel',script:'/home/dgu/.local/bin/cloudflared',interpreter:'none',args:['tunnel','--config','/home/dgu/.cloudflared/lab-chat.yml','run','lab-chat'],out_file:`${root}/.data/run/tunnel.log`,error_file:`${root}/.data/run/tunnel-error.log`}
]};
