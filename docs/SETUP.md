# Deploy your own Web Bridge instance

This guide is for a **new, separate deployment** owned by the person following it. It does not transfer the original author's Cloudflare account, Worker, OAuth app, KV data, or configured provider keys.

Web Bridge is an authenticated remote MCP server. Its tools include public tweet and page-source retrieval, YouTube search, and configured private API calls. The ChatGPT MCP app also contains the Providers UI and the YouTube composer mention search. Private provider keys are entered in that owner's `/keys` page and stored encrypted in that owner's KV namespace.

## 1. Get the source and install dependencies

Clone this repository after its owner has granted you access, then run these commands from the project folder:

```powershell
npm ci
npm run typecheck
```

Do not copy the original author's local `.wrangler/`, `.dev.vars`, or ignored `wrangler.jsonc`. Those are not part of this repository.

## 2. Create a new Cloudflare Worker and KV namespace

1. Sign in to the Cloudflare account that will own this instance and verify it with `npx wrangler whoami`.
2. Create a **new** KV namespace named `OAUTH_KV`:

   ```powershell
   npx wrangler kv namespace create OAUTH_KV
   ```

3. Copy `wrangler.example.jsonc` to the ignored local filename `wrangler.jsonc`:

   ```powershell
   Copy-Item wrangler.example.jsonc wrangler.jsonc
   ```

4. In that local file, set a unique Worker `name`, the new account's exact HTTPS `PUBLIC_ORIGIN`, and the ID returned for the new KV namespace. Do not use the original author's Worker hostname or KV ID. `PUBLIC_ORIGIN` is the origin only: no `/mcp`, `/callback`, or trailing slash.

The Worker host is determined by the chosen Worker name and the `workers.dev` subdomain enabled for the new Cloudflare account. Confirm the final hostname in the Cloudflare dashboard or deployment output before creating OAuth callbacks.

## 3. Create a GitHub OAuth App for this Worker

Create a new OAuth App under the new owner's GitHub account. Use public, non-sensitive information for its name and homepage.

- Homepage URL: `https://<new-worker-host>`
- Authorization callback URL: `https://<new-worker-host>/callback`
- Device flow: leave disabled unless the code is deliberately changed to support it.

The callback above is the **GitHub-to-Worker** callback. ChatGPT's OAuth redirect is handled by the MCP authorization flow; do not substitute a ChatGPT callback URL here. The callback URL must match the deployed Worker hostname and `/callback` path exactly.

Set `GITHUB_ALLOWED_LOGIN` to the new owner's GitHub login. This is important: the current code treats an empty allowlist as unrestricted GitHub login access.

## 4. Configure Worker secrets privately

The application expects these environment names:

- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `GITHUB_ALLOWED_LOGIN`
- `ADMIN_PAGE_CODE`
- `API_KEYS_ENCRYPTION_KEY`

`PUBLIC_ORIGIN` belongs in the local Wrangler configuration as a non-secret variable. The GitHub client ID is not itself confidential, but this project can store it as a Worker secret for a simple, consistent setup.

For production, add the values using Cloudflare's dashboard or `npx wrangler secret put <NAME>`. Enter each value directly into Cloudflare's secret prompt; do not paste values into this repository, a normal chat message, or a committed `.dev.vars` file. Generate a unique, strong `ADMIN_PAGE_CODE` and a fresh 32-byte base64 `API_KEYS_ENCRYPTION_KEY` for this instance. Keep a secure backup of the encryption key outside Git: losing it makes existing encrypted provider keys unreadable.

The `.dev.vars.example` file is only a placeholder for local development. If creating a local `.dev.vars`, never commit it.

## 5. Deploy and verify the Worker

Before deploying, check that `npx wrangler whoami` shows the intended account and that the local `wrangler.jsonc` names only the new Worker and namespace. Then:

```powershell
npm run typecheck
npm run deploy
```

Check the unauthenticated `/mcp` response and follow the OAuth resource metadata URL advertised by its `401` challenge; do not guess metadata paths. Complete a login with the allowlisted GitHub account. A `401` before OAuth is expected for a protected MCP endpoint, not evidence that the deployment failed.

After authentication, test a public tool and inspect `tools/list`. Do not test `call_configured_api` unless the new owner explicitly requests a call to a specific configured private API.

## 6. Connect it to ChatGPT

In ChatGPT on the web, open **Plugins**, choose **Add custom MCP server**, and enter:

- Name: `Web Bridge` (or another name the owner chooses)
- Server URL: `https://<new-worker-host>/mcp`
- Authentication: OAuth

Review the server and its tools before creating the plugin, then install it in the relevant personal or workspace plugin area. The first protected tool use should start the GitHub sign-in/authorization flow. Afterward, verify the Providers interface and a normal public YouTube search. Composer `@`-mention search is documented for ChatGPT desktop; availability can depend on the ChatGPT client and workspace policy.

## 7. Configure private API providers (optional)

Open `https://<new-worker-host>/keys` and enter the private page code (`ADMIN_PAGE_CODE`), then add providers in the UI. This page gate is independent of the GitHub OAuth login used by the MCP server. Use only the new owner's API keys. The page is served by the Worker; do not put keys into MCP tool inputs or this repository.

## Version note

This repository pins `@cloudflare/workers-oauth-provider` in `package-lock.json` and currently uses its single-Worker `OAuthProvider` API. Cloudflare released version 1.0 on October 1, 2026. For a first deployment, preserve the pinned dependency and inspect the current official docs and installed package migration guide before considering an upgrade. Do not silently migrate the auth architecture during setup.

## Official references

- [OpenAI: Add a custom MCP server to ChatGPT](https://developers.openai.com/api/docs/guides/custom-mcp-server)
- [OpenAI: MCP authentication for plugins](https://developers.openai.com/plugins/build/auth)
- [Cloudflare: Build a remote MCP server](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/)
- [Cloudflare: Workers OAuth Provider 1.0 release and migration](https://developers.cloudflare.com/changelog/post/2026-10-01-workers-oauth-provider-1x/)
- [GitHub: Create an OAuth App](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)
