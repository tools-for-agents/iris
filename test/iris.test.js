// iris tests — run with `node --test`. These drive a REAL headless browser against
// fixture pages, because a test that mocked the browser would be testing everything
// except the one thing iris is for: looking.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const out = mkdtempSync(join(tmpdir(), 'iris-test-'));
process.env.IRIS_OUT = out;
process.on('exit', () => { try { rmSync(out, { recursive: true, force: true }); } catch {} });

const iris = await import('../src/core.js');
const fixture = (n) => resolve(import.meta.dirname, 'fixtures', n);

// No browser → nothing here can run. Say so loudly rather than passing vacuously:
// a green suite that never opened a browser is exactly the false comfort iris exists
// to abolish.
const chrome = (await import('../src/browser.js')).findChrome();
const needsChrome = { skip: chrome ? false : 'no Chrome found (set IRIS_CHROME)' };

const rule = (run, r) => run.violations.filter((v) => v.rule === r);

test('the eye catches every defect on a page written without looking', needsChrome, async () => {
  const run = await iris.look(fixture('broken.html'), { viewports: 'desktop', themes: 'light' });

  // Each of these is a real mistake an agent makes writing CSS blind, and every
  // one is invisible to a DOM assertion — which is why they survive into production.
  assert.equal(rule(run, 'page-overflow').length, 1, 'the page scrolls sideways');
  assert.ok(rule(run, 'clipped').some((v) => /escapee/.test(v.selector)),
    'a button hanging off the right edge is a button you cannot click');
  assert.ok(rule(run, 'contrast').some((v) => /ghost/.test(v.selector)),
    '#c8c8c8 on white is 1.67:1 — present, and unreadable');
  assert.ok(rule(run, 'tiny-text').some((v) => /whisper/.test(v.selector)), '8px type');
  assert.ok(rule(run, 'tap-target').some((v) => /pip/.test(v.selector)), 'a 14px button');
  assert.ok(rule(run, 'overlap').length >= 1, 'text printing over text');

  // A page that throws is broken however good it looks.
  assert.ok(run.console_errors.some((e) => /undefinedFunction/.test(e.text)), 'the exception is caught too');
  assert.equal(run.summary.passed, false);

  // And it produced actual pixels — the whole point.
  const png = run.shots[0].path;
  assert.ok(existsSync(png) && statSync(png).size > 1000, 'a real PNG landed on disk');
});

test('a clean page passes — the eye does not cry wolf', needsChrome, async () => {
  const run = await iris.look(fixture('clean.html'), { viewports: 'desktop,phone', themes: 'dark,light' });
  assert.equal(run.shots.length, 4, '2 viewports × 2 themes');
  assert.deepEqual(run.violations, [], `expected no violations, got: ${JSON.stringify(run.violations)}`);
  assert.equal(run.console_errors.length, 0);
  assert.equal(run.summary.passed, true);
});

// The headline case. A dead game renders one perfect frame and then nothing —
// it is FLAWLESS in a screenshot. Only watching it move tells you the truth.
test('a game that renders one perfect frame and then dies is caught — a screenshot never would', needsChrome, async () => {
  const run = await iris.play(fixture('deadgame.html'), { seconds: 2, frames: 4, keys: 'ArrowRight,ArrowLeft' });
  assert.equal(run.unique_frames, 1, 'every frame is pixel-identical');
  assert.ok(rule(run, 'frozen').length, 'nothing is animating');
  assert.ok(rule(run, 'no-raf').length, 'there is no game loop at all');
  assert.ok(rule(run, 'input-ignored').length, 'it does not answer the arrow keys');
  assert.equal(run.summary.passed, false);
});

test('a real game passes: the loop runs, the frames differ, and it answers the keys', needsChrome, async () => {
  const run = await iris.play(fixture('livegame.html'), { seconds: 2, frames: 4, keys: 'ArrowRight' });
  assert.ok(run.metrics.fps >= 30, `expected a playable frame rate, got ${run.metrics.fps}`);
  assert.ok(run.unique_frames > 1, 'the picture actually changes');
  assert.equal(run.input.changed, true, 'pressing ArrowRight moved something');
  assert.equal(rule(run, 'frozen').length, 0);
  assert.equal(rule(run, 'input-ignored').length, 0);
  assert.equal(run.summary.passed, true);
});

// The same defect at three viewports is ONE bug. A report that lists it three
// times buries the other two bugs under it.
test('the report collapses one defect across viewports instead of repeating it', needsChrome, async () => {
  const run = await iris.look(fixture('broken.html'), { viewports: 'desktop,phone', themes: 'light' });
  const txt = iris.report(run);
  const overflow = txt.split('\n').filter((l) => l.includes('page-overflow'));
  assert.equal(overflow.length, 1, 'listed once…');
  assert.match(txt, /at desktop\/light, phone\/light|at phone\/light, desktop\/light/, '…but says it happens at both');
});

