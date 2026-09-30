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
