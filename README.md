# GLM Workspace

A local, fully customizable chat workspace for [Z.ai](https://z.ai) GLM models (GLM-5.3 and friends). It runs on your own machine: a tiny zero-dependency Node server proxies the API so your key never touches the browser.

## Features

- **Chat**: streaming, visible reasoning, Markdown, code highlighting, LaTeX, edit/regenerate, raw request inspector, speed and token stats
- **Model controls**: model picker, temperature, top-p, max tokens, thinking toggle, JSON mode, stop sequences, extra request params
- **Tools**
  - Web: `web_search` (Z.ai search via the Coding Plan), `fetch_url`, `http_request` (raw HTTP, any method, cookie sessions), `render_page` (headless Chrome), `crawl_site`
  - Files: a sandbox (`files/`) with list/read/write/delete, a Files tab, and zip downloads
  - Memory: `remember` / `update_memory` / `forget`, plus `search_chats` / `read_chat` across every past conversation
  - Compute: `run_javascript` (with `http` and `files` helpers), calculator, current time
  - GitHub: `github_api` — the REST API with your `GITHUB_TOKEN` (token stays in `.env`)
  - Shell: `run_command` — allowlisted binaries only, executed without a shell, approval-gated
  - MCP: connect any streamable-HTTP MCP server; its tools show up via `mcp_list` / `mcp_call`
  - Custom tools: define your own with a JSON schema and a JavaScript handler
- **Autopilot**: GLM works in cycles on a mission you give it, or one it picks itself, with limits or no limit, pause/stop, and a journal in `autopilot/journal.md`
- **Look**: themes, accent color, fonts, widths, and custom CSS

## Setup

Requires Node 20+. Google Chrome is optional (only needed for `render_page`).

```bash
git clone https://github.com/GalacTechNyc/glm-workspace.git
cd glm-workspace
cp .env.example .env   # then put your Z.ai API key in .env
npm start
```

Open http://localhost:5173.

## Optional capabilities (all keys live in `.env`)

| Key | Unlocks |
|---|---|
| `OPENAI_API_KEY` | `generate_image`, audio transcription & listening |
| `ATLASCLOUD_API_KEY` | `generate_video` (Seedance) |
| `TAVILY_API_KEY` / `BRAVE_API_KEY` | extra web search providers |
| `GITHUB_TOKEN` | `github_api` — full GitHub REST API access; the token is attached server-side and never shown to the model |
| `COMMAND_ALLOWLIST` | `run_command` — a comma-separated list of the only binaries GLM may execute. Commands run **without a shell** (one binary + plain arguments; pipes/redirects/substitutions are rejected), in the files sandbox, with a timeout and output caps. Off unless the list is set. |
| `MCP_SERVERS` | MCP bridge — `name=url` pairs, comma-separated. After a restart the model can discover each server's tools (`mcp_list`) and call them (`mcp_call`). |

For local/LAN targets (e.g. testing your own dev servers), also flip **Settings → Web access → Allow local network**.

| Key | Unlocks |
|---|---|
| `EXTRA_ROOTS` | Real directories outside the sandbox, addressed as `root:name/...` — e.g. `EXTRA_ROOTS=~/projects:rw,/var/www:r`. Read/write (`:rw`, default) or read-only (`:r`). Writes outside the sandbox ask for confirmation by default. |
| `AUTO_MODEL` / `AUTO_ENDPOINT` | Tuning for the headless autopilot below. |

## Headless autopilot (server-side, no browser tab)

The UI autopilot runs in a browser tab. There is also a lean server-side runner that keeps working when the tab is closed — same `.env` key, server-side tools only (no `web_search`/`run_code`/media in v1), journaling to `files/autopilot/journal.md`:

```bash
# start a run (defaults: 10 cycles, 30 min, read-only web, no commands)
curl -s localhost:5173/api/auto/start -H 'content-type: application/json' \
  -d '{"goal":"Audit https://example.com: crawl it, note every form and outbound link, write autopilot/audit/report.md"}'

curl -s localhost:5173/api/auto/status   # progress + log tail
curl -s -X POST localhost:5173/api/auto/stop
```

`readOnlyWeb` (default true), `allowCommands`, `allowWrites` and `allowUpdates` are per-run flags on the start call. Without a human to approve prompts, confirm-worthy actions are denied rather than guessed at — flip the flags explicitly when you want more.

## Self-update loop (off by default)

The workspace can accept updates to itself through a chain designed so nothing restarts on a model's word alone:

1. **Propose** — `submit_update(ref)` (interactive or autopilot) writes an HMAC-signed trigger to `data/auto-update.json`. Inert on its own; requires `AUTO_UPDATE=on` + `UPDATE_SECRET` in `.env` even to write.
2. **Verify** — `npm run watch` (a separate process, the only part with restart rights) checks the proposal out into a temp worktree and runs `verify.js` there: syntax checks on every JS file, the inline UI script, path/guard invariant tests against the real code, and a smoke boot of the server on a spare port that must answer HTTP 200.
3. **Apply or roll back** — only then does it fast-forward, restart, and health-check the live server. Failed health check → automatic rollback to the previous commit and restart. Bad verify → nothing happens.

Breakers: `touch data/STOP` (or `AUTO_UPDATE=off`) kills it; max 1 update per 15 min and 10/day; 3 consecutive failed verifies self-disable the watcher until a human deletes `data/watcher.disabled`. Everything lands in `data/updatelog.md`.

Run it: `AUTO_UPDATE=on` + a 16+ char `UPDATE_SECRET` in `.env`, then `npm run watch` in a second terminal.

## Where things live

| Path | What |
|---|---|
| `public/index.html` | The whole UI (one file) |
| `server.js` | Server, API proxy, web search |
| `tools.js` | HTTP, headless Chrome, crawler, files sandbox, memory |
| `data/` | Your chats and memories (not committed) |
| `files/` | Everything GLM downloads or writes (not committed) |

## Safety notes

The server only listens on `127.0.0.1` and rejects requests from other sites. It isn't built to be exposed to the internet: anyone who can reach it can use your API key and its web tools. Tools can't reach your local network unless you enable it, the crawler respects `robots.txt`, and autopilot can be kept read-only on the web.

`run_command` deserves respect: a page the model fetches could try to steer it into running something. That's why it needs an explicit allowlist, has no shell interpretation (no pipes, redirects, or substitution), runs in the sandbox directory, and asks for approval before every run by default. Keep the allowlist to what you actually use, and keep confirmations on for it.
