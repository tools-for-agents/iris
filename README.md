# 👁 iris — the agent's eye

**An agent writing a website or a game today never looks at what it made.** It emits CSS and a game loop, the tests pass, and it says "done" — having never once seen the page. That is why the design is bad. It is not a taste problem. It is a *feedback* problem: a human glances at the screen and instantly sees that the button is off the edge, the grey text is unreadable, and the game isn't moving. An agent has no glance.

`iris` is the glance. It opens a real browser, renders what you built at real viewports in both themes, **hands the pixels back to the model**, and measures the things a glance would catch.

Zero dependencies — no puppeteer, no playwright. Node's `WebSocket` and `fetch` speak the Chrome DevTools Protocol directly.

```bash
node src/cli.js look ./index.html          # a page
node src/cli.js play ./game.html --keys ArrowLeft,ArrowRight,Space   # a game
node src/cli.js serve                       # the contact sheet, at :7990
```

## What it catches

| | |
|---|---|
| **page-overflow** | the page scrolls sideways — the single most common agent CSS bug, and invisible to every DOM assertion |
| **clipped** | an element hanging past the right edge. A button 39px off-screen is a feature that does not exist |
| **contrast** | measured against the *effective* backdrop (walking up until something is opaque), WCAG AA, large-text aware |
| **tiny-text** | type below the 12px floor |
| **overlap** | text printing over text — the unmistakable signature of a layout that broke |
| **tap-target** | controls smaller than 24px (high severity on phones) |
| **console** | a page that throws is broken however good it looks |

And for games, where a screenshot is actively misleading:

| | |
|---|---|
| **frozen** | every frame pixel-identical — nothing is animating |
| **no-raf** | `requestAnimationFrame` never fired. There is no game loop |
| **input-ignored** | pressed the keys, not a pixel changed. The game is not listening |
| **low-fps / hitch** | below 30fps, or a frame gap you can feel |

**A dead game looks flawless in a still.** One that draws one perfect frame and then never draws again is indistinguishable from a working one until you watch it move. `iris play` watches it move.

## For the agent (MCP)

`iris_look` returns **the actual images** alongside the report, so the model sees its own output.

| tool | what it's for |
|---|---|
| `iris_look` | Render a page and get back screenshots + every defect. **Use after writing or changing ANY interface, before claiming it works.** |
| `iris_play` | Is the game loop drawing, how fast, and does it answer input |
| `iris_runs` | What the eye has already seen |

The CLI **exits non-zero when something is broken**, so it can gate a loop, a commit, or a workflow. That is what makes the *generate → look → critique → fix → look again* loop close on its own.

## It found its own bugs

iris's first job was to look at iris. It found, in its own web view: a phone layout that scrolled sideways by 202px, link colours picked on a dark ground that hit **2.27:1** on a light one, six 10px labels, and a fixed footer sitting on the last row. `73 high · 225 medium · 88 low` → **`✓ nothing broken`**.

It also found three bugs in *itself*, which is the part worth reading:

- **It was auditing pages that had not rendered yet.** `iris` waited for the `load` event — but every modern app, including every tool in this kit, draws its content from a `fetch()` that starts *after* load. Measured: at the moment iris audited its own UI, the page had **0 cards and 0 images** on screen. It would have called a blank page clean. An eye that reports on a page it never saw finish is worse than no eye. It now waits for the network to go quiet and the images to decode.
- **`cursor: pointer` inherits.** So every `<span>` inside one clickable row reported as its own undersized tap target — one row with a title, subtitle and icon produced four findings for zero bugs. Only the outermost element carrying the pointer is the real target.
- **A link inside a fixed footer is itself `static`.** So a sticky bar over scrolled content read as "text printing over text" — which is what a sticky bar is *for*. The rule now asks whether an element lives inside a positioned layer, not whether it is one.

And while writing the fixture that *proves* iris works, I gave the "clean" page white text on a light-blue button: **2.42:1**. iris caught it. In the page written to demonstrate the tool, I made exactly the mistake the tool exists to catch — because I hadn't looked.

## Notes

- Finds Chrome/Chromium/Edge/Brave automatically. `IRIS_CHROME=/path/to/binary` to override, or `IRIS_CDP=9222` to attach to a browser you already have open and watch it work.
- Counts **distinct** problems, not sightings: the same 10px label at 3 viewports × 2 themes is one thing to fix, and reporting it as six inflates the number as dishonestly as hiding it would deflate it.
- Screenshots and `run.json` land in `./.iris/<run-id>/`.

---

Part of **tools-for-agents** — 🛰️ agent-hq · 🔎 lens · ⚒ anvil · 🧠 cortex · 🧭 scout · ◎ recall · **👁 iris**

The kit gives an agent memory, retrieval, execution, reading and recall. This one gives it **sight**.
