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
  const run = await iris.look(fixture('sloppy.html'), { viewports: 'desktop', themes: 'light' });

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
  const run = await iris.look(fixture('clean.html'), { viewports: 'desktop', themes: 'light' });
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
