// Server-side tools for GLM: raw HTTP, headless Chrome rendering, crawling, and a files sandbox.
// Everything the model downloads or writes lands in ./files (served at /files/...).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const FILES_ROOT = path.join(__dirname, 'files');
fs.mkdirSync(FILES_ROOT, { recursive: true });

// Extra roots (EXTRA_ROOTS=/abs/path[:rw|:r],... in .env) let the model work on real
// directories outside the files sandbox: read files, run commands with cwd there.
// Paths are addressed as root:<name>/relative. :r roots are read-only for file writes.
const EXTRA_ROOTS = [];
for (const spec of (process.env.EXTRA_ROOTS || '').split(',').map(s => s.trim()).filter(Boolean)) {
  const [raw, mode] = spec.split(':');
  const full = path.resolve(raw.replace(/^~(?=\/|$)/, os.homedir()));
  if (full === FILES_ROOT || full === path.join(__dirname, 'data')) continue;
  EXTRA_ROOTS.push({ name: (path.basename(full) || 'root').replace(/[^A-Za-z0-9_-]/g, '_'), full, write: (mode || 'rw') !== 'r' });
}
function findExtraRoot(full) { return EXTRA_ROOTS.find(r => full === r.full || full.startsWith(r.full + path.sep)); }

const DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const HARD_MAX_CHARS = 500_000;
const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(p => fs.existsSync(p));

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------- files sandbox ---------------- */
function safePath(p = '', { write = false } = {}) {
  const s = String(p);
  const m = s.match(/^root:([A-Za-z0-9_-]+)(?:\/+(.*))?$/);
  if (m) {
    const r = EXTRA_ROOTS.find(x => x.name === m[1]);
    if (!r) throw new Error(`Unknown root "root:${m[1]}". Configured: ${EXTRA_ROOTS.map(x => 'root:' + x.name).join(', ') || '(none — add EXTRA_ROOTS to .env)'}`);
    if (write && !r.write) throw new Error(`root:${r.name} is read-only`);
    const full = path.resolve(r.full, m[2] || '');
    if (full !== r.full && !full.startsWith(r.full + path.sep)) throw new Error('Path escapes the root');
    return full;
  }
  if (/^([A-Za-z]:[\\/]|\/|\\\\)/.test(s)) { // absolute: only inside a configured root
    const full = path.resolve(s);
    const r = findExtraRoot(full);
    if (!r) throw new Error('Absolute paths outside configured roots are not allowed. Use sandbox-relative paths or root:name/... (EXTRA_ROOTS in .env).');
    if (write && !r.write) throw new Error(`root:${r.name} is read-only`);
    return full;
  }
  const full = path.resolve(FILES_ROOT, s.replace(/^\/+/, ''));
  if (full !== FILES_ROOT && !full.startsWith(FILES_ROOT + path.sep)) throw new Error('Path escapes the files sandbox');
  return full;
}
const relPath = full => {
  const r = findExtraRoot(full);
  if (r) return full === r.full ? 'root:' + r.name : 'root:' + r.name + '/' + path.relative(r.full, full).split(path.sep).join('/');
  return path.relative(FILES_ROOT, full).split(path.sep).join('/');
};

async function saveBytes(rel, buf) {
  const full = safePath(rel, { write: true });
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, buf);
  return relPath(full);
}

function urlToPath(u, contentType = '') {
  const url = new URL(u);
  let p; try { p = decodeURIComponent(url.pathname); } catch { p = url.pathname; }
  if (p.endsWith('/')) p += 'index.html';
  if (!path.extname(p) && /html/i.test(contentType)) p += '.html';
  if (url.search) {
    const ext = path.extname(p);
    p = p.slice(0, p.length - ext.length) + '_' + crypto.createHash('md5').update(url.search).digest('hex').slice(0, 8) + ext;
  }
  return url.hostname + p.replace(/[<>:"|?*\\]/g, '_');
}

/* ---------------- network guard ---------------- */
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const l = ip.toLowerCase();
  if (l.startsWith('::ffff:')) return isPrivateIp(l.slice(7));
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80');
}

async function checkUrl(u, allowPrivate) {
  const url = new URL(u);
  if (!/^https?:$/.test(url.protocol)) throw new Error('Only http(s) URLs are allowed');
  if (!allowPrivate) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map(a => a.address);
    if (addrs.some(isPrivateIp)) throw new Error(`Blocked: ${url.hostname} is a local/private address. Turn on "Allow local network" in settings to reach it.`);
  }
  return url;
}

/* ---------------- cookie jars (sessions) ---------------- */
const jars = new Map();

function storeCookies(session, url, setCookies) {
  let jar = jars.get(session) || [];
  for (const sc of setCookies) {
    const [pair, ...attrs] = sc.split(';');
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    const c = { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), domain: url.hostname.toLowerCase(), hostOnly: true, path: '/', expires: null };
    for (const a of attrs) {
      const [k, ...v] = a.trim().split('=');
      const key = k.toLowerCase(), val = v.join('=');
      if (key === 'domain' && val) { c.domain = val.replace(/^\./, '').toLowerCase(); c.hostOnly = false; }
      else if (key === 'path' && val) c.path = val;
      else if (key === 'max-age') c.expires = Date.now() + Number(val) * 1000;
      else if (key === 'expires' && c.expires == null) { const t = Date.parse(val); if (!isNaN(t)) c.expires = t; }
    }
    jar = jar.filter(x => !(x.name === c.name && x.domain === c.domain && x.path === c.path));
    if (c.expires == null || c.expires > Date.now()) jar.push(c);
  }
  jars.set(session, jar);
}

function cookieHeader(session, url) {
  const h = url.hostname.toLowerCase(), now = Date.now();
  return (jars.get(session) || [])
    .filter(c => (c.expires == null || c.expires > now) && (c.hostOnly ? h === c.domain : h === c.domain || h.endsWith('.' + c.domain)) && url.pathname.startsWith(c.path))
    .map(c => `${c.name}=${c.value}`).join('; ');
}

/* ---------------- raw fetch with manual redirects ---------------- */
async function rawFetch({ url, method = 'GET', headers = {}, body, bodyBase64, session, followRedirects = true, userAgent, timeoutMs = 30000, maxBytes = 100e6, allowPrivate }) {
  let current = await checkUrl(url, allowPrivate);
  let m = String(method).toUpperCase();
  let b = bodyBase64 ? Buffer.from(bodyBase64, 'base64') : body;
  const chain = [];
  for (let hop = 0; hop <= 10; hop++) {
    const h = { 'User-Agent': userAgent || DEFAULT_UA, Accept: '*/*', ...headers };
    if (session) { const ck = cookieHeader(session, current); if (ck) h.Cookie = [h.Cookie, ck].filter(Boolean).join('; '); }
    const res = await fetch(current, { method: m, headers: h, body: ['GET', 'HEAD'].includes(m) ? undefined : b, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    if (session) storeCookies(session, current, res.headers.getSetCookie());
    const loc = res.headers.get('location');
    if (followRedirects && res.status >= 300 && res.status < 400 && loc) {
      chain.push({ status: res.status, url: current.href });
      await res.body?.cancel();
      // re-check every hop so a public URL can't bounce us into the local network
      current = await checkUrl(new URL(loc, current).href, allowPrivate);
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && m === 'POST')) { m = 'GET'; b = undefined; }
      continue;
    }
    const chunks = []; let size = 0, capped = false;
    if (res.body) for await (const c of res.body) {
      size += c.length;
      if (size > maxBytes) { capped = true; break; }
      chunks.push(c);
    }
    return { res, url: current.href, chain, buf: Buffer.concat(chunks), capped };
  }
  throw new Error('Too many redirects');
}

