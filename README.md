# GitHub Control Center — update package

This update preserves the existing Supabase email/password authentication, GitHub OAuth callback, encrypted server-side GitHub tokens, Vercel API route and dashboard design.

## Included in this update
- Multi-account selector and disconnect
- Repository listing and create
- Repository description / visibility edit
- Branch listing
- File and folder browser
- Text file editor with commit
- ZIP upload for source/text files, preserving nested folders
- If the ZIP contains exactly one common top-level folder, that wrapper folder is stripped
- Existing pull request and Actions read views

## Important ZIP upload limitation
This first implementation handles UTF-8 text/source files. Binary assets (images, fonts, compiled files, etc.) are rejected rather than silently corrupted. The GitHub REST contents API supports binary blobs, but a separate binary-safe upload flow should be added before relying on ZIP uploads containing binary assets.

## Setup
1. Replace the repository files with the matching files in this ZIP.
2. Keep your current Vercel and Supabase environment variables. Do not overwrite them with `.env.example`.
3. Install dependencies with `npm install`.
4. Run `npm run build` locally.
5. Upload/commit the changes to the GitHub repository's production branch.
6. Wait for the Vercel deployment to finish.

## Existing environment variables
Frontend:
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

Vercel server-side:
- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY`
- `APP_URL` (no trailing slash)
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `GITHUB_TOKEN_ENCRYPTION_KEY` (at least 32 bytes)

GitHub OAuth callback URL must remain:
`https://github-control-center.vercel.app/api/github/callback`

## OAuth permissions
The current OAuth scope remains `repo workflow read:user user:email`. Repository create/edit and file writes require write access to the target repository. Repository deletion is intentionally not exposed in the UI.

## Notes
- Keep the existing Supabase tables and `consume_github_oauth_state` RPC.
- No database schema migration is required for this phase.
- Do not expose `SUPABASE_SECRET_KEY`, GitHub OAuth secret, or token encryption key in frontend variables.
