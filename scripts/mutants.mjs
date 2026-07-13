// CAN THE TEST SUITE STILL FAIL?
//
// Every other gate here asks "is the code right". This one asks the question underneath it:
// IS ANYTHING STILL WATCHING. A suite that has quietly stopped covering a property goes green
// for exactly the same reason as a suite that is passing honestly, and there is no way to tell
// the two apart by looking at the green.
//
// It has happened across this kit more than once. anvil's Docker tests were SKIPPED for months
// — 11 pass, 0 fail, 9 skipped, green every run — while the tool was completely broken on
// Linux. lens's file walk swallowed .env files, and twenty green tests never saw it.
//
// So: break the code ON PURPOSE, in the exact places whose breakage would cost the most, and
// demand the suite goes RED. If it stays green, the canary is dead and this job fails — the
// test guarding that line has stopped guarding it, and you find out today rather than the
// morning after it mattered.
//
//   node scripts/mutants.mjs
//
// Each canary must have EXACTLY ONE anchor. An anchor that has drifted is a canary that
// silently stopped watching, so a missing or ambiguous anchor is a hard failure, never a skip.

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const CANARIES = [
  {
    why: 'the walk descends into shadow roots — iris audited the empty host and blessed a broken app',
    file: 'src/audit.js',
    find: '      if (el.shadowRoot) deepAll(el.shadowRoot, out);',
    into: '      void el;',
    hits: 2,   // auditPage AND critiquePage each have one; both must be watched
  },
  {
    why: "a box is intersected with its ancestors' clip — an element is only where you can SEE it",
    file: 'src/audit.js',
    find: '      const boxes = boxesOf(t.el).map((b) => clipBox(b, cl)).filter(Boolean);',
    into: '      const boxes = boxesOf(t.el);',
  },
  {
    why: 'ancestor opacity fades the ink — a child of opacity:.12 still COMPUTES to 1',
    file: 'src/audit.js',
    find: '      if (Number.isFinite(o)) a *= o;',
    into: '      if (Number.isFinite(o)) a *= 1;',
  },
  {
    why: 'a cover is only a cover if it PAINTS — a transparent layer wins the hit-test and hides nothing',
    file: 'src/audit.js',
    find: '          if (!paints(top, lay)) continue;                            // see-through: it covers nothing',
    into: '          if (false) continue;',
  },
  {
    why: 'the phone viewport must really be a phone — a desktop pointer gets hover styles and lies about tap targets',
    file: 'src/core.js',
    find: '  phone: { width: 390, height: 844, mobile: true },',
    into: '  phone: { width: 390, height: 844, mobile: false },',
  },
  {
    why: 'a page with no viewport meta is laid out at 980px and scaled down — every size on it is a size in the wrong space',
    file: 'src/audit.js',
    find: "    const meta = document.querySelector('meta[name=\"viewport\" i]');",
    into: '    const meta = true;',
  },
  {
    why: 'the shot viewer must not be walked out of the run dir — the id arg was joined raw and served /etc/passwd',
    file: 'src/core.js',
    find: '  if (f !== root && !f.startsWith(root + sep)) return null;   // escaped the run dir → refuse',
    into: '  if (false) return null;',
  },
];

// iris drives a real headless Chrome across the whole suite, so it is far slower than the other
// six repos — 42 tests, ~2.5 min locally and more on a cold CI runner. The default 300s cap
// killed the BASELINE run mid-suite, spawnSync returned status:null, and the harness read that as
// "the suite is already red" — a TIMEOUT masquerading as a FAILURE. A canary gate that cannot tell
// "the tests failed" from "the tests did not finish" is a gate that goes red for the wrong reason.
const TIMEOUT_MS = 900_000;
const run = () => {
  const r = spawnSync('npm', ['test'], { encoding: 'utf8', timeout: TIMEOUT_MS });
  // r.signal is set (SIGTERM) when spawnSync itself killed it for exceeding the timeout — that is
  // NOT a test failure, it is a suite that never got to answer. Say which one it was.
  return { failed: r.status !== 0, timedOut: r.signal === 'SIGTERM' || r.error?.code === 'ETIMEDOUT' };
};

// The baseline must be GREEN, or every canary "dies" for free and this job proves nothing.
console.log('baseline…');
const base = run();
if (base.timedOut) {
  console.error(`THE SUITE DID NOT FINISH within ${TIMEOUT_MS / 1000}s — this is a timeout, not a failure. `
    + 'Raise TIMEOUT_MS or speed up the suite; do not read a slow suite as a broken one.');
  process.exit(1);
}
if (base.failed) { console.error('THE SUITE IS ALREADY RED. Nothing can be proven from here.'); process.exit(1); }
console.log('baseline: green\n');

let dead = 0;
for (const c of CANARIES) {
  const orig = readFileSync(c.file, 'utf8');
  const want = c.hits ?? 1;
  const hits = orig.split(c.find).length - 1;
  // The COUNT is part of the anchor. A line that used to appear twice and now appears once has
  // MOVED, and a canary pointed at a line that moved is watching nothing at all.
  if (hits !== want) {
    console.error(`✗ ANCHOR DRIFTED in ${c.file}: found ${hits}×, expected ${want}×\n    ${c.find}\n  ` +
      'A canary whose anchor has moved is not watching anything. Re-point it.');
    dead++; continue;
  }
  writeFileSync(c.file, orig.split(c.find).join(c.into));
  const res = run();
  writeFileSync(c.file, orig);

  // A TIMEOUT ON A MUTANT IS NOT A KILL. A broken mutant can make the suite hang instead of fail
  // fast, and counting that as "killed" would let a genuinely-surviving mutant through the day it
  // happens to time out. Demand a real red, or say the run was inconclusive.
  if (res.timedOut) {
    console.error(`✗ INCONCLUSIVE — the suite timed out with this broken, so we cannot say it was killed:\n    ${c.why}`);
    dead++;
  } else if (!res.failed) {
    console.error(`✗ SURVIVED — the suite went GREEN with this broken:\n    ${c.why}\n` +
      `    ${c.file}\n  Nothing is guarding that line any more.`);
    dead++;
  } else {
    console.log(`✓ killed — ${c.why}`);
  }
}

if (dead) { console.error(`\n${dead} canary/canaries are not watching. The suite cannot prove what it claims.`); process.exit(1); }
console.log(`\nall ${CANARIES.length} canaries killed — the suite can still fail where it matters.`);
