// GLM Workspace — tiny zero-dependency server.
// Serves the UI and proxies requests to Z.ai so the API key never touches the browser.
const http = require('http');
const fs = require('fs');
const path = require('path');

// --- load .env ---
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const KEY = process.env.ZAI_API_KEY;
const PORT = Number(process.env.PORT || 5173);
if (!KEY) { console.error('Missing ZAI_API_KEY in .env'); process.exit(1); }

// Only these upstreams are allowed (picked in the UI's settings).
const ENDPOINTS = {
  coding: 'https://api.z.ai/api/coding/paas/v4',   // GLM Coding Plan
  standard: 'https://api.z.ai/api/paas/v4',        // pay-as-you-go balance
};

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

async function proxy(req, res, upstreamPath, method) {
  const endpoint = ENDPOINTS[req.headers['x-endpoint']] || ENDPOINTS.coding;
  const body = method === 'POST' ? await readBody(req) : undefined;
  const ac = new AbortController();
  req.on('close', () => { if (!res.writableEnded) ac.abort(); });
  try {
    const up = await fetch(endpoint + upstreamPath, {
      method,
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body,
      signal: ac.signal,
    });
    res.writeHead(up.status, {
      'Content-Type': up.headers.get('content-type') || 'application/json',
      'Cache-Control': 'no-cache',
    });
    if (!up.body) return res.end();
    for await (const chunk of up.body) res.write(chunk);
    res.end();
  } catch (e) {
    if (ac.signal.aborted) return;
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Proxy error: ' + e.message } }));
  }
}

// Fetch a web page's text for the built-in `fetch_url` tool.
async function fetchUrl(req, res) {
  try {
    const { url } = JSON.parse(await readBody(req));
    if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) URLs allowed');
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 GLM-Workspace' }, signal: AbortSignal.timeout(15000) });
    let text = await r.text();
    text = text.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: r.status, text: text.slice(0, 20000) }));
  } catch (e) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// ---------------------------------------------------------------------------
// Web search. Z.ai's search is included with the Coding Plan via its MCP server;
// Tavily / Brave are optional if you add TAVILY_API_KEY / BRAVE_API_KEY to .env.
// ---------------------------------------------------------------------------
const ZAI_MCP = 'https://api.z.ai/api/mcp/web_search_prime/mcp';
let mcpSession = null;

async function mcpPost(body, session) {
  const r = await fetch(ZAI_MCP, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(session ? { 'mcp-session-id': session } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });
  const text = await r.text();
  // responses come back as SSE; grab the JSON-RPC message from the data: line
  const data = text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).pop();
  return { headers: r.headers, status: r.status, msg: data ? JSON.parse(data) : (text ? JSON.parse(text) : null) };
}

async function mcpInit() {
  const init = await mcpPost({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'glm-workspace', version: '1' } } });
  if (init.msg?.error) throw new Error(init.msg.error.message);
  mcpSession = init.headers.get('mcp-session-id');
  await mcpPost({ jsonrpc: '2.0', method: 'notifications/initialized' }, mcpSession);
}

async function searchZai({ query, recency, domain, location, contentSize }) {
  const args = { search_query: query.slice(0, 70), location: location || 'us', content_size: contentSize || 'medium' };
  if (recency && recency !== 'noLimit') args.search_recency_filter = recency;
  if (domain) args.search_domain_filter = domain;
  const call = () => mcpPost({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name: 'web_search_prime', arguments: args } }, mcpSession);
  if (!mcpSession) await mcpInit();
  let { msg } = await call();
  if (msg?.error) { await mcpInit(); ({ msg } = await call()); } // session may have expired
  if (msg?.error) throw new Error(msg.error.message);
  let text = msg?.result?.content?.find(c => c.type === 'text')?.text ?? '[]';
  if (msg?.result?.isError) throw new Error(text);
  let parsed = JSON.parse(text);
  if (typeof parsed === 'string') parsed = JSON.parse(parsed); // payload is double-encoded
  return (Array.isArray(parsed) ? parsed : []).map(r => ({
    title: r.title,
    // Z.ai sometimes returns relative redirect links that can't be opened
    url: /^https?:\/\//.test(r.link || '') ? r.link : null,
    snippet: r.content,
    site: r.media || undefined,
    date: r.publish_date || undefined,
  }));
}

