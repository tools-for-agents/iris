// iris core — the agent's eye.
//
// Every other tool in the kit gives an agent a sense it was missing: cortex
// remembers, lens reads code, scout reads the web, anvil runs things. iris lets it
// SEE. An agent writing CSS or a game loop today emits code and never looks at the
// result — it is designing blind, and the output looks exactly like what it is.
//
// look()  → render a page at real viewports and themes, and hand the PIXELS back.
// audit() → measure what a glance would catch: overflow, clipping, contrast,
//           unreadable type, collisions, a console full of exceptions.
// play()  → for games: is the loop drawing, how fast, and does it answer input.
//
// Zero dependencies — the browser is driven over CDP by src/browser.js.
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { open, findChrome } from './browser.js';
import { auditPage, instrumentFrames, readFrames } from './audit.js';

export const OUT = () => process.env.IRIS_OUT || './.iris';

// The three shapes a screen actually comes in. Not a spectrum — the three places
// a layout breaks. (A "responsive" page that was only ever seen at 1440 is a page
// that has never been seen.)
export const VIEWPORTS = {
  phone: { width: 390, height: 844, mobile: true },
  tablet: { width: 834, height: 1112, mobile: false },
  desktop: { width: 1440, height: 900, mobile: false },
};
export const THEMES = ['dark', 'light'];

const DEFAULTS = { minTap: 24, minFont: 12, contrastAA: 4.5 };

// A local file is still a page. Agents write index.html far more often than they
// deploy, so `iris look ./game.html` has to just work.
export function toUrl(target) {
  if (/^https?:|^data:|^about:/.test(target)) return target;
  const p = isAbsolute(target) ? target : resolve(process.cwd(), target);
  if (!existsSync(p)) throw new Error(`no such page: ${target}`);
  return pathToFileURL(p).href;
}

const slug = (s) => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 40).toLowerCase() || 'page';
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

// ── look: render it, and hand back the pixels ────────────────────────────────
export async function look(target, opts = {}) {
  const url = toUrl(target);
  const viewports = pickViewports(opts.viewports);
  const themes = pickThemes(opts.themes);
  const cfg = { ...DEFAULTS, ...opts };
  const runId = `${slug(target)}-${stamp()}`;
  const dir = join(OUT(), runId);
  mkdirSync(dir, { recursive: true });

  const session = await open();
  const shots = [];
  try {
    for (const vp of viewports) {
      for (const theme of themes) {
        await session.page.viewport(VIEWPORTS[vp]);
        await session.page.theme(theme);
        session.page.console.length = 0;            // attribute console noise to the render that caused it
        await session.page.goto(url, { waitMs: opts.wait ?? 350 });
        const png = await session.page.screenshot({ fullPage: !!opts.full });
        const file = `${vp}-${theme}.png`;
        writeFileSync(join(dir, file), png);
        const a = opts.audit === false ? null
          : await session.page.evaluate(auditPage, { ...cfg, mobile: VIEWPORTS[vp].mobile });
        shots.push({
          viewport: vp, theme, file, path: join(dir, file), bytes: png.length,
          violations: a ? a.violations : [], counts: a ? a.counts : {},
          console: session.page.console.slice(0, 20),
        });
      }
    }
  } finally { await session.close(); }

  const run = summarise({ id: runId, kind: 'look', target, url, dir, shots });
  writeFileSync(join(dir, 'run.json'), JSON.stringify(run, null, 2));
  return run;
}

