// Headless autopilot: runs in the server process with no browser tab open.
// Start with POST /api/auto/start { goal, cycles, minutes, readOnlyWeb, allowCommands }.
// Uses the same ZAI_API_KEY; journals to files/autopilot/journal.md.
// Server-side tools only (no web_search, run_code or media in v1); confirm-worthy
// actions are denied by default because there is no human to approve them.
const path = require('path');
const tools = require('./tools');

const KEY = process.env.ZAI_API_KEY;
const ENDPOINT = (process.env.AUTO_ENDPOINT === 'standard' ? 'https://api.z.ai/api/paas/v4' : 'https://api.z.ai/api/coding/paas/v4') + '/chat/completions';
const MODEL = process.env.AUTO_MODEL || 'glm-5.3';
const JOURNAL = 'autopilot/journal.md';
const MAX_ROUNDS = 8, HISTORY_CHARS = 280000;

const SCHEMAS = {
  http_request: { name: 'http_request', description: 'Raw HTTP request, any method: status, headers, exact body. Binary responses land in the files sandbox. Long bodies are paged with next_offset.', parameters: { type: 'object', properties: { url: { type: 'string' }, method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] }, headers: { type: 'object' }, body: { type: 'string' }, session: { type: 'string' }, format: { type: 'string', enum: ['raw', 'text', 'links', 'headers'] }, offset: { type: 'integer' }, max_chars: { type: 'integer' }, save_to: { type: 'string' }, timeout_ms: { type: 'integer' } }, required: ['url'] } },
  render_page: { name: 'render_page', description: 'Render a URL in headless Chrome (JS runs) and return the DOM as text/html, with optional screenshot.', parameters: { type: 'object', properties: { url: { type: 'string' }, wait_ms: { type: 'integer' }, format: { type: 'string', enum: ['text', 'html', 'links'] }, screenshot: { type: 'boolean' }, save_to: { type: 'string' }, offset: { type: 'integer' }, max_chars: { type: 'integer' } }, required: ['url'] } },
  crawl_site: { name: 'crawl_site', description: 'Crawl a site breadth-first, mirroring pages into the files sandbox; returns a summary with saved paths.', parameters: { type: 'object', properties: { url: { type: 'string' }, max_pages: { type: 'integer' }, max_depth: { type: 'integer' }, include: { type: 'string' }, exclude: { type: 'string' }, same_origin: { type: 'boolean' }, save_assets: { type: 'boolean' }, session: { type: 'string' } }, required: ['url'] } },
  list_files: { name: 'list_files', description: 'List the files sandbox (and any configured root:name extra roots).', parameters: { type: 'object', properties: { path: { type: 'string' }, recursive: { type: 'boolean' } } } },
  read_file: { name: 'read_file', description: 'Read a file (paged; encoding "base64" for binary). Works on root:name/... paths for extra roots.', parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer' }, max_chars: { type: 'integer' }, encoding: { type: 'string', enum: ['utf8', 'base64'] } }, required: ['path'] } },
  write_file: { name: 'write_file', description: 'Write/append a file in the sandbox (or a writable root:name). Use for reports, data, code.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, encoding: { type: 'string' }, append: { type: 'boolean' } }, required: ['path', 'content'] } },
  github_api: { name: 'github_api', description: 'GitHub REST API with the server GITHUB_TOKEN. GET, or POST/PUT/PATCH/DELETE to change things.', parameters: { type: 'object', properties: { path: { type: 'string' }, method: { type: 'string' }, body: { type: 'object' }, accept: { type: 'string' } }, required: ['path'] } },
  run_command: { name: 'run_command', description: 'Run an allowlisted binary (COMMAND_ALLOWLIST) without a shell, in the files sandbox.', parameters: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' }, timeout_ms: { type: 'integer' } }, required: ['command'] } },
  mcp_list: { name: 'mcp_list', description: 'List configured MCP servers and their tools.', parameters: { type: 'object', properties: {} } },
  mcp_call: { name: 'mcp_call', description: 'Call a tool on an MCP server (names from mcp_list).', parameters: { type: 'object', properties: { server: { type: 'string' }, tool: { type: 'string' }, args: { type: 'object' } }, required: ['server', 'tool'] } },
  remember: { name: 'remember', description: 'Save a durable fact to long-term memory.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  update_memory: { name: 'update_memory', description: 'Rewrite a memory by id.', parameters: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'] } },
  forget: { name: 'forget', description: 'Delete a memory by id.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  search_chats: { name: 'search_chats', description: 'Search past conversations for words or a phrase.', parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } } } },
  read_chat: { name: 'read_chat', description: 'Read a past conversation by chat_id.', parameters: { type: 'object', properties: { chat_id: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, required: ['chat_id'] } },
  submit_update: { name: 'submit_update', description: 'Propose updating the app itself to a specific commit. The watcher process independently verifies (tests + smoke boot) before anything restarts, and rolls back on failure. Use for improvements to this workspace you have already pushed as a commit.', parameters: { type: 'object', properties: { ref: { type: 'string', description: 'Full or short commit sha to move to.' }, note: { type: 'string', description: 'What this update does, one line.' } }, required: ['ref'] } },
  save_lesson: { name: 'save_lesson', description: 'Distill a durable operational lesson from this run - what broke and why, what worked, how to drive the tools - so future runs start smarter. One specific lesson per call, under 1000 chars, with a short tag (e.g. "self-update", "paths", "verify"). Save lessons during the run when they happen, not only at the end.', parameters: { type: 'object', properties: { text: { type: 'string' }, tag: { type: 'string' } }, required: ['text'] } },
  list_lessons: { name: 'list_lessons', description: 'List learned lessons (newest first), optionally filtered by tag.', parameters: { type: 'object', properties: { tag: { type: 'string' }, limit: { type: 'integer' } } } },
  delete_lesson: { name: 'delete_lesson', description: 'Delete an obsolete or wrong lesson by id (from list_lessons).', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
};

function guard(name, args, cfg) {
  const method = String(args.method || 'GET').toUpperCase();
  if (name === 'http_request' && cfg.readOnlyWeb && !['GET', 'HEAD', 'OPTIONS'].includes(method))
    return { error: 'Blocked: headless autopilot is read-only on the web (no POST/PUT/PATCH/DELETE).' };
  if (name === 'run_command' && !cfg.allowCommands)
    return { error: 'Blocked: run_command needs allowCommands:true on the run (no one is watching to approve it).' };
  if (name === 'github_api' && !['GET', 'HEAD'].includes(method) && !cfg.allowWrites)
    return { error: 'Blocked: GitHub writes need allowWrites:true on the run.' };
  if ((name === 'write_file' || name === 'delete_file') && !cfg.allowWrites && /^root:/.test(String(args.path || '')))
    return { error: 'Blocked: writing outside the files sandbox needs allowWrites:true on the run.' };
  if (name === 'submit_update' && !cfg.allowUpdates)
    return { error: 'Blocked: self-update needs allowUpdates:true on the run (the watcher still verifies everything independently).' };
  return null;
}

function systemPrompt(cfg, memories) {
  return `You are GLM running headless inside the glm-workspace server — no human is watching in real time.
Mission: ${cfg.goal}
Work in cycles: make real progress with your tools every cycle, then finish the cycle with two lines: "DONE: <one line>" and "NEXT: <one line>". When the whole mission is complete, write AUTOPILOT_DONE on its own line.
Append a short dated entry to ${JOURNAL} each cycle (what you did, learned, what's next). Save real outputs under autopilot/<project>/.
Limits: no web_search in headless mode (fetch pages directly); no sign-ups, logins, posting or purchases; respect robots.txt; if an action is blocked, adapt and move on.
${cfg.readOnlyWeb ? 'You are read-only on the web: GET requests only.' : 'Prefer read-only web access; only send data when the mission clearly needs it.'}${memories.length ? `\nWhat you remember:\n${memories.map(m => `- [${m.id}] ${m.text}`).join('\n')}` : ''}${lessons.length ? `\n## Lessons from past runs (act on these - they were paid for)\n${lessons.map(l => `- [${l.tag}] ${l.text}`).join('\n')}` : ''}`;
}

function trimHistory(msgs) {
  let total = msgs.reduce((a, m) => a + (m.content?.length || 0) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0);
  const keep = msgs.length - 6;
  for (let i = 1; i < keep && total > HISTORY_CHARS; i++) {
    const m = msgs[i];
    if ((m.content?.length || 0) > 3000) { total -= m.content.length - 3000; m.content = m.content.slice(0, 3000) + '\\n…[trimmed]'; }
  }
  return msgs;
}

async function callModel(messages, toolDefs) {
  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages, ...(toolDefs.length ? { tools: toolDefs, tool_choice: 'auto' } : {}), max_tokens: 8192 }),
    signal: AbortSignal.timeout(300000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error?.message || `Z.ai HTTP ${r.status}`);
  return j.choices?.[0]?.message || {};
}

const sleep = ms => new Promise(res => setTimeout(res, ms));
const stamp = () => new Date().toISOString().slice(0, 16).replace('T', ' ');
const clip = (s, n = 30000) => (s?.length > n ? s.slice(0, n) + `…[${s.length - n} more]` : s) ?? '';

const RUN = { active: false, stop: false, cfg: null, cycle: 0, started: 0, log: [], history: [] };
const log = line => { RUN.log.push(`${stamp()} ${line}`); if (RUN.log.length > 200) RUN.log.shift(); console.log('[autopilot]', line); };

async function journal(entry) {
  try { await tools.callTool('write_file', { path: JOURNAL, content: `\n## ${stamp()}\n${entry}\n`, append: true }); }
  catch (e) { log('journal write failed: ' + e.message); }
}

async function runCycle() {
  const cfg = RUN.cfg;
  RUN.history.push({ role: 'user', content: `[Autopilot] Cycle ${RUN.cycle}. Continue the mission.` });
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (RUN.stop) return;
    const defs = Object.values(SCHEMAS).map(s => ({ type: 'function', function: s }));
    const msg = await callModel([{ role: 'system', content: RUN.system }, ...trimHistory(RUN.history)], defs);
    RUN.history.push({ role: 'assistant', content: msg.content || '', ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) });
    if (msg.reasoning_content) RUN.history.at(-1).reasoning_content = msg.reasoning_content;
    if (!msg.tool_calls?.length) {
      log(`cycle ${RUN.cycle} round ${round + 1}: said "${clip(msg.content, 120)}"`);
      break;
    }
    for (const call of msg.tool_calls) {
      if (RUN.stop) return;
      let args = {}; try { args = JSON.parse(call.function.arguments || '{}'); } catch {}
      const blocked = guard(call.function.name, args, cfg);
      let result;
      if (blocked) result = blocked;
      else try { result = await tools.callTool(call.function.name, args); }
      catch (e) { result = { error: e.message }; }
      const content = typeof result === 'string' ? clip(result) : JSON.stringify(result, null, 2).slice(0, 40000);
      log(`cycle ${RUN.cycle}: ${call.function.name}(${clip(call.function.arguments, 80)}) -> ${result?.error ? 'error: ' + clip(String(result.error), 100) : 'ok'}`);
      RUN.history.push({ role: 'tool', tool_call_id: call.id, content });
    }
  }
  const last = [...RUN.history].reverse().find(m => m.role === 'assistant' && m.content);
  if (/^\s*AUTOPILOT_DONE\s*$/m.test(last?.content || '')) { RUN.done = true; return; }
  await journal(`Cycle ${RUN.cycle}: ${(last?.content || '').split('\n').slice(0, 6).join(' ').slice(0, 500)}`);
}

