import { useEffect, useMemo, useState } from 'react';
import JSZip from 'jszip';
import {
  Activity, BookOpen, Boxes, ChevronRight, ExternalLink, File, FilePlus2,
  Folder, File as FileIcon, GitBranch, GitPullRequest, Github, LayoutDashboard, LoaderCircle,
  LockKeyhole, LogOut, Menu, Plus, RefreshCw, ShieldCheck, Upload, Workflow, X, Zap
} from 'lucide-react';
import { supabase } from './supabase';

type Account = { id:string; login:string; name:string|null; avatar_url:string; profile_url:string; account_type:string; scopes:string[] };
type Repo = { id:number; name:string; full_name:string; description:string|null; private:boolean; html_url:string; language:string|null; stargazers_count:number; updated_at:string; default_branch:string; archived?:boolean };
type Entry = { name:string; path:string; type:'file'|'dir'; sha?:string; size?:number; download_url?:string };
const nav = [
  ['Overview',LayoutDashboard],['Accounts',Github],['Repositories',BookOpen],
  ['Branches',GitBranch],['File manager',Folder],['Pull requests',GitPullRequest],
  ['Actions',Workflow],['Activity',Activity]
] as const;

async function api(path:string, init:RequestInit={}) {
  const {data} = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Please sign in again.');
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type':'application/json', Authorization:`Bearer ${token}`, ...(init.headers||{}) }
  });
  const body = await res.json().catch(()=>({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}
const json = (method:string, body:unknown):RequestInit => ({ method, body:JSON.stringify(body) });

export default function App() {
  const [session,setSession] = useState<any>(null);
  const [boot,setBoot] = useState(true);
  const [email,setEmail] = useState('');
  const [password,setPassword] = useState('');
  const [authBusy,setAuthBusy] = useState(false);
  const [notice,setNotice] = useState('');
  const [section,setSection] = useState('Overview');
  const [accounts,setAccounts] = useState<Account[]>([]);
  const [repos,setRepos] = useState<Repo[]>([]);
  const [selected,setSelected] = useState('');
  const [repo,setRepo] = useState('');
  const [rows,setRows] = useState<any[]>([]);
  const [busy,setBusy] = useState(false);
  const [mobile,setMobile] = useState(false);
  const [modal,setModal] = useState<'connect'|'createRepo'|'editRepo'|'file'|null>(null);
  const [form,setForm] = useState({name:'',description:'',private:true,path:'',content:'',message:'Update via GitHub Control Center'});
  const [folder,setFolder] = useState('');
  const [branch,setBranch] = useState('main');
  const [fileEntries,setFileEntries] = useState<Entry[]>([]);
  const [currentFile,setCurrentFile] = useState('');
  const [zipBusy,setZipBusy] = useState(false);

  useEffect(()=>{
    supabase.auth.getSession().then(({data})=>{setSession(data.session);setBoot(false)});
    const {data:{subscription}}=supabase.auth.onAuthStateChange((_e,s)=>setSession(s));
    return ()=>subscription.unsubscribe();
  },[]);
  useEffect(()=>{ if(session) refresh(); },[session]);

  async function refresh() {
    setBusy(true);
    try {
      const d=await api('/api/github/accounts');
      setAccounts(d.accounts||[]);
      if(!selected && d.accounts?.[0]) setSelected(d.accounts[0].id);
    } catch(e:any) { setNotice(e.message); }
    finally { setBusy(false); }
  }
  async function signIn(e:React.FormEvent) {
    e.preventDefault(); setAuthBusy(true); setNotice('');
    try { const {error}=await supabase.auth.signInWithPassword({email,password}); if(error) throw error; }
    catch(e:any){setNotice(e.message)} finally{setAuthBusy(false)}
  }
  async function signUp() {
    setAuthBusy(true);
    try { const {error}=await supabase.auth.signUp({email,password}); if(error) throw error; setNotice('Check your email to confirm your account.'); }
    catch(e:any){setNotice(e.message)} finally{setAuthBusy(false)}
  }
  async function connect() {
    try { const d=await api('/api/github/connect',{method:'POST'}); location.assign(d.authorizationUrl); }
    catch(e:any){setNotice(e.message)}
  }
  async function disconnect(a:Account) {
    if(!confirm(`Disconnect @${a.login}? The GitHub token will be revoked.`)) return;
    try { await api(`/api/github/accounts/${a.id}`,{method:'DELETE'}); setAccounts(v=>v.filter(x=>x.id!==a.id)); setNotice(`@${a.login} disconnected.`); }
    catch(e:any){setNotice(e.message)}
  }
  async function loadRepos() {
    if(!selected) return;
    setBusy(true);
    try { const d=await api(`/api/github/repositories?accountId=${selected}`); setRepos(d.repositories||[]); setRows(d.repositories||[]); }
    catch(e:any){setNotice(e.message)} finally{setBusy(false)}
  }
  async function loadRows() {
    if(!selected) return;
    setBusy(true); setNotice('');
    try {
      if(section==='Repositories') { await loadRepos(); return; }
      if(section==='Branches'||section==='Pull requests'||section==='Actions') {
        if(!repo) throw new Error('Choose a repository first.');
        const endpoint=section==='Branches'?'branches':section==='Pull requests'?'pulls':'actions';
        const d=await api(`/api/github/${endpoint}?accountId=${selected}&repository=${encodeURIComponent(repo)}`);
        setRows(d.branches||d.pullRequests||d.runs||[]);
      }
      if(section==='File manager') await loadFiles();
    } catch(e:any){setNotice(e.message)} finally{setBusy(false)}
  }
  useEffect(()=>{ if(session && selected && ['Repositories','Branches','Pull requests','Actions','File manager'].includes(section)) loadRows(); },[section,selected,repo]);
  async function loadFiles(path='') {
    if(!selected||!repo) return;
    const d=await api(`/api/github/files?accountId=${selected}&repository=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}&ref=${encodeURIComponent(branch)}`);
    const list=Array.isArray(d.files)?d.files:[d.files];
    setFolder(path); setFileEntries(list.filter(Boolean).map((x:any)=>({name:x.name,path:x.path,type:x.type==='dir'?'dir':'file',sha:x.sha,size:x.size,download_url:x.download_url})));
  }
  async function openFile(path:string) {
    try {
      const d=await api(`/api/github/file?accountId=${selected}&repository=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}&ref=${encodeURIComponent(branch)}`);
      const raw=d.file?.content||'';
      const content=d.file?.encoding==='base64'?decodeURIComponent(escape(atob(raw.replace(/\n/g,'')))):raw;
      setCurrentFile(path); setForm(v=>({...v,path,content,message:`Update ${path}`})); setModal('file');
    } catch(e:any){setNotice(e.message)}
  }
  async function saveFile() {
    try {
      await api(`/api/github/files?accountId=${selected}&repository=${encodeURIComponent(repo)}`,json('POST',{
        branch, message:form.message, files:[{path:form.path,content:form.content}]
      }));
      setModal(null); setNotice('File committed successfully.'); await loadFiles(folder);
    } catch(e:any){setNotice(e.message)}
  }
  async function uploadZip(file?:File) {
    if(!file||!selected||!repo) return;
    setZipBusy(true); setNotice('');
    try {
      const zip=await JSZip.loadAsync(file);
      const all=Object.values(zip.files).filter(f=>!f.dir);
      const paths=all.map(f=>f.name.replace(/^\/+/, ''));
      const firstParts=paths.map(p=>p.split('/')[0]).filter(Boolean);
      const stripRoot=paths.length>0 && firstParts.every(p=>p===firstParts[0]) && paths.every(p=>p.includes('/'));
      const filesToCommit:{path:string;content:string}[]=[];
      for(const entry of all) {
        let path=entry.name.replace(/^\/+/, '');
        if(stripRoot) path=path.slice(firstParts[0].length+1);
        if(!path) continue;
        const content=await entry.async('base64');
        filesToCommit.push({path,content:`__B64__${content}`});
      }
      // Decode in browser to UTF-8 for text-oriented repository files.
      const decoded=[];
      for(const f of filesToCommit) {
        const b64=f.content.slice(7);
        const bytes=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));
        const textContent=new TextDecoder('utf-8',{fatal:false}).decode(bytes);
        if(textContent.includes('\u0000')) throw new Error(`Binary file not supported in this ZIP upload: ${f.path}. Upload text/source files only in this version.`);
        decoded.push({path:f.path,content:textContent});
      }
      const batchSize=30;
      for(let i=0;i<decoded.length;i+=batchSize) {
        await api(`/api/github/files?accountId=${selected}&repository=${encodeURIComponent(repo)}`,json('POST',{
          branch,message:`Upload ZIP: ${file.name} (${Math.floor(i/batchSize)+1}/${Math.ceil(decoded.length/batchSize)})`,files:decoded.slice(i,i+batchSize)
        }));
      }
      setNotice(`${decoded.length} files uploaded. ${stripRoot?'The single outer folder was removed.':'Folder structure was preserved.'}`);
      await loadFiles(folder);
    } catch(e:any){setNotice(e.message)}
    finally{setZipBusy(false)}
  }
  async function createRepo() {
    try {
      const d=await api(`/api/github/repository?accountId=${selected}`,json('POST',form));
      setModal(null); setNotice(`Repository ${d.repository?.full_name||form.name} created.`); await loadRepos();
    } catch(e:any){setNotice(e.message)}
  }
  async function editRepo() {
    try {
      await api(`/api/github/repository?accountId=${selected}&repository=${encodeURIComponent(repo)}`,json('PATCH',{
        name:form.name||undefined,description:form.description,private:form.private
      }));
      setModal(null); setNotice('Repository settings updated.'); await loadRepos();
    } catch(e:any){setNotice(e.message)}
  }
  const active=accounts.find(a=>a.id===selected);
  const initials=useMemo(()=>session?.user?.email?.slice(0,1).toUpperCase()||'U',[session]);
  if(boot) return <div className="boot"><Github size={32}/><span>INITIALIZING CONTROL PLANE</span></div>;
  if(!session) return <main className="login"><div className="login-card">
    <Brand/><div className="eyebrow">● PRIVATE WORKSPACE</div><h1>One console.<br/><em>Every account.</em></h1>
    <p>Manage your GitHub identities, repositories, files and automation from one workspace.</p>
    <form onSubmit={signIn}><input type="email" placeholder="Email address" value={email} onChange={e=>setEmail(e.target.value)} required/><input type="password" placeholder="Password" value={password} onChange={e=>setPassword(e.target.value)} required minLength={6}/><button className="primary" disabled={authBusy}><LockKeyhole size={17}/>{authBusy?'Please wait…':'Sign in to your workspace'}</button></form>
    <button className="signup" onClick={signUp} disabled={authBusy}>Create workspace account</button>{notice&&<div className="notice">{notice}</div>}<footer><ShieldCheck size={14}/> Protected workspace · Private by default</footer>
  </div></main>;

  return <div className="shell">
    <aside className={`sidebar ${mobile?'open':''}`}>
      <Brand/><div className="workspace"><b>CC</b><div><strong>Personal workspace</strong><small>Owner access</small></div></div>
      <label>WORKSPACE</label><nav>{nav.map(([name,Icon])=><button key={name} className={section===name?'selected':''} onClick={()=>{setSection(name);setMobile(false)}}><Icon size={17}/>{name}</button>)}</nav>
      <label className="identity-label">CONNECTED IDENTITIES <button onClick={()=>setModal('connect')}><Plus size={14}/></button></label>
      <div className="identities">{accounts.map(a=><button key={a.id} onClick={()=>{setSelected(a.id);setSection('Accounts')}}><img src={a.avatar_url}/>@{a.login}<i/></button>)}{!accounts.length&&<small>No GitHub accounts connected yet.</small>}</div>
      <div className="side-bottom"><div className="security"><ShieldCheck/><div><b>Security first</b><small>Tokens stay server-side.</small></div></div>
        <div className="profile"><span>{initials}</span><div><b>{session.user.email}</b><small>Workspace owner</small></div><button onClick={()=>supabase.auth.signOut()}><LogOut size={16}/></button></div>
      </div>
    </aside>
    <main className="main">
      <header><button className="hamb" onClick={()=>setMobile(true)}><Menu/></button><span>Workspace / <b>{section}</b></span><div className="right"><i/> PRIVATE MODE <button onClick={refresh}><RefreshCw size={15}/></button></div></header>
      <div className="content">
        <div className="heading"><div><div className="eyebrow">— CONTROL CENTER / 01</div><h1>{section==='Overview'?'Your GitHub universe.':section+'.'}</h1><p>All your identities, repositories and developer activity — in one place.</p></div>
          <div className="actions"><button className="secondary" onClick={refresh}><RefreshCw size={15}/> Refresh</button><button className="primary" onClick={()=>setModal('connect')}><Plus size={16}/> Connect account</button></div>
        </div>
        {notice&&<div className="notice">{notice}<button onClick={()=>setNotice('')}><X size={14}/></button></div>}
        {section==='Overview'&&<><section className="hero"><div className="hero-copy"><div className="eyebrow"><Zap size={13}/> YOUR DEVELOPER COMMAND CENTER</div><h2>Many accounts.<br/><em>One source of control.</em></h2><p>Switch GitHub identities, manage repositories and edit project files without juggling browser sessions.</p><button className="secondary" onClick={()=>setModal('connect')}>Add an identity →</button></div><div className="hero-orbit"><Github size={60}/></div></section>
          <div className="metrics"><article><small>CONNECTED ACCOUNTS</small><strong>{accounts.length}</strong><span>GitHub identities linked</span></article><article><small>REPOSITORIES</small><strong>{repos.length||'—'}</strong><span>Loaded for active account</span></article><article><small>ACTIVE IDENTITY</small><strong className="metric-name">{active?`@${active.login}`:'—'}</strong><span>Selected GitHub account</span></article><article><small>MANAGEMENT MODULES</small><strong>05</strong><span>Repository, branch, files, PR, Actions</span></article></div>
          <section className="panel"><PanelHead title="Connected accounts" eyebrow="IDENTITY MANAGEMENT"/>{accounts.length?accounts.map(a=><div className="account" key={a.id}><img src={a.avatar_url}/><div><b>{a.name||a.login}</b><small>@{a.login} · {a.account_type}</small></div><a href={a.profile_url} target="_blank" rel="noreferrer">Profile <ExternalLink size={13}/></a><button className="danger" onClick={()=>disconnect(a)}>Disconnect</button></div>):<Empty text="Connect a GitHub identity to begin."/>}</section></>}
        {section==='Accounts'&&<section className="panel"><PanelHead title="Connected identities" eyebrow="ACCOUNT SWITCHER"/>{accounts.map(a=><div className="account" key={a.id}><img src={a.avatar_url}/><div><b>@{a.login}</b><small>{a.scopes?.join(', ')}</small></div><button className="secondary" onClick={()=>{setSelected(a.id);setSection('Repositories')}}>Use account</button><button className="danger" onClick={()=>disconnect(a)}>Disconnect</button></div>)}</section>}
        {section!=='Overview'&&section!=='Accounts'&&<section className="panel">
          <div className="panel-head"><div><small>LIVE GITHUB DATA</small><h3>{section}</h3></div><div className="tools">
            <select value={selected} onChange={e=>setSelected(e.target.value)}><option value="">Choose account</option>{accounts.map(a=><option key={a.id} value={a.id}>@{a.login}</option>)}</select>
            {['Branches','File manager','Pull requests','Actions'].includes(section)&&<select value={repo} onChange={e=>setRepo(e.target.value)}><option value="">Choose repository</option>{repos.map(r=><option key={r.id} value={r.full_name}>{r.full_name}</option>)}</select>}
            {section==='Repositories'&&<button className="primary" onClick={()=>{setForm({name:'',description:'',private:true,path:'',content:'',message:'Initial commit'});setModal('createRepo')}}><Plus size={14}/> New repository</button>}
            <button className="secondary" onClick={loadRows}><RefreshCw size={14}/> Reload</button>
          </div></div>
          {busy?<Empty text="Loading GitHub data…"/>:
          section==='Repositories'?<>{rows.map((r:Repo)=><div className="data-row" key={r.id}><div><b>{r.full_name}</b><small>{r.description||'No description'} · {r.private?'Private':'Public'} · {r.language||'No language'} {r.archived?'· Archived':''}</small></div><button className="secondary" onClick={()=>{setRepo(r.full_name);setForm({name:r.name,description:r.description||'',private:r.private,path:'',content:'',message:'Update repository'});setModal('editRepo')}}>Edit</button><a href={r.html_url} target="_blank" rel="noreferrer">Open <ExternalLink size={12}/></a></div>)}{!rows.length&&<Empty text="No repositories found for this account."/>}</>:
          section==='File manager'?<div className="file-manager">
            <div className="file-toolbar"><div className="crumb" onClick={()=>loadFiles('')}>ROOT</div>{folder&&<><ChevronRight size={13}/><span>{folder}</span></>}<span className="grow"/><label className="upload-btn"><Upload size={14}/>{zipBusy?'Uploading…':'Upload ZIP'}<input type="file" accept=".zip,application/zip" disabled={zipBusy||!repo} onChange={e=>uploadZip(e.target.files?.[0])}/></label><button className="primary" onClick={()=>{setForm({name:'',description:'',private:true,path:folder?folder+'/':'',content:'',message:'Add file'});setModal('file')}}><FilePlus2 size={14}/> New file</button></div>
            {fileEntries.map(f=><button className="file-entry" key={f.path} onClick={()=>f.type==='dir'?loadFiles(f.path):openFile(f.path)}>{f.type==='dir'?<Folder size={16}/>:<FileIcon size={16}/>}<span>{f.name}</span><small>{f.type==='dir'?'Folder':`${Math.max(1,Math.round((f.size||0)/1024))} KB`}</small><ChevronRight size={13}/></button>)}
            {!fileEntries.length&&<Empty text="This folder is empty, or select a repository to browse its files."/>}
          </div>:
          section==='Branches'?<>{rows.map((r:any)=><div className="data-row" key={r.name}><div><b>{r.name}</b><small>{r.protected?'Protected':'Unprotected'} · {r.commitSha?.slice(0,10)}</small></div></div>)}{!rows.length&&<Empty text="Choose a repository to view branches."/>}</>:
          <>{rows.map((r:any)=><div className="data-row" key={r.id||r.name}><div><b>{r.title||r.name||r.display_title||r.name_with_owner}</b><small>{r.state||r.status||r.conclusion||r.language||''}</small></div>{(r.html_url||r.html_url) && <a href={r.html_url} target="_blank" rel="noreferrer">Open <ExternalLink size={12}/></a>}</div>)}{!rows.length&&<Empty text="Choose a repository and reload to view data."/>}</>}
        </section>}
        <footer className="page-foot">GITHUB CONTROL CENTER <span>SUPABASE AUTH · VERCEL FUNCTIONS · ENCRYPTED TOKENS</span></footer>
      </div>
    </main>
    {modal&&<div className="backdrop" onClick={()=>setModal(null)}><section className="modal" onClick={e=>e.stopPropagation()}><button className="close" onClick={()=>setModal(null)}><X/></button>
      {modal==='connect'?<><div className="modal-icon"><Github/></div><div className="eyebrow">GITHUB INTEGRATION</div><h2>Connect an identity.</h2><p>Authorize GitHub to access repositories, branches, pull requests and Actions. Tokens remain encrypted server-side.</p><div className="permission"><ShieldCheck/><div><b>Permission transparency</b><small>Permissions are controlled by your GitHub OAuth App.</small></div></div><button className="primary full" onClick={connect}><Github size={17}/> Continue with GitHub</button></>:
      modal==='createRepo'?<><div className="eyebrow">REPOSITORY MANAGER</div><h2>Create repository</h2><input placeholder="Repository name" value={form.name} onChange={e=>setForm(v=>({...v,name:e.target.value}))}/><textarea placeholder="Description" value={form.description} onChange={e=>setForm(v=>({...v,description:e.target.value}))}/><label className="check"><input type="checkbox" checked={form.private} onChange={e=>setForm(v=>({...v,private:e.target.checked}))}/> Private repository</label><button className="primary full" onClick={createRepo} disabled={!form.name.trim()}>Create repository</button></>:
      modal==='editRepo'?<><div className="eyebrow">REPOSITORY SETTINGS</div><h2>Edit repository</h2><input placeholder="Repository name" value={form.name} onChange={e=>setForm(v=>({...v,name:e.target.value}))}/><textarea placeholder="Description" value={form.description} onChange={e=>setForm(v=>({...v,description:e.target.value}))}/><label className="check"><input type="checkbox" checked={form.private} onChange={e=>setForm(v=>({...v,private:e.target.checked}))}/> Private repository</label><button className="primary full" onClick={editRepo}>Save repository settings</button></>:
      <><div className="eyebrow">FILE EDITOR · {branch}</div><h2>{currentFile?'Edit file':'Create file'}</h2><input placeholder="Path e.g. src/App.tsx" value={form.path} onChange={e=>setForm(v=>({...v,path:e.target.value}))}/><textarea className="code-input" placeholder="File content" value={form.content} onChange={e=>setForm(v=>({...v,content:e.target.value}))}/><input placeholder="Commit message" value={form.message} onChange={e=>setForm(v=>({...v,message:e.target.value}))}/><button className="primary full" onClick={saveFile} disabled={!form.path.trim()}>Commit file</button></>}
    </section></div>}
  </div>;
}
function Brand(){return <div className="brand"><span className="brand-icon"><Github/></span><div><b>GITHUB<span>CONTROL</span></b><small>MULTI-ACCOUNT CONSOLE</small></div><button className="mobile-x"><X/></button></div>}
function PanelHead({title,eyebrow}:{title:string;eyebrow:string}){return <div className="panel-head"><div><small>{eyebrow}</small><h3>{title}</h3></div></div>}
function Empty({text}:{text:string}){return <div className="empty"><Boxes size={27}/><p>{text}</p></div>}
