import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { createCipheriv, createDecipheriv, randomBytes, hkdfSync } from 'node:crypto';

const supabase=createClient(process.env.SUPABASE_URL!,process.env.SUPABASE_SECRET_KEY!,{auth:{persistSession:false}});
const appUrl=process.env.APP_URL!;
const callbackUrl=`${appUrl}/api/github/callback`;
const key=()=>{const secret=process.env.GITHUB_TOKEN_ENCRYPTION_KEY;if(!secret||Buffer.byteLength(secret)<32)throw new Error('GITHUB_TOKEN_ENCRYPTION_KEY must be at least 32 bytes.');return Buffer.from(hkdfSync('sha256',Buffer.from(secret),Buffer.from('github-control-center'),Buffer.from('token-storage:v1'),32));};
function encrypt(token:string){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(),iv),data=Buffer.concat([cipher.update(token,'utf8'),cipher.final()]);return {iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')};}
function decrypt(x:any){const d=createDecipheriv('aes-256-gcm',key(),Buffer.from(x.iv,'base64'));d.setAuthTag(Buffer.from(x.tag,'base64'));return Buffer.concat([d.update(Buffer.from(x.data,'base64')),d.final()]).toString('utf8');}
async function owner(req:VercelRequest){const h=req.headers.authorization||'';const jwt=h.startsWith('Bearer ')?h.slice(7):'';if(!jwt)throw Object.assign(new Error('Sign in required.'),{status:401});const {data,error}=await supabase.auth.getUser(jwt);if(error||!data.user)throw Object.assign(new Error('Session is invalid.'),{status:401});return data.user.id;}
async function gh(token:string,path:string,method='GET',body?:unknown){const r=await fetch('https://api.github.com'+path,{method,headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'GitHub-Control-Center','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const data=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error((data as any).message||'GitHub API error'),{status:r.status});return {data,link:r.headers.get('link')||''};}
async function account(userId:string,id:string){const {data,error}=await supabase.from('github_accounts').select('*').eq('user_id',userId).eq('id',id).single();if(error||!data)throw Object.assign(new Error('GitHub account not found.'),{status:404});return data;}
export default async function handler(req:VercelRequest,res:VercelResponse){
 const route=String(req.query.route||'');const userId=route==='callback'?null:await owner(req).catch(e=>{res.status(e.status||401).json({error:e.message});return 'AUTH_FAILED'});
 if(userId==='AUTH_FAILED')return;
 try{
  if(route==='status'&&req.method==='GET')return res.json({configured:!!(process.env.GITHUB_CLIENT_ID&&process.env.GITHUB_CLIENT_SECRET),missing:['GITHUB_CLIENT_ID','GITHUB_CLIENT_SECRET'].filter(k=>!process.env[k])});
  if(route==='connect'&&req.method==='POST'){
   if(!process.env.GITHUB_CLIENT_ID||!process.env.GITHUB_CLIENT_SECRET)throw Object.assign(new Error('GitHub OAuth secrets are not configured in Vercel.'),{status:400});
   const state=randomBytes(32).toString('hex');const {error}=await supabase.from('github_oauth_states').insert({state,user_id:userId,expires_at:new Date(Date.now()+600000).toISOString()});if(error)throw error;
   const q=new URLSearchParams({client_id:process.env.GITHUB_CLIENT_ID,redirect_uri:callbackUrl,scope:'repo workflow read:user user:email',state});return res.json({authorizationUrl:`https://github.com/login/oauth/authorize?${q}`});
  }
  if(route==='callback'&&req.method==='GET'){
   const state=String(req.query.state||''),code=String(req.query.code||'');const {data:s}=await supabase.from('github_oauth_states').select('*').eq('state',state).maybeSingle();
   if(!s||new Date(s.expires_at).getTime()<Date.now())return res.redirect(`${appUrl}/?github=state_expired`);
   await supabase.from('github_oauth_states').delete().eq('state',state);
   if(!code||req.query.error)return res.redirect(`${appUrl}/?github=denied`);
   const tokenRes=await fetch('https://github.com/login/oauth/access_token',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify({client_id:process.env.GITHUB_CLIENT_ID,client_secret:process.env.GITHUB_CLIENT_SECRET,code,redirect_uri:callbackUrl})});
   const tokenData:any=await tokenRes.json();if(!tokenData.access_token)return res.redirect(`${appUrl}/?github=token_exchange_failed`);
   const profile=await gh(tokenData.access_token,'/user');const p:any=profile.data;
   const record={user_id:s.user_id,github_id:p.id,login:p.login,name:p.name,avatar_url:p.avatar_url,profile_url:p.html_url,account_type:p.type||'User',scopes:String(tokenData.scope||'').split(/[ ,]+/).filter(Boolean),encrypted_token:encrypt(tokenData.access_token),updated_at:new Date().toISOString()};
   const {error}=await supabase.from('github_accounts').upsert(record,{onConflict:'user_id,github_id'});if(error)return res.redirect(`${appUrl}/?github=save_failed`);
   return res.redirect(`${appUrl}/?github=connected`);
  }
  if(route==='accounts'&&req.method==='GET'){const {data,error}=await supabase.from('github_accounts').select('id,github_id,login,name,avatar_url,profile_url,account_type,scopes,connected_at').eq('user_id',userId).order('connected_at');if(error)throw error;return res.json({accounts:data||[]});}
  const accountId=String(req.query.accountId||req.query.id||'');
  if(route.startsWith('accounts/')&&req.method==='DELETE'){
   const id=route.split('/')[1];const a=await account(userId!,id);const token=decrypt(a.encrypted_token);
   const revoke=await fetch(`https://api.github.com/applications/${encodeURIComponent(process.env.GITHUB_CLIENT_ID!)}/token`,{method:'DELETE',headers:{Authorization:'Basic '+Buffer.from(`${process.env.GITHUB_CLIENT_ID}:${process.env.GITHUB_CLIENT_SECRET}`).toString('base64'),Accept:'application/vnd.github+json','Content-Type':'application/json'},body:JSON.stringify({access_token:token})});
   if(!revoke.ok&&revoke.status!==404)throw Object.assign(new Error('GitHub did not confirm token revocation; account remains connected.'),{status:502});
   const {error}=await supabase.from('github_accounts').delete().eq('id',id).eq('user_id',userId);if(error)throw error;return res.json({ok:true});
  }
  if(['repositories','branches','pulls','actions'].includes(route)){
   const a=await account(userId!,accountId);const token=decrypt(a.encrypted_token);
   if(route==='repositories'){const r=await gh(token,'/user/repos?visibility=all&affiliation=owner,collaborator,organization_member&sort=updated&per_page=100');return res.json({repositories:(r.data as any[]).map(x=>({id:x.id,name:x.name,full_name:x.full_name,description:x.description,private:x.private,html_url:x.html_url,language:x.language,stargazers_count:x.stargazers_count,updated_at:x.updated_at,default_branch:x.default_branch}))});}
   const full=String(req.query.repository||'');if(!/^[\w.-]+\/[\w.-]+$/.test(full))throw Object.assign(new Error('Valid owner/repository required.'),{status:400});const path=full.split('/').map(encodeURIComponent).join('/');
   if(route==='branches'){const r=await gh(token,`/repos/${path}/branches?per_page=100`);return res.json({branches:(r.data as any[]).map(b=>({name:b.name,protected:b.protected,commitSha:b.commit.sha}))});}
   if(route==='pulls'){const r=await gh(token,`/repos/${path}/pulls?state=open&per_page=50`);return res.json({pullRequests:(r.data as any[]).map(p=>({id:p.id,number:p.number,title:p.title,state:p.state,draft:p.draft,html_url:p.html_url,created_at:p.created_at,updated_at:p.updated_at,user:p.user?.login,base:p.base?.ref,head:p.head?.ref}))});}
   const r=await gh(token,`/repos/${path}/actions/runs?per_page=30`);return res.json({runs:(r.data as any).workflow_runs||[]});
  }
  return res.status(404).json({error:'API route not found.'});
 }catch(e:any){console.error('GitHub API error',e);return res.status(e.status||500).json({error:e.message||'Unexpected server error.'});}
}