const TAVILY_RANGE = { oneDay: 'day', oneWeek: 'week', oneMonth: 'month', oneYear: 'year' };
async function searchTavily({ query, recency, domain, count }) {
  const body = { query, max_results: count, search_depth: 'basic' };
  if (TAVILY_RANGE[recency]) body.time_range = TAVILY_RANGE[recency];
  if (domain) body.include_domains = [domain];
  const r = await fetch('https://api.tavily.com/search', {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.TAVILY_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.detail?.error || j.error || `Tavily HTTP ${r.status}`);
  return (j.results || []).map(x => ({ title: x.title, url: x.url, snippet: x.content, date: x.published_date }));
}

const BRAVE_FRESH = { oneDay: 'pd', oneWeek: 'pw', oneMonth: 'pm', oneYear: 'py' };
async function searchBrave({ query, recency, domain, count }) {
  const u = new URL('https://api.search.brave.com/res/v1/web/search');
  u.searchParams.set('q', domain ? `${query} site:${domain}` : query);
  u.searchParams.set('count', String(Math.min(count, 20)));
  if (BRAVE_FRESH[recency]) u.searchParams.set('freshness', BRAVE_FRESH[recency]);
  const r = await fetch(u, { headers: { 'X-Subscription-Token': process.env.BRAVE_API_KEY, Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.detail || `Brave HTTP ${r.status}`);
  return (j.web?.results || []).map(x => ({ title: x.title, url: x.url, snippet: x.description?.replace(/<[^>]+>/g, ''), date: x.age }));
}

const SEARCH_PROVIDERS = {
  zai: { label: 'Z.ai Web Search (Coding Plan)', available: () => true, run: searchZai },
  tavily: { label: 'Tavily', available: () => !!process.env.TAVILY_API_KEY, run: searchTavily },
  brave: { label: 'Brave Search', available: () => !!process.env.BRAVE_API_KEY, run: searchBrave },
};

async function webSearch(req, res) {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  try {
    const opts = JSON.parse(await readBody(req));
    if (!opts.query) return send(200, { error: 'Missing query' });
    const p = SEARCH_PROVIDERS[opts.provider] || SEARCH_PROVIDERS.zai;
    if (!p.available()) return send(200, { error: `${p.label} isn't configured — add its API key to .env` });
    const count = Math.max(1, Math.min(+opts.count || 8, 20));
    const t0 = Date.now();
    const results = (await p.run({ ...opts, count })).slice(0, count);
    send(200, { provider: p.label, query: opts.query, searched_at: new Date().toISOString(), took_ms: Date.now() - t0, results });
  } catch (e) {
    send(200, { error: 'Search failed: ' + e.message });
  }
}

// Chats are persisted to disk (big tool outputs would blow past browser storage limits).
const DATA_DIR = path.join(__dirname, 'data');
const CHATS_FILE = path.join(DATA_DIR, 'chats.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

const tools = require('./tools');
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  // Block DNS-rebinding and cross-site requests: only this app, served from localhost, may call the API.
  if (!ALLOWED_HOSTS.has(req.headers.host)) { res.writeHead(403); return res.end('Forbidden host'); }
  if (url.pathname.startsWith('/api/') && req.method !== 'GET' && req.headers['x-glm-workspace'] !== '1') {
    res.writeHead(403); return res.end('Missing X-GLM-Workspace header');
  }

  if (autoRoute(url.pathname, req, res)) return;
  if (url.pathname.startsWith('/api/tools/') && req.method === 'POST') return tools.handleTool(url.pathname.slice(11), await readBody(req), res);
  if (url.pathname.startsWith('/files/')) return tools.serveFile(url.pathname.slice(7), url.searchParams.has('download'), res, req.headers.range);
  if (url.pathname === '/api/zip') return tools.serveZip(url.searchParams.get('path'), res);
  if (url.pathname === '/api/chats') {
    if (req.method === 'PUT') {
      try {
        const body = await readBody(req);
        JSON.parse(body); // validate before overwriting
        await fs.promises.writeFile(CHATS_FILE + '.tmp', body);
        await fs.promises.rename(CHATS_FILE + '.tmp', CHATS_FILE);
        res.writeHead(204); return res.end();
      } catch (e) { res.writeHead(400); return res.end(e.message); }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(fs.existsSync(CHATS_FILE) ? fs.readFileSync(CHATS_FILE) : 'null');
  }
  if (url.pathname === '/api/search' && req.method === 'POST') return webSearch(req, res);
  if (url.pathname === '/api/search/providers') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(Object.entries(SEARCH_PROVIDERS).map(([id, p]) => ({ id, label: p.label, available: p.available() }))));
  }
  if (url.pathname === '/api/chat' && req.method === 'POST') return proxy(req, res, '/chat/completions', 'POST');
  if (url.pathname === '/api/models') return proxy(req, res, '/models', 'GET');
  if (url.pathname === '/api/fetch' && req.method === 'POST') return fetchUrl(req, res);

  const file = path.join(__dirname, 'public', url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
  if (!file.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, '127.0.0.1', () => console.log(`GLM Workspace → http://localhost:${PORT}`));
