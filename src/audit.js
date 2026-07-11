// iris — the checks. Everything here runs INSIDE the page (serialised across CDP),
// so it sees computed styles and real geometry, not the source you hoped for.
//
// These are deliberately the things an agent gets wrong when it writes CSS blind:
// it cannot see that the text is 10px, that the button hangs off the right edge,
// that grey-on-grey is unreadable, or that two labels are sitting on top of each
// other. A human notices in a glance. An agent needs it measured.

// NB: this function is stringified and evaluated in the page. It may only use
// browser globals — no imports, no closure over module scope.
export function auditPage(opts) {
  const { mobile, minTap, minFont, contrastAA } = opts;
  // Declared up here, not next to checkTap: checkTap is hoisted and called from the
  // element loop above its own definition, so a `const` beside it sits in the
  // temporal dead zone and the whole audit throws.
  const TEXT_INPUT = ['text', 'search', 'email', 'password', 'url', 'tel', 'number', 'date', ''];
  const V = [];
  const W = window.innerWidth, H = window.innerHeight;
  const add = (rule, severity, el, detail, extra) => {
    V.push({ rule, severity, selector: sel(el), text: label(el), detail, ...extra });
  };

  // A selector short enough to be useful in a report and specific enough to find.
  function sel(el) {
    if (!el || el === document.documentElement) return 'html';
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 4; n = n.parentElement) {
      let s = n.tagName.toLowerCase();
      if (n.id) { parts.unshift(s + '#' + n.id); break; }
      const cls = (n.className && typeof n.className === 'string')
        ? n.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((c) => '.' + c).join('') : '';
      parts.unshift(s + cls);
    }
    return parts.join(' > ');
  }
  const label = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);

  // ── colour maths (WCAG) ────────────────────────────────────────────────────
  const parse = (c) => {
    const m = String(c).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]; return (hi + 0.05) / (lo + 0.05); };
  // Composite a translucent foreground over its backdrop, the way the screen does.
  const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  // The colour actually BEHIND this text — walk up until something is opaque.
  // Reading `background-color` off the element itself reports `transparent` for
  // almost every text node, which is how contrast checkers end up comparing text
  // against nothing and passing everything.
  function backdrop(el) {
    let acc = null;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (!c || c.a === 0) continue;
      acc = acc ? over(acc, c) : c;
      if (acc.a >= 0.999) return acc;
    }
    const c = parse(getComputedStyle(document.body).backgroundColor);
    const white = { r: 255, g: 255, b: 255, a: 1 };
    if (acc && c && c.a > 0) return over(acc, c);
    return acc ? over(acc, white) : (c && c.a > 0 ? c : white);
  }

  const visible = (el, r) => {
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || +s.opacity === 0) return false;
    if (r.bottom < 0 || r.top > document.documentElement.scrollHeight) return false;
    return true;
  };
  // Does this element hold text of its OWN (not just its children's)?
  const ownText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);

  // ── 1. the page scrolls sideways ───────────────────────────────────────────
  // The single most common agent CSS bug, and invisible in any DOM assertion.
  const de = document.documentElement;
  const slop = de.scrollWidth - de.clientWidth;
  if (slop > 1) {
    V.push({ rule: 'page-overflow', severity: 'high', selector: 'html', text: '',
      detail: `the page scrolls horizontally by ${slop}px — content is wider than the ${W}px viewport` });
  }

  const all = [...document.body.querySelectorAll('*')].slice(0, 4000);
  const texts = [];

  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (!visible(el, r)) continue;
    const st = getComputedStyle(el);

    // ── 2. clipped past the right edge ───────────────────────────────────────
    // Something you rendered and the user cannot reach. A button 39px off-screen
    // is a feature that does not exist.
    if (r.right > W + 1 && r.width < W * 1.5 && r.left < W) {
      const clip = Math.round(r.right - W);
      if (clip > 2) add('clipped', 'high', el, `extends ${clip}px past the right edge of the ${W}px viewport`,
        { rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] });
    }

    if (!ownText(el)) {
      // ── 3. tap targets (interactive, no text of its own — icon buttons) ─────
      checkTap(el, r, st);
      continue;
    }
    texts.push({ el, r, st });

    // ── 4. text too small to read ────────────────────────────────────────────
    const fs = parseFloat(st.fontSize);
    if (fs && fs < minFont) {
      add('tiny-text', 'medium', el, `${fs.toFixed(1)}px text — below the ${minFont}px floor${mobile ? ' (phones make this worse, not better)' : ''}`);
    }

    // ── 5. contrast ──────────────────────────────────────────────────────────
    const fg = parse(st.color);
    if (fg && fg.a > 0.05) {
      const bg = backdrop(el);
      const eff = fg.a < 1 ? over(fg, bg) : fg;
      const cr = ratio(eff, bg);
      const bold = +st.fontWeight >= 700;
      const large = fs >= 24 || (bold && fs >= 18.66);
      const need = large ? 3 : contrastAA;
      if (cr < need) {
        add('contrast', cr < need - 1.5 ? 'high' : 'medium', el,
          `contrast ${cr.toFixed(2)}:1 against its background — WCAG AA wants ${need}:1 for ${large ? 'large' : 'body'} text`,
          { fg: st.color, bg: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})`, ratio: +cr.toFixed(2) });
      }
    }
    checkTap(el, r, st);
  }

  function checkTap(el, r, st) {
    const tag = el.tagName.toLowerCase();
    const realTag = tag === 'button' || tag === 'a' || tag === 'select';
    const roleBtn = el.hasAttribute('onclick') || el.getAttribute('role') === 'button';
    // `cursor: pointer` INHERITS. Naively treating it as "this is a button" made
    // every <span> and <div> inside one clickable row report as its own undersized
    // tap target — a row with a title, a subtitle and an icon produced FOUR
    // findings for zero bugs. Only the outermost element carrying the pointer is
    // the real target; its children are its contents.
    const pointerRoot = st.cursor === 'pointer'
      && (!el.parentElement || getComputedStyle(el.parentElement).cursor !== 'pointer');
    // A text field is not a tap target — you aim at the box, and its hit area is
    // the padded wrapper the designer drew, not the bare <input> line box.
    const inputTarget = tag === 'input' && !TEXT_INPUT.includes(el.type || '')
      && !['hidden', 'range'].includes(el.type);
    if (!realTag && !roleBtn && !pointerRoot && !inputTarget) return;
    // Wrapped by a real control? Then IT is the target you press, not this.
    if (!realTag && !inputTarget && el.closest('button, a, select, [role="button"]')) return;
    if (r.width < 1 || r.height < 1) return;
    const small = Math.min(r.width, r.height);
    if (small < minTap) {
      add('tap-target', mobile ? 'high' : 'low', el,
        `${Math.round(r.width)}×${Math.round(r.height)}px — smaller than the ${minTap}px minimum touch target`,
        { rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] });
    }
  }

  // ── 6. text sitting on top of text ─────────────────────────────────────────
  // Two labels overlapping is the unmistakable signature of a layout that broke,
  // and it is exactly what a screenshot shows and a DOM test never will.
  // Deliberate stacking is not a collision. Checking only the element's OWN
  // `position` is not enough: a link inside a fixed footer is itself `static`, so a
  // sticky bar sitting over scrolled content read as "text printing over text" —
  // which is what a fixed bar is FOR. Ask whether it lives inside a positioned
  // layer, not whether it is one.
  const layered = (el) => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const p = getComputedStyle(n).position;
      if (p === 'fixed' || p === 'absolute' || p === 'sticky') return true;
    }
    return false;
  };
  const T = texts.slice(0, 400).filter((t) => !layered(t.el));
  for (let i = 0; i < T.length; i++) {
    for (let j = i + 1; j < T.length; j++) {
      const a = T[i], b = T[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;      // nesting is not collision
      const ox = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const oy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (ox <= 2 || oy <= 2) continue;
      const area = ox * oy, smaller = Math.min(a.r.width * a.r.height, b.r.width * b.r.height);
      if (smaller > 0 && area / smaller > 0.35) {
        V.push({ rule: 'overlap', severity: 'high', selector: sel(a.el), text: label(a.el),
          detail: `overlaps “${label(b.el)}” (${sel(b.el)}) across ${Math.round(area)}px² — text is printing over text` });
        j = T.length;   // one report per element is enough; a broken row would emit dozens
      }
    }
  }

  return { viewport: { width: W, height: H, mobile: !!mobile }, violations: V,
    counts: V.reduce((a, v) => { a[v.rule] = (a[v.rule] || 0) + 1; return a; }, {}) };
}

// ── Games ────────────────────────────────────────────────────────────────────
// A game is not a layout. It has no text to contrast and no tap targets — it has
// a loop. So we ask the only questions that matter: is it drawing, how often, and
// does it answer when you press a key.

// Install a frame counter. Runs in the page; must be called before you wait.
export function instrumentFrames() {
  if (window.__iris) return true;
  const s = { frames: 0, start: performance.now(), longest: 0, last: performance.now() };
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf((t) => {
    const now = performance.now();
    const gap = now - s.last;
    if (s.frames > 0 && gap > s.longest) s.longest = gap;   // the worst hitch, not the average — that is what players feel
    s.last = now; s.frames++;
    return cb(t);
  });
  window.__iris = s;
  return true;
}

export function readFrames() {
  const s = window.__iris;
  if (!s) return { instrumented: false };
  const elapsed = performance.now() - s.start;
  const canvases = [...document.querySelectorAll('canvas')].map((c) => ({
    w: c.width, h: c.height,
    css: [Math.round(c.getBoundingClientRect().width), Math.round(c.getBoundingClientRect().height)],
    ctx: (() => { try { return c.getContext('webgl2') ? 'webgl2' : (c.getContext('webgl') ? 'webgl' : '2d'); } catch { return '?'; } })(),
  }));
  return {
    instrumented: true,
    frames: s.frames,
    elapsed_ms: Math.round(elapsed),
    fps: elapsed > 0 ? +(s.frames / (elapsed / 1000)).toFixed(1) : 0,
    worst_hitch_ms: Math.round(s.longest),
    canvases,
  };
}