/* ---------------- content helpers ---------------- */
function isTextual(ct, buf) {
  if (/^text\/|json|xml|javascript|ecmascript|x-www-form-urlencoded|svg|csv|yaml|toml|graphql/i.test(ct || '')) return true;
  if (/^(image|audio|video|font)\/|octet-stream|zip|pdf|gzip|x-tar|wasm|protobuf|msword|officedocument/i.test(ct || '')) return false;
  return !buf.subarray(0, 4096).includes(0);
}

function decode(buf, ct = '') {
  const cs = (ct.match(/charset=["']?([\w-]+)/i) || [])[1] || 'utf-8';
  try { return new TextDecoder(cs).decode(buf); } catch { return new TextDecoder('utf-8').decode(buf); }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', copy: '©', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
const decodeEntities = s => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return isNaN(n) ? m : String.fromCodePoint(n); }
  return ENTITIES[e.toLowerCase()] ?? m;
});

function htmlToText(html) {
  return decodeEntities(html
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/header|\/footer)[^>]*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\f\r]+/g, ' ').replace(/\n\s*/g, '\n')
    .replace(/^[•\s]*$/gm, '') // drop empty list items (icon-only nav links etc.)
    .replace(/\n{3,}/g, '\n\n').trim();
}

const htmlTitle = html => decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').trim();
const ASSET_EXT = /\.(css|js|mjs|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|pdf|zip|gz|tar|dmg|exe|json|xml|txt|csv)$/i;

