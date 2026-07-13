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
];

const run = () => spawnSync('npm', ['test'], { encoding: 'utf8', timeout: 300_000 }).status;

// The baseline must be GREEN, or every canary "dies" for free and this job proves nothing.
console.log('baseline…');
if (run() !== 0) { console.error('THE SUITE IS ALREADY RED. Nothing can be proven from here.'); process.exit(1); }
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
  const status = run();
  writeFileSync(c.file, orig);

  if (status === 0) {
    console.error(`✗ SURVIVED — the suite went GREEN with this broken:\n    ${c.why}\n` +
      `    ${c.file}\n  Nothing is guarding that line any more.`);
    dead++;
  } else {
    console.log(`✓ killed — ${c.why}`);
  }
}

if (dead) { console.error(`\n${dead} canary/canaries are not watching. The suite cannot prove what it claims.`); process.exit(1); }
console.log(`\nall ${CANARIES.length} canaries killed — the suite can still fail where it matters.`);
