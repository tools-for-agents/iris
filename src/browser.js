// iris — the browser driver. Zero dependencies: Node's global WebSocket + fetch
// speak the Chrome DevTools Protocol directly, so there is no puppeteer, no
// playwright, no 300MB of node_modules. We launch (or attach to) a headless
// Chrome, drive one page, and close it.
//
// This file knows nothing about design. It knows how to open an eye.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

// Where a Chrome-shaped browser tends to live. IRIS_CHROME overrides everything.
const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
];

export function findChrome() {
  const override = process.env.IRIS_CHROME;
  if (override) return existsSync(override) ? override : null;
  return CANDIDATES.find((p) => existsSync(p)) || null;
}

const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Chrome takes a moment to open its debugging port. Poll rather than guess.
async function waitForCdp(port, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) });
      if (r.ok) return await r.json();
    } catch { /* not up yet */ }
    await sleep(80);
  }
  throw new Error(`Chrome did not open a debugging port on ${port} within ${timeoutMs}ms`);
}

// ── One page, driven ─────────────────────────────────────────────────────────
// Wraps a CDP websocket: send(method) → result, plus the two event streams we
// actually care about (page load, and everything the page logged or threw).
class Page {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.waiters = [];          // [{ method, resolve }]
    this.console = [];          // every error the page emitted, in order
    this.inflight = 0;          // requests in flight — how we know the page has stopped moving
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id != null && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(`${m.error.message} (${m.error.code})`));
        else resolve(m.result);
        return;
      }
      if (m.method) this.#event(m);
    };
  }

  #event(m) {
    if (m.method === 'Network.requestWillBeSent') this.inflight++;
    else if (m.method === 'Network.loadingFinished' || m.method === 'Network.loadingFailed') {
      this.inflight = Math.max(0, this.inflight - 1);
    }
    // The main document's HTTP status. A 404 page still renders, still fires `load`,
    // and still audits clean — so "iris says your page is fine" would be a report
    // about your error page. Keep the status and let the caller refuse it.
    if (m.method === 'Network.responseReceived' && m.params.type === 'Document'
        && m.params.frameId && !this.status) {
      this.status = m.params.response.status;
    }
    // A page that throws is a page that is broken, whatever it looks like. We
    // collect these unconditionally — a screenshot that looks fine while the
    // console is on fire is the exact failure iris exists to catch.
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      this.console.push({ level: 'exception', text: d.exception?.description || d.text || 'exception',
        url: d.url, line: d.lineNumber });
    } else if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
      this.console.push({ level: m.params.type,
        text: (m.params.args || []).map((a) => a.description ?? a.value ?? a.type).join(' ') });
    } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      // Network/security failures land here — a 404 image, a blocked font.
      this.console.push({ level: 'error', text: m.params.entry.text, url: m.params.entry.url });
    }
    // `i > 0` NEVER CHECKED waiters[0]. Almost every navigation has exactly one waiter — a single
    // once('Page.loadEventFired') — so it sat at index 0, was skipped by this loop, and only ever
    // resolved via its 8–10s TIMEOUT. Every page load in iris was paying the full timeout to
    // discover a `load` event that had already fired. That is why the suite was slow enough to
    // make the mutants job time out, and it was hiding here in an off-by-one the whole time.
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      if (this.waiters[i].method === m.method) { this.waiters.splice(i, 1)[0].resolve(m.params); }
    }
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  once(method, timeoutMs = 8000) {
    return new Promise((resolve) => {
      const w = { method, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) { this.waiters.splice(i, 1); resolve(null); }   // timing out is not an error: some pages never fire load
      }, timeoutMs);
    });
  }

  // Evaluate a FUNCTION in the page, not a string. Passing source as a template
  // literal is how you get `\n` interpreted on THIS side and a SyntaxError on the
  // other; serialising a real function sidesteps the whole class of bug.
  async evaluate(fn, ...args) {
    const expr = `(${fn.toString()}).apply(null, ${JSON.stringify(args)})`;
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error('page threw: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  }

  async viewport({ width, height, dpr = 1, mobile = false }) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: dpr, mobile,
      // A phone that reports a desktop pointer gets desktop hover styles and lies
      // about tap targets. Emulate touch when we emulate a phone.
      screenOrientation: mobile ? { angle: 0, type: 'portraitPrimary' } : undefined,
    });
    // maxTouchPoints must be 1..16 even when disabling — 0 is rejected outright.
    await this.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: 5 });
  }

  // Both halves of how themes are actually implemented in the wild: the media
  // query, and the `data-theme` attribute apps stamp on <html> for their toggle.
  // 🔑 AND `prefers-reduced-motion: reduce`, WHICH IS NOT A DETAIL — IT IS WHY THE PICTURE
  // IS THE SAME PICTURE TWICE.
  //
  // A screenshot of a page mid-animation is a frame nobody was meant to read, and the audit
  // then grades the frame. recall's briefing cards enter with `animation: rise .28s both`;
  // a gate that waited for `.hit` to EXIST photographed them at ~40% opacity and reported
  // "concept · retrieval-budget" at 2.92:1 — a `high`, on text that is 16:1 once it lands.
  // It passed on my laptop and failed on CI, which is the signature of a race, not a defect:
  // the finding was iris's own shutter speed.
  //
  // Waiting for the animations to END is not available: a spinner, a pulse, a drifting
  // nebula never end, and this kit has all three. Reduced motion is: it is a REAL setting a
  // REAL audience uses (vestibular disorders), every page here already declares what it means
  // — `@media (prefers-reduced-motion: reduce) { .hit { animation:none } }` — and it makes the
  // render deterministic, because an entrance animation's whole purpose is to arrive at the
  // base state, which is exactly what this renders.
  //
  // The trade is honest and worth naming: a page whose FINAL state exists only inside its
  // keyframes (`opacity:0` + `animation: fadeIn forwards`) renders here as it renders for a
  // reduced-motion user — invisible. That is not iris missing a defect. That IS the defect,
  // and it is one nobody in this kit was looking for either.
  // …EXCEPT WHERE THE MOTION IS THE MEASUREMENT. `play` exists to count frames and catch
  // hitches, and a reduced-motion render of a game is a still photograph of a racetrack. It
  // asks for 'no-preference' on purpose: the honest default for LOOKING at a page is the
  // opposite of the honest default for WATCHING one move.
  async theme(name, { motion = 'reduce' } = {}) {
    await this.send('Emulation.setEmulatedMedia', {
      features: [
        { name: 'prefers-color-scheme', value: name },
        { name: 'prefers-reduced-motion', value: motion },
      ],
    });
    await this.evaluate((t) => { document.documentElement.dataset.theme = t; }, name);
  }

  // The `load` event means the HTML and its <script> tags arrived. It does NOT
  // mean the page has drawn anything: every app in this kit renders its content
  // from a fetch() that starts AFTER load. Screenshotting at `load` + a fixed
  // delay caught this very tool's UI with zero cards and zero images on screen —
  // and it would then have audited that blank page and called it clean. An eye
  // that reports on a page it never saw finish is worse than no eye.
  //
  // So: wait for the network to actually go quiet, then for the images to decode.
  // Run a script BEFORE the page's own scripts do — the only place you can stand if you
  // want to change what the app finds when it starts: a `fetch` that fails, an empty
  // localStorage, a clock at midnight. `--pre` runs after load, which is too late for any
  // of that, because by then the app has already asked its questions and got its answers.
  // A BOOT SCRIPT THAT THROWS IS SILENT, AND THAT IS THE WORST THING IT COULD BE.
  //
  // `--pre` fails loudly. `--boot` did not: if the source threw — a typo, a mangled quote,
  // an API that is not there yet — the page simply loaded WITHOUT the stub, the app talked
  // to the real server, and the gate went on to audit a state it had never actually
  // reached. It cost me a red CI and a long hunt: scout's "refused write" gate failed
  // because the write was never refused; the boot script had died on the way in and said
  // nothing, so the page happily fetched example.com for real.
  //
  // So the script now reports on itself. It records success or the error it died of, and
  // the caller reads that back and refuses to audit a state that was never set up.
  async boot(src) {
    const wrapped = `try { ${src}\n window.__iris_boot = 'ok'; } catch (e) { window.__iris_boot = 'threw: ' + (e && e.message || e); }`;
    const { identifier } = await this.send('Page.addScriptToEvaluateOnNewDocument', { source: wrapped });
    (this._boots ||= []).push(identifier);
  }

  // Read back what the boot script did. Undefined means it never ran at all — which is
  // just as fatal, and just as invisible, as one that threw.
  async bootVerdict() {
    const r = await this.send('Runtime.evaluate', { expression: 'window.__iris_boot', returnByValue: true });
    return r.result?.value;
  }

  async goto(url, { waitMs = 250, quietMs = 400, timeoutMs = 10000 } = {}) {
    const load = this.once('Page.loadEventFired', timeoutMs);
    this.inflight = 0;
    this.status = null;
    const nav = await this.send('Page.navigate', { url });
    // A failed navigation still renders a page — Chrome's OWN error page — and it
    // still fires `load`. Without this check iris screenshotted "This site can't be
    // reached", audited it, and reported a tidy verdict about a site it never saw.
    // It once told me six different apps had identical defects, because it was
    // looking at the same error page six times. Refusing to look is the honest
    // answer; a clean report on a page that never loaded is the worst lie it could
    // tell.
    if (nav.errorText) throw new Error(`could not load ${url} — ${nav.errorText}`);
    await load;
    await this.networkIdle({ quietMs, timeoutMs: 6000 });
    try { await this.evaluate(() => document.fonts?.ready); } catch { /* no font API */ }
    // Images fetched by the app's own JS are still decoding after the request
    // finishes — an <img> with no intrinsic size renders as a 0px-tall hole.
    try {
      await this.evaluate(() => Promise.race([
        Promise.all([...document.images].map((i) => (i.complete ? null : i.decode().catch(() => null)))),
        new Promise((r) => setTimeout(r, 3000)),
      ]));
    } catch { /* no decode() */ }
    await sleep(waitMs);   // let the last transition land, or every screenshot is mid-fade
    if (this.status && this.status >= 400) {
      throw new Error(`${url} returned HTTP ${this.status} — that is the server's error page, not your page. `
        + `Auditing it would tell you nothing about the page you meant.`);
    }
    return { status: this.status };
  }

  // Quiet = no request in flight for `quietMs`. Capped, because a page holding a
  // long-poll or an SSE stream open would otherwise never be quiet — and half the
  // tools in this kit do exactly that.
  async networkIdle({ quietMs = 400, timeoutMs = 6000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let quietSince = this.inflight === 0 ? Date.now() : 0;
    while (Date.now() < deadline) {
      if (this.inflight === 0) {
        if (!quietSince) quietSince = Date.now();
        if (Date.now() - quietSince >= quietMs) return true;
      } else {
        quietSince = 0;
      }
      await sleep(50);
    }
    return false;   // busy page; we looked as long as we sensibly could
  }

  // ── :hover, rendered ─────────────────────────────────────────────────────
  //
  // A hover state is CSS that nobody has ever looked at. It cannot be posed from the page — adding
  // a class reaches .armed or .done, but :hover is the browser's own, and JS cannot set it. So the
  // whole class went unaudited across the kit, and it is not hypothetical: lens shipped
  // `.ch-btn.brain:hover { color:#a78bfa }` at 2.72:1 on light, found by hand, because no gate
  // could render it.
  //
  // CDP can. forcePseudoState pins the state on the node itself, so it is deterministic and it can
  // hold on MANY elements at once — unlike moving a mouse, which hovers one thing, wherever it
  // happens to land, and un-hovers it the moment anything moves.
  // 🔑 ONE getDocument FOR THE WHOLE LIST, AND THAT IS THE WHOLE POINT.
  //
  // Re-requesting the document DISCARDS every nodeId it handed out before, and a forced
  // pseudo-state is attached to a nodeId. So calling getDocument per selector UNFORCES
  // everything forced before it: only the LAST selector in the list was ever rendered.
  //
  //   --hover ".run"          → 2 findings      (anvil's selected row, 4.42:1)
  //   --hover ".run, .xtk a"  → ✓ nothing broken   ← .run forced, then wiped
  //   --hover ".xtk a, .run"  → 2 findings      ← .run forced last, survives
  //
  // And it reported every selector as LANDED, because each one genuinely matched nodes —
  // so `blind` said nothing, and iris printed a clean verdict about states it had unforced
  // itself. That is C158's bug wearing C158's fix as a costume, and strictly worse: the
  // version it replaced at least only lied when a selector matched nothing.
  //
  // It invalidated an entire kit-wide sweep. Six repos came back "clean" having rendered one
  // state each; anvil's 4.42:1 was on the page the whole time, in the list, and iris said
  // nothing broken. Ask the document ONCE, then force everything against that root.
  async forceStates(selectors, states = ['hover']) {
    await this.send('DOM.enable');
    // 🔑 AND THE OBSERVER MUST NOT REPORT ITS OWN FOOTPRINT AS THE PAGE'S DEFECT.
    //
    // forcePseudoState needs the CSS agent ("CSS agent was not enabled" without it). Enabling it
    // makes Chrome fetch the page's stylesheet sources — and on a file:// page, which is a UNIQUE
    // security origin, fetching its own stylesheet is a cross-origin violation. Chrome logs
    // "Unsafe attempt to load URL file://X from frame with URL file://X", iris counts console
    // errors as build failures, and so `--hover` on `iris look ./game.html` — the commonest thing
    // an agent does with this tool — would have failed EVERY page, for a error the page did not
    // make and a user could never fix. The tool would have been reporting itself.
    //
    // So: note where the log is, enable, and drop ONLY an error that is (a) new, (b) exactly this
    // signature, and (c) about the page's own file: URL. A real cross-origin error from the page,
    // or this one on http://, still counts — this is a scalpel, not a blanket.
    const before = this.console.length;
    await this.send('CSS.enable');
    const mine = (e) => e.level === 'error'
      && /Unsafe attempt to load URL file:/.test(e.text)
      && (!e.url || String(e.url).startsWith('file:'));
    for (let i = this.console.length - 1; i >= before; i--) {
      if (mine(this.console[i])) this.console.splice(i, 1);
    }
    const { root } = await this.send('DOM.getDocument', { depth: -1 });
    const landed = [];
    for (const selector of selectors) {
      const { nodeIds } = await this.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector });
      for (const nodeId of nodeIds) {
        await this.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: states });
      }
      // 🔑 COUNT WHAT RENDERS, NOT WHAT MATCHES.
      //
      // Forcing :hover on a display:none element is a no-op with a receipt: the selector reports
      // "landed", no blind-spot line is printed, and NOTHING was looked at. It is a pass that means
      // nothing, which is worse than a miss — a miss says so out loud.
      //
      // It has now lied twice in one day. scout's .toc-toggle is [hidden] on the library page and
      // "landed" there. agent-hq is an SPA that keeps all eight views in the DOM and hides the
      // inactive ones, so the same 15 selectors "landed" on all eight — .card on the ledger,
      // .agent on the board. They cannot all be there, and the report said they were.
      //
      // The audit only ever measures visible elements, so no verdict was ever wrong because of
      // this. What was wrong is the sentence iris prints about its own coverage, which is the one
      // thing a reader uses to decide whether to believe the verdict.
      landed.push([selector, await this.evaluate((sel) => {
        try {
          return [...document.querySelectorAll(sel)].filter((el) => {
            const r = el.getBoundingClientRect();
            if (r.width < 1 || r.height < 1) return false;
            const s = getComputedStyle(el);
            return s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity !== 0;
          }).length;
        } catch { return 0; }
      }, selector)]);
    }
    return landed;
  }

  async screenshot({ fullPage = false } = {}) {
    const r = await this.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: fullPage,
    });
    return Buffer.from(r.data, 'base64');
  }

  async key(text, { type = 'keyDown' } = {}) {
    await this.send('Input.dispatchKeyEvent', { type, key: text, code: text, windowsVirtualKeyCode: KEYCODES[text] || 0 });
  }

  async press(text) {
    await this.key(text, { type: 'keyDown' });
    await sleep(16);
    await this.key(text, { type: 'keyUp' });
  }

  async click(x, y) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    }
  }
}

