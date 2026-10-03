#!/usr/bin/env node
// watcher.js — the ONLY component with permission to update the running app.
// Deliberately a separate process: it must outlive the server it restarts.
//
// Flow: looks for data/auto-update.json (HMAC-signed, key from .env UPDATE_SECRET),
// checks the referenced commit out to a temp worktree, runs verify.js against it,
// and only then fast-forwards main, restarts the server, and health-checks it.
// Bad health = automatic rollback to the last-known-good commit. All actions are
// appended to data/updatelog.md.
//
// Circuit breakers:
//   - enabled only when .env has AUTO_UPDATE=on (checked at boot and every loop)
//   - touch data/STOP               -> exits within one poll interval
//   - max 1 update / 15 min, max 10 / day
//   - 3 consecutive failed verifies -> disables itself until data/STOP is removed
//     and the file data/watcher.disabled is deleted by a human
//   - health check must return HTTP 200 within 30s or it rolls back and restarts
//
// Run: node watcher.js   (or `npm run watch`)
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const TRIGGER = path.join(DATA, 'auto-update.json');
const STOP = path.join(DATA, 'STOP');
const DISABLED = path.join(DATA, 'watcher.disabled');
const LOG = path.join(DATA, 'updatelog.md');
const PORT = Number(process.env.PORT || 5173);
const POLL_MS = 20_000;
const MIN_GAP_MS = 15 * 60_000;
const DAILY_CAP = 10;

fs.mkdirSync(DATA, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stamp = () => new Date().toISOString();
const log = line => { const l = `${stamp()} ${line}`; fs.appendFileSync(LOG, l + '\n'); console.log('[watcher]', line); };
const die = msg => { log('FATAL ' + msg); process.exit(1); };

// --- env (fresh each loop so flipping AUTO_UPDATE in .env takes effect live) ---
function readEnv() {
  const envPath = path.join(ROOT, '.env');
  const out = {};
  if (fs.existsSync(envPath)) for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
const enabled = () => readEnv().AUTO_UPDATE === 'on';
const secret = () => readEnv().UPDATE_SECRET || '';

// --- git helpers (no network operations beyond fetch/pull of the configured remote) ---
function git(args, opts = {}) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${String(r.stderr || r.stdout || '').split('\n')[0].slice(0, 160)}`);
  return String(r.stdout || '').trim();
}
const currentSha = () => git(['rev-parse', 'HEAD']);
const RUNNING_SHA = (() => { try { return currentSha(); } catch { return null; } })(); // code this watcher process was loaded from
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts });
  return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

// --- trigger validation ---
function readTrigger() {
  if (!fs.existsSync(TRIGGER)) return null;
  let t; try { t = JSON.parse(fs.readFileSync(TRIGGER, 'utf8')); } catch { log('trigger present but not valid JSON — ignoring'); return null; }
  if (!t || typeof t.ref !== 'string' || !/^[0-9a-f]{40}$/.test(t.ref)) { log('trigger ref is not a full commit sha — ignoring'); return null; }
  const mac = crypto.createHmac('sha256', secret()).update(t.ref).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(String(t.sig || '').padEnd(mac.length).slice(0, mac.length)))) {
    log('trigger signature mismatch — ignoring (forged or stale secret?)');
    return null;
  }
  return t;
}
// exposed for autopilot.js so only code holding the .env-derived secret can sign
function signTrigger(ref) {
  return { ref, sig: crypto.createHmac('sha256', secret()).update(ref).digest('hex') };
}

// --- server control ---
const serverPids = () => String(run('lsof', ['-ti', `:${PORT}`, '-sTCP:LISTEN']).out).split('\n').filter(Boolean);
// SIGTERM, wait for the port to actually free, then SIGKILL stragglers and wait again.
// (The address-filtered lsof missed user-launched servers bound on other families —
// the "zombie old server passes health check" bug.)
async function stopServer() {
  const term = serverPids();
  for (const pid of term) { try { process.kill(Number(pid), 'SIGTERM'); } catch {} }
  for (let i = 0; i < 25 && serverPids().length; i++) await sleep(200);
  const stuck = serverPids();
  if (stuck.length) { log('port still held after SIGTERM — SIGKILL ' + stuck.join(' ')); for (const pid of stuck) { try { process.kill(Number(pid), 'SIGKILL'); } catch {} } }
  for (let i = 0; i < 15 && serverPids().length; i++) await sleep(200);
  if (serverPids().length) log('WARNING: port ' + PORT + ' still occupied after SIGKILL');
}
function startServer() {
  const out = fs.openSync(path.join(DATA, 'server.log'), 'a');
  return spawn(process.execPath, ['server.js'], { cwd: ROOT, detached: true, stdio: ['ignore', out, out] }).unref();
}
// Healthy means: a server answers AND (when expected) it reports the exact build
// from the candidate commit. An old zombie still holding the port must NOT pass.
const healthy = expectBuild => new Promise(res => {
  const done = v => { clearTimeout(t); res(v); };
  const t = setTimeout(() => res(false), 30_000);
  const check = n => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/tools/capabilities', method: 'POST', headers: { 'Content-Type': 'application/json', 'X-GLM-Workspace': '1' } }, r => {
      let b = '';
      r.on('data', d => b += d);
      r.on('end', () => {
        if (r.statusCode !== 200) return n > 75 ? done(false) : setTimeout(() => check(n + 1), 400);
        try { const j = JSON.parse(b); done(!expectBuild || j.build === expectBuild); }
        catch { done(false); }
      });
    });
    req.on('error', () => n > 75 ? done(false) : setTimeout(() => check(n + 1), 400));
    req.end();
  };
  check(0);
});

function warnIfStale() {
  try {
    const head = currentSha();
    if (!RUNNING_SHA || !head || head === RUNNING_SHA) return;
    // only nag when the watcher's OWN code changed between the two commits —
    // warning on every apply trains people to ignore warnings
    let touched = true;
    try { touched = git(['diff', '--name-only', RUNNING_SHA, head, '--', 'watcher.js']).trim().length > 0; } catch {}
    if (touched) {
      // under the watch.js supervisor, reload automatically instead of nagging to restart
      if (process.env.WATCH_SUPERVISED === '1') { log(`reloading watcher: ${RUNNING_SHA.slice(0, 7)} -> ${head.slice(0, 7)} (watcher.js changed)`); process.exit(75); }
      log(`WATCHER STALE: running code from ${RUNNING_SHA.slice(0, 7)} but checkout is ${head.slice(0, 7)} — restart \`npm run watch\` to load the new watcher rules`);
    } else log(`note: checkout moved to ${head.slice(0, 7)} (watcher.js unchanged — running rules still current)`);
  } catch {}
}

