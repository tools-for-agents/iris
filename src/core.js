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
import { auditPage, critiquePage, canvasHealth, blindSpots, instrumentFrames, readFrames } from './audit.js';

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

// A design system is a file. Look for one where a project would keep it, so the
// agent does not have to be told.
export function loadTokens(explicit) {
  const tries = explicit ? [explicit]
    : ['./iris.tokens.json', './tokens.json', join(resolve(OUT(), '..'), 'iris.tokens.json')];
  for (const t of tries) {
    try { if (existsSync(t)) return JSON.parse(readFileSync(t, 'utf8')); } catch { /* malformed → fall through */ }
  }
  if (explicit) throw new Error(`no tokens file at ${explicit}`);
  return null;
}

const slug = (s) => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 40).toLowerCase() || 'page';
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

// ── the game's palette ───────────────────────────────────────────────────────
// A canvas is ONE element with ONE colour as far as the DOM knows. So every taste
// check iris has — type scale, spacing grid, radii, palette — is blind to a game.
// Games got no design review at all, which is exactly why agent-written games look
// the way they do: `'red'`, then `'#ff0000'`, then `'crimson'`, across two hundred
// lines, and nobody ever chose any of them.
//
// A declared palette fixes it the same way tokens.json fixed CSS. The model does not
// have to remember what it picked ten lines ago, if the answer is in a file.
const HEX = (h) => {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(h).trim());
  if (!m) return null;
  const s = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
};
// "redmean" — a cheap approximation of perceptual distance, and much closer to what an
// eye does than plain Euclidean RGB, which thinks green and blue are equally far apart.
const dist = (a, b) => {
  const rb = (a[0] + b[0]) / 2, dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return Math.sqrt((2 + rb / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rb) / 256) * db * db);
};
const rgbs = (c) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

export function gameDesign(canvases, game) {
  const F = [];
  const roles = Object.entries(game?.palette || {})
    .map(([name, hex]) => ({ name, hex, rgb: HEX(hex) })).filter((r) => r.rgb);
  if (!roles.length) return null;
  const tol = +game.tolerance || 30;

  // ── roles nobody can tell apart ──────────────────────────────────────────
  // If two roles sit closer together than the tolerance used to match a pixel TO a
  // role, the palette is ambiguous by construction: a pixel cannot be attributed to
  // either of them. And if the thing you chase and the thing that kills you are the
  // same colour, the game is unplayable however cleanly it renders — which no
  // screenshot, and no DOM assertion, will ever tell you.
  for (let i = 0; i < roles.length; i++) {
    for (let j = i + 1; j < roles.length; j++) {
      const d = dist(roles[i].rgb, roles[j].rgb);
      if (d < tol) {
        F.push({ rule: 'indistinct-roles', severity: 'design',
          detail: `“${roles[i].name}” (${roles[i].hex}) and “${roles[j].name}” (${roles[j].hex}) are ${Math.round(d)} apart — `
            + `closer than the ${tol} you set as the tolerance. Two roles a player cannot tell apart are one role and a bug report.` });
      }
    }
  }

  // ── the ground you drew is not the ground you declared ───────────────────
  const ground = roles.find((r) => r.name === 'ground' || r.name === 'background');
  for (const cv of canvases) {
    if (!ground || !cv.ground) continue;
    const d = dist(cv.ground, ground.rgb);
    if (d > tol) {
      F.push({ rule: 'off-palette-ground', severity: 'design',
        detail: `the canvas is painted on ${rgbs(cv.ground)}, but you declared the ground as “${ground.name}” ${ground.hex} `
          + `(${Math.round(d)} away). Everything else is measured against the ground — get that wrong and every other colour is wrong with it.` });
    }
  }

  // ── colours nobody chose ─────────────────────────────────────────────────
  const off = new Map();
  for (const cv of canvases) {
    for (const c of cv.ink_colors || []) {
      let best = null;
      for (const r of roles) {
        const d = dist(c.rgb, r.rgb);
        if (!best || d < best.d) best = { d, role: r };
      }
      if (!best || best.d <= tol) continue;
      const key = c.rgb.join(',');
      const prev = off.get(key);
      if (prev) prev.share += c.share;
      else off.set(key, { rgb: c.rgb, share: c.share, near: best.role, d: best.d });
    }
  }
  if (off.size) {
    const list = [...off.values()].sort((a, b) => b.share - a.share).slice(0, 8);
    F.push({ rule: 'off-palette', severity: 'design',
      detail: `${off.size} colour${off.size > 1 ? 's are' : ' is'} drawn on the canvas that ${off.size > 1 ? 'are' : 'is'} not in your game palette: `
        + list.map((o) => `${rgbs(o.rgb)} (${(o.share * 100).toFixed(1)}% of the ink → nearest is “${o.near.name}” ${o.near.hex}, ${Math.round(o.d)} away)`).join('; ')
        + `. A palette is the set of things a colour is ALLOWED to mean; anything else is a decision nobody made.`,
      values: list.map((o) => ({ value: rgbs(o.rgb), nearest: o.near.hex, role: o.near.name, distance: Math.round(o.d), share: o.share })) });
  }

  return { findings: F, roles: roles.map((r) => ({ name: r.name, hex: r.hex })), tolerance: tol };
}

