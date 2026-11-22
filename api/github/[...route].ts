
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  hkdfSync,
} from 'node:crypto';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;
const appUrl = process.env.APP_URL;

if (!supabaseUrl || !supabaseSecretKey || !appUrl) {
  throw new Error(
    'Missing required server environment variables: SUPABASE_URL, SUPABASE_SECRET_KEY, APP_URL'
  );
}

const supabase = createClient(supabaseUrl, supabaseSecretKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

const callbackUrl = `${appUrl}/api/github/callback`;

// --------------------------------------------------
// ENCRYPTION
// --------------------------------------------------

function encryptionKey() {
  const secret = process.env.GITHUB_TOKEN_ENCRYPTION_KEY;

  if (!secret || Buffer.byteLength(secret) < 32) {
    throw new Error(
      'GITHUB_TOKEN_ENCRYPTION_KEY must be at least 32 bytes.'
    );
  }

  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(secret),
      Buffer.from('github-control-center'),
      Buffer.from('token-storage:v1'),
      32
    )
  );
}

function encrypt(token: string) {
  const iv = randomBytes(12);

  const cipher = createCipheriv(
    'aes-256-gcm',
    encryptionKey(),
    iv
  );

  const encrypted = Buffer.concat([
    cipher.update(token, 'utf8'),
    cipher.final(),
  ]);

  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64'),
  };
}

function decrypt(value: {
  iv: string;
  tag: string;
  data: string;
}) {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(),
    Buffer.from(value.iv, 'base64')
  );

  decipher.setAuthTag(
    Buffer.from(value.tag, 'base64')
  );

  return Buffer.concat([
    decipher.update(
      Buffer.from(value.data, 'base64')
    ),
    decipher.final(),
  ]).toString('utf8');
}

// --------------------------------------------------
// AUTHENTICATION
// --------------------------------------------------

async function owner(req: VercelRequest) {
  const authorization = req.headers.authorization || '';

  const jwt = authorization.startsWith('Bearer ')
    ? authorization.slice(7)
    : '';

  if (!jwt) {
    throw Object.assign(
      new Error('Sign in required.'),
      { status: 401 }
    );
  }

  const { data, error } = await supabase.auth.getUser(jwt);

  if (error || !data.user) {
    throw Object.assign(
      new Error('Session is invalid.'),
      { status: 401 }
    );
  }

  return data.user.id;
}

// --------------------------------------------------
// GITHUB API REQUEST
// --------------------------------------------------