const KEYCODES = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Enter: 13, ' ': 32, Space: 32, Escape: 27 };

// ── Session: a browser that cleans up after itself ───────────────────────────
export async function open({ chrome = findChrome(), attach = process.env.IRIS_CDP } = {}) {
  // Attaching to a browser you already have open is the cheap path — no launch
  // cost, and you can watch it work. Launching is the default because an agent
  // running unattended has no browser to attach to.
  if (attach) {
    const base = attach.startsWith('http') ? attach : `http://127.0.0.1:${attach}`;
    const port = +new URL(base).port;
    await waitForCdp(port, 3000);
    const page = await newPage(port);
    return { page, close: async () => { try { page.ws.close(); } catch {} } };
  }

  if (!chrome) {
    throw new Error('no Chrome found. Install Chrome/Chromium, or set IRIS_CHROME=/path/to/binary '
      + '(or point IRIS_CDP at an already-running browser started with --remote-debugging-port).');
  }

  // Launching a browser is not reliable enough to do once. Under load Chrome will
  // occasionally print "DevTools listening on ws://…" and then die on its own
  // allocator before it ever answers HTTP — the port opens and closes faster than
  // we can poll it. A tool that spawns a browser on every single call cannot treat
  // that as fatal, so: try again, on a fresh port, once.
  try {
    return await launch(chrome);
  } catch (e) {
    await sleep(600);
    try { return await launch(chrome); }
    catch (again) { throw new Error(`${again.message}\n  (this was the second attempt; the first failed too)`); }
  }
}

