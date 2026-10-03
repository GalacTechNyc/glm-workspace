#!/usr/bin/env node
// watch.js — supervisor for watcher.js.
//
// The watcher can update its own code. When an applied update changes watcher.js,
// the running process is stale, so it exits 75 ("reload me") and this supervisor
// respawns it — no manual `npm run watch` restart needed. Any other exit (STOP file,
// AUTO_UPDATE=off, crash, or Ctrl-C) stops here too. SIGINT/SIGTERM pass through to
// the child because it shares this process group, so Ctrl-C still ends everything.
const { spawn } = require('child_process');
const RELOAD = 75;
let last = 0, rapid = 0;

function run() {
  const child = spawn(process.execPath, ['watcher.js'], {
    cwd: __dirname,
    stdio: 'inherit',
    env: { ...process.env, WATCH_SUPERVISED: '1' }, // tells watcher.js a supervisor is here to respawn it
  });
  child.on('exit', (code, signal) => {
    if (signal) return process.exit(0);                 // killed (Ctrl-C etc.) — stop
    if (code !== RELOAD) return process.exit(code ?? 0); // normal stop / crash — stop with its code
    const now = Date.now();
    rapid = now - last < 5000 ? rapid + 1 : 0;           // reload-storm guard
    last = now;
    if (rapid >= 3) { console.error('[watch] watcher asked to reload 3x in a row too fast — stopping'); return process.exit(1); }
    console.log('[watch] reloading watcher (its code changed)');
    run();
  });
}

run();