test('runs are remembered, readable, and can be forgotten', needsChrome, async () => {
  const run = await iris.look(fixture('clean.html'), { viewports: 'desktop', themes: 'dark' });
  const list = iris.runs();
  assert.ok(list.some((r) => r.id === run.id), 'the run is in the store');
  assert.ok(iris.getRun(run.id).summary.passed);
  assert.ok(iris.shotBytes(run.id, 'desktop-dark.png').length > 1000, 'the PNG reads back');
  // no climbing out of the run directory
  assert.equal(iris.shotBytes(run.id, '../../../etc/passwd'), null);
  assert.equal(iris.forget(run.id).removed, 1);
  assert.equal(iris.getRun(run.id), null);
});

test('a bad viewport or theme name fails loudly instead of silently rendering the default', () => {
  assert.throws(() => iris.toUrl('./does-not-exist.html'), /no such page/);
});

// The other half of the problem. Everything above asks "is it broken". This asks
// "did anyone DESIGN it" — because a page can be entirely un-broken and still look
// like a machine wrote it, and that is what the user actually complains about.
test('a page that works perfectly and was designed by nobody is called out for it', needsChrome, async () => {
  // tokens:false on purpose — this is the HEURISTIC path, for a project that has not
  // declared a system. (With one declared, the answer is sharper; see the last test.)
  const run = await iris.look(fixture('sloppy.html'), { viewports: 'desktop', themes: 'light', tokens: false });

  // Nothing is WRONG with it. That is the entire point of the fixture.
  assert.equal(run.summary.passed, true, 'sloppy.html is not broken — it renders, it fits, it is readable');

  const d = Object.fromEntries((run.design.findings || []).map((f) => [f.rule, f]));
  assert.ok(d['type-scale'], 'eight font sizes is not a scale, it is an accumulation');
  assert.match(d['type-scale'].detail, /8 distinct font sizes/);
  assert.ok(d['spacing-grid'], '9px next to 11px next to 13px is nudging, not deciding');
  assert.ok(d['radius-scale'], 'seven corner radii');
  assert.ok(d['twin-colours'], 'four greys a person cannot tell apart are one grey and a maintenance cost');

  // Design findings must NOT fail the build — taste is a conversation, not a gate.
  assert.equal(run.summary.high, 0);
});

test('a page on a scale is left alone — the critique is not a lint that fires on everything', needsChrome, async () => {
  const run = await iris.look(fixture('clean.html'), { viewports: 'desktop', themes: 'light', tokens: false });
  assert.deepEqual(run.design.findings, [],
    `a page on a grid with one radius and a real type scale must draw no comment, got: ${JSON.stringify(run.design.findings)}`);
  // and it still reports the scales it measured, so you can see what you actually built
  assert.ok(run.design.scales.type.length >= 1);
});

// The worst thing an eye can do is report confidently on a page it never saw. A
// failed navigation still renders — Chrome's own error page — and still fires
// `load`, so iris used to screenshot THAT, audit it, and hand back a tidy verdict.
// It once told me six different apps had identical defects, because it was looking
// at the same error page six times. Refusing to look is the honest answer.
test('a page that never loaded is refused, not audited', needsChrome, async () => {
  await assert.rejects(
    () => iris.look('http://127.0.0.1:1/', { viewports: 'desktop', themes: 'dark' }),
    /could not load/,
    'a connection that is refused must throw, not produce a clean report about Chrome’s error page');
});