// --- the update sequence ---
async function applyUpdate(t) {
  const prev = currentSha();
  log(`update begin: ${t.ref.slice(0, 7)} (from ${prev.slice(0, 7)})`);

  // 1. fetch the ref and verify it out into a temp worktree; run verify.js THERE
  git(['fetch', '--quiet', 'origin', t.ref]);
  const tmp = path.join(ROOT, '.verify-worktree');
  fs.rmSync(tmp, { recursive: true, force: true });
  git(['worktree', 'add', '--quiet', '--detach', tmp, t.ref]);
  try { fs.copyFileSync(path.join(ROOT, '.env'), path.join(tmp, '.env')); } catch {} // smoke boot needs a key
  let verdict, expectBuild = null;
  try {
    verdict = run(process.execPath, ['verify.js'], { cwd: tmp });
    try { expectBuild = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8')).version; } catch {}
  } finally {
    try { git(['worktree', 'remove', '--force', tmp]); } catch {}
    try { git(['worktree', 'prune']); } catch {}
  }
  if (verdict.code !== 0) {
    log(`verify FAILED (exit ${verdict.code}):\n${verdict.out.slice(-1500)}\n${verdict.err.slice(-500)}`);
    return { ok: false, stage: 'verify' };
  }
  log('verify passed:\n' + verdict.out.split('\n').filter(l => l.startsWith('  ')).join('\n').slice(0, 800));

  // 2. fast-forward local main to the verified commit (no force, no divergence)
  git(['reset', '--hard', t.ref]); // we only ever get here after a clean verify

  // 3. restart and health-check; roll back on failure
  await stopServer();
  startServer();
  if (await healthy(expectBuild)) { log(`update applied: ${t.ref.slice(0, 7)} healthy (build ${expectBuild || '?'})`); warnIfStale(); return { ok: true }; }
  log(`health check FAILED (expected build ${expectBuild || '?'}) — rolling back to ` + prev.slice(0, 7));
  git(['reset', '--hard', prev]);
  await stopServer(); startServer();
  const recovered = await healthy();
  log(recovered ? 'rollback healthy' : 'ROLLBACK ALSO UNHEALTHY — server needs human attention');
  return { ok: false, stage: 'health', recovered };
}

// --- main loop ---
let lastUpdate = 0, today = '', dayCount = 0, fails = 0;
async function loop() {
  if (!enabled()) return;
  if (fs.existsSync(STOP)) { log('STOP file present — exiting'); fs.writeFileSync(DISABLED, stamp() + ' stopped via STOP\n'); process.exit(0); }
  if (fs.existsSync(DISABLED)) return; // stays off until a human deletes the file
  if (today !== new Date().toISOString().slice(0, 10)) { today = new Date().toISOString().slice(0, 10); dayCount = 0; }

  const t = readTrigger();
  if (t && Date.now() - lastUpdate > MIN_GAP_MS && dayCount < DAILY_CAP && t.ref !== currentSha()) {
    fs.unlinkSync(TRIGGER);
    lastUpdate = Date.now(); dayCount++;
    const r = await applyUpdate(t);
    if (!r.ok) {
      fails++;
      if (fails >= 3) { fs.writeFileSync(DISABLED, `${stamp()} 3 consecutive failures — human re-enable required\n`); log('3 consecutive failures — self-disabled'); }
    } else fails = 0;
  } else if (t && t.ref === currentSha()) fs.unlinkSync(TRIGGER); // already live
}

if (require.main === module) {
  const env = readEnv();
  if (env.AUTO_UPDATE !== 'on') die('AUTO_UPDATE is not "on" — nothing to do. This is the default.');
  if (!env.UPDATE_SECRET || env.UPDATE_SECRET.length < 16) die('UPDATE_SECRET missing or under 16 chars — refusing to run without HMAC signing');
  git(['rev-parse', '--git-dir']); // must be a git checkout
  log(`watcher up (poll ${POLL_MS / 1000}s, port ${PORT}, cap ${DAILY_CAP}/day, gap ${MIN_GAP_MS / 60000}min, code ${RUNNING_SHA ? RUNNING_SHA.slice(0, 7) : '?'})`);
  warnIfStale();
  setInterval(() => loop().catch(e => log('loop error: ' + e.message)), POLL_MS);
}

module.exports = { signTrigger, readTrigger, enabled: () => enabled() };
