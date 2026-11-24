import type { VercelRequest, VercelResponse } from '@vercel/node';

function httpError(message: string, status = 400) {
  return Object.assign(new Error(message), { status });
}

async function github(token: string, path: string, method = 'GET', body?: unknown) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'GitHub-Control-Center',
      'Content-Type': 'application/json'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data: any = await response.json().catch(() => ({}));
  if (!response.ok) throw httpError(data.message || `GitHub API returned ${response.status}`, response.status);
  return data;
}

function safePath(value: unknown) {
  const path = String(value || '');
  if (!path || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw httpError('A valid repository-relative path is required.');
  }
  return path.split('/').map(encodeURIComponent).join('/');
}

function safeBranch(value: unknown) {
  const name = String(value || '');
  if (!name || name.length > 240 || name.startsWith('-') || name.includes('..') || name.includes(' ')) {
    throw httpError('A valid branch name is required.');
  }
  return name;
}

export async function handleAdvanced(
  req: VercelRequest,
  res: VercelResponse,
  route: string,
  token: string,
  encodedRepoPath: string
) {
  const repo = encodedRepoPath;
  const body: any = req.body || {};

  // Git Manager: branch lifecycle
  if (route === 'git/branches' && req.method === 'GET') {
    const data = await github(token, `/repos/${repo}/branches?per_page=100`);
    return res.json({ branches: data.map((b: any) => ({
      name: b.name, protected: b.protected, commitSha: b.commit.sha
    })) });
  }
  if (route === 'git/branches' && req.method === 'POST') {
    const name = safeBranch(body.name);
    const from = safeBranch(body.from || 'main');
    const base = await github(token, `/repos/${repo}/git/ref/heads/${encodeURIComponent(from)}`);
    await github(token, `/repos/${repo}/git/refs`, 'POST', {
      ref: `refs/heads/${name}`, sha: base.object.sha
    });
    return res.status(201).json({ ok: true, branch: name, sha: base.object.sha });
  }
  if (route === 'git/branches' && req.method === 'PATCH') {
    const oldName = safeBranch(body.oldName);
    const newName = safeBranch(body.newName);
    if (oldName === newName) throw httpError('Choose a different branch name.');
    const current = await github(token, `/repos/${repo}/git/ref/heads/${encodeURIComponent(oldName)}`);
    await github(token, `/repos/${repo}/git/refs`, 'POST', {
      ref: `refs/heads/${newName}`, sha: current.object.sha
    });
    try {
      await github(token, `/repos/${repo}/git/refs/heads/${encodeURIComponent(oldName)}`, 'DELETE');
    } catch (error) {
      // If deletion fails, remove the new ref to avoid leaving a duplicate branch.
      try {
        await github(token, `/repos/${repo}/git/refs/heads/${encodeURIComponent(newName)}`, 'DELETE');
      } catch { /* keep the original GitHub error */ }
      throw error;
    }
    return res.json({ ok: true, oldName, newName });
  }
  if (route === 'git/branches' && req.method === 'DELETE') {
    const name = safeBranch(req.query.name || body.name);
    await github(token, `/repos/${repo}/git/refs/heads/${encodeURIComponent(name)}`, 'DELETE');
    return res.json({ ok: true, deleted: name });
  }

  // Git Manager: commits, commit detail/diff, compare and merge
  if (route === 'git/commits' && req.method === 'GET') {
    const sha = String(req.query.sha || '');
    const page = Math.max(1, Math.min(100, Number(req.query.page || 1)));
    const data = await github(token, `/repos/${repo}/commits?per_page=30&page=${page}${sha ? `&sha=${encodeURIComponent(sha)}` : ''}`);
    return res.json({ commits: data.map((c: any) => ({
      sha: c.sha, message: c.commit?.message, author: c.commit?.author?.name,
      date: c.commit?.author?.date, html_url: c.html_url
    })) });
  }
  if (route === 'git/commit' && req.method === 'GET') {
    const sha = String(req.query.sha || '');
    if (!/^[a-f0-9]{7,40}$/i.test(sha)) throw httpError('A valid commit SHA is required.');
    const data = await github(token, `/repos/${repo}/commits/${encodeURIComponent(sha)}`);
    return res.json({ commit: {
      sha: data.sha, message: data.commit?.message, author: data.commit?.author,
      stats: data.stats, files: (data.files || []).map((f: any) => ({
        filename: f.filename, status: f.status, additions: f.additions,
        deletions: f.deletions, changes: f.changes, patch: f.patch
      }))
    } });
  }
  if (route === 'git/compare' && req.method === 'GET') {
    const base = safeBranch(req.query.base);
    const head = safeBranch(req.query.head);
    const data = await github(token, `/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
    return res.json({ comparison: {
      status: data.status, ahead_by: data.ahead_by, behind_by: data.behind_by,
      total_commits: data.total_commits,
      commits: (data.commits || []).map((c: any) => ({
        sha: c.sha, message: c.commit?.message, html_url: c.html_url
      })),
      files: (data.files || []).map((f: any) => ({
        filename: f.filename, status: f.status, additions: f.additions,
        deletions: f.deletions, patch: f.patch
      }))
    } });
  }
  if (route === 'git/merge' && req.method === 'POST') {
    const base = safeBranch(body.base);
    const head = safeBranch(body.head);
    const message = String(body.commitMessage || `Merge ${head} into ${base}`).slice(0, 500);
    const data = await github(token, `/repos/${repo}/merges`, 'POST', {
      base, head, commit_message: message
    });
    return res.json({ merged: true, sha: data.sha, html_url: data.html_url });
  }

  // Automation Center: workflows, run/dispatch/cancel/rerun and enable/disable
  if (route === 'automation/workflows' && req.method === 'GET') {
    const data = await github(token, `/repos/${repo}/actions/workflows?per_page=100`);
    return res.json({ workflows: (data.workflows || []).map((w: any) => ({
      id: w.id, name: w.name, path: w.path, state: w.state,
      badge_url: w.badge_url, html_url: w.html_url
    })) });
  }
  if (route === 'automation/dispatch' && req.method === 'POST') {
    const workflowId = String(body.workflowId || '');
    const ref = safeBranch(body.ref || 'main');
    if (!/^[0-9]+$/.test(workflowId) && !workflowId.endsWith('.yml') && !workflowId.endsWith('.yaml')) {
      throw httpError('A valid workflow ID or workflow file is required.');
    }
    await github(token, `/repos/${repo}/actions/workflows/${encodeURIComponent(workflowId)}/dispatches`, 'POST', {
      ref, inputs: body.inputs || {}
    });
    return res.json({ ok: true, dispatched: workflowId, ref });
  }
  if (route.startsWith('automation/runs/') && req.method === 'POST') {
    const parts = route.split('/');
    const runId = parts[2];
    const action = parts[3];
    if (!/^[0-9]+$/.test(runId) || !['rerun', 'cancel'].includes(action)) throw httpError('Invalid workflow run action.');
    await github(token, `/repos/${repo}/actions/runs/${runId}/${action}`, 'POST');
    return res.json({ ok: true, runId, action });
  }
  if (route.startsWith('automation/workflows/') && req.method === 'POST') {
    const parts = route.split('/');
    const workflowId = parts[2];
    const action = parts[3];
    if (!/^[0-9]+$/.test(workflowId) || !['enable', 'disable'].includes(action)) throw httpError('Invalid workflow state action.');
    await github(token, `/repos/${repo}/actions/workflows/${workflowId}/${action}`, 'PUT');
    return res.json({ ok: true, workflowId, state: action === 'enable' ? 'active' : 'disabled' });
  }
  if (route === 'automation/workflow-file' && req.method === 'GET') {
    const path = safePath(req.query.path);
    const ref = safeBranch(req.query.ref || 'main');
    const data = await github(token, `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`);
    return res.json({ file: {
      path: data.path, sha: data.sha, encoding: data.encoding,
      content: data.content, size: data.size
    } });
  }
  if (route === 'automation/workflow-file' && req.method === 'PUT') {
    const path = safePath(body.path);
    if (!path.startsWith('.github/workflows/')) throw httpError('Workflow files must be inside .github/workflows/.');
    const branch = safeBranch(body.branch || 'main');
    const content = String(body.content ?? '');
    if (content.length > 500000) throw httpError('Workflow file is too large.');
    let sha: string | undefined;
    try {
      const existing = await github(token, `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`);
      sha = existing.sha;
    } catch (e: any) {
      if (e.status !== 404) throw e;
    }
    const data = await github(token, `/repos/${repo}/contents/${path}`, 'PUT', {
      message: String(body.message || `Update ${path}`).slice(0, 500),
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch,
      ...(sha ? { sha } : {})
    });
    return res.json({ ok: true, commit: data.commit?.sha, content: data.content?.path || path });
  }

  return res.status(404).json({ error: 'Advanced API route not found.', route });
}
