#!/usr/bin/env node
// iris — MCP server (stdio JSON-RPC). The agent's eye.
//
// The important thing this server does that no other tool in the kit does: it
// returns IMAGES. `iris_look` hands the model actual pixels of the page it just
// wrote, alongside the measured defects. An agent that can see its own output
// stops designing blind — which is the entire reason the design is bad.
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import * as iris from '../src/core.js';

const PROTOCOL = '2024-11-05';

// A run carries a handful of PNGs. Sending all of them every time would drown the
// context, so we send the pixels and keep the prose tight.
const imageBlocks = (paths) => paths.filter(Boolean).map((p) => {
  try { return { type: 'image', data: readFileSync(p).toString('base64'), mimeType: 'image/png' }; }
  catch { return null; }
}).filter(Boolean);

const tools = [
  {
    name: 'iris_look',
    description: 'LOOK at a web page you built — a URL or a local .html file — and get back the actual screenshots '
      + 'plus every defect a glance would catch: the page scrolling sideways, an element clipped off the right edge, '
      + 'unreadable contrast, type too small to read, text printing over text, tap targets too small, and any console '
      + 'exception. Use this after writing or changing ANY user interface, before you claim it works. Renders at real '
      + 'viewports (phone, tablet, desktop) and in both light and dark themes, because that is where layouts actually break.',
    inputSchema: { type: 'object', properties: {
      target: { type: 'string', description: 'A URL (http://…) or a path to a local HTML file' },
      viewports: { type: 'string', description: 'Comma-separated: phone, tablet, desktop (default "phone,desktop")' },
      themes: { type: 'string', description: 'Comma-separated: dark, light (default both)' },
      full: { type: 'boolean', description: 'Capture the full page, not just the first screen' },
      pre: { type: 'string', description: 'JavaScript to run in the page after it loads and BEFORE it is audited — use it to '
        + 'put the page into a state you would otherwise have to click to reach: a disabled button, an empty list, an error '
        + 'banner, a row toggled off. Those states are the ones that are broken, because they are the ones nobody ever looks '
        + 'at. Example: "document.querySelectorAll(\'button\').forEach(b => b.disabled = true)". Throws if it fails, because '
        + 'a state you could not reach is not a state that passed.' },
    }, required: ['target'] },
    run: async (a) => {
      const run = await iris.look(a.target, a);
      return { text: iris.report(run), images: run.shots.map((s) => s.path) };
    },
  },
  {
    name: 'iris_play',
    description: 'For GAMES and anything animated. A screenshot cannot tell you a game is dead — a game that renders one '
      + 'perfect frame and then never draws again looks flawless in a still. This drives the real thing: counts frames over '
      + 'several seconds, measures fps and the worst stutter, checks the frames actually differ, and presses keys to see '
      + 'whether the game answers. Catches: a loop that never runs, a frozen canvas, input that is ignored, sub-30fps.',
    inputSchema: { type: 'object', properties: {
      target: { type: 'string', description: 'A URL or a path to a local HTML file' },
      seconds: { type: 'number', description: 'How long to watch it (default 3)' },
      keys: { type: 'string', description: 'Keys to press, comma-separated — e.g. "ArrowLeft,ArrowRight,Space"' },
    }, required: ['target'] },
    run: async (a) => {
      const run = await iris.play(a.target, a);
      // First, last, and the input before/after pair: enough to see motion, not
      // enough to flood the window.
      const f = run.frames || [];
      const paths = [f[0]?.path, f.at(-1)?.path].filter(Boolean);
      return { text: iris.report(run), images: paths };
    },
  },
  {
    name: 'iris_runs',
    description: 'What the eye has already looked at — past runs, with their verdicts.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } },
    run: (a) => ({ text: JSON.stringify(iris.runs({ limit: a.limit || 20 }).map((r) => ({
      id: r.id, kind: r.kind, target: r.target, passed: r.summary?.passed, summary: r.summary })), null, 2) }),
  },
  {
    name: 'iris_stats',
    description: 'Where the browser is, where the images land, and how many runs passed.',
    inputSchema: { type: 'object', properties: {} },
    run: () => ({ text: JSON.stringify(iris.stats(), null, 2) }),
  },
];

