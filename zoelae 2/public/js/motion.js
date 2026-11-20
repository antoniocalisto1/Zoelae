/* Motion — one clock, springs on top of it.
 *
 * Every moving thing in the app shares a single requestAnimationFrame loop, so
 * thirty-six cards travelling at once cost one callback rather than seventy-two.
 * Springs animate from their live value and keep their velocity when re-targeted,
 * which is what lets any motion be grabbed, redirected or reversed mid-flight.
 *
 * Two parameters, not the physics triplet:
 *   damping  1.0 = critically damped — the default, no overshoot.
 *            ~0.8 adds a little bounce; only ever use it when the gesture that
 *            started the motion carried momentum.
 *   response seconds to reach the target. Not a duration — a spring has none;
 *            its settle time falls out of the parameters.
 */

export const RM = matchMedia('(prefers-reduced-motion: reduce)');
export const FLAT = matchMedia('(prefers-reduced-transparency: reduce)');

const ticker = (() => {
  const subs = new Set();
  let raf = 0, last = 0;
  function tick(now) {
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    for (const fn of Array.from(subs)) fn(dt);
    raf = subs.size ? requestAnimationFrame(tick) : 0;
  }
  return {
    add(fn) { subs.add(fn); if (!raf) { last = performance.now(); raf = requestAnimationFrame(tick); } },
    remove(fn) { subs.delete(fn); }
  };
})();

export class Spring {
  constructor(value, onUpdate, opts = {}) {
    this.x = value; this.v = 0; this.t = value; this.cb = onUpdate;
    this.eps = opts.eps == null ? 0.4 : opts.eps;
    this.running = false; this.onRest = null;
    this.tune(opts.damping == null ? 1 : opts.damping, opts.response == null ? 0.4 : opts.response);
    this.step = this.step.bind(this);
  }
  tune(damping, response) {
    const w = (2 * Math.PI) / response;
    this.k = w * w; this.c = 2 * damping * w;
  }
  to(target, o = {}) {
    this.t = target;
    this.tune(o.damping == null ? 1 : o.damping, o.response == null ? 0.4 : o.response);
    this.onRest = o.onRest || null;
    if (o.velocity != null) this.v = o.velocity;        // hand off the gesture's velocity
    if (RM.matches) { this.halt(); this.x = target; this.v = 0; this.cb(this.x); this.rest(); return this; }
    if (!this.running) { this.running = true; ticker.add(this.step); }
    return this;
  }
  step(dt) {
    const n = Math.max(1, Math.ceil(dt / 0.004)), h = dt / n;
    for (let i = 0; i < n; i++) {
      const a = -this.k * (this.x - this.t) - this.c * this.v;
      this.v += a * h; this.x += this.v * h;
    }
    if (Math.abs(this.v) < this.eps * 4 && Math.abs(this.x - this.t) < this.eps) {
      this.x = this.t; this.v = 0; this.cb(this.x); this.halt(); this.rest(); return;
    }
    this.cb(this.x);
  }
  /** Displace without losing velocity — this is what lets an interrupted card
   *  carry on from where it is rather than restart. */
  shift(d) { if (d) { this.x += d; this.cb(this.x); } return this; }
  hold(x) { this.halt(); this.x = x; this.v = 0; this.cb(x); return this; }
  halt() { if (this.running) { this.running = false; ticker.remove(this.step); } }
  stop() { this.halt(); return this; }
  rest() { const r = this.onRest; this.onRest = null; if (r) r(); }
  get moving() { return this.running; }
}

/** Apple's momentum projection — scroll-style deceleration, not v²/2a. */
export const project = (v, d = 0.998) => (v / 1000) * d / (1 - d);

/** At a boundary, resist progressively instead of stopping dead. */
export const rubberband = (over, dim, c = 0.55) => (over * dim * c) / (dim + c * Math.abs(over));

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/**
 * One drag helper for every draggable surface. Tracks 1:1 from where it was
 * grabbed, rubber-bands past [lo, hi], and reports the release velocity taken
 * from the last ~100ms of movement.
 *
 * `onlyForward` is for surfaces that are also scrollers: the gesture isn't
 * claimed until it's clearly heading the one way we handle, so a scroll that
 * belongs to the content stays with the content.
 */
export function dragAxis(handle, spring, axis, opt) {
  const { lo = 0, hi = Infinity, dim, release, guard, onlyForward } = opt;
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button,a,input,select,textarea')) return;
    if (guard && !guard(e)) return;
    const pos = (ev) => (axis === 'y' ? ev.clientY : ev.clientX);
    const start = pos(e);
    let origin = spring.x;
    const hist = [{ p: start, t: e.timeStamp }];
    let moved = false;
    let armed = !onlyForward;
    if (armed) { spring.stop(); handle.setPointerCapture(e.pointerId); handle.classList.add('dragging'); }

    const stop = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      handle.classList.remove('dragging');
    };
    const move = (ev) => {
      const p = pos(ev), d = p - start;
      if (!armed) {
        if (d < -4) { stop(); return; }                  // the content wants this one
        if (d < 8) { hist.push({ p, t: ev.timeStamp }); return; }
        armed = true; origin = spring.x;
        spring.stop(); handle.setPointerCapture(ev.pointerId); handle.classList.add('dragging');
      }
      const raw = origin + (p - (onlyForward ? start + 8 : start));
      if (Math.abs(d) > 3) moved = true;
      let v = raw;
      if (raw < lo) v = lo - rubberband(lo - raw, dim());
      else if (raw > hi) v = hi + rubberband(raw - hi, dim());
      spring.hold(v);
      hist.push({ p, t: ev.timeStamp });
      if (hist.length > 8) hist.shift();
    };
    const up = (ev) => {
      stop();
      if (!armed) return;
      const last = hist[hist.length - 1];
      const first = hist.find(h => last.t - h.t <= 100) || last;
      let v = last.t > first.t ? (last.p - first.p) / ((last.t - first.t) / 1000) : 0;
      if (ev.timeStamp - last.t > 80) v = 0;             // the finger stopped before lifting
      release(spring.x, v, moved);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
}