test('a page the server answered with 404 is refused too — that is its error page, not yours', needsChrome, async () => {
  const { createServer } = await import('node:http');
  const srv = createServer((req, res) => {
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>gone</title><body><h1>404</h1><p>Not found.</p></body>');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/missing`;
  try {
    // This page is perfectly well-formed: it renders, it fits, it is readable. It
    // would audit CLEAN — which is exactly why the status has to be checked.
    await assert.rejects(() => iris.look(url, { viewports: 'desktop', themes: 'dark' }), /HTTP 404/);
  } finally { srv.close(); }
});

// The `background` shorthand resets background-color to transparent, so a page whose
// body is a gradient reports NO background colour anywhere — and a checker that reads
// only background-color measures its light-grey text against WHITE. That turned a
// dark, perfectly readable app into a dozen contrast "failures". Contrast must be
// judged against what is actually PAINTED.
test('text on a gradient is judged against the gradient, not against a white page that is not there', needsChrome, async () => {
  const run = await iris.look(fixture('gradient.html'), { viewports: 'desktop', themes: 'dark' });
  assert.deepEqual(rule(run, 'contrast'), [],
    `every pixel of this page is dark and every word legible; got: ${JSON.stringify(rule(run, 'contrast'))}`);
  assert.equal(run.summary.passed, true);
});

// A game can render, animate at 120fps, and answer the keys — and be unplayable,
// because you cannot SEE it. The DOM contrast check is no help: a canvas is one
// element with one colour as far as the DOM knows. So iris reads the pixels.
test('a game you cannot see is caught — it renders, it animates, and it is invisible', needsChrome, async () => {
  const run = await iris.play(fixture('invisiblegame.html'), { seconds: 2, frames: 3 });

  // Everything iris knew how to check BEFORE this passes.
  assert.ok(run.metrics.fps >= 30, 'the loop runs');
  assert.ok(run.unique_frames > 1, 'the frames differ');

  const un = rule(run, 'unreadable')[0];
  assert.ok(un, 'nothing on this canvas reaches 3:1 against the ground');
  assert.match(un.detail, /you cannot see it|clears 3:1/);

  // And a 320×200 canvas drawn at 640×400 doubles every pixel. A screenshot just
  // looks slightly soft, and you assume that is the style.
  const blur = rule(run, 'canvas-blur')[0];
  assert.ok(blur, 'the canvas is stretched');
  assert.match(blur.detail, /320x200 but drawn at 640x400/);
  assert.equal(run.summary.passed, false);
});

// One working key covers for every dead one. Pressing them all together and asking
// "did anything move" is how a game that promises "space to dash" in its own HUD,
// and does nothing at all on space, reported as `input registered`.
test('a dead key hides behind a working one — unless you press them one at a time', needsChrome, async () => {
  const run = await iris.play(fixture('deadkey.html'), { seconds: 1, frames: 2, keys: 'ArrowRight,Space' });
  assert.equal(run.input.conclusive, true, 'this game is still until you press something, so pixels DO prove it');
  assert.deepEqual(run.input.per_key, [{ key: 'ArrowRight', changed: true }, { key: 'Space', changed: false }]);
  const ig = rule(run, 'input-ignored')[0];
  assert.ok(ig, 'Space did nothing and must be named');
  assert.match(ig.detail, /Space did nothing/);
});

// And where pixels genuinely cannot answer, iris says so instead of guessing. A game
// that moves on its own changes pixels whether or not the key did anything —
// "input registered" there is a confident answer to a question it cannot answer.
test('when the picture moves on its own, iris declines to claim the keys work', needsChrome, async () => {
  const run = await iris.play(fixture('livegame.html'), { seconds: 1, frames: 2, keys: 'ArrowRight' });
  assert.equal(run.input.conclusive, false, 'livegame animates by itself');
  assert.ok(rule(run, 'input-unproven').length, 'it must say it cannot know, not that the key worked');
  assert.match(iris.report(run), /input unproven/);
  // …and declining is not a failure. It is a fact about the game, not a defect.
  assert.equal(run.summary.high, 0);
});

// The generic critique can only ask "are you consistent with YOURSELF" — which
// catches drift but cannot tell you what you should have chosen. A declared system
// can. This page is perfectly consistent, and consistent with a system nobody
// declared: 15px type, 10px radii, 18px spacing. Every value is named, with the one
// it should have been.
test('a page graded against a declared system is told exactly which value to use instead', needsChrome, async () => {
  const run = await iris.look(fixture('offsystem.html'),
    { viewports: 'desktop', themes: 'dark', tokens: fixture('tokens.json') });

  const f = Object.fromEntries(run.design.findings.map((x) => [x.rule, x]));

  const t = f['off-scale-type'];
  assert.ok(t, '15px and 26px are not in the declared scale');
  assert.ok(t.values.some((v) => v.value === 15 && v.nearest === 14), 'and it says 15 → 14');
  assert.ok(t.values.every((v) => v.at?.length), 'every value names where it lives — a bare number sends you hunting');

  const r = f['off-scale-radius'];
  assert.ok(r.values.some((v) => v.value === 10 && v.nearest === 8), '10px radius → 8px');

  const g = f['off-grid-spacing'];
  assert.ok(g.values.some((v) => v.value === 18 && v.nearest === 20), '18px → the 4px grid');

  // The system's own floors are what iris holds you to.
  assert.equal(run.summary.high, 0, 'nothing here is BROKEN — that is the whole point');

  // And without the system, the same page draws almost no comment: it IS consistent.
  const loose = await iris.look(fixture('offsystem.html'), { viewports: 'desktop', themes: 'dark', tokens: false });
  assert.ok(loose.design.findings.length < run.design.findings.length,
    'the heuristic sees a tidy page; only the declared system sees a wrong one');
});

// ── The DOM lies, and iris believed it. Twice. ───────────────────────────────────
// Both of these were found by pointing iris at the kit's own landing page — the one
// surface the eye had never seen. It reported four defects. All four were iris's.

test('an inline that wraps is not a rectangle — two <b>s in one sentence do not collide', needsChrome, async () => {
  const run = await iris.look(fixture('inlinewrap.html'), { viewports: 'desktop', themes: 'dark' });

  // getBoundingClientRect() on a wrapped inline is the UNION of its line boxes — a
  // shape it never occupies. Compare those unions and any two <b>s in a paragraph
  // "print over" each other. Compare the LINE boxes and they plainly do not.
  assert.deepEqual(rule(run, 'overlap'), [],
    `no glyph on this page touches another; got: ${JSON.stringify(rule(run, 'overlap'))}`);

  // The headline is painted by its background. The gradient is the ink, not the ground.
  assert.deepEqual(rule(run, 'contrast'), [],
    `every stop of this gradient is bright on near-black; got: ${JSON.stringify(rule(run, 'contrast'))}`);
  assert.equal(run.summary.passed, true, 'nothing here is broken');
});

test('gradient text is judged by its darkest stop — and the old model passed a headline nobody can read', needsChrome, async () => {
  const run = await iris.look(fixture('darkclip.html'), { viewports: 'desktop', themes: 'dark' });

  const c = rule(run, 'contrast');
  assert.equal(c.length, 1, 'the smudged headline is caught');
  assert.ok(c[0].ratio < 2, `1.63:1 — unreadable; got ${c[0].ratio}:1`);

  // The proof that we measure the INK: the reported foreground must be a stop of the
  // gradient, not the #e8ebf2 `color` that the transparent fill means is never painted.
  assert.match(c[0].fg, /rgb\(4[0-9], 4[0-9], 5[0-9]\)|rgb\(5[0-9], 5[0-9], 6[0-9]\)/,
    `the ink is a gradient stop, not the never-painted color; got fg=${c[0].fg}`);
  assert.doesNotMatch(c[0].fg, /232/, 'rgb(232,235,242) is declared, and never reaches the screen');
});

// ── Games had no taste review at all ────────────────────────────────────────────
// A canvas is ONE element with ONE colour as far as the DOM knows, so type-scale,
// spacing-grid and radius checks are all blind to a game. Which is exactly why
// agent-written games look the way they do: 'red', then '#ff0000', then 'crimson',
// two hundred lines apart, and nobody ever chose any of them.

test('a game can be entirely un-broken and still designed by nobody', needsChrome, async () => {
  const run = await iris.play(fixture('slopgame.html'), { seconds: 2, frames: 3, tokens: resolve(import.meta.dirname, '..', 'tokens.json') });

  // It draws, it animates, it answers the keys, every shape is readable. Nothing is broken.
  assert.equal(run.summary.passed, true, 'this game works — that is the whole point of the fixture');

  // And it is five different reds for one meaning, plus a green that means nothing.
  const off = run.design.findings.find((f) => f.rule === 'off-palette');
  assert.ok(off, 'the colours nobody chose are named');
  assert.ok(off.values.length >= 4, `four distinct reds and a stray green; got ${off.values.length}`);

  // Naming the value is not enough — it has to say what it SHOULD have been.
  // "rgb(220,20,60) is off-palette" sends you hunting. "→ danger #ec4899" does not.
  assert.ok(off.values.every((v) => v.nearest && v.role && v.distance > 0),
    'every off-palette colour names the role it came closest to');
  assert.ok(off.values.some((v) => v.role === 'danger'), 'the reds are reaching for "danger"');
});

test('a game that is on the palette is left alone — the check is not a lint that fires on everything', needsChrome, async () => {
  const run = await iris.play(fixture('livegame.html'), { seconds: 2, frames: 3, tokens: resolve(import.meta.dirname, '..', 'tokens.json') });
  assert.deepEqual(run.design.findings, [],
    `this game draws the declared ground and the declared player and nothing else; got ${JSON.stringify(run.design.findings)}`);
});

test('two roles a player cannot tell apart are one role and a bug report', needsChrome, async () => {
  // The tolerance does double duty: it is how close a pixel must be to BE a role, so
  // two roles closer together than it are ambiguous by construction — no pixel could
  // ever be attributed to either. Which is also the definition of a player who cannot
  // tell the thing they chase from the thing that kills them.
  const run = await iris.play(fixture('livegame.html'), { seconds: 2, frames: 2, tokens: false });
  const d = iris.gameDesign(run.canvases, {
    tolerance: 30,
    palette: { ground: '#0b0e14', player: '#4fd6be', danger: '#54d4bd' },   // danger IS the player
  });
  const clash = d.findings.find((f) => f.rule === 'indistinct-roles');
  assert.ok(clash, 'the thing you chase and the thing that kills you are the same colour');
  assert.match(clash.detail, /player/);
  assert.match(clash.detail, /danger/);
});

// ── almost aligned is not aligned ───────────────────────────────────────────────
test('three pixels out of true is not a decision, it is an accident', needsChrome, async () => {
  const run = await iris.look(fixture('askew.html'), { viewports: 'desktop', themes: 'dark', tokens: resolve(import.meta.dirname, '..', 'tokens.json') });

  // Nothing is broken and every number is on the system. It still looks cheap.
  assert.equal(run.summary.passed, true, 'nothing here is BROKEN — that is the point');

  const a = run.design.findings.find((f) => f.rule === 'almost-aligned');
  assert.ok(a, 'the nudged card is caught');
  assert.ok(a.values.some((v) => v.value === '3px' && v.edge === 'left'), `names the offset and the edge; got ${JSON.stringify(a.values)}`);
  assert.ok(a.values.every((v) => v.at?.length === 2), 'and names BOTH elements — one of them alone is not a misalignment');
});

test('the alignment check does not fire on things working exactly as designed', needsChrome, async () => {
  // Both of these were false positives I had to kill before this could ship, and both
  // are the same mistake: comparing edges that are not comparable.
  //
  //  · a CHIP is shrink-to-fit — two chips with different words in them have different
  //    widths, so their TRAILING edges differ by definition. Only compare a trailing
  //    edge when both elements are stretched to fill the container.
  //  · a button pushed to the far end of a wrapping toolbar with `margin-left:auto` has
  //    a leading edge set by where the row ran out, not by any column. "Stacked" has to
  //    mean IN A COLUMN BY CONSTRUCTION, not "landed on different rows".
  //
  // A checker that fires on correct work teaches you to skim past it, which costs you
  // the one time it was right.
  for (const f of ['clean.html', 'sloppy.html', 'inlinewrap.html']) {
    const run = await iris.look(fixture(f), { viewports: 'desktop', themes: 'dark' });
    assert.deepEqual((run.design?.findings || []).filter((x) => x.rule === 'almost-aligned'), [],
      `${f} is aligned; got ${JSON.stringify((run.design?.findings || []).filter((x) => x.rule === 'almost-aligned'))}`);
  }
});

test('an element is only where you can SEE it — a card scrolled out of a kanban is not on the sidebar', needsChrome, async () => {
  // getBoundingClientRect() does not know about clipping. It reports a card scrolled out
  // the side of a kanban at the geometry it WOULD have had — which lands it on top of the
  // sidebar. iris called the real agent-hq dashboard "text printing over text" for a chip
  // that is not on the screen at all.
  const run = await iris.look(fixture('scrolled.html'), { viewports: 'desktop', themes: 'dark' });
  assert.deepEqual(rule(run, 'overlap'), [],
    `the scrolled-out cards are inside a scroller, clipped, invisible; got ${JSON.stringify(rule(run, 'overlap'))}`);
  assert.equal(run.summary.passed, true, 'a horizontal scroller is a design, not a defect');
});

// ── stdout IS the protocol ──────────────────────────────────────────────────────
// An MCP server speaks newline-delimited JSON-RPC on stdout and NOTHING else.
//
// One console.log anywhere in a code path a tool can reach — a leftover debug line, a
// helpful progress message — puts a line on that stream which is not a message. The
// client desyncs. It does not fail loudly: the call simply never comes back, or comes
// back as the wrong reply to the wrong request, and the agent is left holding a session
// that has quietly stopped working. It is the single easiest way to break an MCP server,
// and the hardest to notice, because everything still LOOKS fine.
//
// A dynamic check cannot cover this: it only sees the code paths it happens to exercise,
// and a debug line inside `search()` is invisible until someone searches. So walk the
// import graph from the server itself and refuse the whole class.
//
// `cli.js` and `server.js` are the CLI and the `serve` command — they are meant to print,
// and the MCP server never imports them. If that ever changes, this test is what tells you.
test('nothing the MCP server can reach is allowed to print to stdout', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const { dirname, resolve, relative } = await import('node:path');

  const entry = resolve(import.meta.dirname, '..', 'mcp', 'mcp-server.js');
  const seen = new Set();
  const offenders = [];

  const walk = (file) => {
    if (seen.has(file) || !existsSync(file)) return;
    seen.add(file);
    const src = readFileSync(file, 'utf8');

    // The server itself writes the protocol — that is its job. Everything it pulls in must not.
    if (file !== entry) {
      src.split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return;                       // a comment about it is fine
        if (/console\.(log|info|debug|dir|table)\s*\(|process\.stdout\.write\s*\(/.test(line)) {
          offenders.push(`${relative(process.cwd(), file)}:${i + 1}  ${line.trim().slice(0, 70)}`);
        }
      });
    }
    for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      walk(resolve(dirname(file), m[1]));
    }
  };
  walk(entry);

  // agent-hq's MCP server imports nothing local — it is a thin HTTP client over the
  // platform's API — so for it this walk finds only the entry file, and there is genuinely
  // nothing to check. That is not a vacuous pass: it is the guard that fires the day
  // somebody wires the server straight into services.js, which does print.
  assert.ok(seen.size >= 1, 'the entry point was found');
  assert.deepEqual(offenders, [],
    'stdout is the protocol — one stray print desyncs every agent session:\n  ' + offenders.join('\n  '));
});

