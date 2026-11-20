// Toasts, modals and an in-page confirm. No native alert/confirm dialogs anywhere.
//
// Modals arrive on a spring rather than a keyframe, and the layer underneath
// steps back while one is up. The head is a handle: drag it down and the modal
// follows your finger 1:1, rubber-banding upward; on release the resting point
// is projected from the flick before the spring continues at the finger's speed.
import { $ } from './format.js';
import { Spring, RM, dragAxis, project, clamp } from './motion.js';
import { setModalPush } from './artworkDetail.js';

let toastState = { el: null, spring: null, timer: 0 };

export function toast(message) {
  const root = $('#toastRoot');
  clearTimeout(toastState.timer);
  const fresh = !toastState.el;

  if (fresh) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    root.appendChild(el);
    toastState.el = el;
    toastState.spring = new Spring(90, (y) => {
      el.style.transform = `translate3d(-50%,${y}px,0)`;
      el.style.opacity = String(clamp(1 - y / 90, 0, 1));
    }, { eps: 0.3 });
    toastState.spring.hold(90);
    el.onpointerenter = () => clearTimeout(toastState.timer);
    el.onpointerleave = () => armToast(2000);
  }

  const el = toastState.el;
  const paint = () => { el.textContent = message; el.classList.remove('swap'); };
  if (fresh || RM.matches) paint();
  else { el.classList.add('swap'); setTimeout(paint, 130); }   // a replacement cross-fades its text

  toastState.spring.to(0, { response: 0.38 });
  armToast(2600);
}

function armToast(ms) {
  clearTimeout(toastState.timer);
  toastState.timer = setTimeout(() => {
    const s = toastState.spring, el = toastState.el;
    if (!s) return;
    s.to(90, { response: 0.32, onRest: () => { el.remove(); toastState.el = null; toastState.spring = null; } });
  }, ms);
}

/* ---------- modals ---------- */

let modal = { el: null, overlay: null, spring: null, h: 0, returnFocus: null };
// A closing modal animates out, so a second modal can be opened before the
// first has finished leaving — the share flow does exactly that. Each modal
// carries a generation, and a close only clears the root if it is still the
// current one; otherwise its predecessor would wipe the modal that replaced it.
let generation = 0;

function applyModal(y) {
  if (!modal.el) return;
  const p = clamp(1 - y / modal.h, 0, 1);
  modal.el.style.transform = `translate3d(0,${y}px,0)`;
  modal.overlay.style.opacity = String(p);
  setModalPush(p);
}

export function openModal(html, { size = '' } = {}) {
  const root = $('#modalRoot');
  if (modal.spring) modal.spring.stop();
  generation++;
  modal.returnFocus = document.activeElement;
  root.innerHTML = `<div class="overlay" data-overlay><div class="modal ${size}">${html}</div></div>`;
  modal.overlay = root.querySelector('[data-overlay]');
  modal.el = root.querySelector('.modal');

  modal.overlay.addEventListener('click', (e) => { if (e.target === modal.overlay) closeModal(); });
  root.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => closeModal()));

  // How far it has to travel to be gone: its own height plus the gap above it.
  modal.h = modal.el.offsetHeight + modal.el.getBoundingClientRect().top + 24;
  modal.spring = new Spring(modal.h, applyModal, { eps: 0.4 });
  modal.spring.hold(modal.h);
  modal.spring.to(0, { response: 0.4 });          // nothing was thrown, so no bounce

  const head = modal.el.querySelector('.modal-head');
  if (head) {
    head.classList.add('grabbable');
    dragAxis(head, modal.spring, 'y', {
      lo: 0, dim: () => modal.h,
      release: (y, v) => {
        if (y + project(v) > modal.h * 0.4) closeModal(v);
        else modal.spring.to(0, { velocity: v, damping: Math.abs(v) > 250 ? 0.8 : 1, response: 0.3 });
      }
    });
  }
  return modal.el;
}

export function closeModal(velocity = 0, then) {
  if (!modal.spring) { $('#modalRoot').innerHTML = ''; setModalPush(0); if (then) then(); return; }
  const spring = modal.spring;
  const gen = generation;
  const focusBack = modal.returnFocus;
  modal.spring = null;                                    // a second Escape must not re-run this
  spring.to(modal.h, { velocity, response: 0.3, onRest: () => {
    if (gen === generation) {                             // nothing has taken our place
      $('#modalRoot').innerHTML = '';
      modal.el = null; modal.overlay = null;
      setModalPush(0);
      if (focusBack && focusBack.focus) focusBack.focus({ preventScroll: true });
    }
    if (then) then();
  } });
}

export const isModalOpen = () => !!modal.spring;

document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modal.spring) { e.stopPropagation(); closeModal(); } }, true);

export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const el = openModal(`
      <div class="modal-head"><h3>${title}</h3></div>
      <div class="modal-body"><p style="margin:0;color:var(--muted)">${message}</p></div>
      <div class="modal-foot">
        <button class="btn" data-cancel>Cancel</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${confirmLabel}</button>
      </div>`, { size: 'sm' });
    el.querySelector('[data-cancel]').onclick = () => closeModal(0, () => resolve(false));
    el.querySelector('[data-ok]').onclick = () => closeModal(0, () => resolve(true));
  });
}

export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs a secure context; fall back to a temporary selection.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}
