const {contextBridge,ipcRenderer}=require('electron');
// No arbitrary channel names, filesystem access, tokens, or Electron objects cross this boundary.
contextBridge.exposeInMainWorld('damiDesktop',Object.freeze({
  version:2,
  getUpdateState:()=>ipcRenderer.invoke('dami:update-state'),
  checkUpdates:()=>ipcRenderer.invoke('dami:check-updates'),
  onUpdateState:callback=>{
    if(typeof callback!=='function')return ()=>{};
    const listener=(_event,state)=>callback(state);
    ipcRenderer.on('dami:update-state',listener);return ()=>ipcRenderer.removeListener('dami:update-state',listener);
  },
  setState:state=>ipcRenderer.invoke('dami:state',state),
  isActive:()=>ipcRenderer.invoke('dami:active'),
  retry:()=>ipcRenderer.invoke('dami:retry'),
  changeWorkspace:()=>ipcRenderer.invoke('dami:change-workspace'),
  onNavigate:callback=>{
    if(typeof callback!=='function')return ()=>{};
    const listener=(_event,id)=>{if(typeof id==='string')callback(id);};
    ipcRenderer.on('dami:navigate',listener);return ()=>ipcRenderer.removeListener('dami:navigate',listener);
  },
  onActivity:callback=>{
    if(typeof callback!=='function')return ()=>{};
    const listener=(_event,active)=>callback(active===true);
    ipcRenderer.on('dami:activity',listener);return ()=>ipcRenderer.removeListener('dami:activity',listener);
  }
}));
