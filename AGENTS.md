# AGENTS.md — iris

👁 **The agent's eye.** Renders what you built at real viewports and themes and hands the *pixels* back to
the model: overflow, clipping, contrast, unreadable type, collisions, dead game loops, design drift.
CLI + MCP + a GitHub Action. Part of [tools-for-agents](https://github.com/tools-for-agents).

## Setup

```bash
node --version          # 22+ required. There is nothing to install.
npm test                # = node --test. ~3.5 min (it drives a real Chrome).
node src/cli.js look https://example.com --viewports phone,desktop
node src/cli.js serve   # the contact sheet, :7990
```

**Zero runtime dependencies, and that is a hard rule.** `package.json` has no `dependencies` and must not
grow one — the whole kit is auditable end-to-end because of it. Node 22+ gives you `node:sqlite` and a test
runner; you do not need more.

| Env | For |
|---|---|
| `IRIS_CHROME` | path to a browser, if it cannot be found |
| `IRIS_CDP` | attach to an already-running Chrome instead of launching one |
| `IRIS_OUT` | where runs are stored (default `./.iris`) — **redirect this in tests** |
| `IRIS_PORT` | `serve` port (default 7990) |

## The rules this repo is built on

**1. Only the picture is evidence.** A test suite does not look at the page. Every tool in this kit shipped
a broken phone layout past green CI. If you change anything a human sees, render it and *look* — that is
what this tool is for, and it is why it must be right.

**2. Falsify both ways, or you have measured nothing.** A gate that passes on the fix and also passes on the
bug is not a gate. Break the thing on purpose and watch it go red before you believe a green:

```bash
# and ASSERT THE MUTATION APPLIED — a sed/perl that quietly matched nothing
# "proves" the fix while testing the original. Use node, and exit non-zero if unchanged.
```

**3. The rule must not demand the opposite of correct.** Twice now a rule fired on the commonest *correct*
implementation of the thing it checks: `clipped` on a CSS ellipsis, `unreachable-control` on a
`role="option"` inside a listbox. Before adding or sharpening a rule, ask what a correct page looks like to
it. A false positive at `high` fails other people's builds.

**4. A pass must mean something.** `--hover` used to count a selector as "landed" when it *matched*, not when
it *rendered*, so a `display:none` element passed silently. If iris cannot see something, it must say so —
a blind-spot line beats a quiet lie.

**5. Determinism is the product.** iris emulates `prefers-reduced-motion: reduce` so the picture is the same
picture twice; a page mid-animation is a frame nobody was meant to read, and grading it produces findings
that change run to run. `play` asks for `no-preference` on purpose — motion *is* the measurement there.

## Tests

`npm test` — `node --test`, and **no test may be skipped** (CI asserts `skipped 0`). Chrome-dependent tests
guard on `needsChrome`.

A new rule needs a **fixture** in `test/fixtures/` that pins **both** directions: the defect fires, the
correct-looking neighbour does not. Check your fixture actually reproduces — a fixture that reproduces
nothing goes green against a broken rule and teaches you the opposite of the truth.

## CI

`test` · `mutants` · `look` · `look-lightbox` · `first-run` · `states` · `dead-api` · `slow-api`

- **`mutants`** breaks the audit on purpose — every canary must die. ~40 min in CI, ~2.4h locally.
  **Do not run it locally. Push and read CI.**
- **`look` / `look-lightbox`** point iris at its own reader, seeded with real runs, with `--hover` and a
  `pre` that opens the lightbox. An empty page cannot overflow, collide or be unreadable — a UI gate that
  has never seen a row of data is a screenshot of an empty room.
- `first-run`, `states`, `dead-api`, `slow-api` render the states a user hits and nothing else looks at:
  empty, disabled, 500, and slow.

## Commits

Lowercase, `area: what changed and why it mattered` — `core:`, `ui:`, `ci:`, `fix:`. Say what was actually
wrong in the body, including the part that fooled you. The git log is this project's real documentation.