// ── play: a game is a loop, so watch the loop ────────────────────────────────
export async function play(target, opts = {}) {
  const url = toUrl(target);
  const seconds = Math.min(30, Math.max(1, +opts.seconds || 3));
  const keys = typeof opts.keys === 'string' ? opts.keys.split(',').map((s) => s.trim()).filter(Boolean)
    : (opts.keys || []);
  const vp = VIEWPORTS[opts.viewport && VIEWPORTS[opts.viewport] ? opts.viewport : 'desktop'];
  const runId = `${slug(target)}-play-${stamp()}`;
  const dir = join(OUT(), runId);
  mkdirSync(dir, { recursive: true });

  const session = await open();
  const page = session.page;
  const frames = [];
  let metrics = null, inputEffect = null;
  try {
    await page.viewport(vp);
    await page.theme(opts.theme || 'dark');
    await page.goto(url, { waitMs: 200 });
    // Instrument AFTER load: a game that installs its own rAF wrapper on boot
    // would otherwise be wrapping ours, and we'd count its frames twice.
    await page.evaluate(instrumentFrames);

    const shots = Math.min(12, Math.max(2, +opts.frames || 6));
    const gap = Math.round((seconds * 1000) / shots);
    for (let i = 0; i < shots; i++) {
      await new Promise((r) => setTimeout(r, gap));
      const png = await page.screenshot();
      const file = `frame-${String(i).padStart(2, '0')}.png`;
      writeFileSync(join(dir, file), png);
      frames.push({ i, file, path: join(dir, file), hash: createHash('sha1').update(png).digest('hex').slice(0, 12) });
    }
    metrics = await page.evaluate(readFrames);

    // Does it answer? Press the keys, and see whether the picture changed. A game
    // that renders beautifully and ignores the arrow keys is not a game yet.
    if (keys.length) {
      const before = await page.screenshot();
      for (const k of keys) { await page.press(k); await new Promise((r) => setTimeout(r, 120)); }
      await new Promise((r) => setTimeout(r, 250));
      const after = await page.screenshot();
      writeFileSync(join(dir, 'input-before.png'), before);
      writeFileSync(join(dir, 'input-after.png'), after);
      const h = (b) => createHash('sha1').update(b).digest('hex');
      inputEffect = { keys, changed: h(before) !== h(after) };
    }
  } finally { await session.close(); }

  const uniq = new Set(frames.map((f) => f.hash)).size;
  const v = [];
  // The two ways a game is dead on arrival, and neither shows up in a single shot.
  if (uniq === 1 && frames.length > 1) {
    v.push({ rule: 'frozen', severity: 'high', selector: 'canvas', detail:
      `every one of the ${frames.length} frames over ${seconds}s is pixel-identical — nothing is animating` });
  }
  if (metrics?.instrumented && metrics.frames === 0) {
    v.push({ rule: 'no-raf', severity: 'high', selector: 'window', detail:
      'requestAnimationFrame was never called — there is no game loop running' });
  } else if (metrics?.instrumented && metrics.fps > 0 && metrics.fps < 30) {
    v.push({ rule: 'low-fps', severity: 'medium', selector: 'window', detail:
      `${metrics.fps} fps over ${(metrics.elapsed_ms / 1000).toFixed(1)}s — below 30, the game will feel like a slideshow` });
  }
  if (metrics?.instrumented && metrics.worst_hitch_ms > 100) {
    v.push({ rule: 'hitch', severity: 'medium', selector: 'window', detail:
      `worst frame gap ${metrics.worst_hitch_ms}ms — a visible stutter (a smooth frame is ~16ms)` });
  }
  if (metrics?.instrumented && !metrics.canvases.length) {
    v.push({ rule: 'no-canvas', severity: 'low', selector: 'body', detail: 'no <canvas> on the page — if this is a DOM game, ignore this' });
  }
  if (inputEffect && !inputEffect.changed) {
    v.push({ rule: 'input-ignored', severity: 'high', selector: 'window', detail:
      `pressed ${inputEffect.keys.join(', ')} and not a single pixel changed — the game is not listening` });
  }

  const run = summarise({ id: runId, kind: 'play', target, url, dir,
    shots: [{ viewport: opts.viewport || 'desktop', theme: opts.theme || 'dark', file: frames.at(-1)?.file,
      path: frames.at(-1)?.path, violations: v, counts: {}, console: session.page.console.slice(0, 20) }],
    frames, metrics, input: inputEffect, unique_frames: uniq, seconds });
  writeFileSync(join(dir, 'run.json'), JSON.stringify(run, null, 2));
  return run;
}

// ── the verdict ──────────────────────────────────────────────────────────────
function summarise(run) {
  const all = run.shots.flatMap((s) => (s.violations || []).map((v) => ({ ...v, viewport: s.viewport, theme: s.theme })));
  const errors = run.shots.flatMap((s) => (s.console || []).filter((c) => c.level === 'exception' || c.level === 'error'));

  // Count DISTINCT problems, not sightings. The same 10px label seen at 3 viewports
  // × 2 themes is one thing to fix, and reporting it as six inflates the number
  // exactly as dishonestly as hiding it would deflate it. "32 high" that is really
  // five bugs teaches you to ignore the number.
  const distinct = new Map();
  for (const v of all) {
    const k = v.rule + '|' + v.selector;
    if (!distinct.has(k) || RANK[v.severity] < RANK[distinct.get(k).severity]) distinct.set(k, v);
  }
  const D = [...distinct.values()];
  const by = (sev) => D.filter((v) => v.severity === sev).length;
  // A page that throws is broken however good it looks — count it as a failure,
  // not a footnote.
  const exceptions = errors.filter((e) => e.level === 'exception').length;
  const high = by('high') + exceptions;
  return {
    ...run,
    violations: all,
    console_errors: errors,
    summary: { total: D.length, high, medium: by('medium'), low: by('low'),
      sightings: all.length, console_errors: errors.length,
      passed: high === 0 && errors.length === 0 },
  };
}
const RANK = { high: 0, medium: 1, low: 2 };

