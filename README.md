# GitHub Control Center

React + TypeScript + Vite frontend, Vercel serverless API, Supabase Auth/Postgres and GitHub OAuth.

## Included
- Private workspace login with Supabase email/password authentication.
- Multi-account GitHub OAuth connection.
- Encrypted GitHub access tokens stored only in Supabase and decrypted only in the Vercel function.
- Accounts, repositories, branches, pull requests and GitHub Actions read views.
- Disconnect confirmation before revoking a GitHub OAuth token.
- Responsive dark control-center UI.

## 1. Install and run
```bash
npm install
cp .env.example .env.local
npm run dev
```
Fill in the Supabase browser URL and publishable key in `.env.local`.

## 2. Supabase
1. Open the `github-control-center` Supabase project.
2. Open SQL Editor and run `supabase/migrations/202611220001_github_control_center.sql`.
3. In Authentication > Providers, enable Email.
4. In Authentication > URL Configuration, set Site URL to your Vercel URL and add local + Vercel callback origins to the redirect allow list as required.
5. Create a Supabase secret key for server-side use. Never put it in a `VITE_` variable.

## 3. GitHub OAuth App
Create/configure a GitHub OAuth App:
- Homepage URL: your Vercel project URL
- Authorization callback URL: `https://YOUR_DOMAIN/api/github/callback`

The callback URL must match exactly.

## 4. Vercel environment variables
Add these in Project Settings > Environment Variables for Production, Preview and Development:
- `VITE_SUPABASE_URL` (public)
- `VITE_SUPABASE_PUBLISHABLE_KEY` (public)
- `SUPABASE_URL` (server only)
- `SUPABASE_SECRET_KEY` (server only)
- `GITHUB_CLIENT_ID` (server only)
- `GITHUB_CLIENT_SECRET` (server only)
- `GITHUB_TOKEN_ENCRYPTION_KEY` (server only; at least 32 random bytes)
- `APP_URL` (server only; public site origin, no trailing slash)

Generate an encryption key locally, e.g. `openssl rand -base64 48`. Keep it stable: changing it makes already stored tokens unreadable unless they are re-encrypted.

## 5. Deploy
Import this repository into Vercel, select the `nexus` team and the existing `github-control-center` project. Framework Vite, build `npm run build`, output `dist`. Add environment variables before first production deployment.

## Security notes
- Supabase secret key is only read by the Vercel function. Never expose it to browser code.
- GitHub tokens are AES-256-GCM encrypted before database storage.
- The API verifies Supabase user JWTs on protected routes and scopes account queries to that user.
- OAuth state is random, single-use and expires after ten minutes.
- This is the initial migration baseline. Before public production use, add rate limiting, CSRF/origin controls, stronger audit coverage, and test OAuth end-to-end with a dedicated test account.
- GitHub write operations are intentionally not included in this baseline. Add them only with explicit per-action confirmation and audit logging.