/* ---------- per-element motion handles ---------- */

const handles = new WeakMap();

/** Four springs (x, y, scale, opacity) bound to one element, created on demand. */
export function motionFor(el) {
  let m = handles.get(el);
  if (!m) {
    m = {};
    const apply = () => {
      el.style.transform = `translate3d(${m.x.x}px,${m.y.x}px,0) scale(${m.s.x})`;
      el.style.opacity = String(m.o.x);
    };
    m.x = new Spring(0, apply, { eps: 0.25 });
    m.y = new Spring(0, apply, { eps: 0.25 });
    m.s = new Spring(1, apply, { eps: 0.0025 });
    m.o = new Spring(1, apply, { eps: 0.008 });
    m.apply = apply;
    /** Hand back the element's own styling once everything is home again. */
    m.settle = () => {
      if (!m.x.moving && !m.y.moving && !m.s.moving && !m.o.moving &&
          m.x.x === 0 && m.y.x === 0 && m.s.x === 1 && m.o.x === 1) {
        el.style.transform = ''; el.style.opacity = '';
      }
    };
    handles.set(el, m);
  }
  return m;
}

export function dropMotion(el) { handles.delete(el); }

/** Images arrive rather than pop in. Safe to call on an already-loaded image. */
export function fadeIn(img) {
  if (!img) return;
  img.classList.add('lazy');
  const show = () => img.classList.add('in');
  if (img.complete && img.naturalWidth) requestAnimationFrame(show);
  else {
    img.addEventListener('load', show, { once: true });
    img.addEventListener('error', show, { once: true });   // never leave it invisible
  }
}

/**
 * FLIP a keyed list inside a container: survivors travel from where they were
 * to where they now belong, arrivals rise in, departures shrink away from their
 * old position. Because each offset is a spring, changing the order again
 * mid-flight redirects the elements instead of restarting them.
 *
 *   build(item) -> element, keyed by data-id
 */
export function flipList(container, items, build, opts = {}) {
  const { exitLayer, stagger = 14, response = 0.46, refresh } = opts;

  const present = new Map();
  const firstRect = new Map();
  for (const el of Array.from(container.children)) {
    if (!el.dataset.id) continue;
    present.set(el.dataset.id, el);
    firstRect.set(el.dataset.id, el.getBoundingClientRect());
  }

  const keep = [], enter = [], frag = document.createDocumentFragment();
  for (const item of items) {
    const id = String(item.id);
    let el = present.get(id);
    if (el) { present.delete(id); keep.push(el); if (refresh) refresh(el, item); }
    else { el = build(item); enter.push(el); }
    frag.appendChild(el);
  }

  // Lift departures out of the flow first, so survivors reflow into their real homes.
  for (const el of present.values()) exitElement(el, firstRect.get(el.dataset.id), exitLayer);
  container.appendChild(frag);

  if (RM.matches) {
    keep.concat(enter).forEach(el => { el.style.transform = ''; el.style.opacity = ''; });
    return;
  }

  for (const el of keep) {
    const f = firstRect.get(el.dataset.id), l = el.getBoundingClientRect();
    const m = motionFor(el);
    const dx = f.left - l.left, dy = f.top - l.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) { m.settle(); continue; }
    m.x.shift(dx); m.y.shift(dy);
    const done = { response, onRest: m.settle };
    m.x.to(0, done); m.y.to(0, done);
  }

  enter.forEach((el, i) => {
    const m = motionFor(el);
    m.o.hold(0); m.s.hold(0.94); m.y.hold(10);
    const go = () => {
      m.o.to(1, { response: 0.4, onRest: m.settle });
      m.s.to(1, { response: 0.42, onRest: m.settle });
      m.y.to(0, { response: 0.42, onRest: m.settle });
    };
    // A short stagger so a new set reads as arriving rather than blinking.
    if (i < 12 && keep.length) setTimeout(go, i * stagger); else go();
  });
}

function exitElement(el, rect, layer) {
  if (RM.matches || !rect || !layer) { el.remove(); return; }
  const m = motionFor(el);
  m.x.hold(0); m.y.hold(0);
  el.style.position = 'fixed';
  el.style.left = rect.left + 'px';
  el.style.top = rect.top + 'px';
  el.style.width = rect.width + 'px';
  el.style.height = rect.height + 'px';
  el.style.margin = '0';
  layer.appendChild(el);
  m.s.to(0.93, { response: 0.3 });
  m.o.to(0, { response: 0.26, onRest: () => { dropMotion(el); el.remove(); } });
}

/**
 * A number that springs between values instead of snapping, so you can see
 * which way it moved. One spring per key for the life of the page: re-rendering
 * replaces the element, but the figure carries on from where it actually was.
 */
const figures = {};
export function animateNumber(el, key, to, fmt) {
  let s = figures[key];
  if (!s) s = figures[key] = new Spring(to, () => {}, { eps: 0.4 });
  s.cb = (v) => { el.textContent = fmt(v); };
  el.textContent = fmt(s.x);
  s.to(to, { response: 0.5 });
}
export function resetFigures() {
  Object.keys(figures).forEach(k => { figures[k].stop(); delete figures[k]; });
}