async function githubRequest(
  token: string,
  path: string,
  method = 'GET',
  body?: unknown
) {
  const response = await fetch(
    `https://api.github.com${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'GitHub-Control-Center',
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw Object.assign(
      new Error(
        (data as any).message || 'GitHub API error.'
      ),
      { status: response.status }
    );
  }

  return {
    data,
    link: response.headers.get('link') || '',
  };
}

// --------------------------------------------------
// GET ACCOUNT
// --------------------------------------------------

async function getAccount(
  userId: string,
  id: string
) {
  const { data, error } = await supabase
    .from('github_accounts')
    .select('*')
    .eq('user_id', userId)
    .eq('id', id)
    .single();

  if (error || !data) {
    throw Object.assign(
      new Error('GitHub account not found.'),
      { status: 404 }
    );
  }

  return data;
}

// --------------------------------------------------
// REDIRECT
// --------------------------------------------------

function redirectUrl(status: string) {
  return `${appUrl}/?github=${encodeURIComponent(status)}`;
}

// --------------------------------------------------
// MAIN HANDLER
// --------------------------------------------------

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {

  // --------------------------------------------------
  // ROUTE DETECTION - UPDATED
  // --------------------------------------------------

  const routeParam = req.query.route;

  const requestPath = new URL(
    req.url || '/',
    'https://control-center.local'
  ).pathname;

  const pathRoute = requestPath
    .replace(/^\/api\/github\/?/, '')
    .replace(/\/+$/, '');

  const route = Array.isArray(routeParam)
    ? routeParam.join('/')
    : String(routeParam || pathRoute || '');

  let userId: string | null = null;

  // --------------------------------------------------
  // AUTHENTICATION EXCEPT OAUTH CALLBACK
  // --------------------------------------------------

  if (route !== 'callback') {
    try {
      userId = await owner(req);
    } catch (error: any) {
      return res.status(error.status || 401).json({
        error: error.message || 'Authentication failed.',
      });
    }
  }

  try {

    // --------------------------------------------------
    // STATUS
    // --------------------------------------------------

    if (route === 'status' && req.method === 'GET') {
      const missing = [
        'GITHUB_CLIENT_ID',
        'GITHUB_CLIENT_SECRET',
      ].filter((key) => !process.env[key]);

      return res.json({
        configured: missing.length === 0,
        missing,
      });
    }

    // --------------------------------------------------
    // CONNECT GITHUB ACCOUNT
    // --------------------------------------------------

    if (route === 'connect' && req.method === 'POST') {

      if (
        !process.env.GITHUB_CLIENT_ID ||
        !process.env.GITHUB_CLIENT_SECRET
      ) {
        throw Object.assign(
          new Error(
            'GitHub OAuth secrets are not configured in Vercel.'
          ),
          { status: 400 }
        );
      }

      const state = randomBytes(32).toString('hex');

      const { error } = await supabase
        .from('github_oauth_states')
        .insert({
          state,
          user_id: userId,
          expires_at: new Date(
            Date.now() + 10 * 60 * 1000
          ).toISOString(),
        });

      if (error) {
        throw error;
      }

      const query = new URLSearchParams({
        client_id: process.env.GITHUB_CLIENT_ID,
        redirect_uri: callbackUrl,
        scope: 'repo workflow read:user user:email',
        state,
      });

      return res.json({
        authorizationUrl:
          `https://github.com/login/oauth/authorize?${query.toString()}`,
      });
    }

    // --------------------------------------------------
    // GITHUB OAUTH CALLBACK
    // --------------------------------------------------

    if (route === 'callback' && req.method === 'GET') {

      const state = String(req.query.state || '');
      const code = String(req.query.code || '');

      if (!state) {
        return res.redirect(
          redirectUrl('state_expired')
        );
      }

      // Consume OAuth state once.

      const {
        data: consumed,
        error: consumeError,
      } = await supabase.rpc(
        'consume_github_oauth_state',
        {
          p_state: state,
        }
      );

      const savedState = consumed?.[0];

      if (consumeError || !savedState) {
        return res.redirect(
          redirectUrl('state_expired')
        );
      }

      if (!code || req.query.error) {
        return res.redirect(
          redirectUrl('denied')
        );
      }

      // Exchange OAuth code.

      const tokenResponse = await fetch(
        'https://github.com/login/oauth/access_token',
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            client_id: process.env.GITHUB_CLIENT_ID,
            client_secret: process.env.GITHUB_CLIENT_SECRET,
            code,
            redirect_uri: callbackUrl,
          }),
        }
      );

      const tokenData: any = await tokenResponse.json();

      if (
        !tokenResponse.ok ||
        !tokenData.access_token
      ) {
        return res.redirect(
          redirectUrl('token_exchange_failed')
        );
      }

      // Get GitHub profile.

      const profileResponse = await githubRequest(
        tokenData.access_token,
        '/user'
      );

      const profile: any = profileResponse.data;

      // Prepare encrypted account record.

      const record = {
        user_id: savedState.user_id,
        github_id: profile.id,
        login: profile.login,
        name: profile.name,
        email: profile.email || null,
        avatar_url: profile.avatar_url,
        profile_url: profile.html_url,
        account_type: profile.type || 'User',
        scopes: String(tokenData.scope || '')
          .split(/[ ,]+/)
          .filter(Boolean),
        encrypted_token: encrypt(
          tokenData.access_token
        ),
        updated_at: new Date().toISOString(),
      };

      const { error: saveError } = await supabase
        .from('github_accounts')
        .upsert(record, {
          onConflict: 'user_id,github_id',
        });

      if (saveError) {
        console.error(
          'GitHub account save failed:',
          saveError
        );

        return res.redirect(
          redirectUrl('save_failed')
        );
      }

      return res.redirect(
        redirectUrl('connected')
      );
    }

    // --------------------------------------------------
    // LIST CONNECTED ACCOUNTS
    // --------------------------------------------------

    if (route === 'accounts' && req.method === 'GET') {

      const { data, error } = await supabase
        .from('github_accounts')
        .select(
          'id,github_id,login,name,email,avatar_url,profile_url,account_type,scopes,connected_at'
        )
        .eq('user_id', userId)
        .order('connected_at', {
          ascending: true,
        });

      if (error) {
        throw error;
      }

      return res.json({
        accounts: data || [],
      });
    }

    // --------------------------------------------------
    // DISCONNECT ACCOUNT
    // --------------------------------------------------

    if (
      route.startsWith('accounts/') &&
      req.method === 'DELETE'
    ) {

      const id = route.split('/')[1];

      if (!id) {
        throw Object.assign(
          new Error('Account ID is required.'),
          { status: 400 }
        );
      }

      const account = await getAccount(
        userId!,
        id
      );

      const token = decrypt(
        account.encrypted_token
      );

      const clientId = process.env.GITHUB_CLIENT_ID;
      const clientSecret = process.env.GITHUB_CLIENT_SECRET;

      if (!clientId || !clientSecret) {
        throw Object.assign(
          new Error(
            'GitHub OAuth credentials are not configured.'
          ),
          { status: 500 }
        );
      }

      // Revoke GitHub OAuth token.

      const revokeResponse = await fetch(
        `https://api.github.com/applications/${encodeURIComponent(
          clientId
        )}/token`,
        {
          method: 'DELETE',
          headers: {
            Authorization:
              'Basic ' +
              Buffer.from(
                `${clientId}:${clientSecret}`
              ).toString('base64'),
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            access_token: token,
          }),
        }
      );

      if (
        !revokeResponse.ok &&
        revokeResponse.status !== 404
      ) {
        throw Object.assign(
          new Error(
            'GitHub did not confirm token revocation. Account remains connected.'
          ),
          { status: 502 }
        );
      }

      const { error } = await supabase
        .from('github_accounts')
        .delete()
        .eq('id', id)
        .eq('user_id', userId);

      if (error) {
        throw error;
      }

      return res.json({
        ok: true,
      });
    }

    // --------------------------------------------------
    // REPOSITORIES / BRANCHES / PULLS / ACTIONS
    // --------------------------------------------------

    if (
      [
        'repositories',
        'branches',
        'pulls',
        'actions',
      ].includes(route) &&
      req.method === 'GET'
    ) {

      const accountId = String(
        req.query.accountId ||
        req.query.id ||
        ''
      );

      if (!accountId) {
        throw Object.assign(
          new Error('Account ID is required.'),
          { status: 400 }
        );
      }

      const account = await getAccount(
        userId!,
        accountId
      );

      const token = decrypt(
        account.encrypted_token
      );

      // ------------------------------------------------
      // REPOSITORIES
      // ------------------------------------------------

      if (route === 'repositories') {

        const result = await githubRequest(
          token,
          '/user/repos?visibility=all&affiliation=owner,collaborator,organization_member&sort=updated&per_page=100'
        );

        return res.json({
          repositories: (
            result.data as any[]
          ).map((repo) => ({
            id: repo.id,
            name: repo.name,
            full_name: repo.full_name,
            description: repo.description,
            private: repo.private,
            html_url: repo.html_url,
            language: repo.language,
            stargazers_count: repo.stargazers_count,
            updated_at: repo.updated_at,
            default_branch: repo.default_branch,
          })),
        });
      }

      // Validate repository owner/name.

      const fullName = String(
        req.query.repository || ''
      );

      if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) {
        throw Object.assign(
          new Error(
            'Valid owner/repository required.'
          ),
          { status: 400 }
        );
      }

      const repositoryPath = fullName
        .split('/')
        .map(encodeURIComponent)
        .join('/');

      // ------------------------------------------------
      // BRANCHES
      // ------------------------------------------------

      if (route === 'branches') {

        const result = await githubRequest(
          token,
          `/repos/${repositoryPath}/branches?per_page=100`
        );

        return res.json({
          branches: (
            result.data as any[]
          ).map((branch) => ({
            name: branch.name,
            protected: branch.protected,
            commitSha: branch.commit.sha,
          })),
        });
      }

      // ------------------------------------------------
      // PULL REQUESTS
      // ------------------------------------------------

      if (route === 'pulls') {

        const result = await githubRequest(
          token,
          `/repos/${repositoryPath}/pulls?state=open&per_page=50`
        );

        return res.json({
          pullRequests: (
            result.data as any[]
          ).map((pull) => ({
            id: pull.id,
            number: pull.number,
            title: pull.title,
            state: pull.state,
            draft: pull.draft,
            html_url: pull.html_url,
            created_at: pull.created_at,
            updated_at: pull.updated_at,
            user: pull.user?.login,
            base: pull.base?.ref,
            head: pull.head?.ref,
          })),
        });
      }

      // ------------------------------------------------
      // GITHUB ACTIONS
      // ------------------------------------------------

      if (route === 'actions') {

        const result = await githubRequest(
          token,
          `/repos/${repositoryPath}/actions/runs?per_page=30`
        );

        return res.json({
          runs: (
            result.data as any
          ).workflow_runs || [],
        });
      }
    }

    // --------------------------------------------------
    // METHOD NOT ALLOWED / UNKNOWN ROUTE
    // --------------------------------------------------

    const allowedMethods: Record<
      string,
      string[]
    > = {
      status: ['GET'],
      connect: ['POST'],
      callback: ['GET'],
      accounts: ['GET'],
      repositories: ['GET'],
      branches: ['GET'],
      pulls: ['GET'],
      actions: ['GET'],
    };

    const baseRoute = route.startsWith('accounts/')
      ? 'accounts'
      : route;

    if (
      allowedMethods[baseRoute] &&
      !allowedMethods[baseRoute].includes(
        req.method || ''
      )
    ) {
      res.setHeader(
        'Allow',
        allowedMethods[baseRoute].join(', ')
      );

      return res.status(405).json({
        error: 'Method not allowed.',
      });
    }

    return res.status(404).json({
      error: 'API route not found.',
      route,
      method: req.method,
    });

  } catch (error: any) {

    console.error(
      'GitHub API error:',
      error
    );

    return res.status(
      error.status || 500
    ).json({
      error:
        error.message ||
        'Unexpected server error.',
    });
  }
}