function extractLinks(html, base) {
  const links = [], assets = [], seenL = new Set(), seenA = new Set();
  const abs = u => { try { const x = new URL(decodeEntities(u.trim()), base); x.hash = ''; return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; } };
  for (const m of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a>/gi)) {
    const u = abs(m[1]); if (!u || seenL.has(u)) continue;
    seenL.add(u); links.push({ url: u, text: htmlToText(m[2]).slice(0, 100) });
  }
  const addAsset = raw => { const u = abs(raw); if (u && !seenA.has(u)) { seenA.add(u); assets.push(u); } };
  for (const m of html.matchAll(/<(?:img|script|source|iframe|video|audio|embed)\b[^>]*?\bsrc\s*=\s*["']?([^"'\s>]+)/gi)) addAsset(m[1]);
  for (const m of html.matchAll(/<link\b[^>]*?\bhref\s*=\s*["']?([^"'\s>]+)/gi)) addAsset(m[1]);
  for (const m of html.matchAll(/\bsrcset\s*=\s*["']([^"']+)["']/gi)) m[1].split(',').forEach(s => addAsset(s.trim().split(/\s+/)[0]));
  return { links, assets };
}

// Page a big string: returns the slice plus what the model needs to ask for the next chunk.
function page(text, offset = 0, maxChars = 50000) {
  maxChars = Math.max(1, Math.min(Number(maxChars) || 50000, HARD_MAX_CHARS));
  offset = Math.max(0, Number(offset) || 0);
  const slice = text.slice(offset, offset + maxChars);
  const end = offset + slice.length;
  return { body: slice, total_chars: text.length, offset, truncated: end < text.length, ...(end < text.length ? { next_offset: end } : {}) };
}

/* ---------------- tools ---------------- */
async function http_request(o) {
  const format = o.format || 'raw';
  const method = (o.method || 'GET').toUpperCase();
  const r = await rawFetch({
    url: o.url, method, headers: o.headers || {}, body: o.body, bodyBase64: o.body_base64, session: o.session,
    followRedirects: o.follow_redirects !== false, userAgent: o.userAgent, allowPrivate: o.allowPrivate,
    maxBytes: o.maxBytes, timeoutMs: Math.min(Number(o.timeout_ms) || 30000, 120000),
  });
  const headers = Object.fromEntries(r.res.headers);
  const sc = r.res.headers.getSetCookie(); if (sc.length) headers['set-cookie'] = sc;
  const ct = r.res.headers.get('content-type') || '';
  const text = isTextual(ct, r.buf);
  const out = {
    status: r.res.status, status_text: r.res.statusText, url: r.url, ...(r.chain.length ? { redirects: r.chain } : {}),
    headers, content_type: ct, size_bytes: r.buf.length, sha256: crypto.createHash('sha256').update(r.buf).digest('hex'),
    is_text: text, ...(r.capped ? { size_capped: `Stopped at the ${Math.round(o.maxBytes / 1e6)}MB download limit` } : {}),
    ...(o.session ? { session: o.session } : {}),
  };
  let saveTo = o.save_to;
  if (!saveTo && !text && r.buf.length && method !== 'HEAD') saveTo = 'auto'; // binary always lands on disk
  if (saveTo) out.saved_to = await saveBytes(saveTo === 'auto' ? 'downloads/' + urlToPath(r.url, ct) : saveTo, r.buf);
  if (format === 'headers' || method === 'HEAD') return out;
  if (!text) {
    out.note = `Binary content (${r.buf.length} bytes) saved to files/${out.saved_to}. Use read_file with encoding "base64" to inspect bytes.`;
    out.base64_preview = r.buf.subarray(0, 96).toString('base64');
    return out;
  }
  const body = decode(r.buf, ct);
  if (format === 'links') {
    const { links, assets } = extractLinks(body, r.url);
    return { ...out, title: htmlTitle(body), links: links.slice(0, 500), assets: assets.slice(0, 500), link_count: links.length, asset_count: assets.length };
  }
  const content = format === 'text' ? htmlToText(body) : body;
  return { ...out, ...(format === 'text' ? { title: htmlTitle(body) } : {}), ...page(content, o.offset, o.max_chars ?? o.maxChars) };
}

// Chrome often finishes its work but lingers (updater/helpers), so we poll for "done"
// and then kill the whole process group ourselves.
function runChrome(args, timeoutMs, isDone) {
  return new Promise((resolve, reject) => {
    const p = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    const out = [];
    let lastLen = -1, finished = false;
    const kill = () => { try { process.kill(-p.pid, 'SIGKILL'); } catch { try { p.kill('SIGKILL'); } catch {} } };
    const finish = (err, val) => { if (finished) return; finished = true; clearInterval(poll); clearTimeout(t); kill(); err ? reject(err) : resolve(val); };
    p.stdout.on('data', d => out.push(d));
    const poll = setInterval(() => {
      const buf = Buffer.concat(out);
      // done once the check passes and output has stopped growing
      if (isDone(buf) && buf.length === lastLen) finish(null, buf.toString('utf8'));
      lastLen = buf.length;
    }, 300);
    const t = setTimeout(() => finish(new Error('Headless Chrome timed out')), timeoutMs);
    p.on('error', e => finish(e));
    p.on('close', () => finish(null, Buffer.concat(out).toString('utf8')));
  });
}

async function render_page(o) {
  if (!CHROME) throw new Error('No Chrome/Chromium found on this machine');
  const url = await checkUrl(o.url, o.allowPrivate);
  const wait = Math.min(Math.max(Number(o.wait_ms) || 5000, 500), 60000);
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'glm-chrome-'));
  const base = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
    '--disable-extensions', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-service-autorun',
    '--use-mock-keychain', '--password-store=basic', `--user-data-dir=${tmp}`, `--virtual-time-budget=${wait}`, `--window-size=${o.window_size || '1280,2000'}`,
    `--user-agent=${o.userAgent || DEFAULT_UA}`];
  try {
    const dom = await runChrome([...base, '--dump-dom', url.href], wait + 45000, b => /<\/html>\s*$/i.test(b.subarray(-64).toString()));
    const out = { url: url.href, rendered: true, title: htmlTitle(dom), html_chars: dom.length };
    if (o.screenshot) {
      const rel = o.screenshot_path || `screenshots/${url.hostname}-${Date.now()}.png`;
      const full = safePath(rel);
      await fsp.mkdir(path.dirname(full), { recursive: true });
      await fsp.rm(full, { force: true });
      await runChrome([...base, `--screenshot=${full}`, url.href], wait + 45000, () => { try { return fs.statSync(full).size > 0; } catch { return false; } });
      out.screenshot_saved_to = relPath(full);
    }
    if (o.save_to) out.saved_to = await saveBytes(o.save_to === 'auto' ? 'rendered/' + urlToPath(url.href, 'text/html') : o.save_to, Buffer.from(dom));
    const format = o.format || 'text';
    if (format === 'links') { const { links, assets } = extractLinks(dom, url.href); return { ...out, links: links.slice(0, 500), assets: assets.slice(0, 500), link_count: links.length }; }
    return { ...out, ...page(format === 'html' ? dom : htmlToText(dom), o.offset, o.max_chars ?? o.maxChars) };
  } finally {
    fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

async function loadRobots(origin, ua) {
  try {
    const r = await fetch(new URL('/robots.txt', origin), { headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const groups = []; let cur = { agents: [], rules: [] }, inRules = false;
    for (const raw of (await r.text()).split('\n')) {
      const line = raw.replace(/#.*/, '').trim(); if (!line.includes(':')) continue;
      const i = line.indexOf(':'), key = line.slice(0, i).trim().toLowerCase(), val = line.slice(i + 1).trim();
      if (key === 'user-agent') { if (inRules) { groups.push(cur); cur = { agents: [], rules: [] }; inRules = false; } cur.agents.push(val.toLowerCase()); }
      else if (key === 'allow' || key === 'disallow') { inRules = true; if (val) cur.rules.push({ allow: key === 'allow', path: val, re: new RegExp('^' + val.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$')) }); }
    }
    groups.push(cur);
    const rules = groups.filter(g => g.agents.includes('*')).flatMap(g => g.rules);
    // longest matching rule wins
    return p => { let best = null; for (const r of rules) if (r.re.test(p) && (!best || r.path.length > best.path.length)) best = r; return !best || best.allow; };
  } catch { return null; }
}

async function crawl_site(o) {
  const start = await checkUrl(o.url, o.allowPrivate);
  const maxPages = Math.min(Math.max(Number(o.max_pages) || 25, 1), 500);
  const maxDepth = Math.min(Math.max(Number(o.max_depth ?? 2), 0), 10);
  const sameOrigin = o.same_origin !== false;
  const include = o.include ? new RegExp(o.include) : null, exclude = o.exclude ? new RegExp(o.exclude) : null;
  const ua = o.userAgent || DEFAULT_UA;
  const delay = Math.max(Number(o.delayMs ?? 250), 0);
  const outDir = `crawls/${start.hostname}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  const robots = o.respectRobots !== false ? await loadRobots(start.origin, ua) : null;
  const deadline = Date.now() + 5 * 60 * 1000;
  start.hash = '';
  const seen = new Set([start.href]), queue = [{ url: start.href, depth: 0 }], assetSet = new Set();
  const pages = [], errors = [], skipped = { robots: 0, offsite: 0, filtered: 0 };

  while (queue.length && pages.length < maxPages && Date.now() < deadline) {
    const { url, depth } = queue.shift();
    const u = new URL(url);
    if (robots && !robots(u.pathname + u.search)) { skipped.robots++; continue; }
    try {
      const r = await rawFetch({ url, userAgent: ua, allowPrivate: o.allowPrivate, session: o.session, maxBytes: 25e6, timeoutMs: 20000 });
      const ct = r.res.headers.get('content-type') || '';
      const entry = { url, status: r.res.status, bytes: r.buf.length, type: ct.split(';')[0], depth };
      if (r.url !== url) entry.final_url = r.url;
      if (/html/i.test(ct)) {
        const html = decode(r.buf, ct);
        entry.title = htmlTitle(html).slice(0, 120);
        const { links, assets } = extractLinks(html, r.url);
        entry.links = links.length;
        for (const l of links) {
          if (seen.has(l.url)) continue;
          seen.add(l.url);
          const lu = new URL(l.url);
          if (sameOrigin && lu.origin !== start.origin) { skipped.offsite++; continue; }
          if ((include && !include.test(l.url)) || (exclude && exclude.test(l.url))) { skipped.filtered++; continue; }
          if (ASSET_EXT.test(lu.pathname)) { if (o.save_assets) assetSet.add(l.url); continue; }
          if (depth < maxDepth) queue.push({ url: l.url, depth: depth + 1 });
        }
        if (o.save_assets) for (const a of assets) if (!sameOrigin || new URL(a).origin === start.origin) assetSet.add(a);
      }
      if (o.save !== false) entry.saved_to = await saveBytes(`${outDir}/${urlToPath(r.url, ct)}`, r.buf);
      pages.push(entry);
    } catch (e) { errors.push({ url, error: e.message }); }
    if (delay) await sleep(delay);
  }

  const assetsSaved = []; let assetErrors = 0;
  if (o.save_assets) for (const a of [...assetSet].slice(0, 400)) {
    if (Date.now() > deadline) break;
    try {
      const r = await rawFetch({ url: a, userAgent: ua, allowPrivate: o.allowPrivate, session: o.session, maxBytes: 50e6, timeoutMs: 20000 });
      if (r.res.ok) assetsSaved.push(await saveBytes(`${outDir}/${urlToPath(r.url, r.res.headers.get('content-type') || '')}`, r.buf));
      else assetErrors++;
    } catch { assetErrors++; }
    if (delay) await sleep(Math.min(delay, 100));
  }

  const summary = {
    start_url: start.href, output_dir: o.save !== false ? outDir : null, pages_fetched: pages.length,
    total_bytes: pages.reduce((a, p) => a + p.bytes, 0), still_queued: queue.length, skipped, errors: errors.slice(0, 50),
    ...(o.save_assets ? { assets_saved: assetsSaved.length, asset_errors: assetErrors } : {}),
    robots_txt: robots ? 'respected' : o.respectRobots === false ? 'ignored' : 'none found',
    timed_out: Date.now() > deadline, pages,
  };
  if (o.save !== false) await saveBytes(`${outDir}/_crawl.json`, Buffer.from(JSON.stringify(summary, null, 2)));
  return summary;
}

async function list_files(o = {}) {
  const root = safePath(o.path || '');
  const out = [];
  async function walk(dir, depth) {
    let entries; try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= 2000) return;
      const full = path.join(dir, e.name);
      const st = await fsp.stat(full).catch(() => null); if (!st) continue;
      out.push({ path: relPath(full), type: e.isDirectory() ? 'dir' : 'file', size: e.isDirectory() ? undefined : st.size, modified: st.mtime.toISOString() });
      if (e.isDirectory() && o.recursive !== false && depth < 12) await walk(full, depth + 1);
    }
  }
  const st = await fsp.stat(root).catch(() => null);
  if (!st) throw new Error(`Not found: ${o.path}`);
  if (!st.isDirectory()) return { files: [{ path: relPath(root), type: 'file', size: st.size, modified: st.mtime.toISOString() }] };
  await walk(root, 0);
  return { root: relPath(root) || '/', count: out.length, total_bytes: out.reduce((a, f) => a + (f.size || 0), 0), files: out };
}

async function read_file(o) {
  const full = safePath(o.path);
  const st = await fsp.stat(full);
  if (st.isDirectory()) return list_files({ path: o.path });
  if (o.encoding === 'base64') {
    const offset = Math.max(0, Number(o.offset) || 0);
    const len = Math.min(Math.floor((Number(o.max_chars) || 40000) * 3 / 4), 3e5);
    const fh = await fsp.open(full);
    try {
      const buf = Buffer.alloc(Math.max(0, Math.min(len, st.size - offset)));
      await fh.read(buf, 0, buf.length, offset);
      const end = offset + buf.length;
      return { path: relPath(full), size_bytes: st.size, encoding: 'base64', byte_offset: offset, bytes_returned: buf.length, data: buf.toString('base64'), ...(end < st.size ? { next_offset: end } : {}) };
    } finally { await fh.close(); }
  }
  if (st.size > 50e6) throw new Error('File too large to read as text (50MB max); use encoding "base64" to page through bytes');
  const buf = await fsp.readFile(full);
  if (!isTextual('', buf)) return { path: relPath(full), size_bytes: st.size, note: 'Looks binary. Use encoding "base64" to read bytes.' };
  return { path: relPath(full), size_bytes: st.size, ...page(buf.toString('utf8'), o.offset, o.max_chars) };
}

async function write_file(o) {
  if (!o.path) throw new Error('path is required');
  const full = safePath(o.path, { write: true });
  if (full === FILES_ROOT) throw new Error('Invalid path');
  await fsp.mkdir(path.dirname(full), { recursive: true });
  const data = o.encoding === 'base64' ? Buffer.from(o.content || '', 'base64') : Buffer.from(o.content ?? '', 'utf8');
  await (o.append ? fsp.appendFile : fsp.writeFile)(full, data);
  const st = await fsp.stat(full);
  return { path: relPath(full), bytes_written: data.length, size_bytes: st.size, appended: !!o.append };
}

async function delete_file(o) {
  const full = safePath(o.path, { write: true });
  if (full === FILES_ROOT) throw new Error('Refusing to delete the whole sandbox');
  const st = await fsp.stat(full);
  await fsp.rm(full, { recursive: true, force: true });
  return { deleted: relPath(full), type: st.isDirectory() ? 'dir' : 'file' };
}

async function clear_sessions(o = {}) {
  if (o.session) jars.delete(o.session); else jars.clear();
  return { cleared: o.session || 'all', remaining: [...jars.keys()] };
}

async function capabilities() {
  return { chrome: !!CHROME, images: !!process.env.OPENAI_API_KEY, audio: !!process.env.OPENAI_API_KEY, videos: !!process.env.ATLASCLOUD_API_KEY, github: !!process.env.GITHUB_TOKEN, shell: commandAllowlist().length > 0, shell_allowlist: commandAllowlist(), mcp: mcpServers().length > 0, chrome_path: CHROME || null, files_root: FILES_ROOT, sessions: [...jars.keys()],
    extra_roots: EXTRA_ROOTS.map(r => ({ name: r.name, write: r.write })),
    self_update: readEnvFile().AUTO_UPDATE === 'on' && !!(readEnvFile().UPDATE_SECRET || '') };
}

/* ---------------- image generation (OpenAI) ---------------- */
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

async function generate_image(o) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('Image generation is not set up: add OPENAI_API_KEY to .env and restart the server.');
  const prompt = String(o.prompt || '').trim();
  if (!prompt) throw new Error('prompt is required');
  const model = o.model || 'gpt-image-2';
  const format = ['png', 'jpeg', 'webp'].includes(o.format) ? o.format : 'png';
  const opts = { size: o.size || 'auto', quality: o.quality || 'auto', output_format: format, ...(o.background ? { background: o.background } : {}) };
  const refs = (Array.isArray(o.reference_images) ? o.reference_images : []).slice(0, 10);
  let r;
  if (refs.length) {
    // edit / remix existing images from the sandbox
    const form = new FormData();
    form.append('model', model); form.append('prompt', prompt);
    for (const [k, v] of Object.entries(opts)) form.append(k, v);
    for (const ref of refs) {
      const full = safePath(ref);
      const type = IMAGE_TYPES[path.extname(full).toLowerCase()];
      if (!type) throw new Error(`${ref}: reference images must be PNG, JPEG, WebP or GIF`);
      form.append('image[]', new Blob([await fsp.readFile(full)], { type }), path.basename(full));
    }
    r = await fetch('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(300000) });
  } else {
    r = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, n: 1, ...opts }), signal: AbortSignal.timeout(300000),
    });
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`OpenAI: ${j.error?.message || 'HTTP ' + r.status}`);
  const item = j.data?.[0];
  const buf = item?.b64_json ? Buffer.from(item.b64_json, 'base64')
    : item?.url ? Buffer.from(await (await fetch(item.url, { signal: AbortSignal.timeout(60000) })).arrayBuffer())
    : null;
  if (!buf) throw new Error('OpenAI returned no image');
  const slug = prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'image';
  const rel = o.save_to || `images/${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}-${slug}.${format === 'jpeg' ? 'jpg' : format}`;
  const saved = await saveBytes(rel, buf);
  return {
    saved_to: saved, model, size: j.size || opts.size, quality: j.quality || opts.quality, bytes: buf.length,
    ...(refs.length ? { edited_from: refs } : {}), ...(item.revised_prompt ? { revised_prompt: item.revised_prompt } : {}),
    ...(j.usage ? { usage: j.usage } : {}),
  };
}

/* ---------------- video generation (Atlas Cloud, e.g. ByteDance Seedance) ----------------
   Async: submit a prediction, poll it, then download the outputs (video, plus last frame if asked). */
const ATLAS = 'https://api.atlascloud.ai/api/v1/model';
const videoJobs = new Map(); // prediction id -> { rel, prompt, saved, finishing }

async function atlas(pathname, init = {}) {
  const r = await fetch(ATLAS + pathname, {
    ...init,
    headers: { Authorization: `Bearer ${process.env.ATLASCLOUD_API_KEY}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers || {}) },
    signal: AbortSignal.timeout(60000),
  });
  const j = await r.json().catch(() => ({}));
  const failed = !r.ok || (typeof j.code === 'number' && j.code !== 0 && j.code !== 200);
  if (failed) throw new Error(`Atlas Cloud: ${j.msg || j.message || 'HTTP ' + r.status}`);
  return j.data;
}

async function finishVideo(id, pred) {
  const job = videoJobs.get(id) || {};
  if (job.saved) return job.saved;
  job.finishing ||= (async () => {
    const outputs = (pred.outputs || []).filter(u => typeof u === 'string');
    if (!outputs.length) throw new Error('Atlas Cloud finished but returned no output');
    const base = (job.rel || `videos/${id}.mp4`).replace(/\.\w+$/, '');
    const result = { video_id: id, status: 'completed' };
    for (const url of outputs) {
      const r = await fetch(url, { signal: AbortSignal.timeout(300000) });
      if (!r.ok) continue;
      const type = (r.headers.get('content-type') || '').split(';')[0];
      const buf = Buffer.from(await r.arrayBuffer());
      const urlExt = (new URL(url).pathname.match(/\.(\w+)$/) || [])[1]?.toLowerCase();
      if (!result.saved_to && (type.startsWith('video/') || ['mp4', 'mov', 'webm'].includes(urlExt))) {
        result.saved_to = await saveBytes(`${base}.${urlExt && ['mp4', 'mov', 'webm'].includes(urlExt) ? urlExt : 'mp4'}`, buf);
        result.bytes = buf.length;
      } else if (!result.thumbnail && (type.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp'].includes(urlExt))) {
        result.thumbnail = await saveBytes(`${base}.last-frame.${urlExt && ['png', 'jpg', 'jpeg', 'webp'].includes(urlExt) ? urlExt : 'jpg'}`, buf);
      }
    }
    if (!result.saved_to) throw new Error('Could not download the video output');
    job.saved = result; videoJobs.set(id, job);
    return result;
  })();
  videoJobs.set(id, job);
  try { return await job.finishing; } catch (e) { job.finishing = null; throw e; }
}

async function waitVideo(id, waitMs) {
  const deadline = Date.now() + Math.min(Math.max(Number(waitMs) || 0, 0), 600000);
  for (;;) {
    const pred = await atlas(`/prediction/${encodeURIComponent(id)}`);
    const status = String(pred?.status || '').toLowerCase();
    if (status === 'completed' || status === 'succeeded') return finishVideo(id, pred);
    if (status === 'failed' || status === 'timeout') return { video_id: id, status, error: pred.error || (status === 'timeout' ? 'Generation timed out on Atlas Cloud' : 'Generation failed') };
    if (Date.now() >= deadline) return { video_id: id, status: status || 'processing', hint: 'Still rendering. Check again with video_status.' };
    await sleep(Math.min(4000, Math.max(0, deadline - Date.now())));
  }
}

async function generate_video(o) {
  if (!process.env.ATLASCLOUD_API_KEY) throw new Error('Video generation is not set up: add ATLASCLOUD_API_KEY to .env and restart the server.');
  const prompt = String(o.prompt || '').trim();
  if (!prompt) throw new Error('prompt is required');
  const body = {
    model: o.model || 'bytedance/seedance-2.5/text-to-video',
    prompt,
    duration: Number(o.duration) || 5,
    resolution: o.resolution || '720p',
    ratio: o.ratio || 'adaptive',
    generate_audio: o.generate_audio !== false,
    watermark: false,
    return_last_frame: true, // gives GLM an image to check with look_at_image
    output_format: 'mp4',
  };
  const data = await atlas('/generateVideo', { method: 'POST', body: JSON.stringify(body) });
  if (!data?.id) throw new Error('Atlas Cloud did not return a job id');
  const slug = prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'video';
  videoJobs.set(data.id, { prompt, rel: `videos/${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}-${slug}.mp4` });
  const out = await waitVideo(data.id, o.wait_ms ?? 300000);
  return { ...out, model: body.model, duration: body.duration, resolution: body.resolution, ratio: body.ratio };
}

async function video_status(o = {}) {
  if (!o.video_id) return { videos: [...videoJobs.entries()].slice(-15).map(([id, j]) => ({ video_id: id, prompt: j.prompt?.slice(0, 80), ...(j.saved ? { saved_to: j.saved.saved_to } : { status: 'not finished, or not checked since' }) })) };
  return waitVideo(o.video_id, o.wait_ms ?? 60000);
}

/* ---------------- ears: transcription + audio understanding (OpenAI) ----------------
   The browser decodes any audio/video file into mono WAV chunks under audio/.cache/;
   these tools send them to OpenAI, then delete the chunks. */
const AUDIO_CACHE = 'audio/.cache/';

function requireOpenAI() {
  if (!process.env.OPENAI_API_KEY) throw new Error('Audio is not set up: add OPENAI_API_KEY to .env and restart the server.');
}
async function readCacheChunk(rel) {
  if (!String(rel).startsWith(AUDIO_CACHE)) throw new Error('Audio chunks must come from audio/.cache/');
  return fsp.readFile(safePath(rel));
}
const dropCache = rels => Promise.all(rels.map(r => fsp.rm(safePath(r), { force: true }).catch(() => {})));
const clock = s => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };

async function transcribe_chunks(o) {
  requireOpenAI();
  const chunks = Array.isArray(o.chunks) ? o.chunks : [];
  if (!chunks.length) throw new Error('No audio to transcribe');
  const model = o.model || 'gpt-4o-transcribe-diarize';
  const diarize = /diarize/.test(model) && o.speakers !== false;
  const segments = []; const texts = [];
  try {
    for (const [i, c] of chunks.entries()) {
      const form = new FormData();
      form.append('file', new Blob([await readCacheChunk(c.path)], { type: 'audio/wav' }), `chunk-${i}.wav`);
      form.append('model', model);
      form.append('response_format', diarize ? 'diarized_json' : model === 'whisper-1' ? 'verbose_json' : 'json');
      if (diarize) form.append('chunking_strategy', 'auto');
      if (o.language) form.append('language', o.language);
      const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: form, signal: AbortSignal.timeout(600000),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`OpenAI: ${j.error?.message || 'HTTP ' + r.status}`);
      const off = Number(c.offset_s) || 0;
      if (Array.isArray(j.segments) && j.segments.length) {
        for (const sg of j.segments) segments.push({ start: +(off + (sg.start || 0)).toFixed(1), end: +(off + (sg.end || 0)).toFixed(1), ...(sg.speaker ? { speaker: chunks.length > 1 ? `${i + 1}${sg.speaker}` : sg.speaker } : {}), text: String(sg.text || '').trim() });
      }
      texts.push(String(j.text || (j.segments || []).map(sg => sg.text).join(' ')).trim());
    }
  } finally { await dropCache(chunks.map(c => c.path)); }

  const text = texts.join('\n\n').trim();
  const source = String(o.source || 'audio');
  const lines = segments.length
    ? segments.map(sg => `[${clock(sg.start)}]${sg.speaker ? ` **${sg.speaker}:**` : ''} ${sg.text}`)
    : [text];
  const md = `# Transcript: ${path.basename(source)}\n\n_Source: ${source} · model: ${model} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}_\n\n${lines.join('\n\n')}\n`;
  const base = path.basename(source).replace(/\.[^.]+$/, '') || 'audio';
  const saved = await saveBytes(o.save_to || `audio/transcripts/${base}.md`, Buffer.from(md));
  const readable = segments.length ? lines.join('\n') : text;
  return {
    source, model, saved_to: saved, duration_s: o.duration_s, chunks: chunks.length,
    ...(diarize && chunks.length > 1 ? { note: 'Speaker labels restart in each 10-minute chunk (1A, 2A…), so the same person can have different labels across chunks.' } : {}),
    ...(segments.length ? { speakers: [...new Set(segments.map(sg => sg.speaker).filter(Boolean))] } : {}),
    transcript: readable.length > 60000 ? readable.slice(0, 60000) + `\n…[truncated; full transcript in ${saved}]` : readable,
  };
}

async function listen_audio(o) {
  requireOpenAI();
  const chunk = o.chunk;
  if (!chunk?.path) throw new Error('No audio to listen to');
  try {
    const data = (await readCacheChunk(chunk.path)).toString('base64');
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: o.model || 'gpt-audio-1.5', modalities: ['text'],
        messages: [{ role: 'user', content: [
          { type: 'text', text: `Listen carefully to this audio and answer the question. Describe what you actually hear (speech, voices and tone, music, sound effects, background, quality) and say when you're unsure.\n\nQuestion: ${o.question || 'Describe everything you hear in detail.'}` },
          { type: 'input_audio', input_audio: { data, format: 'wav' } },
        ] }],
      }),
      signal: AbortSignal.timeout(300000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`OpenAI: ${j.error?.message || 'HTTP ' + r.status}`);
    let answer = (j.choices?.[0]?.message?.content || '').trim();
    // the model sometimes wraps its answer as {"analysis": "..."}; unwrap single-field JSON
    try { const parsed = JSON.parse(answer); const vals = Object.values(parsed || {}); if (vals.length === 1 && typeof vals[0] === 'string') answer = vals[0]; } catch {}
    return { source: o.source, model: o.model || 'gpt-audio-1.5', heard: `${clock(chunk.offset_s || 0)}–${clock((chunk.offset_s || 0) + (chunk.duration_s || 0))}`, answer };
  } finally { await dropCache([chunk.path]); }
}

/* ---------------- long-term memory + past chats ---------------- */
const DATA_DIR = path.join(__dirname, 'data');
const MEMORY_FILE = path.join(DATA_DIR, 'memory.json');
const CHATS_FILE = path.join(DATA_DIR, 'chats.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

async function loadMemory() {
  try { return JSON.parse(await fsp.readFile(MEMORY_FILE, 'utf8')); } catch { return []; }
}
// serialize read-modify-write so parallel tool calls can't clobber each other
let memoryQueue = Promise.resolve();
function withMemory(fn) {
  const run = memoryQueue.then(async () => {
    const list = await loadMemory();
    const result = await fn(list);
    await fsp.writeFile(MEMORY_FILE + '.tmp', JSON.stringify(list, null, 2));
    await fsp.rename(MEMORY_FILE + '.tmp', MEMORY_FILE);
    return result;
  });
  memoryQueue = run.catch(() => {});
  return run;
}
const memId = () => crypto.randomBytes(3).toString('hex');

async function memory_list() {
  const list = await loadMemory();
  return { count: list.length, memories: list };
}

async function remember(o) {
  const text = String(o.text || '').trim();
  if (!text) throw new Error('text is required');
  if (text.length > 2000) throw new Error('Keep each memory short (under 2000 characters). Split it up or save details to a file.');
  return withMemory(list => {
    const dup = list.find(m => m.text.toLowerCase() === text.toLowerCase());
    if (dup) return { saved: false, note: 'Already in memory', id: dup.id };
    const m = { id: memId(), text, created: new Date().toISOString(), source: o.source === 'user' ? 'user' : 'glm' };
    list.push(m);
    return { saved: true, id: m.id, total_memories: list.length };
  });
}

async function update_memory(o) {
  const text = String(o.text || '').trim();
  if (!text) throw new Error('text is required');
  return withMemory(list => {
    const m = list.find(x => x.id === o.id);
    if (!m) throw new Error(`No memory with id ${o.id}`);
    const old = m.text; m.text = text; m.updated = new Date().toISOString();
    return { updated: m.id, was: old, now: text };
  });
}

async function forget(o) {
  return withMemory(list => {
    const i = list.findIndex(x => x.id === o.id);
    if (i < 0) throw new Error(`No memory with id ${o.id}`);
    const [m] = list.splice(i, 1);
    return { forgotten: m.text, remaining: list.length };
  });
}

async function memory_clear() {
  return withMemory(list => { const n = list.length; list.length = 0; return { cleared: n }; });
}

async function loadChats() {
  try { return JSON.parse(await fsp.readFile(CHATS_FILE, 'utf8')) || []; } catch { return []; }
}

async function search_chats(o = {}) {
  const chats = await loadChats();
  const limit = Math.min(Math.max(Number(o.limit) || 20, 1), 100);
  const day = c => new Date(c.updated || c.created || 0).toISOString().slice(0, 10);
  const q = String(o.query || '').trim().toLowerCase();
  if (!q) {
    return { total_chats: chats.length, chats: chats.slice(0, limit).map(c => ({ chat_id: c.id, title: c.title, date: day(c), messages: c.messages.length, ...(c.id === o.current_chat_id ? { current: true } : {}) })) };
  }
  const words = q.split(/\s+/).filter(Boolean);
  const hits = [];
  for (const c of chats) {
    for (const [i, m] of c.messages.entries()) {
      if (!['user', 'assistant'].includes(m.role) || m.auto || m.note) continue;
      const text = m.content || '', low = text.toLowerCase();
      if (!words.every(w => low.includes(w))) continue;
      const at = low.includes(q) ? low.indexOf(q) : low.indexOf(words[0]);
      const start = Math.max(0, at - 160), end = Math.min(text.length, at + 260);
      hits.push({
        chat_id: c.id, chat_title: c.title, date: day(c), message_index: i, role: m.role,
        snippet: (start ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ') + (end < text.length ? '…' : ''),
        ...(c.id === o.current_chat_id ? { current_chat: true } : {}),
      });
    }
  }
  return { query: o.query, total_matches: hits.length, results: hits.slice(0, limit) };
}

async function read_chat(o) {
  const c = (await loadChats()).find(x => x.id === o.chat_id);
  if (!c) throw new Error(`No chat with id ${o.chat_id}. Use search_chats to find ids.`);
  const offset = Math.max(0, Number(o.offset) || 0), limit = Math.min(Math.max(Number(o.limit) || 20, 1), 100);
  const clip = (t, n) => t.length > n ? t.slice(0, n) + `…[${t.length - n} more chars]` : t;
  const msgs = c.messages.slice(offset, offset + limit).map((m, k) => ({
    i: offset + k, role: m.note || m.auto ? 'autopilot' : m.role,
    ...(m.role === 'tool' ? { tool: m.name, content: clip(m.content || '', 600) } : { content: clip(m.content || '', 4000) }),
    ...(m.tool_calls?.length ? { called: m.tool_calls.map(t => t.function.name) } : {}),
  }));
  const next = offset + msgs.length;
  return { chat_id: c.id, title: c.title, total_messages: c.messages.length, messages: msgs, ...(next < c.messages.length ? { next_offset: next } : {}) };
}

/* ---------------- GitHub API (token stays in .env, never shown to the model) ---------------- */
async function github_api(o) {
  const key = process.env.GITHUB_TOKEN;
  if (!key) throw new Error('github_api is not set up: add GITHUB_TOKEN to .env and restart the server.');
  const p = String(o.path || '');
  if (!p.startsWith('/') || p.startsWith('//')) throw new Error('path must be an absolute API path like /repos/owner/repo');
  const url = new URL(p, 'https://api.github.com');
  if (url.origin !== 'https://api.github.com') throw new Error('Only api.github.com is allowed');
  const method = String(o.method || 'GET').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)) throw new Error('Unsupported method ' + method);
  const headers = {
    Authorization: `Bearer ${key}`,
    Accept: o.accept || 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'glm-workspace',
  };
  let body;
  if (o.body != null) { headers['Content-Type'] = 'application/json'; body = typeof o.body === 'string' ? o.body : JSON.stringify(o.body); }
  const r = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(Math.min(Number(o.timeout_ms) || 30000, 120000)) });
  const rl = k => r.headers.get('x-ratelimit-' + k);
  const out = {
    status: r.status, status_text: r.statusText, url: r.url,
    rate_limit: { limit: rl('limit'), remaining: rl('remaining') },
    ...(r.headers.get('link') ? { pagination: r.headers.get('link') } : {}),
  };
  const text = await r.text();
  if (text) { try { out.body = JSON.parse(text); } catch { out.body = text.slice(0, 50000); } }
  return out;
}

/* ---------------- shell: run_command (allowlisted binaries, executed WITHOUT a shell) ---------------- */
function commandAllowlist() {
  return (process.env.COMMAND_ALLOWLIST || '').split(',').map(s => s.trim().replace(/^\/+/, '')).filter(Boolean);
}

// minimal tokenizer: single/double quotes group arguments; no escapes, substitution or metachars allowed
function splitArgs(cmd) {
  const out = [];
  let cur = '', q = null;
  for (const c of String(cmd)) {
    if (q) { if (c === q) q = null; else cur += c; continue; }
    if (c === "'" || c === '"') { q = c; continue; }
    if (/\s/.test(c)) { if (cur) { out.push(cur); cur = ''; } continue; }
    cur += c;
  }
  if (q) throw new Error('Unterminated quote in command');
  if (cur) out.push(cur);
  return out;
}

async function run_command(o) {
  const allow = commandAllowlist();
  if (!allow.length) throw new Error('run_command is not configured: add COMMAND_ALLOWLIST=binary1,binary2,... to .env and restart the server.');
  const cmd = String(o.command || '').trim();
  if (!cmd) throw new Error('command is required');
  if (/[`$|;&<>\n\r]/.test(cmd)) throw new Error('Shell metacharacters (| ; & < > ` $ newlines) are not allowed. The command runs one binary with plain arguments, without a shell.');
  const parts = splitArgs(cmd);
  const bin = path.basename(parts[0]);
  if (!allow.includes(bin)) throw new Error(`${bin} is not on the COMMAND_ALLOWLIST (${allow.join(', ')}). Add it to .env if the user wants it.`);
  const cwd = o.cwd ? safePath(o.cwd) : FILES_ROOT;
  const timeoutMs = Math.min(Math.max(Number(o.timeout_ms) || 60000, 1000), 600000);
  const t0 = Date.now();
  return await new Promise(resolve => {
    const p = spawn(parts[0], parts.slice(1), { cwd });
    let out = '', err = '';
    const CAP = 200000;
    p.stdout.on('data', d => { if (out.length < CAP) out += d.toString(); });
    p.stderr.on('data', d => { if (err.length < CAP) err += d.toString(); });
    let killed = false;
    const timer = setTimeout(() => { killed = true; try { p.kill('SIGKILL'); } catch {} }, timeoutMs);
    const finish = (code, signal) => {
      clearTimeout(timer);
      const clip = s => s.length > 60000 ? s.slice(0, 60000) + `\n…[${s.length - 60000} more chars]` : s;
      resolve({
        command: parts.join(' '), binary: bin, exit_code: code, ...(signal ? { signal } : {}),
        timed_out: killed, duration_ms: Date.now() - t0, cwd: relPath(cwd) || 'files root',
        stdout: clip(out), ...(err ? { stderr: clip(err) } : {}),
        ...(out.length >= CAP || err.length >= CAP ? { note: 'output capped at 200KB' } : {}),
      });
    };
    p.on('error', e => { err += e.message; finish(null, undefined); });
    p.on('close', finish);
  });
}

/* ---------------- MCP bridge: any streamable-HTTP MCP server via MCP_SERVERS in .env ---------------- */
function mcpServers() {
  const list = [];
  for (const pair of (process.env.MCP_SERVERS || '').split(',')) {
    const i = pair.indexOf('=');
    if (i < 2) continue;
    const name = pair.slice(0, i).trim().replace(/[^A-Za-z0-9_-]/g, '_');
    const url = pair.slice(i + 1).trim();
    if (name && /^https?:\/\//.test(url)) list.push({ name, url, session: null });
  }
  return list;
}
const mcpClients = new Map(); // name -> { srv, tools }

async function mcpPost(srv, body) {
  const r = await fetch(srv.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(srv.session ? { 'mcp-session-id': srv.session } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${srv.name}: HTTP ${r.status} ${text.slice(0, 200)}`);
  const sid = r.headers.get('mcp-session-id'); if (sid) srv.session = sid;
  const data = text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).pop();
  return data ? JSON.parse(data) : (text ? JSON.parse(text) : null);
}

async function mcpClient(name) {
  if (mcpClients.has(name)) return mcpClients.get(name);
  const srv = mcpServers().find(s => s.name === name);
  if (!srv) throw new Error(`No MCP server named "${name}". Configured: ${mcpServers().map(s => s.name).join(', ') || '(none)'}. Set MCP_SERVERS=name=url in .env.`);
  const init = await mcpPost(srv, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'glm-workspace', version: '1' } } });
  if (init?.error) throw new Error(`${name}: ${init.error.message}`);
  await mcpPost(srv, { jsonrpc: '2.0', method: 'notifications/initialized' });
  const c = { srv, tools: null };
  mcpClients.set(name, c);
  return c;
}

async function mcpRefresh(c) {
  if (c.tools) return c;
  const list = await mcpPost(c.srv, { jsonrpc: '2.0', id: Date.now(), method: 'tools/list' });
  if (list?.error) throw new Error(`${c.srv.name}: ${list.error.message}`);
  c.tools = (list?.result?.tools || []).map(t => ({ name: t.name, description: t.description || '', parameters: t.inputSchema || { type: 'object', properties: {} } }));
  return c;
}

async function mcp_list() {
  const servers = mcpServers();
  if (!servers.length) return { servers: [], note: 'No MCP servers configured. Add MCP_SERVERS=name=url,name2=url2 to .env and restart the server.' };
  const out = [];
  for (const s of servers) {
    try { const c = await mcpRefresh(await mcpClient(s.name)); out.push({ name: s.name, url: s.url, ok: true, tools: c.tools }); }
    catch (e) { mcpClients.delete(s.name); out.push({ name: s.name, url: s.url, ok: false, error: e.message }); }
  }
  return { servers: out };
}

async function mcp_call(o) {
  if (!o.server || !o.tool) throw new Error('server and tool are required');
  const c = await mcpRefresh(await mcpClient(o.server));
  if (!c.tools.some(t => t.name === o.tool)) { c.tools = null; await mcpRefresh(c); }
  const call = { jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name: o.tool, arguments: o.args || {} } };
  let msg = await mcpPost(c.srv, call);
  if (msg?.error) { // expired session: re-init once and retry
    mcpClients.delete(o.server); c.srv.session = null;
    const c2 = await mcpRefresh(await mcpClient(o.server));
    msg = await mcpPost(c2.srv, call);
  }
  if (msg?.error) throw new Error(`${o.server}.${o.tool}: ${msg.error.message}`);
  const contents = msg?.result?.content || [];
  const joined = contents.filter(x => x.type === 'text').map(x => x.text).join('\n');
  let parsed; try { parsed = JSON.parse(joined); } catch { parsed = null; }
  return { server: o.server, tool: o.tool, ...(msg?.result?.isError ? { is_error: true } : {}), result: parsed ?? (joined || null) };
}

/* ---------------- submit_update: propose a self-update for the watcher ----------------
   Writes a signed trigger (data/auto-update.json). The watcher — a separate
   process — verifies the commit (verify.js: syntax, invariants, smoke boot on a
   spare port) before fast-forwarding main, restarting, and health-checking the
   server, with automatic rollback. This tool only *proposes*. */
function readEnvFile() {
  const out = {};
  try {
    for (const line of require('fs').readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2];
    }
  } catch {}
  return out;
}
function signRef(ref) {
  const env = readEnvFile();
  const sec = env.UPDATE_SECRET || '';
  if (!sec) throw new Error('Self-update is not configured: set UPDATE_SECRET (16+ chars) and AUTO_UPDATE=on in .env.');
  return { ref, sig: require('crypto').createHmac('sha256', sec).update(ref).digest('hex') };
}
async function submit_update(o) {
  if (!o || !/^[0-9a-f]{7,40}$/.test(String(o.ref || ''))) throw new Error('ref must be a commit sha (7-40 hex chars)');
  if (readEnvFile().AUTO_UPDATE !== 'on') throw new Error('Self-update is off (AUTO_UPDATE != on in .env). Nothing was written.');
  const short = String(o.ref).slice(0, 7);
  const { spawnSync } = require('child_process');
  const check = spawnSync('git', ['cat-file', '-e', `${o.ref}^{commit}`], { cwd: __dirname, encoding: 'utf8' });
  if (check.status !== 0) throw new Error(`${short} is not a commit in this checkout (did the branch get pushed/fetched?)`);
  const t = signRef(String(o.ref));
  const fsx = require('fs');
  fsx.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  fsx.writeFileSync(path.join(__dirname, 'data', 'auto-update.json'), JSON.stringify({ ...t, note: String(o.note || '').slice(0, 200), requested: new Date().toISOString() }, null, 2));
  return {
    proposed: short,
    note: 'Trigger written. The watcher verifies this commit (syntax, invariants, smoke boot), then updates, restarts, health-checks, and rolls back on failure. It acts within ~20s if idle; if the cap is hit it may skip. Status: data/updatelog.md.',
    ...(o.note ? { your_note: String(o.note).slice(0, 200) } : {}),
  };
}

const TOOLS = {
  http_request, render_page, crawl_site, list_files, read_file, write_file, delete_file, clear_sessions, capabilities,
  memory_list, remember, update_memory, forget, memory_clear, search_chats, read_chat, generate_image,
  generate_video, video_status, transcribe_chunks, listen_audio,
  github_api, run_command, mcp_list, mcp_call, submit_update,
};

/* ---------------- HTTP glue ---------------- */
async function handleTool(name, body, res) {
  const send = obj => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const fn = TOOLS[name];
  if (!fn) return send({ error: `Unknown tool: ${name}` });
  try { send(await fn(body ? JSON.parse(body) : {})); }
  // keep absolute paths out of what the model sees
  catch (e) { send({ error: e.message.split(FILES_ROOT + path.sep).join('').split(FILES_ROOT).join('files') }); }
}

// Files are served in a sandboxed origin so downloaded HTML can't run scripts against this app.
async function serveFile(relUrlPath, download, res, range) {
  try {
    const full = safePath(decodeURIComponent(relUrlPath));
    const st = await fsp.stat(full);
    if (st.isDirectory()) { res.writeHead(302, { Location: `/api/zip?path=${encodeURIComponent(relPath(full))}` }); return res.end(); }
    const ext = path.extname(full).toLowerCase();
    const types = { '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.txt': 'text/plain', '.md': 'text/plain', '.csv': 'text/csv',
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.xml': 'text/xml', '.ico': 'image/x-icon',
      '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };
    const m = /^bytes=(\d*)-(\d*)$/.exec(range || '');
    const partial = !!(m && (m[1] || m[2]));
    let start = 0, end = st.size - 1;
    if (partial) {
      start = m[1] ? +m[1] : Math.max(0, st.size - +m[2]);
      end = m[1] && m[2] ? Math.min(+m[2], st.size - 1) : st.size - 1;
      if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    }
    res.writeHead(partial ? 206 : 200, {
      'Content-Type': (types[ext] || 'application/octet-stream') + (/^text|json|xml/.test(types[ext] || '') ? '; charset=utf-8' : ''),
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${st.size}` } : {}),
      'Content-Security-Policy': 'sandbox',
      'X-Content-Type-Options': 'nosniff',
      ...(download ? { 'Content-Disposition': `attachment; filename="${path.basename(full).replace(/"/g, '')}"` } : {}),
    });
    fs.createReadStream(full, { start, end }).pipe(res);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found');
  }
}

function serveZip(rel, res) {
  let full;
  try { full = safePath(rel || ''); } catch { res.writeHead(400); return res.end(); }
  if (!fs.existsSync(full)) { res.writeHead(404); return res.end('Not found'); }
  const name = (path.basename(full) || 'files') + '.zip';
  res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${name}"` });
  const z = spawn('zip', ['-rq', '-', path.basename(full)], { cwd: path.dirname(full) });
  z.stdout.pipe(res);
  z.on('error', () => res.end());
}

// Direct tool invocation for the headless autopilot (see autopilot.js).
async function callTool(name, args = {}) {
  const fn = TOOLS[name];
  if (!fn) throw new Error(`Unknown tool: ${name}`);
  try { return await fn(args); }
  catch (e) { throw new Error(e.message.split(FILES_ROOT + path.sep).join('').split(FILES_ROOT).join('files')); }
}

// internal exports for verify.js (the gate the watcher runs before any update)
module.exports = { handleTool, serveFile, serveZip, callTool, loadMemory, EXTRA_ROOTS,
  _internals: { safePath, relPath, findExtraRoot, EXTRA_ROOTS, readEnvFile } };
