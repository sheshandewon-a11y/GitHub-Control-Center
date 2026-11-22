import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { createCipheriv, createDecipheriv, randomBytes, hkdfSync } from 'node:crypto';

const { SUPABASE_URL, SUPABASE_SECRET_KEY, APP_URL } = process.env;
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !APP_URL) {
  throw new Error('Missing SUPABASE_URL, SUPABASE_SECRET_KEY or APP_URL.');
}
const db = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});
const callbackUrl = `${APP_URL.replace(/\/+$/, '')}/api/github/callback`;

function key() {
  const secret = process.env.GITHUB_TOKEN_ENCRYPTION_KEY || '';
  if (Buffer.byteLength(secret) < 32) throw new Error('GITHUB_TOKEN_ENCRYPTION_KEY must be at least 32 bytes.');
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret), Buffer.from('github-control-center'), Buffer.from('token-storage:v1'), 32));
}
function encrypt(token: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}
function decrypt(v: {iv:string;tag:string;data:string}) {
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(v.iv, 'base64'));
  d.setAuthTag(Buffer.from(v.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(v.data, 'base64')), d.final()]).toString('utf8');
}
function fail(message: string, status = 400) { return Object.assign(new Error(message), { status }); }
async function requireUser(req: VercelRequest) {
  const h = String(req.headers.authorization || '');
  const jwt = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!jwt) throw fail('Sign in required.', 401);
  const { data, error } = await db.auth.getUser(jwt);
  if (error || !data.user) throw fail('Session is invalid.', 401);
  return data.user.id;
}
async function gh(token: string, path: string, method = 'GET', body?: unknown) {
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
  if (!response.ok) throw fail(data.message || `GitHub API returned ${response.status}`, response.status);
  return { data, link: response.headers.get('link') || '' };
}
async function accountFor(userId: string, id: string) {
  if (!id) throw fail('Account ID is required.');
  const { data, error } = await db.from('github_accounts').select('*').eq('user_id', userId).eq('id', id).single();
  if (error || !data) throw fail('GitHub account not found.', 404);
  return data;
}
function repoPath(fullName: string) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) throw fail('Valid owner/repository is required.');
  return fullName.split('/').map(encodeURIComponent).join('/');
}
function sendError(res: VercelResponse, e: any) {
  console.error('GitHub API error:', e);
  return res.status(e.status || 500).json({ error: e.message || 'Unexpected server error.' });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const path = new URL(req.url || '/', 'https://local.invalid').pathname.replace(/^\/api\/github\/?/, '').replace(/\/+$/, '');
  const q = req.query.route;
  const route = Array.isArray(q) ? q.join('/') : String(q || path);
  try {
    if (route === 'callback' && req.method === 'GET') {
      const state = String(req.query.state || '');
      const code = String(req.query.code || '');
      if (!state) return res.redirect(`${APP_URL}/?github=state_expired`);
      const { data: consumed, error } = await db.rpc('consume_github_oauth_state', { p_state: state });
      const saved = consumed?.[0];
      if (error || !saved) return res.redirect(`${APP_URL}/?github=state_expired`);
      if (!code || req.query.error) return res.redirect(`${APP_URL}/?github=denied`);
      const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: process.env.GITHUB_CLIENT_ID, client_secret: process.env.GITHUB_CLIENT_SECRET, code, redirect_uri: callbackUrl })
      });
      const td: any = await tokenRes.json();
      if (!tokenRes.ok || !td.access_token) return res.redirect(`${APP_URL}/?github=token_exchange_failed`);
      const profile = (await gh(td.access_token, '/user')).data;
      const record = {
        user_id: saved.user_id, github_id: profile.id, login: profile.login, name: profile.name,
        email: profile.email || null, avatar_url: profile.avatar_url, profile_url: profile.html_url,
        account_type: profile.type || 'User', scopes: String(td.scope || '').split(/[ ,]+/).filter(Boolean),
        encrypted_token: encrypt(td.access_token), updated_at: new Date().toISOString()
      };
      const { error: saveError } = await db.from('github_accounts').upsert(record, { onConflict: 'user_id,github_id' });
      if (saveError) return res.redirect(`${APP_URL}/?github=save_failed`);
      return res.redirect(`${APP_URL}/?github=connected`);
    }

    const userId = await requireUser(req);

    if (route === 'status' && req.method === 'GET') {
      const missing = ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'].filter(k => !process.env[k]);
      return res.json({ configured: missing.length === 0, missing });
    }
    if (route === 'connect' && req.method === 'POST') {
      if (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET) throw fail('GitHub OAuth is not configured.', 500);
      const state = randomBytes(32).toString('hex');
      const { error } = await db.from('github_oauth_states').insert({
        state, user_id: userId, expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString()
      });
      if (error) throw error;
      const url = new URL('https://github.com/login/oauth/authorize');
      url.search = new URLSearchParams({
        client_id: process.env.GITHUB_CLIENT_ID, redirect_uri: callbackUrl,
        scope: 'repo workflow read:user user:email', state
      }).toString();
      return res.json({ authorizationUrl: url.toString() });
    }
    if (route === 'accounts' && req.method === 'GET') {
      const { data, error } = await db.from('github_accounts')
        .select('id,github_id,login,name,email,avatar_url,profile_url,account_type,scopes,connected_at')
        .eq('user_id', userId).order('connected_at', { ascending: true });
      if (error) throw error;
      return res.json({ accounts: data || [] });
    }
    if (route.startsWith('accounts/') && req.method === 'DELETE') {
      const id = route.split('/')[1];
      const a = await accountFor(userId, id);
      const token = decrypt(a.encrypted_token);
      const clientId = process.env.GITHUB_CLIENT_ID || '';
      const clientSecret = process.env.GITHUB_CLIENT_SECRET || '';
      const revoke = await fetch(`https://api.github.com/applications/${encodeURIComponent(clientId)}/token`, {
        method: 'DELETE',
        headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token: token })
      });
      if (!revoke.ok && revoke.status !== 404) throw fail('GitHub did not confirm token revocation.', 502);
      const { error } = await db.from('github_accounts').delete().eq('id', id).eq('user_id', userId);
      if (error) throw error;
      return res.json({ ok: true });
    }

    const accountId = String(req.query.accountId || (req.body as any)?.accountId || '');
    const account = await accountFor(userId, accountId);
    const token = decrypt(account.encrypted_token);

    if (route === 'repositories' && req.method === 'GET') {
      const result = await gh(token, '/user/repos?visibility=all&affiliation=owner,collaborator,organization_member&sort=updated&per_page=100');
      return res.json({ repositories: result.data.map((r: any) => ({
        id:r.id,name:r.name,full_name:r.full_name,description:r.description,private:r.private,
        html_url:r.html_url,language:r.language,stargazers_count:r.stargazers_count,
        updated_at:r.updated_at,default_branch:r.default_branch,archived:r.archived,
        topics:r.topics || [], fork:r.fork, permissions:r.permissions || {}
      })) });
    }

    if (route === 'repository' && req.method === 'POST') {
      const body = req.body || {};
      if (!/^[a-zA-Z0-9._-]{1,100}$/.test(String(body.name || ''))) throw fail('Repository name is required and may contain letters, numbers, dots, underscores and hyphens.');
      const result = await gh(token, '/user/repos', 'POST', {
        name: body.name, description: body.description || '', private: !!body.private,
        auto_init: true, has_issues: true, has_projects: true, has_wiki: true
      });
      return res.status(201).json({ repository: result.data });
    }

    const fullName = String(req.query.repository || (req.body as any)?.repository || '');
    const rp = repoPath(fullName);
    if (route === 'repository' && req.method === 'PATCH') {
      const body = req.body || {};
      const result = await gh(token, `/repos/${rp}`, 'PATCH', {
        name: body.name, description: body.description, private: body.private,
        archived: body.archived, homepage: body.homepage,
        has_issues: body.has_issues, has_wiki: body.has_wiki,
        default_branch: body.default_branch
      });
      return res.json({ repository: result.data });
    }
    if (route === 'repository' && req.method === 'DELETE') {
      await gh(token, `/repos/${rp}`, 'DELETE');
      return res.json({ ok: true });
    }
    if (route === 'branches' && req.method === 'GET') {
      const result = await gh(token, `/repos/${rp}/branches?per_page=100`);
      return res.json({ branches: result.data.map((b: any) => ({ name:b.name, protected:b.protected, commitSha:b.commit.sha })) });
    }
    if (route === 'branches' && req.method === 'POST') {
      const body = req.body || {};
      const base = await gh(token, `/repos/${rp}/git/ref/heads/${encodeURIComponent(body.from || 'main')}`);
      await gh(token, `/repos/${rp}/git/refs`, 'POST', { ref: `refs/heads/${body.name}`, sha: base.data.object.sha });
      return res.status(201).json({ ok: true, branch: body.name });
    }
    if (route === 'pulls' && req.method === 'GET') {
      const result = await gh(token, `/repos/${rp}/pulls?state=open&per_page=50`);
      return res.json({ pullRequests: result.data });
    }
    if (route === 'actions' && req.method === 'GET') {
      const result = await gh(token, `/repos/${rp}/actions/runs?per_page=30`);
      return res.json({ runs: result.data.workflow_runs || [] });
    }
    if (route === 'files' && req.method === 'GET') {
      const ref = String(req.query.ref || '');
      const p = String(req.query.path || '');
      const suffix = p ? `/${p.split('/').map(encodeURIComponent).join('/')}` : '';
      const result = await gh(token, `/repos/${rp}/contents${suffix}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`);
      return res.json({ files: result.data });
    }
    if (route === 'file' && req.method === 'GET') {
      const p = String(req.query.path || '');
      const ref = String(req.query.ref || '');
      if (!p) throw fail('File path is required.');
      const result = await gh(token, `/repos/${rp}/contents/${p.split('/').map(encodeURIComponent).join('/')}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`);
      return res.json({ file: result.data });
    }
    if (route === 'files' && req.method === 'POST') {
      const body = req.body || {};
      const branch = body.branch || undefined;
      const ref = await gh(token, `/repos/${rp}/git/ref/heads/${encodeURIComponent(branch || 'main')}`);
      const commit = await gh(token, `/repos/${rp}/git/commits/${ref.data.object.sha}`);
      const baseTree = commit.data.tree.sha;
      const entries: any[] = [];
      for (const f of (body.files || [])) {
        const blob = await gh(token, `/repos/${rp}/git/blobs`, 'POST', { content: f.content, encoding: 'utf-8' });
        entries.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.data.sha });
      }
      if (!entries.length) throw fail('No files were supplied.');
      const tree = await gh(token, `/repos/${rp}/git/trees`, 'POST', { base_tree: baseTree, tree: entries });
      const next = await gh(token, `/repos/${rp}/git/commits`, 'POST', {
        message: body.message || 'Update files via GitHub Control Center',
        tree: tree.data.sha, parents: [ref.data.object.sha]
      });
      await gh(token, `/repos/${rp}/git/refs/heads/${encodeURIComponent(branch || 'main')}`, 'PATCH', { sha: next.data.sha, force: false });
      return res.json({ ok: true, commit: next.data.sha, count: entries.length });
    }

    return res.status(404).json({ error: 'API route not found.', route, method: req.method });
  } catch (e: any) {
    return sendError(res, e);
  }
}
