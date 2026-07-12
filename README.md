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

| **unreadable** | it reads the **canvas pixels**: nothing on screen reaches 3:1 against the background. The game draws, and you cannot see it |
| **canvas-blur** | a 400×250 canvas drawn at 800×500 doubles every pixel. The most common thing wrong with a hand-written game, and a screenshot just looks *slightly soft* |
| **input-ignored** | each key pressed **on its own** — because one working key covers for every dead one |

**A dead game looks flawless in a still.** One that draws one perfect frame and then never draws again is indistinguishable from a working one until you watch it move. `iris play` watches it move.

**And it knows what pixels cannot tell it.** A game that animates on its own changes pixels whether or not your keypress did anything — so "input registered" there is a confident answer to a question it cannot answer. iris says `input unproven (the picture moves on its own)` instead. Declining is not a failure; guessing is.

### What it found in a real game

A dodger written the way an agent writes one — it runs at 120fps, the frames differ, the arrows move the player. Everything iris knew how to check passed: **`✓ nothing broken`**. Then it learned to read the canvas:

```
[high]   unreadable  — nothing on the canvas reaches 3:1 against rgb(11, 14, 20);
                       the most visible shape is 1.94:1. The game draws, and you cannot see it.
[medium] canvas-blur — the canvas is 400x250 but drawn at 800x500 CSS px — every pixel
                       is stretched 2x.
[low]    input-unproven — this game animates on its own, so a changed frame does not prove
                       a key did anything. Test the keys yourself.
```

The player and the obstacles were both tasteful dark greys on a dark ground — you could not tell which one *was* you, and the HUD promised a "space to dash" that did not exist.

## The other half: taste, measured

A page can be **entirely un-broken and still look like nobody designed it.** That is what people actually mean by "AI slop", and it is not a mystery of taste — it is a failure of *decision*. A designer picks a type scale, a spacing grid, a palette, one corner radius, and everything obeys. An agent, writing CSS a rule at a time with no memory of what it chose ten lines ago, produces eleven font sizes and seven corner radii it never chose.

That is perfectly measurable. `iris look` also reports:

| | |
|---|---|
| **type-scale** | *"8 distinct font sizes — 13, 14, 15, 16, 17, 19, 21, 27px. A scale is 6 or fewer; the rest are sizes nobody chose."* |
| **spacing-grid** | *"35 of 35 spacing values are off the 4px grid — 9px×6, 5px×5, 7px×5, 11px×5. Nothing here was decided; these are nudges."* |
| **radius-scale** | *"7 distinct corner radii. Real design systems have two or three."* |
| **twin-colours** | *"rgb(85,90,94) and rgb(88,93,97) — indistinguishable. Two colours nobody can tell apart are one colour and a maintenance cost."* |

These **do not fail the build**. Taste is a conversation, not a gate. They tell you where the design is drifting.

The test fixture for this is a page that is *perfectly fine* — it renders, it fits, it is readable, `✓ nothing broken` — and every number in it is different. Then iris says so.

And it said so about **itself**: `161 of 221 spacing values off the grid`, seven corner radii, seven font sizes. iris now sits on a 4px grid, a 3-step radius scale (8 / 12 / pill) and a 4-step type scale (12 / 14 / 16 / 20) — because its own eye told it not to.

## A design system, as a file

The critique above can only ask *"are you consistent with yourself"*. That catches drift, but it cannot tell you what you should have picked. A declared system can.

```bash
iris tokens http://localhost:7900/   # read the system a page is ALREADY using
iris look ./index.html --tokens ./tokens.json
```

```json
{ "type": [12, 14, 16, 20, 24, 30, 40],
  "spacing": { "grid": 4 },
  "radius": [4, 8, 12, 999],
  "minFont": 12, "minTap": 24, "contrastAA": 4.5 }
```

Then every off-system value is named, with the one it should have been, **and where it lives**:

```
· off-scale-type    — 15px (x9 → 14px) on button, .card h1; 26px (x1 → 24px) on h1
· off-scale-radius  — 10px (x4 → 8px) on .card
· off-grid-spacing  — 18px (x6 → 20px) on body, .card
```

**This is the mechanism by which agent design actually gets good: not more taste — fewer decisions.** A model writing CSS a rule at a time cannot remember what it picked ten lines ago. It does not have to, if the answer is in a file.

`iris.tokens.json` / `tokens.json` is auto-loaded from the project root, so the agent does not even have to be told.

### …and a game has a palette

Every check above is blind to a game. A canvas is **one element with one colour** as far as the DOM knows — no type scale, no spacing grid, no radii. So games got *no design review at all*, which is exactly why agent-written games look the way they do:

```js
const HAZARD = ['red', '#ff0000', 'crimson', '#e2483c', 'tomato'];
```

