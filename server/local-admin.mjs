import {randomUUID} from 'node:crypto';
import {createUser,transaction} from './db.mjs';
import {hashPassword,verifyPassword} from './auth.mjs';

// Operator-only provisioning. No HTTP route or self-service role escalation.
export async function provisionLocalAdmin(db,{username,password}){
  if(typeof username!=='string'||!/^[a-z0-9][a-z0-9_-]{2,31}$/.test(username.toLowerCase()))throw new Error('Invalid login name');
  username=username.toLowerCase();
  if(typeof password!=='string'||password.length<8||password.length>256||!password.trim())throw new Error('Password must contain 8–256 characters');
  if(db.prepare("SELECT value FROM app_meta WHERE key='auth_mode'").get()?.value!=='local')throw new Error('Provisioning requires an existing local-account workspace');
  const existing=db.prepare('SELECT u.* FROM user_login_names n JOIN users u ON u.id=n.user_id WHERE n.login_name=?').get(username);
  if(existing){
    if(existing.role!=='admin'||existing.identity_provider!=='local'||!await verifyPassword(password,existing.password_hash))throw new Error('Login name already exists; no account was changed');
    return {id:existing.id,username,role:existing.role,created:false};
  }
  const passwordHash=await hashPassword(password);
  return transaction(db,()=>{
    // Reserved, non-deliverable internal identifier; it is not a verified email address.
    const user=createUser(db,{email:`${randomUUID()}@local.invalid`,name:username,passwordHash,role:'admin'});
    db.prepare('INSERT INTO user_login_names(login_name,user_id) VALUES (?,?)').run(username,user.id);
    db.prepare('INSERT INTO audit_log(actor_id,action,target_id) VALUES (NULL,?,?)').run('admin.provision',user.id);
    return {id:user.id,username,role:user.role,created:true};
  });
}