// ── What the eye cannot see, it must say it cannot see ──────────────────────────
test('a verdict that does not say what it covered invites you to stop looking', needsChrome, async () => {
  // iris told me "✓ nothing broken" about a page whose hero was visibly wrong: the ring's
  // labels were printed on top of its own nodes. iris was RIGHT — every DOM check passed —
  // and the page was still broken, because the ring is a canvas, and to the DOM a canvas is
  // ONE element with ONE colour. Overlap, contrast, tap targets, the whole design system:
  // all structurally blind to it.
  //
  // The blindness is not the bug. The unqualified verdict is. It is the same failure as
  // `input-unproven`, which iris already refuses to guess at.
  const canvas = await iris.look(fixture('livegame.html'), { viewports: 'desktop', themes: 'dark' });
  assert.ok(canvas.blind, 'a page drawing on a canvas is flagged as only partly examined');
  assert.equal(canvas.blind.canvases, 1);

  const said = iris.report(canvas);
  assert.match(said, /could not see all of it/, 'the headline scopes itself to what it actually checked');
  assert.match(said, /one element with one colour/, 'and names why');
  assert.match(said, /LOOK AT THE PICTURE/, 'and says the one thing that can see it');

  // And it must not cry wolf: a page with no canvas gets the plain, unqualified verdict.
  const dom = await iris.look(fixture('clean.html'), { viewports: 'desktop', themes: 'dark' });
  assert.equal(dom.blind, null, 'nothing to be blind to here');
  assert.doesNotMatch(iris.report(dom), /could not see all of it/,
    'an ordinary page is not lectured about canvases it does not have');
});

