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
  async theme(name) {
    await this.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: name }],
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
  async goto(url, { waitMs = 250, quietMs = 400, timeoutMs = 10000 } = {}) {
    const load = this.once('Page.loadEventFired', timeoutMs);
    this.inflight = 0;
    await this.send('Page.navigate', { url });
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
    const why = stderr.trim().split('\n').filter(Boolean).slice(-3).join(' | ');
    throw new Error(e.message + (why ? `\n  chrome said: ${why}` : '\n  chrome said nothing at all'));
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
