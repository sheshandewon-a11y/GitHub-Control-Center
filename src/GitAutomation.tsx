import { useEffect, useState } from 'react';
import { GitBranch, GitCommit, GitCompare, Play, RefreshCw, Save, Workflow, XCircle } from 'lucide-react';

type RequestFn = (path: string, init?: RequestInit) => Promise<any>;
type Props = {
  section: 'Git Manager' | 'Automation Center';
  accountId: string;
  repository: string;
  branch: string;
  request: RequestFn;
  onBranchChange: (branch: string) => void;
  onNotice: (message: string) => void;
};

const send = (method: string, body: unknown): RequestInit => ({
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});
const esc = (v: string) => encodeURIComponent(v);

export default function GitAutomation({ section, accountId, repository, branch, request, onBranchChange, onNotice }: Props) {
  const [branches, setBranches] = useState<any[]>([]);
  const [commits, setCommits] = useState<any[]>([]);
  const [workflows, setWorkflows] = useState<any[]>([]);
  const [runs, setRuns] = useState<any[]>([]);
  const [from, setFrom] = useState('main');
  const [newName, setNewName] = useState('');
  const [base, setBase] = useState('main');
  const [head, setHead] = useState('');
  const [compare, setCompare] = useState<any>(null);
  const [workflowId, setWorkflowId] = useState('');
  const [workflowPath, setWorkflowPath] = useState('');
  const [workflowYaml, setWorkflowYaml] = useState('');
  const [cron, setCron] = useState('0 */6 * * *');
  const [loading, setLoading] = useState(false);

  const query = `?accountId=${esc(accountId)}&repository=${esc(repository)}`;
  const endpoint = (name: string) => `/api/github/advanced/${name}${query}`;

  async function load() {
    if (!accountId || !repository) return;
    setLoading(true);
    try {
      if (section === 'Git Manager') {
        const [b, c] = await Promise.all([
          request(endpoint('git/branches')),
          request(endpoint(`git/commits?sha=${esc(branch)}`))
        ]);
        setBranches(b.branches || []);
        setCommits(c.commits || []);
        if (!base && b.branches?.[0]) setBase(b.branches[0].name);
        if (!head && b.branches?.[0]) setHead(b.branches[0].name);
      } else {
        const [w, a] = await Promise.all([
          request(endpoint('automation/workflows')),
          request(`/api/github/actions?accountId=${esc(accountId)}&repository=${esc(repository)}`)
        ]);
        setWorkflows(w.workflows || []);
        setRuns(a.runs || []);
      }
    } catch (e: any) { onNotice(e.message || 'Could not load GitHub data.'); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, [section, accountId, repository, branch]);

  async function createBranch() {
    try {
      await request(endpoint('git/branches'), send('POST', { name: newName, from: from || branch }));
      setNewName(''); onNotice(`Branch ${newName} created.`); await load();
    } catch (e: any) { onNotice(e.message); }
  }
  async function renameBranch(oldName: string) {
    const next = window.prompt(`Rename branch "${oldName}" to:`, oldName);
    if (!next || next === oldName) return;
    if (!window.confirm(`Rename ${oldName} to ${next}? GitHub branch rename is performed as create + delete.`)) return;
    try {
      await request(endpoint('git/branches'), send('PATCH', { oldName, newName: next }));
      if (branch === oldName) onBranchChange(next);
      onNotice(`Branch renamed to ${next}.`); await load();
    } catch (e: any) { onNotice(e.message); }
  }
  async function deleteBranch(name: string) {
    if (!window.confirm(`Delete branch "${name}"? This cannot be undone from this console.`)) return;
    try {
      await request(endpoint(`git/branches?name=${esc(name)}`), { method: 'DELETE' });
      if (branch === name) onBranchChange('main');
      onNotice(`Branch ${name} deleted.`); await load();
    } catch (e: any) { onNotice(e.message); }
  }
  async function compareBranches() {
    try {
      const d = await request(endpoint(`git/compare?base=${esc(base)}&head=${esc(head)}`));
      setCompare(d.comparison);
    } catch (e: any) { onNotice(e.message); }
  }
  async function mergeBranches() {
    if (!window.confirm(`Merge ${head} into ${base}?`)) return;
    try {
      const d = await request(endpoint('git/merge'), send('POST', { base, head }));
      onNotice(`Merge commit created: ${String(d.sha || '').slice(0, 10)}`); setCompare(null); await load();
    } catch (e: any) { onNotice(e.message); }
  }
  async function workflowAction(id: string, action: string) {
    try {
      await request(endpoint(`automation/workflows/${esc(id)}/${action}`), { method: 'POST' });
      onNotice(`Workflow ${action} request completed.`); await load();
    } catch (e: any) { onNotice(e.message); }
  }
  async function runAction(id: string, action: string) {
    try {
      await request(endpoint(`automation/runs/${esc(id)}/${action}`), { method: 'POST' });
      onNotice(`Workflow run ${action} request sent.`); await load();
    } catch (e: any) { onNotice(e.message); }
  }
  async function dispatch() {
    if (!workflowId) return;
    try {
      await request(endpoint('automation/dispatch'), send('POST', { workflowId, ref: branch }));
      onNotice('Workflow dispatch request sent.'); await load();
    } catch (e: any) { onNotice(e.message); }
  }
  async function openWorkflow(path: string) {
    try {
      const d = await request(`/api/github/advanced/automation/workflow-file${query}&path=${esc(path)}&ref=${esc(branch)}`);
      const raw = d.file?.content || '';
      setWorkflowPath(path);
      setWorkflowYaml(d.file?.encoding === 'base64'
        ? new TextDecoder().decode(Uint8Array.from(atob(raw.replace(/\n/g, '')), c => c.charCodeAt(0)))
        : raw);
    } catch (e: any) { onNotice(e.message); }
  }
  function withSchedule(yaml: string, expression: string) {
    const lines = yaml.replace(/\r\n/g, '\n').split('\n');
    const onIndex = lines.findIndex(line => /^on\s*:\s*(#.*)?$/.test(line));
    if (onIndex < 0) return `on:\n  schedule:\n    - cron: '${expression}'\n  workflow_dispatch:\n${yaml}`;
    let end = onIndex + 1;
    while (end < lines.length && (lines[end].trim() === '' || /^\s/.test(lines[end]))) end++;
    const block = lines.slice(onIndex + 1, end);
    const kept: string[] = [];
    for (let i = 0; i < block.length; i++) {
      if (/^  schedule\s*:/.test(block[i])) {
        i++;
        while (i < block.length && (/^    /.test(block[i]) || lines[onIndex + 1 + i]?.trim() === '')) i++;
        i--;
      } else kept.push(block[i]);
    }
    if (!kept.some(line => /^  workflow_dispatch\s*:/.test(line))) kept.push('  workflow_dispatch:');
    kept.push('  schedule:', `    - cron: '${expression}'`);
    return [...lines.slice(0, onIndex + 1), ...kept, ...lines.slice(end)].join('\n');
  }
  async function applySchedule() {
    if (!workflowPath || !workflowYaml) return;
    if (!/^[0-9*/, -]+$/.test(cron)) { onNotice('Enter a valid cron expression.'); return; }
    try {
      const updated = withSchedule(workflowYaml, cron);
      await request(`/api/github/advanced/automation/workflow-file${query}`, send('PUT', {
        path: workflowPath, branch, content: updated,
        message: `Set workflow schedule: ${cron}`
      }));
      setWorkflowYaml(updated); onNotice(`Schedule saved: ${cron}`);
    } catch (e: any) { onNotice(e.message); }
  }

  if (!accountId || !repository) return <section className="panel"><div className="empty"><GitBranch/><p>Select a GitHub account and repository to use {section}.</p></div></section>;

  return <section className="panel ga-panel">
    <div className="panel-head">
      <div><small>{section === 'Git Manager' ? 'BRANCHES · COMMITS · DIFFS · MERGE' : 'GITHUB ACTIONS · WORKFLOW CONTROL'}</small><h3>{section}</h3></div>
      <button className="secondary" onClick={load}><RefreshCw size={14}/> Refresh</button>
    </div>
    {loading && <div className="ga-loading">Loading GitHub data…</div>}
    {section === 'Git Manager' ? <>
      <div className="ga-section">
        <h4><GitBranch size={16}/> Branch management</h4>
        <div className="ga-create">
          <select value={from} onChange={e => setFrom(e.target.value)}>{branches.map(b => <option key={b.name} value={b.name}>{b.name}</option>)}</select>
          <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="New branch name"/>
          <button className="primary" onClick={createBranch} disabled={!newName.trim()}><GitBranch size={14}/> Create</button>
        </div>
        {branches.map(b => <div className="data-row" key={b.name}>
          <div><b>{b.name}</b><small>{b.protected ? 'Protected' : 'Unprotected'} · {b.commitSha?.slice(0, 10)}</small></div>
          <button className="secondary" onClick={() => onBranchChange(b.name)}>Checkout</button>
          {!b.protected && <><button className="secondary" onClick={() => renameBranch(b.name)}>Rename</button><button className="danger" onClick={() => deleteBranch(b.name)}>Delete</button></>}
        </div>)}
      </div>
      <div className="ga-section">
        <h4><GitCompare size={16}/> Compare and merge branches</h4>
        <div className="ga-create">
          <select value={base} onChange={e => setBase(e.target.value)}>{branches.map(b => <option key={b.name} value={b.name}>{b.name} (base)</option>)}</select>
          <select value={head} onChange={e => setHead(e.target.value)}>{branches.map(b => <option key={b.name} value={b.name}>{b.name} (compare)</option>)}</select>
          <button className="secondary" onClick={compareBranches}>Compare</button>
          <button className="primary" onClick={mergeBranches} disabled={!compare || compare.status === 'behind' || compare.status === 'identical'}>Merge</button>
        </div>
        {compare && <div className="ga-result"><b>{compare.status}</b> · {compare.ahead_by} ahead · {compare.behind_by} behind · {compare.total_commits} commits
          {(compare.files || []).map((f: any) => <div className="ga-file" key={f.filename}><b>{f.filename}</b><small>+{f.additions} / −{f.deletions}</small><pre>{f.patch || 'No text diff available.'}</pre></div>)}
        </div>}
      </div>
      <div className="ga-section">
        <h4><GitCommit size={16}/> Recent commits · {branch}</h4>
        {commits.map(c => <div className="data-row" key={c.sha}><div><b>{c.message?.split('\n')[0]}</b><small>{c.author} · {c.date ? new Date(c.date).toLocaleString() : ''} · {c.sha.slice(0, 8)}</small></div><a href={c.html_url} target="_blank" rel="noreferrer">View</a></div>)}
        {!commits.length && <p className="ga-muted">No commits found on this branch.</p>}
      </div>
    </> : <>
      <div className="ga-section">
        <h4><Workflow size={16}/> Workflow control</h4>
        <div className="ga-create">
          <select value={workflowId} onChange={e => setWorkflowId(e.target.value)}><option value="">Choose workflow to run</option>{workflows.map(w => <option key={w.id} value={w.id}>{w.name} · {w.state}</option>)}</select>
          <button className="primary" onClick={dispatch} disabled={!workflowId}><Play size={14}/> Run workflow</button>
        </div>
        {workflows.map(w => <div className="data-row" key={w.id}>
          <div><b>{w.name}</b><small>{w.path} · {w.state}</small></div>
          <button className="secondary" onClick={() => openWorkflow(w.path)}>Edit YAML / Schedule</button>
          <button className="secondary" onClick={() => workflowAction(String(w.id), w.state === 'disabled_manually' ? 'enable' : 'disable')}>{w.state === 'disabled_manually' ? 'Enable' : 'Disable'}</button>
        </div>)}
        {!workflows.length && <p className="ga-muted">No workflow files found in this repository.</p>}
      </div>
      {workflowPath && <div className="ga-section">
        <h4>Workflow YAML · {workflowPath}</h4>
        <textarea className="ga-yaml" value={workflowYaml} onChange={e => setWorkflowYaml(e.target.value)} spellCheck={false}/>
        <div className="ga-create">
          <select value={cron} onChange={e => setCron(e.target.value)}>
            <option value="0 */6 * * *">Every 6 hours</option>
            <option value="0 0 * * *">Daily at 00:00 UTC</option>
            <option value="0 0 * * 1">Weekly on Monday</option>
            <option value="*/15 * * * *">Every 15 minutes</option>
          </select>
          <button className="secondary" onClick={applySchedule}>Apply schedule</button>
          <button className="primary" onClick={async () => {
            try {
              await request(`/api/github/advanced/automation/workflow-file${query}`, send('PUT', {
                path: workflowPath, branch, content: workflowYaml, message: `Update ${workflowPath}`
              }));
              onNotice('Workflow YAML committed.'); await load();
            } catch (e: any) { onNotice(e.message); }
          }}><Save size={14}/> Save YAML</button>
        </div>
        <p className="ga-muted">Schedules use UTC. GitHub requires scheduled workflows to exist on the repository's default branch. Review the YAML before saving.</p>
      </div>}
      <div className="ga-section">
        <h4><ActivityIcon/> Recent workflow runs</h4>
        {runs.map(r => <div className="data-row" key={r.id}>
          <div><b>{r.name || r.display_title}</b><small>{r.status} · {r.conclusion || 'in progress'} · #{r.run_number}</small></div>
          {r.status === 'in_progress' ? <button className="danger" onClick={() => runAction(String(r.id), 'cancel')}><XCircle size={13}/> Cancel</button> : <button className="secondary" onClick={() => runAction(String(r.id), 'rerun')}><RefreshCw size={13}/> Rerun</button>}
          {r.html_url && <a href={r.html_url} target="_blank" rel="noreferrer">Logs</a>}
        </div>)}
        {!runs.length && <p className="ga-muted">No workflow runs found.</p>}
      </div>
    </>}
  </section>;
}

function ActivityIcon() { return <RefreshCw size={16}/>; }
