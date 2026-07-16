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

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
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
    why: 'a control with NO tabindex is the unreachable one — invert the test and iris blesses every keyboard-unreachable button (cortex .wl, its header stat)',
    file: 'src/audit.js',
    find: "        && el.getAttribute('tabindex') === null && !el.isContentEditable",
    into: "        && el.getAttribute('tabindex') !== null && !el.isContentEditable",
  },
  {
    why: 'a native <input> (a range slider, a checkbox) is keyboard-focusable with no tabindex — stop excluding it and iris cries wolf on every form control (recall\'s budget slider)',
    file: 'src/audit.js',
    find: "    if (!realTag && tag !== 'input' && tag !== 'textarea' && tag !== 'label' && tag !== 'summary'",
    into: "    if (!realTag && tag !== 'zzz' && tag !== 'textarea' && tag !== 'label' && tag !== 'summary'",
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
  {
    why: 'a run iris CANNOT READ is not a run that did not happen — silently dropping it made the contact sheet report 2 runs where there were 3',
    file: 'src/core.js',
    find: '        return { id: d.name, unreadable: true, error: String(e.message).slice(0, 120),',
    into: '        return null; void e; return { id: d.name, unreadable: true, error: String(e.message).slice(0, 120),',
  },
  {
    why: 'a fixed bar over a PANE that scrolls is not clipping — `html` not scrolling does not mean the reader cannot scroll THIS text, and every app shell in this kit (body{height:100vh;overflow:hidden} + an inner scroller) says html never moves ON PURPOSE. Without this, iris calls lens\'s search results "text that can never be moved out from under it" and fails a gate on correct work',
    file: 'src/audit.js',
    find: '      if (canBeScrolledClear(t.el)) continue;',
    into: '      if (false) continue;',
  },
  {
    why: 'an AA contrast failure must FAIL THE BUILD — tokens.json declares contrastAA 4.5 and the verdict only counted `high`, which a contrast finding is not until 3.0. The declared number was 4.5 and the enforced number was 3.0, so everything between shipped: scout\'s brain button sat at 3.84:1 inside a green build',
    file: 'src/core.js',
    find: '      passed: high === 0 && aa === 0 && errors.length === 0 },',
    into: '      passed: high === 0 && errors.length === 0 },',
  },
  {
    why: 'one defect on 558 numbered siblings is ONE row — keyed on the raw selector, a code gutter (div#L1 > span.n … div#L558 > span.n) became 558 findings and the report opened with "284 high". Nobody reads 284; they read "this gate is noise" and skim, which costs exactly what a false positive costs',
    file: 'src/core.js',
    find: "    const key = v.rule + '|' + shapeOf(v.selector);",
    into: "    const key = v.rule + '|' + v.selector;",
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
  // A SKIPPED test cannot kill a canary — it did not run. So the skip count is not trivia here:
  // it is the difference between "nothing guards this line" and "the guard never got to look".
  const skipped = +(`${r.stdout || ''}${r.stderr || ''}`.match(/^\s*(?:ℹ|#)\s*skipped\s+(\d+)/m)?.[1] || 0);
  return { failed: r.status !== 0, timedOut: r.signal === 'SIGTERM' || r.error?.code === 'ETIMEDOUT', skipped };
};

// 🔑 AND IT MUST NOT RUN TWICE AT ONCE. This tool EDITS YOUR SOURCE IN PLACE, so two concurrent runs
// do not merely confuse each other — they can make a planted bug PERMANENT:
//
//     run B plants a mutation in core.js
//     run A reads core.js as its "original"      ← the original now CONTAINS B's bug
//     run B restores its own copy
//     run A restores ITS "original"              ← re-plants B's bug, and A believes it cleaned up
//
// The sabotage is now in your tree, no process is left to undo it, and the tool that put it there
// reports success. It is not theoretical: two overlapping runs turned this repo's suite red, and the
// only message was "THE SUITE IS ALREADY RED" — which names neither the file nor the line.
// An exclusive lock, taken BEFORE the baseline (a concurrent run poisons the baseline too).
const LOCK = new URL('../.mutants.lock', import.meta.url);
try {
  writeFileSync(LOCK, String(process.pid), { flag: 'wx' });   // wx = fail if it already exists
} catch {
  let holder = '?';
  try { holder = readFileSync(LOCK, 'utf8').trim(); } catch { /* raced with a clean exit */ }
  const alive = holder !== '?' && (() => { try { process.kill(+holder, 0); return true; } catch { return false; } })();
  if (alive) {
    console.error(`another mutants run (pid ${holder}) is already editing this source tree. `
      + 'Two at once can make a planted bug PERMANENT — see the note above. Wait for it, or kill it.');
    process.exit(1);
  }
  // The holder is gone (killed before it could clean up). Its restore-on-exit ran, so the tree is
  // sound; the lock is just litter. Take it.
  writeFileSync(LOCK, String(process.pid));
}
const dropLock = () => { try { unlinkSync(LOCK); } catch {} };
process.on('exit', dropLock);

// The baseline must be GREEN, or every canary "dies" for free and this job proves nothing.
console.log('baseline…');
const base = run();
if (base.timedOut) {
  console.error(`THE SUITE DID NOT FINISH within ${TIMEOUT_MS / 1000}s — this is a timeout, not a failure. `
    + 'Raise TIMEOUT_MS or speed up the suite; do not read a slow suite as a broken one.');
  process.exit(1);
}
if (base.failed) { console.error('THE SUITE IS ALREADY RED. Nothing can be proven from here.'); process.exit(1); }
// 🔑 A canary cannot be killed by a test that DID NOT RUN. If the baseline skipped tests, then any
// canary those tests guard will "survive" — and it will look exactly like a coverage hole, sending
// you to write a test that already exists instead of to the one-line fix (start Docker / install
// Chrome). Two different facts, two different fixes; they must not print the same sentence.
// This is anvil's cycle-13 lesson one layer up: in CI a skipped test is a FAILED test, so CI never
// sees this — it is the LOCAL run that lies, and the local run is where you do the work.
if (base.skipped) {
  console.log(`⚠ the baseline SKIPPED ${base.skipped} test(s) — those cannot kill a canary, because they `
    + 'do not run. A survivor below is far more likely to be a missing dependency than a missing test.');
}
console.log('baseline: green\n');

// 🔑 THE MUTATION IS WRITTEN INTO YOUR SOURCE FILE and undone once the suite has run. If this
// process dies in between — Ctrl-C, SIGTERM, a cancelled CI job, an OOM kill — the planted bug is
// LEFT IN YOUR TREE: a deliberately subtle one-character sabotage, sitting exactly where your real
// fix was, ready for the next `git add -A`. It is not hypothetical — a killed run left
// `raw && !isHtml` in scout's core.js, silently reverting a real fix, and the next mutants run said
// only "THE SUITE IS ALREADY RED", which names neither the file nor the line.
//
// A TOOL THAT PLANTS BUGS ON PURPOSE MUST BE THE ONE THING THAT ALWAYS CLEANS UP AFTER ITSELF.
// writeFileSync is synchronous, so it is safe in an exit handler.
let planted = null;                       // { file, orig } while a mutation is on disk
const restore = () => { if (planted) { writeFileSync(planted.file, planted.orig); planted = null; } };
process.on('exit', restore);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.on(sig, () => { restore(); process.exit(130); });
process.on('uncaughtException', (e) => { restore(); console.error(e); process.exit(1); });

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
  planted = { file: c.file, orig };
  writeFileSync(c.file, orig.split(c.find).join(c.into));
  const res = run();
  restore();

  // A TIMEOUT ON A MUTANT IS NOT A KILL. A broken mutant can make the suite hang instead of fail
  // fast, and counting that as "killed" would let a genuinely-surviving mutant through the day it
  // happens to time out. Demand a real red, or say the run was inconclusive.
  if (res.timedOut) {
    console.error(`✗ INCONCLUSIVE — the suite timed out with this broken, so we cannot say it was killed:\n    ${c.why}`);
    dead++;
  } else if (!res.failed) {
    console.error(`✗ SURVIVED — the suite went GREEN with this broken:\n    ${c.why}\n    ${c.file}`);
    console.error(res.skipped
      ? `  …but ${res.skipped} test(s) were SKIPPED. A test that did not run cannot kill a canary, so this\n`
        + '  is most likely a MISSING DEPENDENCY (docker down? no chrome?), not a missing test.\n'
        + '  Provide it and re-run — do not go writing a test that may already exist.'
      : '  Nothing is guarding that line any more.');
    dead++;
  } else {
    console.log(`✓ killed — ${c.why}`);
  }
}

if (dead) { console.error(`\n${dead} canary/canaries are not watching. The suite cannot prove what it claims.`); process.exit(1); }
console.log(`\nall ${CANARIES.length} canaries killed — the suite can still fail where it matters.`);