// A briefing an agent can act on: what is wrong, where, and nothing else. Kept
// short on purpose — a 4000-token wall of violations gets skimmed, not fixed.
export function report(run, { limit = 25 } = {}) {
  const L = [];
  const s = run.summary;
  L.push(`${run.kind === 'play' ? '🎮' : '👁'}  ${run.target}`);
  if (run.kind === 'play' && run.metrics?.instrumented) {
    L.push(`   ${run.metrics.fps} fps · ${run.frames.length} frames, ${run.unique_frames} distinct · worst hitch ${run.metrics.worst_hitch_ms}ms`
      + (run.input ? ` · input ${run.input.changed ? 'registered' : 'IGNORED'}` : ''));
  } else {
    L.push(`   ${run.shots.length} renders (${[...new Set(run.shots.map((x) => x.viewport))].join(', ')} × ${[...new Set(run.shots.map((x) => x.theme))].join(', ')})`);
  }
  L.push(s.passed ? '   ✓ nothing broken' : `   ${s.high} high · ${s.medium} medium · ${s.low} low · ${s.console_errors} console`);

  const order = { high: 0, medium: 1, low: 2 };
  const seen = new Map();
  // Collapse the same defect across viewports/themes — "clipped at desktop AND
  // tablet AND phone" is one bug, and listing it three times buries the others.
  for (const v of [...run.violations].sort((a, b) => order[a.severity] - order[b.severity])) {
    // Key on rule+selector ONLY. The detail carries measurements that legitimately
    // differ per viewport ("scrolls by 960px" vs "by 2010px"), so keying on it split
    // one bug into one row per viewport — which is precisely the burying this dedupe
    // exists to prevent.
    const key = v.rule + '|' + v.selector;
    if (!seen.has(key)) seen.set(key, { ...v, where: new Set(), n: 0 });
    const e = seen.get(key);
    // A Set — one selector often matches SEVERAL elements (four rows in a list),
    // and pushing a name per element per render printed "phone/dark" four times in
    // a row. The count says how many elements; the set says where.
    e.where.add(`${v.viewport}/${v.theme}`);
    e.n++;
  }
  const list = [...seen.values()].slice(0, limit);
  if (list.length) {
    L.push('');
    for (const v of list) {
      const per = Math.round(v.n / v.where.size);
      L.push(`  [${v.severity}] ${v.rule} — ${v.selector}${per > 1 ? `  (×${per} elements)` : ''}`);
      if (v.text) L.push(`      “${v.text}”`);
      L.push(`      ${v.detail}`);
      L.push(`      at ${[...v.where].join(', ')}`);
    }
    if (seen.size > limit) L.push(`  … and ${seen.size - limit} more (raise --limit)`);
  }
  for (const e of run.console_errors.slice(0, 5)) L.push(`  [console] ${e.level}: ${String(e.text).split('\n')[0].slice(0, 140)}`);
  L.push('');
  L.push(`  images: ${run.dir}`);
  return L.join('\n');
}

// ── the run store: what the eye has already seen ─────────────────────────────
export function runs({ limit = 30 } = {}) {
  const base = OUT();
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(base, d.name, 'run.json')))
    .map((d) => { try { return JSON.parse(readFileSync(join(base, d.name, 'run.json'), 'utf8')); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => (a.id < b.id ? 1 : -1))
    .slice(0, limit);
}

export function getRun(id) {
  const f = join(OUT(), id, 'run.json');
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
}

export function shotBytes(id, file) {
  if (/[\\/]|\.\./.test(file)) return null;              // no traversal out of the run dir
  const f = join(OUT(), id, file);
  return existsSync(f) ? readFileSync(f) : null;
}

export function forget(id) {
  const d = join(OUT(), id);
  if (!existsSync(d)) return { removed: 0 };
  rmSync(d, { recursive: true, force: true });
  return { removed: 1, id };
}

export function stats() {
  const all = runs({ limit: 500 });
  return {
    runs: all.length,
    chrome: findChrome(),
    out: resolve(OUT()),
    passing: all.filter((r) => r.summary?.passed).length,
    cortex: (process.env.IRIS_CORTEX_URL || 'http://localhost:7800').replace(/\/$/, ''),
  };
}

function pickViewports(v) {
  if (!v) return ['phone', 'desktop'];                   // the two that actually disagree
  const list = (Array.isArray(v) ? v : String(v).split(',')).map((s) => s.trim()).filter(Boolean);
  const bad = list.filter((x) => !VIEWPORTS[x]);
  if (bad.length) throw new Error(`unknown viewport(s): ${bad.join(', ')} — pick from ${Object.keys(VIEWPORTS).join(', ')}`);
  return list.length ? list : ['phone', 'desktop'];
}
function pickThemes(t) {
  if (!t) return THEMES;
  const list = (Array.isArray(t) ? t : String(t).split(',')).map((s) => s.trim()).filter(Boolean);
  const bad = list.filter((x) => !THEMES.includes(x));
  if (bad.length) throw new Error(`unknown theme(s): ${bad.join(', ')} — pick from ${THEMES.join(', ')}`);
  return list.length ? list : THEMES;
}