// ── look: render it, and hand back the pixels ────────────────────────────────
export async function look(target, opts = {}) {
  const url = toUrl(target);
  const viewports = pickViewports(opts.viewports);
  const themes = pickThemes(opts.themes);
  const runId = `${slug(target)}-${stamp()}`;
  const dir = join(OUT(), runId);
  mkdirSync(dir, { recursive: true });

  const tokens = opts.tokens === false ? null : loadTokens(typeof opts.tokens === 'string' ? opts.tokens : undefined);
  // A declared system also declares its floors: if you say your smallest type is
  // 12px and your smallest target is 24px, those are the numbers iris holds you to.
  const cfg = { ...DEFAULTS,
    ...(tokens ? { minFont: tokens.minFont ?? DEFAULTS.minFont, minTap: tokens.minTap ?? DEFAULTS.minTap,
                   contrastAA: tokens.contrastAA ?? DEFAULTS.contrastAA } : {}),
    ...opts };
  const session = await open();
  const shots = [];
  let canvases = [];
  let spots = null;
  let design = null;
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
        // Taste is a property of the design, not of the window it is shown in — so
        // measure the scales once, on the widest render, rather than six times.
        if (opts.critique !== false && !design && vp === viewports[viewports.length - 1]) {
          design = await session.page.evaluate(critiquePage, { grid: +opts.grid || 4, tokens });
        }
        // `look` never looked inside a canvas. Every check it has — overlap, contrast,
        // tap targets, the whole design system — reads the DOM, and a canvas is ONE
        // element with ONE colour as far as the DOM knows. So a page that draws its
        // content on a canvas got a full, confident audit of the frame around it.
        if (!canvases.length) canvases = await session.page.evaluate(canvasHealth);
        if (!spots) spots = await session.page.evaluate(blindSpots);
        shots.push({
          viewport: vp, theme, file, path: join(dir, file), bytes: png.length,
          violations: a ? a.violations : [], counts: a ? a.counts : {},
          console: session.page.console.slice(0, 20),
        });
      }
    }
  } finally { await session.close(); }

  // WHAT THE EYE CANNOT SEE, IT MUST SAY IT CANNOT SEE.
  //
  // iris told me "✓ nothing broken" about a page whose hero was visibly wrong: the ring's
  // labels were printed on top of its nodes. iris was RIGHT — every DOM check passed —
  // and the page was still broken, because the ring is a canvas, and to the DOM a canvas
  // is one element with one colour.
  //
  // A verdict that does not say what it covered invites you to stop looking. That is the
  // most dangerous thing a checker can do, and it is the same failure as `input-unproven`,
  // which iris already refuses to guess at. So: scope the verdict. If real pixels were
  // drawn on a canvas, the headline says the checks are blind there, and says look.
  const inked = canvases.filter((c) => (c.painted || 0) > 0.005);
  const frames = spots?.iframes || 0;
  const reasons = [];
  if (inked.length) {
    reasons.push(`${inked.length > 1 ? `${inked.length} canvases are` : 'a canvas is'} drawing here, and a canvas is `
      + `one element with one colour as far as the DOM knows`);
  }
  if (frames) {
    reasons.push(`${frames > 1 ? `${frames} iframes are` : 'an iframe is'} embedded here, and every check runs against `
      + `the TOP document — a frame is a separate one, audited by nobody`);
  }
  const blind = reasons.length
    ? { canvases: inked.length, iframes: frames, reasons }
    : null;

  const run = summarise({ id: runId, kind: 'look', target, url, dir, shots, design, canvases, blind });
  writeFileSync(join(dir, 'run.json'), JSON.stringify(run, null, 2));
  return run;
}