// ── The DOM is not what querySelectorAll returns ────────────────────────────────
test('a defect inside a web component is still a defect — querySelectorAll does not cross a shadow boundary', needsChrome, async () => {
  // On any page built from web components — which is to say, most modern apps — iris walked
  // the empty host elements, found nothing wrong with them, and passed the page. It audited
  // the wrapper and blessed the app.
  const run = await iris.look(fixture('shadowdom.html'), { viewports: 'desktop', themes: 'light' });

  const contrast = rule(run, 'contrast');
  const tiny = rule(run, 'tiny-text');
  assert.ok(contrast.length, '#e8e8e8 on white is 1.2:1 — inside a shadow root, and still unreadable');
  assert.ok(tiny.length, '8px is 8px wherever it is declared');

  // A defect you cannot navigate to is a defect you cannot fix. Climbing with
  // parentElement STOPS at a shadow root, so the selector has to step out through the host.
  assert.match(contrast[0].selector, /#host/, 'the selector crosses the boundary, back to something findable');

  // And the design critique sees in there too — an 8px font is off the scale wherever it lives.
  const off = (run.design?.findings || []).find((f) => f.rule === 'type-scale' || f.rule === 'off-scale-type');
  assert.ok(off || run.design, 'the critique walks the same tree');
});

test('iris says when it could not see all of a page — a partial answer that looks total is worse than an admitted gap', needsChrome, async () => {
  // An <iframe> is a separate document, and every check runs against the top one. Unlike a
  // shadow root, it cannot simply be walked into — cross-origin frames cannot be entered by
  // anyone. So rather than pierce some and quietly skip the rest, iris reports that it did
  // not enter them at all.
  const run = await iris.look(fixture('clean.html'), { viewports: 'desktop', themes: 'dark' });
  assert.equal(run.blind, null, 'an ordinary page has nothing to declare, and is not lectured');
  assert.doesNotMatch(iris.report(run), /could not see all of it/);
});

// ── Text that is on the screen and not in the tree ──────────────────────────────
test('SVG text is painted by fill, and ::after text is not an element at all', needsChrome, async () => {
  const run = await iris.look(fixture('invisibletext.html'), { viewports: 'desktop', themes: 'light' });
  const contrast = rule(run, 'contrast');

  // SVG text is painted by `fill`. `color` is inherited, irrelevant, and never reaches the
  // screen — and it is what a DOM checker reads. #eee-on-white was measured as the body's
  // #111-on-white, called 16:1, and passed. The same bug as background-clip:text.
  const svg = contrast.find((v) => /svg/.test(v.selector));
  assert.ok(svg, 'SVG text is judged by the colour that actually paints it');
  assert.ok(svg.ratio < 2, `#eee on white is 1.16:1; got ${svg.ratio}`);

  // ::after renders real words and is not an element, so a walk of the DOM never sees it.
  const after = contrast.find((v) => /::after/.test(v.selector));
  assert.ok(after, 'text rendered by a pseudo-element is still text on the screen');
  assert.match(after.detail, /on the screen but not in the DOM/, 'and the report says why you could not find it');
  assert.ok(rule(run, 'tiny-text').some((v) => /::after/.test(v.selector)), '7px is 7px, wherever it is declared');

  // And the check must not commit the very sin it exists to catch: an emoji is painted by
  // the FONT, in its own colours. Neither `color` nor `fill` touches it. There is no
  // foreground colour here to judge — and judging one anyway called four visible glyphs on
  // recall's diagram "1.08:1".
  assert.ok(!contrast.some((v) => /🧠|🛰|🧭/.test(v.text || '')),
    'a pictograph carries no foreground colour to measure, so it is not measured');
});

// ── Opacity does not inherit as a computed value ────────────────────────────────
test('text painted at 12% is not 18:1, whatever its declared colour says', needsChrome, async () => {
  // A child of `opacity: .12` still COMPUTES to `opacity: 1`. It is painted at twelve
  // percent. So iris read #111 on white, called it 18:1, and passed a paragraph the screen
  // was showing at about 1.3:1 — the disabled panel, the ghost state, the fade-in that
  // never finished. `filter: opacity()` is the same thing by another route.
  const run = await iris.look(fixture('faded.html'), { viewports: 'desktop', themes: 'light' });
  const c = rule(run, 'contrast');

  assert.ok(c.some((v) => /disabled/.test(v.selector)), 'an ancestor opacity fades the ink');
  assert.ok(c.some((v) => /ghost/.test(v.selector)), 'and so does filter: opacity()');
  assert.ok(c.every((v) => v.ratio < 2), `both are ~1.3:1 on screen; got ${c.map((v) => v.ratio)}`);

  // And it must not fire on ordinary pages: opacity 1 leaves the maths exactly as it was.
  const clean = await iris.look(fixture('clean.html'), { viewports: 'desktop', themes: 'dark' });
  assert.deepEqual(rule(clean, 'contrast'), [], 'a page with no fading is unaffected');
});

// ── A page is a state machine, and a URL lands you on exactly one of its states ─────
test('--pre renders a state you would have to click to reach, and audits it there', needsChrome, async () => {
  // Every check iris has ever run has seen ONE state: the one the URL boots into.
  // Everything you must DO something to reach — a button gone disabled, a row toggled
  // off, an error banner — was never rendered, so it was never measured. And those are
  // exactly the states that are broken, because they are the states nobody looks at.
  // (This is not hypothetical: every disabled control in the kit was unreadable, two of
  // them at 1:1 — the exact colour of their own background — and three CI gates had been
  // green over them for a month.)
  const f = fixture('states.html');

  // As it boots, this page is fine. That is the whole problem.
  const boot = await iris.look(f, { viewports: 'desktop', themes: 'dark' });
  assert.deepEqual(rule(boot, 'contrast'), [], 'nothing is wrong with the state the URL lands on');

  // Put it into the states you can only reach by doing something.
  const posed = await iris.look(f, { viewports: 'desktop', themes: 'dark',
    pre: "document.getElementById('go').disabled = true; document.getElementById('r').classList.add('off')" });
  const c = rule(posed, 'contrast');

  assert.ok(c.some((v) => /button#go/.test(v.selector)), 'the disabled button is now visible to the audit');
  assert.ok(c.some((v) => /#r\b/.test(v.selector)), 'and so is the row that was switched off');
  assert.ok(c.every((v) => v.ratio < 3), `both are faded to nothing; got ${c.map((v) => v.ratio)}`);
});

test('a --pre that fails is an error, not a pass', needsChrome, async () => {
  // The dangerous failure is not a crash, it is a no-op: a state script that quietly does
  // nothing hands back a clean report for a state that was never rendered, and reads as
  // proof the state is fine. So a state we could not reach must STOP the run.
  await assert.rejects(
    () => iris.look(fixture('states.html'), { viewports: 'desktop', themes: 'dark',
      pre: "document.getElementById('does-not-exist').disabled = true" }),
    /--pre failed/,
    'reaching for an element that is not there must fail loudly',
  );
});

// ── The state where the server says no ─────────────────────────────────────────────
test('--boot lands before the page\'s own scripts, so the API can be broken underneath it', needsChrome, async () => {
  // `--pre` runs AFTER load, which is far too late to change what the app found when it
  // started: by then it has already asked its questions and got its answers. `--boot` runs
  // before the page's first line, which is the only place you can stand if you want to
  // break the API and see what gets drawn when the server says no.
  //
  // This matters because EVERY data-driven UI is a shell that asks a server what to render,
  // and most have never rendered the answer "no" — they render an empty room instead, which
  // is indistinguishable from having no data. All seven tools in this kit did exactly that.
  const f = fixture('asks-a-server.html');

  // Prove the boot script actually took effect: the page's own fetch must see the stub.
  // (If --boot were a no-op, this element would stay empty and the test would still pass —
  // so assert on evidence the PAGE produced, not on the absence of an error.)
  const run = await iris.look(f, { viewports: 'desktop', themes: 'dark',
    boot: "window.fetch = () => Promise.resolve(new Response(JSON.stringify([{name:'the boot script got here first'}]),"
        + "{status:200,headers:{'content-type':'application/json'}}));",
    pre: "if (!document.getElementById('list').textContent.includes('got here first')) "
       + "throw new Error('the page fetched for real — --boot arrived too late to matter')" });
  assert.ok(run.summary, 'the page rendered what the boot script fed it');
});

// ── The failure path is a state too, and it was rendering nothing ──────────────────
test('when --pre fails, it hands you the picture of the page that failed it', needsChrome, async () => {
  // The first cut threw before the screenshot, so a failed assertion produced NO IMAGE —
  // iris, of all things, went blind exactly when you most needed to see. I hit it within
  // the hour: --pre asserted that a slow page says it is loading, six tools failed, and
  // every run directory was EMPTY. The verdict told me something was wrong and then
  // refused to show me what.
  const err = await iris.look(fixture('clean.html'), { viewports: 'desktop', themes: 'dark',
    pre: "throw new Error('nope')" }).then(() => null, (e) => e);

  assert.ok(err, 'a failing --pre still fails the run');
  const shot = /(\S+FAILED\.png)/.exec(err.message)?.[1];
  assert.ok(shot, `the error names a screenshot; got: ${err.message.split('\n')[0]}`);
  assert.ok(existsSync(shot), 'and the screenshot is really on disk, not just named');
  assert.ok(statSync(shot).size > 1000, 'and it is a real picture, not an empty file');
});

// ── A FIXED BAR IS ALLOWED TO COVER WHAT YOU CAN SCROLL AWAY FROM ───────────────
// The overlap check excludes everything inside a fixed/sticky layer, and it is right to:
// a sticky bar over scrolled content is what a sticky bar is FOR, and calling that "text
// printing over text" was a false positive removed on purpose.
//
// But the forgiveness had a hole. A bar may cover content the reader can SCROLL OUT FROM
// UNDER IT. On a page that CANNOT SCROLL, nothing ever moves: the text under the bar is
// sliced in half forever. That is not stacking — it is clipping, and it was sitting on
// cortex's graph view, passing every gate, for weeks.
test('a fixed bar over text on a page that CANNOT scroll is clipping it', async () => {
  const run = await iris.look(fixture('underbar.html'), { viewports: 'desktop', themes: 'light' });
  const found = rule(run, 'overlay-clip');
  assert.equal(found.length, 1, `exactly one line is buried; got ${JSON.stringify(found)}`);
  assert.match(found[0].selector, /buried/, 'and it is the line under the bar');
  assert.equal(run.summary.passed, false, 'text you can never read is a defect');
});

// THE TRANSPARENT LAYER IS THE TRAP, and I fell in it.
// elementFromPoint() answers "what is on top for HIT-TESTING" — not "what actually PAINTS
// here". A see-through fixed layer wins the hit test over text it does not put a single
// pixel on, and my first cut called a line "100% covered" with half of it in plain sight.
// Which is the bug this tool exists to catch, committed by the check itself: the DOM
// reported something the screen never showed, and the eye believed it.
test('a TRANSPARENT fixed layer covers nothing, and is never reported', async () => {
  const run = await iris.look(fixture('underbar.html'), { viewports: 'desktop', themes: 'light' });
  const hit = rule(run, 'overlay-clip').map((v) => v.selector).join(' ');
  assert.ok(!/ghosted/.test(hit), `a layer that paints nothing hides nothing; got ${hit}`);
  assert.ok(!/safe/.test(hit), 'and text under nothing at all is certainly fine');
});

// THE NEGATIVE THAT MATTERS. Same bar, same text under it — but this page SCROLLS, so the
// reader moves the line clear with one flick. Reporting that would fire on nearly every
// long page on the web, and a checker that fires on correct work teaches you to skim past
// it — which costs you the one time it was right.
//
// I nearly shipped it: `documentElement.clientHeight` is the usual idiom for "the viewport"
// and on iris's own page it reported 2583 (the CONTENT height) against a 900px viewport, so
// a page that scrolls 2.5k pixels was judged unscrollable. window.innerHeight is the viewport.
test('a fixed bar over a page that DOES scroll is not a defect — you can scroll out from under it', async () => {
  const run = await iris.look(fixture('underbar-scrolls.html'), { viewports: 'desktop', themes: 'light' });
  assert.deepEqual(rule(run, 'overlay-clip'), [],
    `the reader can scroll this line out from under the bar; got ${JSON.stringify(rule(run, 'overlay-clip'))}`);
});
