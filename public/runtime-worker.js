// Persistent code runtime for GLM. Each session is one Web Worker: isolated from the page and
// from the computer, but its state (variables, imports, loaded packages) survives between runs.
const PYODIDE = 'https://cdn.jsdelivr.net/pyodide/v0.29.5/full/';

let lang = 'javascript', pyodide = null, ready = Promise.resolve(), currentJob = null;
const state = {}; // JS runs keep values here between runs

/* ---------- calls back into the app's tools (http, files) ---------- */
const rpcWaiters = new Map();
let rpcSeq = 0;
function rpc(name, args) {
  return new Promise(resolve => {
    const rpcId = ++rpcSeq;
    rpcWaiters.set(rpcId, resolve);
    postMessage({ type: 'rpc', rpcId, name, args });
  });
}
const unwrap = r => { if (r && r.error) throw new Error(r.error); return r; };

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const helpers = {
  http: async o => unwrap(await rpc('http_request', typeof o === 'string' ? { url: o } : o)),
  files: {
    read: async p => { const r = unwrap(await rpc('read_file', { path: p, max_chars: 500000 })); return r.body ?? r.data ?? r; },
    write: async (p, content, encoding) => {
      if (content instanceof Uint8Array) return unwrap(await rpc('write_file', { path: p, content: toBase64(content), encoding: 'base64' }));
      return unwrap(await rpc('write_file', { path: p, content: typeof content === 'string' ? content : JSON.stringify(content, null, 2), ...(encoding ? { encoding } : {}) }));
    },
    list: async (p = '') => unwrap(await rpc('list_files', { path: p })).files,
  },
  sleep: ms => new Promise(r => setTimeout(r, ms)),
};

/* ---------- output capture ---------- */
function safeString(x) {
  if (typeof x === 'string') return x;
  try { return JSON.stringify(x, (k, v) => typeof v === 'bigint' ? v.toString() : v); } catch { return String(x); }
}
const emit = (stream, text) => postMessage({ type: 'log', jobId: currentJob, stream, text });
console.log = console.info = console.debug = (...a) => emit('stdout', a.map(safeString).join(' ') + '\n');
console.error = console.warn = (...a) => emit('stderr', a.map(safeString).join(' ') + '\n');

function jsonSafe(v) {
  if (v === undefined) return null;
  try {
    const s = JSON.stringify(v, (k, x) => typeof x === 'bigint' ? x.toString() : x instanceof Map ? Object.fromEntries(x) : x instanceof Set ? [...x] : ArrayBuffer.isView(x) ? `<${x.constructor.name} length ${x.length}>` : x);
    if (s === undefined) return String(v);
    return s.length > 200000 ? s.slice(0, 200000) + '…[truncated]' : JSON.parse(s);
  } catch { return String(v); }
}

/* ---------- Python ---------- */
const toJs = o => (o && typeof o.toJs === 'function') ? o.toJs({ dict_converter: Object.fromEntries }) : o;

async function initPython() {
  importScripts(PYODIDE + 'pyodide.js');
  pyodide = await loadPyodide({ indexURL: PYODIDE });
  pyodide.setStdout({ batched: s => emit('stdout', s + '\n') });
  pyodide.setStderr({ batched: s => emit('stderr', s + '\n') });
  await pyodide.loadPackage('micropip');
  // `import glm` inside Python gives access to the app's file and web tools
  pyodide.registerJsModule('glm', {
    http: async o => pyodide.toPy(await helpers.http(toJs(o))),
    read_file: async p => helpers.files.read(p),
    write_file: async (p, content, encoding) => pyodide.toPy(await helpers.files.write(p, toJs(content), encoding)),
    list_files: async p => pyodide.toPy(await helpers.files.list(p || '')),
    sleep: ms => helpers.sleep(ms),
  });
}

function pyResult(out) {
  if (out === undefined || out === null) return null;
  if (typeof out !== 'object' || typeof out.toJs !== 'function') return jsonSafe(out);
  try {
    const js = out.toJs({ dict_converter: Object.fromEntries, create_pyproxies: false });
    return jsonSafe(js);
  } catch {
    return String(out); // repr for objects that don't convert
  } finally {
    try { out.destroy(); } catch {}
  }
}

/* ---------- runs (one at a time per session) ---------- */
async function run({ jobId, code }) {
  try { await ready; } catch (e) { postMessage({ type: 'result', jobId, ok: false, error: 'Runtime failed to start: ' + e, ms: 0 }); return; }
  currentJob = jobId;
  postMessage({ type: 'started', jobId });
  const t0 = performance.now();
  try {
    let result;
    if (lang === 'python') {
      await pyodide.loadPackagesFromImports(code, { messageCallback: () => {} });
      result = pyResult(await pyodide.runPythonAsync(code));
    } else {
      const fn = new Function('state', 'http', 'files', 'sleep', `"use strict"; return (async () => {\n${code}\n})()`);
      result = jsonSafe(await fn(state, helpers.http, helpers.files, helpers.sleep));
    }
    postMessage({ type: 'result', jobId, ok: true, result, ms: performance.now() - t0 });
  } catch (err) {
    postMessage({ type: 'result', jobId, ok: false, error: String(err?.message || err), ms: performance.now() - t0 });
  } finally {
    currentJob = null;
  }
}

let queue = Promise.resolve();
onmessage = e => {
  const m = e.data;
  if (m.type === 'rpc-result') { const w = rpcWaiters.get(m.rpcId); rpcWaiters.delete(m.rpcId); w?.(m.result); return; }
  if (m.type === 'init') {
    lang = m.lang;
    ready = (lang === 'python' ? initPython() : Promise.resolve());
    ready.then(() => postMessage({ type: 'ready' }), err => postMessage({ type: 'init-error', error: String(err?.message || err) }));
    return;
  }
  if (m.type === 'run') queue = queue.then(() => run(m));
};
