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
  //
  // And it must see GRADIENTS. The `background` shorthand resets background-color to
  // transparent, so a page whose body is `background: radial-gradient(...)` reports NO
  // background colour anywhere in the chain — and every piece of its light-grey text
  // got measured against WHITE. A dark, perfectly readable page produced a dozen
  // contrast "failures" that way. If the backdrop genuinely cannot be known (a photo
  // behind the text), say so and decline to judge, rather than inventing white.
  function bgOf(n) {
    const s = getComputedStyle(n);
    const c = parse(s.backgroundColor);
    if (c && c.a > 0) return c;
    const img = s.backgroundImage;
    if (img && img !== 'none') {
      const stops = [...img.matchAll(/rgba?\([^)]+\)/g)].map((m) => parse(m[0])).filter((x) => x && x.a > 0);
      if (stops.length) {   // a gradient: average its stops — close enough to judge text against
        const k = stops.length;
        const sum = stops.reduce((a, x) => ({ r: a.r + x.r, g: a.g + x.g, b: a.b + x.b }), { r: 0, g: 0, b: 0 });
        return { r: sum.r / k, g: sum.g / k, b: sum.b / k, a: 1 };
      }
      if (/url\(/.test(img)) return { unknown: true };   // a photo. Nobody can compute this; do not pretend.
    }
    return null;
  }
  function backdrop(el) {
    let acc = null;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const c = bgOf(n);
      if (!c) continue;
      if (c.unknown) return { unknown: true };
      acc = acc ? over(acc, c) : c;
      if (acc.a >= 0.999) return acc;
    }
    const c = bgOf(document.body) || bgOf(document.documentElement);
    const white = { r: 255, g: 255, b: 255, a: 1 };
    if (c && c.unknown) return { unknown: true };
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
    const bgc = fg && fg.a > 0.05 ? backdrop(el) : null;
    if (fg && fg.a > 0.05 && bgc && !bgc.unknown) {
      const bg = bgc;
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

// ── Taste, measured ──────────────────────────────────────────────────────────
// A page can be entirely un-broken and still look like nobody designed it. What
// separates designed work from generated work is not correctness, it is DECISION:
// a designer picks a type scale, a spacing grid, a palette, one radius — and then
// everything obeys it. An agent, writing CSS a rule at a time with no memory of
// what it chose ten lines ago, produces 11 font sizes and 7 corner radii it never
// decided on. That is what "AI slop" actually looks like up close, and unlike taste
// it is perfectly measurable: count the decisions, and see how many were accidents.
//
// These are NOT defects. They do not fail a build. They tell you where the design
// is drifting.
export function critiquePage(opts) {
  const { grid = 4, maxType = 6, maxRadius = 4, maxInk = 8 } = opts || {};
  const F = [];
  const px = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? Math.round(n * 10) / 10 : null; };
  const bump = (m, k, el) => { if (k == null) return; const e = m.get(k) || { n: 0, eg: [] };
    e.n++; if (e.eg.length < 3 && el) e.eg.push(el); m.set(k, e); };
  const sortNum = (m) => [...m.entries()].sort((a, b) => a[0] - b[0]);
  const top = (m, k = 4) => [...m.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, k);

  const fonts = new Map(), radii = new Map(), spaces = new Map(), inks = new Map(), weights = new Map();
  const els = [...document.body.querySelectorAll('*')].slice(0, 3000);
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') continue;
    const tag = el.tagName.toLowerCase();
    if (tag === 'svg' || tag === 'path' || tag === 'img' || tag === 'canvas') continue;

    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (hasText) {
      bump(fonts, px(s.fontSize), el);
      bump(inks, s.color, el);
      bump(weights, s.fontWeight, el);
    }
    // Only radii that are actually drawn — a radius on a thing with no edge is invisible.
    if (s.backgroundColor !== 'rgba(0, 0, 0, 0)' || s.borderTopWidth !== '0px') {
      const rad = px(s.borderTopLeftRadius);
      if (rad) bump(radii, rad, el);
    }
    for (const p of ['paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight',
      'marginTop', 'marginBottom', 'gap', 'columnGap', 'rowGap']) {
      const v = px(s[p]);
      if (v && v >= 3 && v <= 96) bump(spaces, v, el);   // <3px is a hairline, >96 is a layout gesture
    }
  }

  // ── the type scale ─────────────────────────────────────────────────────────
  // Count EVERY distinct size, not only the ones used twice. A page with eleven
  // sizes each used once is not "eleven outliers" — it is eleven sizes.
  const usedFonts = sortNum(fonts);
  if (usedFonts.length > maxType) {
    F.push({ rule: 'type-scale', severity: 'design',
      detail: `${usedFonts.length} distinct font sizes in use — ${usedFonts.map(([k]) => k + 'px').join(', ')}. `
        + `A type scale is ${maxType} sizes or fewer; the rest are sizes nobody chose. Pick a scale and round everything to it.`,
      values: usedFonts.map(([k, v]) => ({ value: k, count: v.n })) });
  }

  // ── the spacing grid ───────────────────────────────────────────────────────
  // A 4px grid is not a rule of taste, it is what makes spacing look intentional
  // rather than nudged. 9px next to 11px next to 13px reads as noise even when you
  // cannot name why.
  const off = sortNum(spaces).filter(([k]) => k % grid !== 0);
  const offTotal = off.reduce((a, [, v]) => a + v.n, 0);
  const all = [...spaces.values()].reduce((a, v) => a + v.n, 0);
  if (off.length && all && offTotal / all > 0.15) {
    F.push({ rule: 'spacing-grid', severity: 'design',
      detail: `${offTotal} of ${all} spacing values are off the ${grid}px grid — ${top(new Map(off), 6).map(([k, v]) => `${k}px×${v.n}`).join(', ')}. `
        + `Nothing here was decided; these are nudges. Snap them to multiples of ${grid}.`,
      values: off.map(([k, v]) => ({ value: k, count: v.n })) });
  }

  // ── one corner, not seven ──────────────────────────────────────────────────
  const usedRadii = sortNum(radii);
  if (usedRadii.length > maxRadius) {
    F.push({ rule: 'radius-scale', severity: 'design',
      detail: `${usedRadii.length} distinct corner radii — ${usedRadii.map(([k]) => k + 'px').join(', ')}. `
        + `Real design systems have two or three (a small one, a large one, and a pill). The rest is drift.`,
      values: usedRadii.map(([k, v]) => ({ value: k, count: v.n })) });
  }

  // ── the palette, and the greys you cannot tell apart ───────────────────────
  const parseC = (c) => { const m = String(c).match(/rgba?\(([^)]+)\)/); if (!m) return null;
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2] }; };
  const inkList = [...inks.keys()].map((c) => ({ css: c, rgb: parseC(c), n: inks.get(c).n })).filter((x) => x.rgb);
  if (inkList.length > maxInk) {
    F.push({ rule: 'palette-sprawl', severity: 'design',
      detail: `${inkList.length} distinct text colours. A palette is a few semantic roles (body, muted, faint, accent, danger) — `
        + `past that you are not choosing colours, you are accumulating them.`,
      values: inkList.sort((a, b) => b.n - a.n).slice(0, 12).map((x) => ({ value: x.css, count: x.n })) });
  }
  // Two colours a person cannot distinguish are one colour with extra maintenance.
  const twins = [];
  for (let i = 0; i < inkList.length; i++) {
    for (let j = i + 1; j < inkList.length; j++) {
      const a = inkList[i].rgb, b = inkList[j].rgb;
      const d = Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
      if (d > 0 && d <= 24) twins.push({ a: inkList[i].css, b: inkList[j].css, d });
    }
  }
  if (twins.length) {
    F.push({ rule: 'twin-colours', severity: 'design',
      detail: twins.slice(0, 4).map((t) => `${t.a} and ${t.b}`).join('; ')
        + ` — indistinguishable to the eye. Two colours nobody can tell apart are one colour and a maintenance cost.`,
      values: twins.slice(0, 8).map((t) => ({ value: `${t.a} ≈ ${t.b}`, count: t.d })) });
  }

  return { findings: F, scales: {
    type: sortNum(fonts).map(([k, v]) => ({ value: k, count: v.n })),
    radius: sortNum(radii).map(([k, v]) => ({ value: k, count: v.n })),
    spacing: sortNum(spaces).map(([k, v]) => ({ value: k, count: v.n })),
    weights: [...weights.keys()].sort(),
  } };
}
