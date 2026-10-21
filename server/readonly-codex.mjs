import {Codex} from '@openai/codex-sdk';
import {mkdirSync,existsSync,symlinkSync,realpathSync,lstatSync,readdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
export function createReadOnlyCodex({directory,authFile,codexPath,model,CodexClass=Codex,timeoutMs=90000,instructionsFile,instructions}){
  if(!directory||!authFile||!codexPath)return null;
  const root=resolve(directory),home=join(root,'codex'),work=join(root,'work');
  mkdirSync(home,{recursive:true,mode:0o700});mkdirSync(work,{recursive:true,mode:0o700});
  // The user explicitly selected this existing login. Do not copy unrelated config,
  // MCP servers, skills, environment variables or source/account-monitor credentials.
  const auth=join(home,'auth.json'),original=realpathSync(authFile);
  if(!existsSync(auth))symlinkSync(original,auth);
  else if(!lstatSync(auth).isSymbolicLink()||realpathSync(auth)!==original)throw new Error('Codex authentication path differs; configure it explicitly');
  const disabledSkills=[];
  for(const base of [join(process.env.HOME||'/home/dgu','.agents','skills'),join(home,'skills','.system')]){
    for(const name of existsSync(base)?readdirSync(base):[])if(existsSync(join(base,name,'SKILL.md')))disabledSkills.push({path:join(base,name,'SKILL.md'),enabled:false});
  }
  for(const name of ['imagegen','openai-docs','skill-creator','skill-installer'])disabledSkills.push({path:join(home,'skills','.system',name,'SKILL.md'),enabled:false});
  const env={PATH:process.env.PATH||'/usr/bin:/bin',HOME:process.env.HOME||'/home/dgu',CODEX_HOME:home,LANG:'C.UTF-8'};
  const codex=new CodexClass({codexPathOverride:codexPath,env,config:{
    features:{shell_tool:false,unified_exec:false,shell_snapshot:false,apps:false,browser_use:false,computer_use:false,multi_agent:false,multi_agent_v2:false,hooks:false,skill_search:false,skip_host_skill_discovery:true,cli_daybreak:false},
    model_instructions_file:instructionsFile,memories:{generate_memories:false,use_memories:false},skills:{config:disabledSkills},project_doc_max_bytes:0,model_reasoning_effort:'low',history:{persistence:'none'},
    developer_instructions:instructions
  }});
  return async(prompt,schema,signal)=>{
    const thread=codex.startThread({...(model?{model}:{}),workingDirectory:work,skipGitRepoCheck:true,sandboxMode:'read-only',approvalPolicy:'never',networkAccessEnabled:false,webSearchMode:'disabled'});
    const turn=await thread.run(prompt,{outputSchema:schema,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs)});
    if(turn.items.some(i=>['command_execution','mcp_tool_call','file_change','web_search'].includes(i.type)))throw new Error('Unexpected tool use in read-only analysis');
    return {value:JSON.parse(turn.finalResponse),usage:turn.usage?{inputTokens:turn.usage.input_tokens,outputTokens:turn.usage.output_tokens}:null};
  };
}
