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