// ── What each tool does to the world ───────────────────────────────────────────
// MCP tool annotations (spec 2025-11-25). The spec's defaults are PESSIMISTIC: with no
// annotations at all, every tool here — including the pure reads — is declared
// destructive and open-world, and a conformant client should warn before each call.
// You do not become safe by omission. You become safe by saying so.
//
//   readOnlyHint    the tool changes nothing        → the client can skip the confirmation
//   destructiveHint it may overwrite or delete      → the client should warn first
//   idempotentHint  calling twice changes no more   → safe to retry on failure
//   openWorldHint   it reaches, or returns content from, outside our trust boundary
//                   (the web; the output of arbitrary code) → scrutinise what comes back
const ANNOTATIONS = {
  iris_runs: {"readOnlyHint": true, "openWorldHint": false},
  iris_stats: {"readOnlyHint": true, "openWorldHint": false},
  iris_look: {"readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": true},
  iris_play: {"readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": true},
};

const toolMap = Object.fromEntries(tools.map((t) => [t.name, t]));
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize')
    return reply(id, { protocolVersion: PROTOCOL, capabilities: { tools: {} },
      serverInfo: { name: 'iris', version: '0.1.0' } });
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list')
    return reply(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema, annotations: ANNOTATIONS[name] })) });
  if (method === 'tools/call') {
    const tool = toolMap[params?.name];
    if (!tool) return fail(id, -32602, `unknown tool: ${params?.name}`);
    // Every tool DECLARES its required arguments in inputSchema, and nothing enforced
    // them. `lens_search` with no query did not say "query is required" — it called
    // search(undefined) and died three layers down with
    //     Cannot read properties of undefined (reading 'match')
    // which is what a model got back, as if it were an answer. A schema that promises a
    // check nobody performs is worse than no schema: the client trusts it.
    const args = params?.arguments || {};
    const missing = (tool.inputSchema?.required || [])
      .filter((k) => args[k] === undefined || args[k] === null || args[k] === '');
    if (missing.length) {
      const how = missing
        .map((k) => `"${k}"${tool.inputSchema.properties?.[k]?.description ? ` (${tool.inputSchema.properties[k].description})` : ''}`)
        .join(', ');
      return fail(id, -32602, `${tool.name}: missing required argument${missing.length > 1 ? 's' : ''} ${how}`);
    }
    // ...and the TYPES it declares, and the enums. Nothing enforced those either, and
    // unlike a missing argument they do not crash — they corrupt, quietly:
    //   kanban_create_task labels:"urgent"   → a task whose labels are the letters u,r,g…
    //   cortex_write title:{...}             → a note on disk called "[object Object]"
    //   lens_search k:"eight"                → silently ignored, and you never learn why
    // Wrong data written confidently is worse than an error, because nothing announces it.
    const props = tool.inputSchema?.properties || {};
    const kindOf = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
    const OK = {
      string: (v) => typeof v === 'string',
      number: (v) => typeof v === 'number' && Number.isFinite(v),
      integer: (v) => Number.isInteger(v),
      boolean: (v) => typeof v === 'boolean',
      array: (v) => Array.isArray(v),
      object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
    };
    const wrong = [];
    for (const [k, spec] of Object.entries(props)) {
      const v = args[k];
      if (v === undefined || v === null) continue;
      if (spec.type && OK[spec.type] && !OK[spec.type](v)) {
        wrong.push(`"${k}" must be ${spec.type}, got ${kindOf(v)}`);
      } else if (spec.enum && !spec.enum.includes(v)) {
        wrong.push(`"${k}" must be one of ${spec.enum.join(' | ')} — got ${JSON.stringify(v)}`);
      }
    }
    if (wrong.length) return fail(id, -32602, `${tool.name}: ${wrong.join('; ')}`);
    try {
      const r = await tool.run(args);
      const content = [{ type: 'text', text: r.text }, ...imageBlocks(r.images || [])];
      return reply(id, { content });
    } catch (err) {
      return reply(id, { content: [{ type: 'text', text: `error: ${err.message}` }], isError: true });
    }
  }
  if (id !== undefined) fail(id, -32601, `method not found: ${method}`);
}

createInterface({ input: process.stdin }).on('line', (line) => {
  line = line.trim(); if (!line) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  handle(msg).catch((e) => { if (msg.id !== undefined) fail(msg.id, -32603, String(e)); });
});
process.stderr.write('iris MCP server ready\n');