// ── tokens: read the system a page is ALREADY using ──────────────────────────
// Writing a design system from nothing is a blank page. Reading one out of a page
// you already like is a starting point you can edit. This is the bootstrap.
export async function extractTokens(target, opts = {}) {
  const url = toUrl(target);
  const session = await open();
  let scales;
  try {
    await session.page.viewport(VIEWPORTS.desktop);
    await session.page.theme(opts.theme || 'dark');
    await session.page.goto(url);
    scales = (await session.page.evaluate(critiquePage, { grid: 4 })).scales;
  } finally { await session.close(); }

  // Keep what the page actually leans on. A size used once is a decision nobody
  // made; a size used forty times is the system, whether or not anyone wrote it down.
  const keep = (list, minUses) => list.filter((x) => x.count >= minUses).map((x) => x.value);
  const uses = (list) => list.reduce((a, x) => a + x.count, 0);
  const type = keep(scales.type, Math.max(2, uses(scales.type) * 0.02));
  const radius = keep(scales.radius, Math.max(2, uses(scales.radius) * 0.05));
  // The grid is whichever of 8/4/2 the page's spacing most nearly obeys.
  const spaceVals = scales.spacing.flatMap((x) => Array(Math.min(x.count, 50)).fill(x.value));
  const fit = (g) => spaceVals.filter((v) => v % g === 0).length / (spaceVals.length || 1);
  const grid = [8, 4, 2].find((g) => fit(g) >= 0.8) || 4;

  return {
    name: opts.name || 'extracted',
    type: type.length ? type : [12, 14, 16, 20],
    spacing: { grid },
    radius: radius.length ? radius : [8, 12],
    minFont: 12, minTap: 24, contrastAA: 4.5,
    _observed: { type: scales.type, radius: scales.radius, grid_fit: { 8: +fit(8).toFixed(2), 4: +fit(4).toFixed(2), 2: +fit(2).toFixed(2) } },
  };
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
  let metrics = null, inputEffect = null, canvases = [];
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
    canvases = await page.evaluate(canvasHealth);

    // Does it answer? Press each key ON ITS OWN and see whether the picture changed.
    //
    // Pressing them all together and asking "did anything move" is how a game that
    // implements ArrowLeft and ArrowRight, promises "space to dash" in its own HUD,
    // and does nothing at all on space, reports as `input registered`. One working
    // key was covering for every broken one.
    if (keys.length) {
      const h = (b) => createHash('sha1').update(b).digest('hex');
      const per = [];
      for (const k of keys) {
        const before = await page.screenshot();
        await page.press(k);
        await new Promise((r) => setTimeout(r, 260));     // a few frames for the effect to land
        const after = await page.screenshot();
        // The game is animating anyway, so a changed picture proves nothing on its
        // own. Compare against how much it changes when we press NOTHING.
        per.push({ key: k, changed: h(before) !== h(after), before, after });
      }
      // The control: what does an idle interval look like?
      const idle0 = await page.screenshot();
      await new Promise((r) => setTimeout(r, 260));
      const idle1 = await page.screenshot();
      const animatesOnItsOwn = h(idle0) !== h(idle1);

      writeFileSync(join(dir, 'input-before.png'), per[0].before);
      writeFileSync(join(dir, 'input-after.png'), per.at(-1).after);
      inputEffect = {
        keys,
        animates_on_its_own: animatesOnItsOwn,
        per_key: per.map(({ key, changed }) => ({ key, changed })),
        changed: per.some((p) => p.changed),
      };
      // If the picture moves by itself, "the pixels changed" tells you nothing — so
      // measure the honest thing instead: does the PLAYER respond. We cannot know
      // that from pixels alone, so we say what we know and do not overclaim.
      inputEffect.conclusive = !animatesOnItsOwn;
    }
  } finally { await session.close(); }

  const uniq = new Set(frames.map((f) => f.hash)).size;
  const v = [];

  // ── the canvas, in pixels ──────────────────────────────────────────────────
  for (const cv of canvases) {
    // A 400x250 canvas stretched to 800x500 doubles every pixel. The most common
    // thing wrong with a hand-written game, and a screenshot will not show it to you
    // — it just looks slightly soft, and you assume that is the style.
    if (cv.scale >= 1.5) {
      v.push({ rule: 'canvas-blur', severity: 'medium', selector: 'canvas', detail:
        `the canvas is ${cv.backing[0]}x${cv.backing[1]} but drawn at ${cv.css[0]}x${cv.css[1]} CSS px — every pixel is `
        + `stretched ${cv.scale}x. Set width/height to ${cv.want[0]}x${cv.want[1]} (css x devicePixelRatio) and scale the context.` });
    }
    // You cannot see the game. It renders, it animates, it answers the keys, and the
    // player and the obstacles are all tasteful dark greys on a dark ground.
    if (cv.best_contrast != null && cv.ink_coverage > 0.0005 && cv.best_contrast < 3) {
      v.push({ rule: 'unreadable', severity: 'high', selector: 'canvas', detail:
        `nothing on the canvas reaches 3:1 against the background ${cv.background} — the most visible shape is `
        + `${cv.best_contrast}:1. The game draws, and you cannot see it.` });
    } else if (cv.readable_shapes === 0 && cv.shapes > 0) {
      v.push({ rule: 'unreadable', severity: 'high', selector: 'canvas', detail:
        `${cv.shapes} distinct shapes are drawn and not one of them clears 3:1 against ${cv.background}.` });
    }
    if (cv.ink_coverage != null && cv.ink_coverage < 0.0005) {
      v.push({ rule: 'empty-canvas', severity: 'medium', selector: 'canvas', detail:
        `${(cv.ink_coverage * 100).toFixed(2)}% of the canvas is anything other than the background — it is very nearly blank.` });
    }
  }

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
  if (inputEffect) {
    const dead = inputEffect.per_key.filter((k) => !k.changed).map((k) => k.key);
    if (!inputEffect.changed) {
      v.push({ rule: 'input-ignored', severity: 'high', selector: 'window', detail:
        `pressed ${inputEffect.keys.join(', ')} and not a single pixel changed — the game is not listening` });
    } else if (inputEffect.conclusive && dead.length) {
      // The game is otherwise still, so a key that changed nothing changed nothing.
      v.push({ rule: 'input-ignored', severity: 'high', selector: 'window', detail:
        `${dead.join(', ')} did nothing. ${inputEffect.per_key.filter((k) => k.changed).map((k) => k.key).join(', ')} `
        + `worked — which is exactly how a dead key hides: one working key covers for it.` });
    } else if (!inputEffect.conclusive) {
      // And here iris DECLINES. The picture moves on its own, so "the pixels changed"
      // proves nothing about the key. Saying "input registered" here — which is what
      // it used to say — is a confident answer to a question it cannot answer.
      v.push({ rule: 'input-unproven', severity: 'low', selector: 'window', detail:
        `this game animates on its own, so a changed frame does not prove a key did anything. `
        + `iris cannot tell you from pixels whether ${inputEffect.keys.join(', ')} actually work — and neither can a screenshot. `
        + `Test the keys yourself, or give the game a still state to be probed in.` });
    }
  }

  // A game has no type scale and no spacing grid, so until now it got no taste review
  // at all — only "can you see it". A declared palette is the one design system a
  // canvas CAN be held to, and it is read from the same tokens.json as everything else.
  const tokens = opts.tokens === false ? null : loadTokens(typeof opts.tokens === 'string' ? opts.tokens : undefined);
  const design = tokens?.game ? gameDesign(canvases, tokens.game) : null;

  const run = summarise({ id: runId, kind: 'play', target, url, dir,
    shots: [{ viewport: opts.viewport || 'desktop', theme: opts.theme || 'dark', file: frames.at(-1)?.file,
      path: frames.at(-1)?.path, violations: v, counts: {}, console: session.page.console.slice(0, 20) }],
    frames, metrics, input: inputEffect, canvases, unique_frames: uniq, seconds, design });
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

