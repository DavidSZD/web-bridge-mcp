# Instructions for coding agents

Before helping deploy or configure this project, read:

1. `README.md` for the features and secret-handling rules.
2. `docs/SETUP.md` for a complete, independent Cloudflare and ChatGPT setup.

## Separate-instance requirement

- Deploy only a new instance in the current user's Cloudflare account. Never target the original author's Worker, KV namespace, GitHub OAuth app, or provider vault.
- Start from `wrangler.example.jsonc`. The real `wrangler.jsonc` is intentionally git-ignored and must be created locally with the new owner's Worker name, origin, and KV namespace ID.
- Check `npx wrangler whoami` and the resolved target before deploying. Never infer the target account from a saved local Wrangler session.
- Use a new GitHub OAuth App and a new `OAUTH_KV` namespace. Set `GITHUB_ALLOWED_LOGIN` to the new owner's GitHub login; do not deploy with an empty allowlist.

## Secrets and changes

- Never request, print, commit, or include real secret values in chat, source files, terminal transcripts, or logs. Guide the owner to enter them directly into Cloudflare secret storage.
- Keep `.dev.vars`, `.env*`, `.wrangler/`, and the real `wrangler.jsonc` out of Git. Do not weaken `.gitignore` to include them.
- Do not migrate or upgrade dependencies as part of a routine first deployment. The OAuth provider version is pinned; if a current official requirement makes migration necessary, explain the impact, use the migration instructions shipped with the package, and verify before deploying.
- Before any deployment, summarize the target Worker, account, KV namespace, and planned external changes. Do not deploy until the user has authorized that deployment in their own environment.

## Verification

- Run `npm ci` and `npm run typecheck` before deployment.
- Verify OAuth discovery and the unauthenticated challenge, complete a GitHub login as an allowlisted user, then connect ChatGPT to `https://<new-worker-host>/mcp` using OAuth.
- Test public tools first. Never call a configured private API unless the user explicitly requests that specific API.
- Report the new owner's endpoint, the secret *names* (never values), verification performed, and anything not tested.
