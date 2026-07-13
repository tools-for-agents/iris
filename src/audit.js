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
  // `querySelectorAll('*')` DOES NOT CROSS A SHADOW BOUNDARY. On any page built from web
  // components — which is to say, most modern apps — iris walked the empty wrapper
  // elements, found nothing wrong with them, and said "✓ nothing broken". Proven on a page
  // where EVERYTHING was broken (8px text at 1.2:1, a button 1200px off the edge, all of it
  // in one shadow root): iris audited the host div, which is empty, and passed the page.
  //
  // This is not the canvas problem. A canvas cannot be read from the DOM at all. THIS CAN —
  // it just needed walking through the door instead of past it.
  //
  // (A CLOSED shadow root returns null from `.shadowRoot`: it cannot be entered, or even
  // counted, from outside. There is nothing to declare — it is invisible to the page too.)
  const deepAll = (root, out) => {
    for (const el of root.querySelectorAll('*')) {
      out.push(el);
      if (el.shadowRoot) deepAll(el.shadowRoot, out);
    }
    return out;
  };

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
    // Climbing with parentElement STOPS at a shadow root, so a finding inside a component
    // used to report a selector with no route to it. Step out through the host.
    const up = (n) => n.parentElement || (n.getRootNode() instanceof ShadowRoot ? n.getRootNode().host : null);
    for (let n = el; n && n.nodeType === 1 && parts.length < 4; n = up(n)) {
      let s = n.tagName.toLowerCase();
      if (n.id) { parts.unshift(s + '#' + n.id); break; }
      const cls = (n.className && typeof n.className === 'string')
        ? n.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((c) => '.' + c).join('') : '';
      parts.unshift(s + cls);
    }
    return parts.join(' > ');
  }
  const label = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);

  // EMOJI ARE PAINTED BY THE FONT, in its own colour layers. `color` and `fill` do not
  // touch them. So measuring either against the background measures a colour that never
  // reaches the screen — and I nearly shipped exactly that: recall's convergence diagram
  // draws 🧠 🛰️ 🧭 🔎 as SVG <text>, and the new fill-based contrast check called four
  // perfectly visible glyphs "1.08:1".
  //
  // Which is the bug this check exists to prevent, committed by the check itself. A
  // pictograph carries no foreground colour to judge, so there is nothing here to judge.

  // OPACITY DOES NOT INHERIT AS A COMPUTED VALUE. A child of `opacity: .12` still computes
  // to `opacity: 1` — and is PAINTED at twelve percent. So a disabled panel, a ghost state,
  // a fade-in that never finished: iris read the text's declared colour (#111 on white,
  // 18:1), passed it, and the screen was showing about 1.3:1.
  //
  // `filter: opacity()` is the same thing by another route, and just as invisible to a
  // check that only reads the element's own style.
  const effectiveAlpha = (el) => {
    let a = 1;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const s = getComputedStyle(n);
      const o = parseFloat(s.opacity);
      if (Number.isFinite(o)) a *= o;
      const m = /opacity\(\s*([\d.]+)(%?)\s*\)/.exec(s.filter || '');
      if (m) a *= (m[2] ? parseFloat(m[1]) / 100 : parseFloat(m[1]));
    }
    return a;
  };

  const PICTO = /^[\p{Extended_Pictographic}\uFE0F\u200D\s]+$/u;
  const onlyEmoji = (t) => !!t && PICTO.test(t);

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
  // `background-clip: text` SWAPS the two roles. The background is not behind the
  // letters — the background IS the letters, and `color` is never painted at all.
  // Read naively, a gradient headline looks like near-white text sitting on a lilac
  // card, and iris called the kit's own perfectly legible hero "2.25:1" — comparing
  // a colour that is not on the screen against a surface that does not exist.
  const clipsText = (s) => s.webkitBackgroundClip === 'text' || s.backgroundClip === 'text';
  const transparent = (c) => !c || c.a < 0.05;
  const paintedByBg = (s) => clipsText(s)
    && (transparent(parse(s.webkitTextFillColor)) || transparent(parse(s.color)));

  // The colour(s) the glyphs are actually PAINTED in. Normally one — but gradient
  // text has one per stop, and WCAG is only satisfied if the WORST of them passes.
  function inkOf(st, el) {
    // SVG TEXT IS PAINTED BY `fill`. `color` is inherited, irrelevant, and never reaches
    // the screen — and it is exactly what a DOM contrast checker reads. So #eee text on
    // white inside an <svg> was measured as the body's #111 on white, called 16:1, and
    // passed. iris caught that it was 8px and missed that it was invisible.
    //
    // This is the background-clip:text bug wearing a different hat: the DOM reporting a
    // colour that is not on the screen, and the eye believing it.
    if (el && el.namespaceURI === 'http://www.w3.org/2000/svg') {
      const f = String(st.fill || '');
      if (f === 'none') return [];                          // not painted at all
      if (/url\(/.test(f)) return [{ unknown: true }];      // a paint server; do not guess
      const c = parse(f);
      return c && c.a > 0.05 ? [c] : [];
    }
    if (paintedByBg(st)) {
      const img = String(st.backgroundImage || '');
      if (/url\(/.test(img)) return [{ unknown: true }];   // a photo is the ink. Nobody can compute this.
      const stops = [...img.matchAll(/rgba?\([^)]+\)/g)].map((m) => parse(m[0])).filter((x) => x && x.a > 0.05);
      if (stops.length) return stops;
      const bc = parse(st.backgroundColor);
      return bc && bc.a > 0.05 ? [bc] : [];
    }
    // `-webkit-text-fill-color` wins over `color` when both are set; it computes to
    // `currentColor`, so when nobody set it this is just the colour.
    const fill = parse(st.webkitTextFillColor);
    const c = fill || parse(st.color);
    return c && c.a > 0.05 ? [c] : [];
  }

  function backdrop(el) {
    let acc = null;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      // An element whose background paints its own glyphs is not behind anything.
      if (clipsText(getComputedStyle(n))) continue;
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

  // Is it inside something that scrolls sideways on purpose? Then it is not clipped;
  // it is off-screen and reachable, which is what a horizontal scroller IS.
  function inScroller(el) {
    for (let n = el.parentElement; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      const o = getComputedStyle(n).overflowX;
      if ((o === 'auto' || o === 'scroll') && n.scrollWidth > n.clientWidth + 1) return true;
    }
    return false;
  }

  // ── 1. the page scrolls sideways ───────────────────────────────────────────
  // The single most common agent CSS bug, and invisible in any DOM assertion.
  const de = document.documentElement;
  const slop = de.scrollWidth - de.clientWidth;
  if (slop > 1) {
    V.push({ rule: 'page-overflow', severity: 'high', selector: 'html', text: '',
      detail: `the page scrolls horizontally by ${slop}px — content is wider than the ${W}px viewport` });
  }

  const all = deepAll(document.body, []).slice(0, 4000);
  const texts = [];

  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (!visible(el, r)) continue;
    const st = getComputedStyle(el);

    // ── 2. clipped past the right edge ───────────────────────────────────────
    // Something you rendered and the user cannot reach. A button 39px off-screen
    // is a feature that does not exist.
    //
    // UNLESS it sits in something that scrolls sideways ON PURPOSE — a kanban, a
    // carousel, a wide table. That content is off-screen and REACHABLE, which is
    // the whole design. Flagging it made a correctly-built horizontal scroller look
    // like five separate bugs, and taught the reader to skim past the real one.
    if (r.right > W + 1 && r.width < W * 1.5 && r.left < W && !inScroller(el)) {
      const clip = Math.round(r.right - W);
      if (clip > 2) add('clipped', 'high', el, `extends ${clip}px past the right edge of the ${W}px viewport`,
        { rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] });
    }

    // ── 2b. clipped past the LEFT edge ────────────────────────────────────────
    // The mirror image, and the one the right-only check silently missed: in an RTL
    // layout the overflow runs LEFT, and in any layout a negative offset can push a
    // control off the left edge — just as unreachable. Worse, negative-left often does
    // NOT grow scrollWidth, so the page-overflow check never sees it either. `r.right > 0`
    // (mirror of the right case's `r.left < W`) keeps the far-off-screen visually-hidden
    // idiom (`left:-9999px`) from tripping it — that ends left of 0, so it is not flagged.
    if (r.left < -1 && r.width < W * 1.5 && r.right > 0 && !inScroller(el)) {
      const clip = Math.round(-r.left);
      if (clip > 2) add('clipped', 'high', el, `extends ${clip}px past the left edge of the ${W}px viewport`,
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
    const alpha = effectiveAlpha(el);
    const inks = (onlyEmoji(label(el)) ? [] : inkOf(st, el))
      .map((c) => (c.unknown ? c : { ...c, a: (c.a ?? 1) * alpha }));
    const bgc = inks.length && !inks[0].unknown ? backdrop(el) : null;
    if (inks.length && !inks[0].unknown && bgc && !bgc.unknown) {
      const bg = bgc;
      const bold = +st.fontWeight >= 700;
      const large = fs >= 24 || (bold && fs >= 18.66);
      const need = large ? 3 : contrastAA;
      // Gradient text is only as readable as its worst stop.
      let worst = null;
      for (const ink of inks) {
        const eff = ink.a < 1 ? over(ink, bg) : ink;
        const cr = ratio(eff, bg);
        if (!worst || cr < worst.cr) worst = { cr, ink: eff };
      }
      if (worst.cr < need) {
        const rgb = (c) => `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`;
        add('contrast', worst.cr < need - 1.5 ? 'high' : 'medium', el,
          `contrast ${worst.cr.toFixed(2)}:1 against its background — WCAG AA wants ${need}:1 for ${large ? 'large' : 'body'} text`
          + (inks.length > 1 ? ` (the worst of ${inks.length} gradient stops — text is only as readable as its darkest)` : ''),
          { fg: rgb(worst.ink), bg: rgb(bg), ratio: +worst.cr.toFixed(2) });
      }
    }
    checkTap(el, r, st);

    // ── text that is on the screen and not in the tree ──────────────────────
    // `::before` and `::after` render real words — badges, counters, icon labels, the
    // little "NEW" on a nav item — and they are not elements, so a walk of the DOM never
    // sees them. iris was blind to a 7px #efefef badge sitting in plain view.
    //
    // They have no box you can measure from the outside, but they do not need one: the
    // computed style has the font size and the colour, and the backdrop is the parent's.
    // That is everything the two checks that matter actually use.
    for (const pseudo of ['::before', '::after']) {
      const ps = getComputedStyle(el, pseudo);
      const content = ps.content;
      // 'none' / 'normal' = nothing rendered. A bare url() is an image, not text.
      if (!content || content === 'none' || content === 'normal') continue;
      if (/^url\(/.test(content)) continue;
      const words = content.replace(/^["']|["']$/g, '').trim();
      if (!words || words.length < 2) continue;             // "•" is decoration, not prose

      const pfs = parseFloat(ps.fontSize);
      if (pfs && pfs < minFont) {
        V.push({ rule: 'tiny-text', severity: 'medium', selector: sel(el) + pseudo, text: words.slice(0, 60),
          detail: `${pfs.toFixed(1)}px text — below the ${minFont}px floor${mobile ? ' (phones make this worse, not better)' : ''}`
            + ` — and it is rendered by ${pseudo}, so it is on the screen but not in the DOM` });
      }
      const praw = parse(ps.color);
      const pink = praw ? { ...praw, a: (praw.a ?? 1) * effectiveAlpha(el) } : null;
      const pbg = pink && pink.a > 0.05 ? backdrop(el) : null;
      if (pink && pink.a > 0.05 && pbg && !pbg.unknown) {
        const eff = pink.a < 1 ? over(pink, pbg) : pink;
        const cr = ratio(eff, pbg);
        const large = pfs >= 24 || (+ps.fontWeight >= 700 && pfs >= 18.66);
        const need = large ? 3 : contrastAA;
        if (cr < need) {
          V.push({ rule: 'contrast', severity: cr < need - 1.5 ? 'high' : 'medium',
            selector: sel(el) + pseudo, text: words.slice(0, 60),
            detail: `contrast ${cr.toFixed(2)}:1 against its background — WCAG AA wants ${need}:1 for ${large ? 'large' : 'body'} text`
              + ` — and it is rendered by ${pseudo}, so it is on the screen but not in the DOM`,
            fg: ps.color, bg: `rgb(${Math.round(pbg.r)}, ${Math.round(pbg.g)}, ${Math.round(pbg.b)})`, ratio: +cr.toFixed(2) });
        }
      }
    }
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
  //
  // And an inline element that WRAPS is not a rectangle. `getBoundingClientRect()`
  // hands back the union of its line boxes — a shape the element never occupies. Two
  // <b>s in one flowing sentence then "collide" inside a box neither of them fills,
  // and iris reported text printing over text on a paragraph that was perfectly fine.
  // Ask for the LINE boxes and compare those.
  const boxesOf = (el) => [...el.getClientRects()].filter((b) => b.width > 1 && b.height > 1);
  const hit = (a, b) => {
    const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return ox > 2 && oy > 2 ? ox * oy : 0;
  };
  //
  // AN ELEMENT IS ONLY WHERE YOU CAN ACTUALLY SEE IT.
  //
  // getBoundingClientRect() does not know about clipping. A card that has been scrolled
  // out the side of a kanban column reports its geometry exactly as if it were sitting on
  // top of the sidebar next to it — and iris duly called the agent-hq dashboard "text
  // printing over text", for a chip that is not on the screen at all. Nothing was over
  // anything; the chip was inside a scroller, clipped away, invisible.
  //
  // So intersect every box with the clip region of its ancestors first. A box that
  // survives to nothing is not a box.
  const clipOf = (el) => {
    let L = -Infinity, T0 = -Infinity, R = Infinity, B = Infinity;
    for (let n = el.parentElement; n && n.nodeType === 1; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;   // clips nothing
      const c = n.getBoundingClientRect();
      L = Math.max(L, c.left); T0 = Math.max(T0, c.top);
      R = Math.min(R, c.right); B = Math.min(B, c.bottom);
    }
    return { left: L, top: T0, right: R, bottom: B };
  };
  const clipBox = (b, cl) => {
    const left = Math.max(b.left, cl.left), top = Math.max(b.top, cl.top);
    const right = Math.min(b.right, cl.right), bottom = Math.min(b.bottom, cl.bottom);
    return (right - left > 1 && bottom - top > 1)
      ? { left, top, right, bottom, width: right - left, height: bottom - top } : null;
  };
  const T = texts.slice(0, 400).filter((t) => !layered(t.el))
    .map((t) => {
      const cl = clipOf(t.el);
      const boxes = boxesOf(t.el).map((b) => clipBox(b, cl)).filter(Boolean);
      if (!boxes.length) return null;
      const r = { left: Math.min(...boxes.map((b) => b.left)), top: Math.min(...boxes.map((b) => b.top)),
        right: Math.max(...boxes.map((b) => b.right)), bottom: Math.max(...boxes.map((b) => b.bottom)) };
      return { ...t, r, boxes, ink: boxes.reduce((n, b) => n + b.width * b.height, 0) };
    })
    .filter((t) => t && t.ink > 0);
  for (let i = 0; i < T.length; i++) {
    for (let j = i + 1; j < T.length; j++) {
      const a = T[i], b = T[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;      // nesting is not collision
      if (!hit(a.r, b.r)) continue;                                  // cheap union reject before the line boxes
      let area = 0;
      for (const ra of a.boxes) for (const rb of b.boxes) area += hit(ra, rb);
      const smaller = Math.min(a.ink, b.ink);
      if (smaller > 0 && area / smaller > 0.35) {
        V.push({ rule: 'overlap', severity: 'high', selector: sel(a.el), text: label(a.el),
          detail: `overlaps “${label(b.el)}” (${sel(b.el)}) across ${Math.round(area)}px² — text is printing over text` });
        j = T.length;   // one report per element is enough; a broken row would emit dozens
      }
    }
  }

  // ── 7. a fixed bar slicing text that can never move out from under it ────────
  //
  // The overlap check above EXCLUDES everything inside a fixed/sticky layer, and it is
  // right to: a sticky bar sitting over scrolled content is what a sticky bar is FOR, and
  // calling that "text printing over text" was a false positive I removed on purpose.
  //
  // But the forgiveness has a hole in it. A bar may cover content the reader can SCROLL
  // OUT FROM UNDER IT. On a page that CANNOT SCROLL, nothing ever moves: the text under
  // the bar is sliced in half forever, and no scroll will ever reveal it. That is not
  // stacking — it is clipping. The rule written to forgive the first case was structurally
  // blind to the second, and it hid a real defect on cortex's own graph view.
  //
  // Do not reason about z-index — ASK THE BROWSER. elementFromPoint() is the compositor's
  // own answer to "what is on top at this pixel"; it already knows about stacking contexts
  // and paint order, and it does not need me to model them a second time, wrongly.
  // NOT documentElement.clientHeight — the usual idiom for "the viewport", and it LIED.
  // On iris's own page it reported 2583 (the content height) while the viewport was 900, so
  // a page that scrolls 2.5k pixels was judged unscrollable and its bottom row was called
  // permanently buried. That false positive would have turned a repo red for a non-bug —
  // which is how you teach people to ignore a checker, and cost yourself the one time it
  // was right. `window.innerHeight` is the viewport, and it is already in scope as H.
  // ── 8. THE PAGE NEVER TOLD THE PHONE IT WAS A PAGE FOR A PHONE ───────────────
  //
  // Without <meta name="viewport">, a phone does not lay the page out at 390px. It lays it out
  // at NINE HUNDRED AND EIGHTY — Chrome's desktop fallback — and then scales the whole thing
  // down to fit the screen. Everything still "fits". Nothing overflows. And every word on it is
  // roughly two and a half times smaller than the number says.
  //
  // Which means every measurement in this file was taken in the wrong space: a 44px tap target
  // is 17 physical pixels, 16px body text reads as 6px, and iris — measuring CSS pixels in a
  // 980px viewport — calls all of it fine. THE MOST COMMON MOBILE BUG THERE IS, and the eye was
  // structurally unable to see it, because from inside the page everything is in proportion.
  //
  // I found it by accident: a test of mine asserted `innerWidth <= 480` on the phone render and
  // fired, believing it was a desktop. innerWidth was 980. The page had not asked for a phone.
  if (mobile) {
    const meta = document.querySelector('meta[name="viewport" i]');
    const content = meta?.getAttribute('content') || '';
    if (!meta) {
      V.push({ rule: 'no-viewport-meta', severity: 'high', selector: 'head', text: '',
        detail: `no <meta name="viewport"> — so a phone lays this page out at ${W}px and scales it `
          + 'down to fit. Nothing overflows and everything is unreadable: a 44px button lands at '
          + `about ${Math.round(44 * 390 / W)}px on the glass. Add: `
          + '<meta name="viewport" content="width=device-width, initial-scale=1">' });
    } else if (!/width\s*=\s*device-width/i.test(content)) {
      V.push({ rule: 'no-viewport-meta', severity: 'high', selector: 'head > meta', text: content.slice(0, 60),
        detail: 'the viewport meta does not say width=device-width, so the page is laid out at a '
          + 'width the device never had, and then scaled. Every size on it is a size in the wrong space.' });
    }
  }

  const rootEl = document.documentElement;
  const pageScrolls = rootEl.scrollHeight > H + 2;
  if (!pageScrolls) {
    const layerOf = (el) => {
      for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
        const p = getComputedStyle(n).position;
        if (p === 'fixed' || p === 'sticky') return n;
      }
      return null;
    };
    // AND elementFromPoint ANSWERS A DIFFERENT QUESTION THAN THE ONE I MEANT TO ASK.
    // It reports what is on top for HIT-TESTING — not what actually PAINTS there. The
    // graph's <canvas> is transparent and sits in a fixed layer, so it wins the hit-test
    // over text it does not put a single pixel on, and my first cut of this check called
    // the hint "100% covered" when half of it was in plain sight.
    //
    // Which is the bug this whole check exists to catch, committed by the check itself:
    // the DOM reported something the screen never showed, and the eye believed it.
    // A COVER IS ONLY A COVER IF IT PAINTS.
    const paints = (from, upTo) => {
      for (let n = from; n && n.nodeType === 1; n = n.parentElement) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c && c.a >= 0.5) return true;
        if (n === upTo) break;
      }
      return false;
    };
    for (const t of texts.slice(0, 400)) {
      const box = clipBox(t.el.getBoundingClientRect(), clipOf(t.el));
      if (!box || box.width < 8 || box.height < 6) continue;
      const mine = layerOf(t.el);
      let probes = 0, covered = 0, by = null;
      for (let gx = 1; gx <= 7; gx++) {
        for (let gy = 1; gy <= 3; gy++) {
          const x = box.left + (box.width * gx) / 8, y = box.top + (box.height * gy) / 4;
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          probes++;
          const top = document.elementFromPoint(x, y);
          if (!top || top === t.el || t.el.contains(top) || top.contains(t.el)) continue;
          const lay = layerOf(top);
          if (!lay || lay === mine || lay.contains(t.el)) continue;   // the same layer is not a cover
          if (!paints(top, lay)) continue;                            // see-through: it covers nothing
          covered++; by = lay;
        }
      }
      // ALL of it covered is a different thing — a modal, a backdrop, a drawer deliberately
      // hiding the page behind it. Text sliced only PART of the way through is nobody's
      // intention: it is a bar that was never told the content reached that far down.
      const frac = probes ? covered / probes : 0;
      if (by && frac > 0.08 && frac < 0.9) {
        V.push({ rule: 'overlay-clip', severity: 'high', selector: sel(t.el), text: label(t.el),
          detail: `${Math.round(frac * 100)}% of this text is under “${label(by) || sel(by)}” (${sel(by)}), `
            + 'which is fixed — and the page does not scroll, so it can never be moved out from under it' });
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
  const { maxType = 6, maxRadius = 4, maxInk = 8, tokens = null } = opts || {};
  // `querySelectorAll('*')` DOES NOT CROSS A SHADOW BOUNDARY. On any page built from web
  // components — which is to say, most modern apps — iris walked the empty wrapper
  // elements, found nothing wrong with them, and said "✓ nothing broken". Proven on a page
  // where EVERYTHING was broken (8px text at 1.2:1, a button 1200px off the edge, all of it
  // in one shadow root): iris audited the host div, which is empty, and passed the page.
  //
  // This is not the canvas problem. A canvas cannot be read from the DOM at all. THIS CAN —
  // it just needed walking through the door instead of past it.
  //
  // (A CLOSED shadow root returns null from `.shadowRoot`: it cannot be entered, or even
  // counted, from outside. There is nothing to declare — it is invisible to the page too.)
  const deepAll = (root, out) => {
    for (const el of root.querySelectorAll('*')) {
      out.push(el);
      if (el.shadowRoot) deepAll(el.shadowRoot, out);
    }
    return out;
  };

  // A declared system beats a heuristic. Without tokens, iris can only ask "are you
  // consistent with YOURSELF" — which catches drift but cannot tell you what you
  // should have picked. With them it can say the useful thing: 13px is not in your
  // scale, and the nearest ones that are are 12 and 14.
  const grid = tokens?.spacing?.grid ?? opts?.grid ?? 4;
  const F = [];
  const px = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? Math.round(n * 10) / 10 : null; };
  const where = (el) => {
    if (!el) return null;
    const t = el.tagName.toLowerCase();
    if (el.id) return t + '#' + el.id;
    const c = (typeof el.className === 'string' && el.className.trim())
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    return t + c;
  };
  // Carry an example selector with every value. A finding that says "6px x20" and
  // nothing else sends you hunting a number through a stylesheet — and some of them
  // are not IN the stylesheet: a <button> with no padding declared inherits 6px from
  // the browser's own defaults, so the value you never wrote is still yours to own.
  const bump = (m, k, el) => { if (k == null) return; const e = m.get(k) || { n: 0, eg: [] };
    e.n++; const w = where(el); if (e.eg.length < 3 && w && !e.eg.includes(w)) e.eg.push(w); m.set(k, e); };
  const sortNum = (m) => [...m.entries()].sort((a, b) => a[0] - b[0]);
  const top = (m, k = 4) => [...m.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, k);

  const fonts = new Map(), radii = new Map(), spaces = new Map(), inks = new Map(), weights = new Map();
  const els = deepAll(document.body, []).slice(0, 3000);
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
      let rad = px(s.borderTopLeftRadius);
      // A `border-radius: 50%` computes to half the box — 50px on a 100px avatar,
      // 9px on an 18px dot. Counting those as distinct radii made every circle in
      // the page look like its own invented corner size. A circle is not an eighth
      // radius; it is the pill token, and there is one of it.
      if (rad && rad >= Math.min(r.width, r.height) / 2 - 1) rad = 999;
      if (rad) bump(radii, rad, el);
    }
    for (const p of ['paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight',
      'marginTop', 'marginBottom', 'gap', 'columnGap', 'rowGap']) {
      const v = px(s[p]);
      if (v && v >= 3 && v <= 96) bump(spaces, v, el);   // <3px is a hairline, >96 is a layout gesture
    }
  }

  // ── things that are ALMOST lined up ────────────────────────────────────────
  // "Do things line up" is the one piece of hierarchy that needs no taste at all —
  // and no design system can answer it. A token file has nothing to say about two
  // cards sitting three pixels out of true.
  //
  // A 40px indent is a decision. A 3px one is an accident. Nobody has ever MEANT to
  // put two stacked cards three pixels out of line; it is what you get by nudging a
  // margin until the number looked about right. And it is exactly the thing a person
  // sees instantly, reads as cheap, and cannot name.
  //
  // Scoped tightly, because a check that fires on every page teaches you to skim past
  // it: SIBLINGS only (a child indented inside its parent is a layout, not a mistake),
  // STACKED only (things side by side are supposed to have different left edges), and
  // NEAR-MISSES only — 1 to 4px. Further apart is a choice, and iris is not here to
  // relitigate choices.
  const NEAR = 4;
  const askew = [];
  const seenPair = new Set();
  const parents = new Set(els.map((e) => e.parentElement).filter(Boolean));
  for (const p of parents) {
    // "Stacked" has to mean IN A COLUMN BY CONSTRUCTION — not "happened to land on
    // different rows". In a wrapping flex row, an item pushed to the far end with
    // `margin-left:auto` has a leading edge set by where the row ran out, not by any
    // column; comparing it to a left-aligned button's leading edge is apples to oranges,
    // and they only came within 4px of each other by accident. That reported anvil's
    // toolbar — a right-aligned button doing exactly what it was told — as a defect.
    const ps = getComputedStyle(p);
    const pd = ps.display;
    const column = pd === 'block' || pd === 'flow-root' || pd === 'list-item'
      || ((pd === 'flex' || pd === 'inline-flex') && ps.flexDirection.startsWith('column'));
    if (!column) continue;
    const kids = [...p.children].filter((k) => {
      const r = k.getBoundingClientRect();
      const s = getComputedStyle(k);
      return r.width >= 40 && r.height >= 8
        && s.display !== 'inline' && s.visibility !== 'hidden' && +s.opacity !== 0
        && s.position !== 'absolute' && s.position !== 'fixed';   // taken out of flow on purpose
    });
    if (kids.length < 2) continue;
    const rects = kids.map((k) => k.getBoundingClientRect());
    // Only ever compare an edge the LAYOUT sets — never one the CONTENT sets.
    //
    // A chip is shrink-to-fit: two chips with different words in them have different
    // widths, so their trailing edges differ BY DEFINITION. Comparing those reported
    // agent-hq's perfectly ordinary label row as three misalignments — a check that
    // fires on a thing working exactly as designed, which is how a checker teaches you
    // to ignore it. An element's leading edge is placed by the layout; its trailing
    // edge is placed by the layout only when it is STRETCHED to fill its container.
    const inner = p.clientWidth - (parseFloat(ps.paddingLeft) || 0) - (parseFloat(ps.paddingRight) || 0);
    const stretched = (r) => inner > 0 && Math.abs(r.width - inner) < 1.5;
    for (let i = 0; i < kids.length; i++) {
      for (let j = i + 1; j < kids.length; j++) {
        const a = rects[i], b = rects[j];
        // Side by side? Then different left edges are the entire point.
        if (Math.abs(a.top - b.top) < Math.max(a.height, b.height) * 0.5) continue;
        for (const edge of ['left', 'right']) {
          if (edge === 'right' && !(stretched(a) && stretched(b))) continue;   // content, not layout
          const d = Math.abs(a[edge] - b[edge]);
          if (d < 1 || d > NEAR) continue;      // <1px is subpixel rounding; >4px is a decision
          const key = `${where(kids[i])}|${where(kids[j])}|${edge}`;
          if (seenPair.has(key)) continue;
          seenPair.add(key);
          askew.push({ a: where(kids[i]), b: where(kids[j]), edge, d: +d.toFixed(1) });
        }
      }
    }
  }
  if (askew.length) {
    F.push({ rule: 'almost-aligned', severity: 'design',
      detail: `${askew.length} pair${askew.length > 1 ? 's' : ''} of stacked siblings sit a few pixels out of true: `
        + askew.slice(0, 5).map((m) => `${m.a} and ${m.b} differ by ${m.d}px on the ${m.edge}`).join('; ')
        + `. A 40px indent is a decision; a 3px one is an accident — and it is the kind a person sees instantly, `
        + `reads as cheap, and cannot name.`,
      values: askew.slice(0, 8).map((m) => ({ value: `${m.d}px`, edge: m.edge, at: [m.a, m.b] })) });
  }

  // ── graded against a declared system ───────────────────────────────────────
  if (tokens) {
    const near = (v, list) => list.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
    const usedT = sortNum(fonts);
    const offT = tokens.type ? usedT.filter(([k]) => !tokens.type.includes(k)) : [];
    if (offT.length) {
      F.push({ rule: 'off-scale-type', severity: 'design',
        detail: `${offT.map(([k, v]) => `${k}px (x${v.n} -> ${near(k, tokens.type)}px) on ${v.eg.join(', ') || '?'}`).join('; ')} `
          + `— not in the type scale you declared: ${tokens.type.join(', ')}px.`,
        values: offT.map(([k, v]) => ({ value: k, count: v.n, nearest: near(k, tokens.type), at: v.eg })) });
    }
    const usedR = sortNum(radii);
    const offR = tokens.radius ? usedR.filter(([k]) => !tokens.radius.includes(k)) : [];
    if (offR.length) {
      F.push({ rule: 'off-scale-radius', severity: 'design',
        detail: `${offR.map(([k, v]) => `${k}px (x${v.n} -> ${near(k, tokens.radius)}px) on ${v.eg.join(', ') || '?'}`).join('; ')} `
          + `— not in your radius scale: ${tokens.radius.join(', ')}px.`,
        values: offR.map(([k, v]) => ({ value: k, count: v.n, nearest: near(k, tokens.radius), at: v.eg })) });
    }
    const offS = sortNum(spaces).filter(([k]) => k % grid !== 0);
    if (offS.length) {
      F.push({ rule: 'off-grid-spacing', severity: 'design',
        detail: `${offS.map(([k, v]) => `${k}px (x${v.n} -> ${Math.round(k / grid) * grid}px) on ${v.eg.join(', ') || '?'}`).join('; ')} `
          + `— off the ${grid}px grid you declared.`,
        values: offS.map(([k, v]) => ({ value: k, count: v.n, nearest: Math.round(k / grid) * grid, at: v.eg })) });
    }
    // With a system declared, the generic "are you consistent with yourself" checks
    // are noise — the system already answered that question.
    return { findings: F, tokens: tokens.name || true, scales: {
      type: sortNum(fonts).map(([k, v]) => ({ value: k, count: v.n })),
      radius: sortNum(radii).map(([k, v]) => ({ value: k, count: v.n })),
      spacing: sortNum(spaces).map(([k, v]) => ({ value: k, count: v.n })),
      weights: [...weights.keys()].sort(),
    } };
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

// ── Can you actually SEE the game? ───────────────────────────────────────────
// The DOM contrast check cannot help here: a canvas is one element with one colour
// as far as the DOM is concerned. So read the pixels. An agent will happily paint
// #2a3140 obstacles and a #3d4757 player onto a #0b0e14 background — every one of
// them a tasteful dark grey, and the game invisible. It renders, it animates, it
// answers the keys, and you cannot see it.
//
// Runs in the page. 2D contexts only: a WebGL buffer cannot be read back without
// preserveDrawingBuffer, and inventing a number there would be worse than silence.
export function canvasHealth() {
  const out = [];
  const dpr = window.devicePixelRatio || 1;
  const lum = (r, g, b) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => { const [hi, lo] = a > b ? [a, b] : [b, a]; return (hi + 0.05) / (lo + 0.05); };

  for (const c of document.querySelectorAll('canvas')) {
    const r = c.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const info = {
      backing: [c.width, c.height],
      css: [Math.round(r.width), Math.round(r.height)],
      want: [Math.round(r.width * dpr), Math.round(r.height * dpr)],
      dpr,
      // Blur: a 400x250 canvas stretched to 800x500 doubles every pixel. It is the
      // most common thing wrong with a hand-written game, and a screenshot hides it.
      scale: +(r.width / (c.width || 1)).toFixed(2),
    };

    let ctx = null;
    try { ctx = c.getContext('2d'); } catch { /* webgl */ }
    if (ctx && c.width > 0 && c.height > 0) {
      let data = null;
      try { data = ctx.getImageData(0, 0, c.width, c.height).data; } catch { data = null; }
      if (data) {
        const px = c.width * c.height;
        const step = Math.max(1, Math.floor(px / 30000));      // sample, don't crawl
        const bins = new Map();
        let n = 0;
        for (let i = 0; i < data.length; i += 4 * step) {
          if (data[i + 3] < 8) continue;                        // transparent
          const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
          const b = bins.get(key);
          if (b) b.n++; else bins.set(key, { n: 1, r: data[i], g: data[i + 1], b: data[i + 2] });
          n++;
        }
        if (n > 0) {
          const sorted = [...bins.values()].sort((a, b) => b.n - a.n);
          const bg = sorted[0];                                  // the commonest colour IS the ground
          const bgL = lum(bg.r, bg.g, bg.b);
          // Everything that is not the ground and is big enough to be a THING,
          // rather than one antialiased edge.
          const ink = sorted.slice(1).filter((x) => x.n / n >= 0.0015);
          const best = ink.reduce((m, x) => Math.max(m, ratio(lum(x.r, x.g, x.b), bgL)), 0);
          info.background = `rgb(${bg.r}, ${bg.g}, ${bg.b})`;
          info.ink_coverage = +((n - bg.n) / n).toFixed(4);
          // How much of the canvas AREA is painted at all. ink_coverage is the share of the
          // OPAQUE pixels that are not the commonest colour — on a transparent canvas that is
          // not the same thing, and reporting it as "93% of the canvas" is a wrong number
          // dressed as a measurement.
          info.painted = +((n * step) / px).toFixed(4);
          info.best_contrast = +best.toFixed(2);
          info.readable_shapes = ink.filter((x) => ratio(lum(x.r, x.g, x.b), bgL) >= 3).length;
          info.shapes = ink.length;
          // The palette the game ACTUALLY DREW. We already binned it to find the ground;
          // throwing it away afterwards is why a game could be graded on whether you can
          // see it, but never on whether anybody chose the colours.
          info.ground = [bg.r, bg.g, bg.b];
          info.ink_colors = ink.slice(0, 16).map((x) => ({ rgb: [x.r, x.g, x.b], share: +(x.n / n).toFixed(4) }));
        }
      }
    }
    out.push(info);
  }
  return out;
}


// What iris CANNOT see, so that it can say so instead of implying it looked.
//
// An <iframe> is a separate document. Every check here runs against the top one, so an
// app embedded in a frame — a widget, an editor, a preview pane, an ad — is audited by
// nobody, and the page still comes back "✓ nothing broken". Same-origin frames could be
// entered; cross-origin ones cannot, ever, by anyone. Rather than pierce some and quietly
// skip the rest, iris reports that it did not enter them at all. A partial answer that
// looks total is worse than an admitted gap.
export function blindSpots() {
  return { iframes: document.querySelectorAll('iframe').length };
}