// Never let the headline contradict the finding underneath it. "input registered"
// on a game whose picture moves by itself is a claim iris cannot support.
function inputWord(i) {
  if (!i.changed) return 'IGNORED';
  if (!i.conclusive) return 'unproven (the picture moves on its own)';
  const dead = i.per_key.filter((k) => !k.changed).map((k) => k.key);
  return dead.length ? `${dead.join('/')} IGNORED` : 'registered';
}

// A briefing an agent can act on: what is wrong, where, and nothing else. Kept
// short on purpose — a 4000-token wall of violations gets skimmed, not fixed.
export function report(run, { limit = 25 } = {}) {
  const L = [];
  const s = run.summary;
  L.push(`${run.kind === 'play' ? '🎮' : '👁'}  ${run.target}`);
  if (run.kind === 'play' && run.metrics?.instrumented) {
    L.push(`   ${run.metrics.fps} fps · ${run.frames.length} frames, ${run.unique_frames} distinct · worst hitch ${run.metrics.worst_hitch_ms}ms`
      + (run.input ? ` · input ${inputWord(run.input)}` : ''));
  } else {
    L.push(`   ${run.shots.length} renders (${[...new Set(run.shots.map((x) => x.viewport))].join(', ')} × ${[...new Set(run.shots.map((x) => x.theme))].join(', ')})`);
  }
  // The headline must never claim more than was examined. "✓ nothing broken" on a page
  // whose content is drawn on a canvas is TRUE and USELESS: every check above reads the
  // DOM, and to the DOM a canvas is one element with one colour. It told me the kit's own
  // hero was fine while its labels were printed on top of its nodes.
  //
  // A verdict that does not say what it covered invites you to stop looking, which is the
  // most dangerous thing a checker can do.
  if (s.passed) L.push(run.blind ? '   ✓ nothing broken IN WHAT I COULD SEE — and I could not see all of it:' : '   ✓ nothing broken');
  else L.push(`   ${s.high} high · ${s.medium} medium · ${s.low} low · ${s.console_errors} console`);
  // The gap is a gap whether or not something else failed. A page with one finding and an
  // unaudited iframe has not been checked, it has been partly checked, and the difference
  // is the whole point.
  if (run.blind) {
    if (!s.passed) L.push('   …and I could not see all of it:');
    for (const r of run.blind.reasons) L.push(`     · ${r}.`);
    L.push('     LOOK AT THE PICTURE. It is the only thing that can.');
  }

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

  // Taste, kept separate on purpose. A page can be entirely un-broken and still
  // look like nobody designed it — and that is a different conversation from "this
  // is broken", so it gets a different heading and it does not fail the build.
  const D = run.design?.findings || [];
  if (D.length) {
    L.push('');
    L.push('  ── nothing is broken here, but nobody decided it either ──');
    for (const d of D) L.push(`  · ${d.rule} — ${d.detail}`);
  }
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