Five hazards, five colours, written a hundred lines apart by something that could not remember what it picked the first time. A player reads five colours as five **meanings**. There is one meaning here.

So declare what a colour is *allowed to mean*, and iris reads the pixels the game actually drew:

```jsonc
"game": {
  "tolerance": 30,
  "palette": { "ground": "#0a0b0e", "player": "#4fd6be", "danger": "#ec4899",
               "goal": "#e0a24e", "neutral": "#8a92a3", "accent": "#c792ea" }
}
```

```
iris play ./game.html --tokens ./tokens.json --strict

✓ nothing broken                        ← it renders, it animates, it answers the keys
── nothing is broken here, but nobody decided it either ──
· off-palette — 5 colours are drawn on the canvas that are not in your game palette:
  rgb(255,0,0) (3.1% of the ink → nearest is "danger" #ec4899, 264 away);
  rgb(220,20,60) (1.6% → "danger", 173 away); rgb(46,204,113) (0.7% → "player", 138 away) …
```

`tolerance` is how far a drawn pixel may sit from a role and still *be* that role. It does double duty: **two roles closer together than the tolerance are ambiguous by construction** — no pixel could be attributed to either — which is also the definition of a player who cannot tell the thing they chase from the thing that kills them.

```
· indistinct-roles — "player" (#4fd6be) and "danger" (#54d4bd) are 12 apart, closer than
  the 30 you set as the tolerance. Two roles a player cannot tell apart are one role and
  a bug report.
```

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

## What happened when it looked at the rest of the kit

Six sibling tools, each built carefully, each "verified" with hand-written CDP scripts, each shipped with a green test suite. Then the eye looked at them:

| | defects | design drift |
|---|---|---|
| **agent-hq** | 13 high · 9 medium | type · spacing · radius · palette · twins |
| **cortex** | 7 high · 7 medium | type · spacing · radius · palette |
| **lens** | 6 high · 17 medium | type · spacing · radius · palette |
| **anvil** | 3 high · 14 medium | type · spacing · palette |
| **scout** | 9 high · 17 medium | type · spacing · radius · palette |
| **recall** | 8 high · 15 medium | type · spacing · radius · palette · twins |
| **iris** | — | clean |

Every one of them scrolls sideways on a phone, or hides text at 2:1 contrast, or clips a control off the edge. I wrote all of them. I checked every one for console exceptions and asserted on the DOM. **Not one of them had ever been looked at.**

iris is clean for exactly one reason: it is the only one the eye has seen.

## Notes

- Finds Chrome/Chromium/Edge/Brave automatically. `IRIS_CHROME=/path/to/binary` to override, or `IRIS_CDP=9222` to attach to a browser you already have open and watch it work.
- Counts **distinct** problems, not sightings: the same 10px label at 3 viewports × 2 themes is one thing to fix, and reporting it as six inflates the number as dishonestly as hiding it would deflate it.
- Screenshots and `run.json` land in `./.iris/<run-id>/`.

---

Part of **tools-for-agents** — 🛰️ agent-hq · 🔎 lens · ⚒ anvil · 🧠 cortex · 🧭 scout · ◎ recall · **👁 iris**

The kit gives an agent memory, retrieval, execution, reading and recall. This one gives it **sight**.

## The agent toolkit

`iris` is the **see** leg of **[tools-for-agents](https://tools-for-agents.github.io)** — an operating system for agents.
Seven zero-dependency, MCP-native tools that form one loop:

| | | |
|---|---|---|
| 🛰️ | [agent-hq](https://github.com/tools-for-agents/agent-hq) | coordinate — shared memory, a kanban agents claim work from, a registry, a cost ledger |
| 🔎 | [lens](https://github.com/tools-for-agents/lens) | read code — token-budgeted retrieval — search, outlines, surgical reads |
| ⚒ | [anvil](https://github.com/tools-for-agents/anvil) | run safely — a throwaway Docker sandbox: network off, capped, timed |
| 🧠 | [cortex](https://github.com/tools-for-agents/cortex) | remember — an Obsidian-compatible second brain, wikilinked |
| 🧭 | [scout](https://github.com/tools-for-agents/scout) | read the web — a URL becomes clean, cached, searchable markdown |
| 🎯 | [recall](https://github.com/tools-for-agents/recall) | recall it all — one query across brain, team, reading and code |
| 👁 | **iris** | **see** — look at what you built, before you claim it works |

**Reading this as an agent?** [`/llms.txt`](https://tools-for-agents.github.io/llms.txt) is the map, and
[`/tools.json`](https://tools-for-agents.github.io/tools.json) hands you all **67 MCP tools** — every name, every
description, every install command — in **one fetch**, without cloning anything.

MIT licensed.
