#!/usr/bin/env node
// verify.js — the gate every self-update must pass before the watcher touches main.
// Deterministic, model-free, zero-dependency. Exit 0 = safe to ship.
// Checks: node --check on every JS file, inline script in index.html, invariant
// tests against the real safePath/guard code, and a smoke boot of the server on a
// spare port (skipped, with a warning, when no ZAI_API_KEY is present).
// Run: node verify.js [smokePort]
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = __dirname;
let failures = 0, notes = 0;
const step = (ok, label, detail = '') => { console.log(`${ok ? '  ok' : '  FAIL'} ${label}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };
const note = (label, detail = '') => { console.log(`  --  ${label}${detail ? ' — ' + detail : ''}`); notes++; };

async function main() {
  console.log('verify: syntax');

  // 1. node --check on every JS file (uses the node binary itself; no dependencies)
  const JS = ['server.js', 'tools.js', 'autopilot.js', 'watcher.js', 'verify.js', 'public/runtime-worker.js'];
  for (const f of JS) {
    if (!fs.existsSync(path.join(ROOT, f))) { note(`syntax ${f} skipped (file absent)`); continue; }
    const r = spawnSync(process.execPath, ['--check', path.join(ROOT, f)], { encoding: 'utf8' });
    step(r.status === 0, `syntax ${f}`, r.status === 0 ? '' : String(r.stderr || '').split('\n')[0].slice(0, 120));
  }

  // 2. the inline script inside index.html parses (last bare <script> block)
  {
    const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    const start = html.lastIndexOf('<script>'), end = html.lastIndexOf('</script>');
    const okBounds = start >= 0 && end > start;
    let ok = false, detail = 'script block not found';
    if (okBounds) {
      const tmp = path.join(os.tmpdir(), `glm-inline-${Date.now()}.js`);
      fs.writeFileSync(tmp, html.slice(start + 8, end));
      const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
      fs.unlinkSync(tmp);
      ok = r.status === 0;
      if (!ok) detail = String(r.stderr || '').split('\n')[0].slice(0, 120);
      else detail = `${end - start} chars`;
    }
    step(ok, 'index.html inline script', detail);
  }

  // 3. invariant tests against the REAL path code (not a copy): safePath / relPath / EXTRA_ROOTS
  console.log('verify: path invariants');
  {
    const t1 = path.join(os.tmpdir(), 'glm-verify-projects'), t2 = path.join(os.tmpdir(), 'glm-verify-www');
    fs.mkdirSync(t1, { recursive: true }); fs.mkdirSync(t2, { recursive: true });
    const prev = process.env.EXTRA_ROOTS;
    process.env.EXTRA_ROOTS = `${t1}:rw,${t2}:r`;
    delete require.cache[require.resolve('./tools')];
    let internals; try { ({ _internals: internals } = require('./tools')); } catch (e) { internals = null; }
    process.env.EXTRA_ROOTS = prev;
    if (!internals) step(false, 'tools.js exports _internals', 'required by the watcher gate');
    else {
      const { safePath, relPath, EXTRA_ROOTS } = internals;
      const throws = fn => { try { fn(); return false; } catch { return true; } };
      step(EXTRA_ROOTS.length === 2 && EXTRA_ROOTS[0].write === true && EXTRA_ROOTS[1].write === false, 'EXTRA_ROOTS parsed (rw/r)');
      step(safePath('a/b.txt') === path.join(ROOT, 'files', 'a', 'b.txt'), 'sandbox path resolves');
      step(safePath('root:projects/x.js') === path.join(t1, 'x.js'), 'root:name path resolves');
      step(safePath('root:projects/x.js', { write: true }) === path.join(t1, 'x.js'), 'rw root accepts writes');
      step(throws(() => safePath('root:www/x', { write: true })), 'ro root write blocked');
      step(throws(() => safePath('root:nope/x')), 'unknown root blocked');
      step(throws(() => safePath('/etc/passwd')), 'absolute path outside roots blocked');
      step(throws(() => safePath('root:projects/../../etc/passwd')), 'root traversal blocked');
      step(throws(() => safePath('../../etc/passwd')), 'sandbox traversal blocked');
      step(relPath(path.join(t1, 'a.js')) === 'root:projects/a.js', 'relPath labels roots');
    }
  }

  // 4. headless guard rules (autopilot.js)
  console.log('verify: headless guard');
  {
    delete require.cache[require.resolve('./autopilot')];
    let g; try { g = require('./autopilot')._guard; } catch (e) { g = null; }
    if (!g) step(false, 'autopilot.js exports _guard');
    else {
      const cfg = { readOnlyWeb: true, allowCommands: false, allowWrites: false, allowUpdates: false };
      const blocked = (name, args, c = cfg) => g(name, args, c) !== null;
      step(blocked('http_request', { method: 'POST' }), 'non-GET web blocked (readOnlyWeb)');
      step(!blocked('http_request', { method: 'GET' }), 'GET web allowed');
      step(blocked('run_command', { command: 'x' }), 'commands blocked without allowCommands');
      step(!blocked('run_command', { command: 'x' }, { ...cfg, allowCommands: true }), 'commands allowed with flag');
      step(blocked('write_file', { path: 'root:projects/a' }), 'root writes blocked without allowWrites');
      step(!blocked('write_file', { path: 'autopilot/x.md' }), 'sandbox writes allowed');
      step(blocked('github_api', { method: 'POST' }), 'github writes blocked (non-GET)');
      step(blocked('submit_update', { ref: 'x' }), 'self-update blocked without allowUpdates');
      step(!blocked('submit_update', { ref: 'x' }, { ...cfg, allowUpdates: true }), 'self-update allowed with flag');
    }
  }

  // 5. smoke boot: start the server on a spare port, require HTTP 200, kill it
  console.log('verify: smoke boot');
  {
    const envKey = process.env.ZAI_API_KEY || (() => {
      const env = path.join(ROOT, '.env');
      if (!fs.existsSync(env)) return null;
      const m = fs.readFileSync(env, 'utf8').match(/^ZAI_API_KEY=(.+)$/m);
      return m ? m[1].trim() : null;
    })();
    if (!envKey) note('smoke boot skipped', 'no ZAI_API_KEY in env or .env');
    else {
      const port = Number(process.argv[2] || 5199);
      const out = fs.openSync(path.join(os.tmpdir(), `glm-verify-server-${Date.now()}.log`), 'a');
      const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', out, out] });
      const t0 = Date.now();
      const up = await new Promise(res => {
        const ping = () => http.get(`http://127.0.0.1:${port}/`, r => res(r.statusCode === 200), () => Date.now() - t0 < 20000 ? setTimeout(ping, 400) : res(false));
        ping();
      });
      child.kill('SIGKILL');
      step(up === true, 'server boots and serves /', up ? `HTTP 200 on :${port} in ${((Date.now() - t0) / 1000).toFixed(1)}s` : 'no 200 within 20s (log in os.tmpdir())');
    }
  }

  console.log(failures ? `verify: ${failures} FAILURE(S)` : `verify: all green${notes ? ` (${notes} skipped)` : ''}`);
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error('verify crashed:', e); process.exit(1); });
