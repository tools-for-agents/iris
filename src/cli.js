#!/usr/bin/env node
// iris CLI — look at what you built.
//   iris look <url|file> [--viewports phone,desktop] [--themes dark,light] [--full] [--json]
//   iris play <url|file> [--seconds 3] [--frames 6] [--keys ArrowLeft,Space] [--json]
//   iris runs [-k 20] | iris forget <run-id> | iris stats
//   iris serve [--port 7990]
import * as iris from './core.js';

const [, , cmd, ...rest] = process.argv;
const VALUE = new Set(['--viewports', '--themes', '--seconds', '--frames', '--keys', '--limit', '--port', '--wait', '--tokens', '--name', '-k']);
const positionals = []; const flags = {};
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (!a.startsWith('-')) positionals.push(a);
  else if (VALUE.has(a)) flags[a] = rest[++i];
  else flags[a] = true;
}
const out = (s) => process.stdout.write(typeof s === 'string' ? s + '\n' : JSON.stringify(s, null, 2) + '\n');
const target = positionals[0];

try {
  if (cmd === 'look') {
    if (!target) throw new Error('usage: iris look <url|file>');
    const run = await iris.look(target, {
      viewports: flags['--viewports'], themes: flags['--themes'],
      full: !!flags['--full'], wait: flags['--wait'] ? +flags['--wait'] : undefined,
      tokens: flags['--no-tokens'] ? false : flags['--tokens'],
    });
    out(flags['--json'] ? run : iris.report(run, { limit: flags['--limit'] ? +flags['--limit'] : 25 }));
    // A non-zero exit is what lets `iris look` sit in a loop or a pre-commit hook
    // and actually STOP something. A checker that always exits 0 is decoration.
    //
    // exitCode, NOT process.exit(): exit() tears the process down without flushing
    // a pending write to a PIPE, so `iris look --json | jq` lost the tail of its own
    // report — and only when the page was broken, because that is when the JSON is
    // big enough to still be draining. A checker that truncates its findings exactly
    // when it has findings is worse than one that never runs.
    if (!run.summary.passed) process.exitCode = 1;
    // --strict also fails the build on design drift. Off by default, because "this is
    // broken" and "nobody decided this" are different conversations and only the first
    // one should stop a release. But once a kit IS on a system, drift is a regression
    // like any other, and the only thing that keeps it from creeping back is a gate.
    //
    // This lives here, not in the GitHub action, because the action used to decide it
    // by GREPPING THE HUMAN REPORT for the sentence "nobody decided it either" — a gate
    // that silently stops gating the day someone rewords a headline.
    if (flags['--strict'] && run.design?.findings?.length) {
      process.stderr.write(`iris: ${run.design.findings.length} design findings and --strict is on\n`);
      process.exitCode = 1;
    }
  } else if (cmd === 'play') {
    if (!target) throw new Error('usage: iris play <url|file> [--keys ArrowLeft,Space]');
    const run = await iris.play(target, {
      seconds: flags['--seconds'], frames: flags['--frames'], keys: flags['--keys'],
      viewport: flags['--viewports'], theme: flags['--themes'],
    });
    out(flags['--json'] ? run : iris.report(run));
    if (!run.summary.passed) process.exitCode = 1;
  } else if (cmd === 'tokens') {
    if (!target) throw new Error('usage: iris tokens <url|file>  — read the design system a page is already using');
    const t = await iris.extractTokens(target, { name: flags['--name'] });
    if (!flags['--json']) delete t._observed;      // the workings, only if you ask
    out(t);
  } else if (cmd === 'runs') {
    const list = iris.runs({ limit: +(flags['-k'] || flags['--limit'] || 20) });
    if (flags['--json']) out(list);
    else if (!list.length) out('nothing looked at yet — try: iris look ./index.html');
    else for (const r of list) {
      out(`${r.summary?.passed ? '✓' : '✗'} ${r.id}  ${r.kind}  ${r.target}  ` +
        `${r.summary?.high || 0}h ${r.summary?.medium || 0}m ${r.summary?.low || 0}l`);
    }
  } else if (cmd === 'forget') {
    if (!target) throw new Error('usage: iris forget <run-id>');
    out(iris.forget(target));
  } else if (cmd === 'stats') {
    out(iris.stats());
  } else if (cmd === 'serve') {
    const { serve } = await import('./server.js');
    serve({ port: flags['--port'] ? +flags['--port'] : undefined });
  } else if (cmd === 'mcp') {
    // stdio JSON-RPC. The server starts on import: `npx @tools-for-agents/iris mcp`
    await import('../mcp/mcp-server.js');
  } else {
    out(`iris — the agent's eye. Render what you built, and measure what a glance would catch.

  iris look <url|file>    render at real viewports × themes; report overflow, clipping,
                          contrast, unreadable type, collisions, console errors
      --viewports phone,tablet,desktop   (default: phone,desktop)
      --themes dark,light                (default: both)
      --full                             full-page screenshot, not just the fold
      --json                             the whole run as JSON
      --tokens <file>                    grade against a declared design system
      --strict                           ALSO fail on design drift, not just defects
                                         (auto-loads ./iris.tokens.json or ./tokens.json)

  iris play <url|file>    for games: is the loop drawing, how fast, does it answer input
      --seconds 3  --frames 6  --keys ArrowLeft,ArrowRight,Space

  iris tokens <url|file>  read the design system a page is ALREADY using — a
                          starting point to edit, instead of a blank page
  iris runs               what the eye has already seen
  iris forget <run-id>    throw a run away
  iris stats              where the browser and the images are
  iris serve [--port 7990]   the contact sheet — every render, side by side

Exits non-zero when something is broken, so it can gate a loop or a commit.
Set IRIS_CHROME to point at a browser, or IRIS_CDP to attach to a running one.`);
  }
} catch (e) {
  process.stderr.write('iris: ' + (e.message || e) + '\n');
  process.exit(2);
}