async function launch(chrome) {

  const port = await freePort();
  const profile = mkdtempSync(join(tmpdir(), 'iris-profile-'));
  const args = [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--hide-scrollbars',            // a scrollbar in every screenshot is 15px of noise, and it skews overflow checks
    '--force-device-scale-factor=1',
    '--disable-dev-shm-usage',      // CI containers have a tiny /dev/shm; without this Chrome dies mid-screenshot
  ];
  // Chrome's sandbox needs user namespaces, which CI containers (and root) do not
  // give it — it exits instantly and the only symptom is a debugging port that never
  // opens. We are already rendering untrusted-by-nobody local pages in a throwaway
  // profile, so drop the sandbox on Linux rather than lose the browser entirely.
  if (process.platform === 'linux') args.push('--no-sandbox', '--disable-setuid-sandbox');
  args.push('about:blank');

  // NOT stdio:'ignore'. Chrome explains itself on stderr, and swallowing that turned
  // a one-line "Failed to move to new namespace" into a blind 12-second timeout that
  // said only "did not open a debugging port". Keep the last of it and hand it over.
  const proc = spawn(chrome, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: false });
  let stderr = '';
  proc.stderr?.on('data', (c) => { stderr = (stderr + c).slice(-1200); });

  let page;
  try {
    await waitForCdp(port);
    page = await newPage(port);
  } catch (e) {
    try { proc.kill('SIGKILL'); } catch {}
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
    // Chrome shouts about GCM registration and voice transcription on every start.
    // Handing THAT back as "what went wrong" is a new way of hiding the real line.
    const noise = /registration_request|gcm|voice_transcription|device_event_log|Failed to send GpuControl/i;
    const why = stderr.trim().split('\n').map((l) => l.trim())
      .filter((l) => l && !noise.test(l)).slice(-3).join(' | ');
    throw new Error(e.message + (why ? `\n  chrome said: ${why}` : '\n  chrome said nothing useful — is another instance stuck? try: pkill -f remote-debugging-port'));
  }

  return {
    page,
    close: async () => {
      try { page.ws.close(); } catch {}
      try { proc.kill('SIGKILL'); } catch {}
      try { rmSync(profile, { recursive: true, force: true }); } catch {}
    },
  };
}

async function newPage(port) {
  // PUT, not GET — Chrome stopped accepting GET /json/new for CSRF reasons.
  const r = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
  const target = await r.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP websocket refused')); });
  const page = new Page(ws);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Log.enable');
  await page.send('Network.enable');   // so we can tell when the page has stopped fetching
  return page;
}
