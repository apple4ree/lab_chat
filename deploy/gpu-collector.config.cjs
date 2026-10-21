// This host's existing raw collector feeds the loopback GPU service.
// Keep the registered label: reservations and history use host + GPU index.
const path=require('node:path');
const root=path.resolve(__dirname,'..');
module.exports={apps:[{
  name:'lab-chat-gpu-collector',cwd:'/home/dgu/gpu-dashboard',
  script:'collector.py',interpreter:'/opt/conda/bin/python3.12',
  args:['--transport','http','--central-url','http://127.0.0.1:8800','--hostname','pro_6000_dgu','--loop','30'],
  exec_mode:'fork',instances:1,autorestart:true,restart_delay:5000,kill_timeout:5000,
  max_memory_restart:'128M',time:true,env:{PYTHONUNBUFFERED:'1'},
  out_file:path.join(root,'.data/run/gpu-collector.log'),
  error_file:path.join(root,'.data/run/gpu-collector-error.log'),
}]};