async function runLoop(cfg) {
  const memories = await tools.loadMemory().catch(() => []);
  const lessons = (await tools.loadLessons().catch(() => [])).slice(-40).reverse();
  RUN.system = systemPrompt(cfg, memories);
  log(`started: "${clip(cfg.goal, 100)}" (${cfg.cycles} cycles, ${cfg.minutes} min)`);
  const deadline = Date.now() + cfg.minutes * 60000;
  try {
    while (!RUN.stop && RUN.cycle < cfg.cycles && Date.now() < deadline) {
      RUN.cycle++;
      await runCycle();
      if (RUN.done || RUN.stop) break;
      await sleep(Math.min(cfg.pauseSec * 1000, Math.max(0, deadline - Date.now())));
    }
    await journal(`Run ended: ${RUN.stop ? 'stopped via API' : RUN.done ? 'mission reported complete' : 'cycle/time limit reached'}.`);
    log(RUN.stop ? 'stopped' : RUN.done ? 'mission complete' : 'finished (limits)');
  } catch (e) {
    log('fatal: ' + e.message);
    await journal('Run failed: ' + e.message);
  } finally {
    RUN.active = false;
  }
}

const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

// exported for verify.js invariant tests
const _guard = guard;
module.exports = { _guard,
  start(cfg, res) {
    if (!KEY) return send(res, 200, { error: 'Missing ZAI_API_KEY' });
    if (RUN.active) return send(res, 200, { error: 'A headless run is already active', status: this.statusPayload() });
    const goal = String(cfg.goal || '').trim();
    if (!goal) return send(res, 200, { error: 'goal is required' });
    Object.assign(RUN, {
      active: true, stop: false, done: false, cycle: 0, started: Date.now(), log: [], history: [],
      cfg: {
        goal,
        cycles: Math.min(Math.max(+cfg.cycles || 10, 1), 200),
        minutes: Math.min(Math.max(+cfg.minutes || 30, 1), 1440),
        pauseSec: Math.min(Math.max(+cfg.pauseSec ?? 10, 0), 600),
        readOnlyWeb: cfg.readOnlyWeb !== false,
        allowCommands: cfg.allowCommands === true,
        allowWrites: cfg.allowWrites === true,
        allowUpdates: cfg.allowUpdates === true,
      },
    });
    runLoop(RUN.cfg);
    return send(res, 200, { started: true, model: MODEL, cfg: RUN.cfg });
  },
  stop(res) { if (!RUN.active) return send(res, 200, { error: 'Nothing running' }); RUN.stop = true; return send(res, 200, { stopping: true }); },
  statusPayload() {
    return {
      active: RUN.active, cycle: RUN.cycle, ...(RUN.cfg ? { cfg: RUN.cfg } : {}),
      started: RUN.started ? new Date(RUN.started).toISOString() : null,
      minutes_running: RUN.started ? +((Date.now() - RUN.started) / 60000).toFixed(1) : 0,
      log_tail: RUN.log.slice(-15),
    };
  },
  status(res) { return send(res, 200, this.statusPayload()); },
};
