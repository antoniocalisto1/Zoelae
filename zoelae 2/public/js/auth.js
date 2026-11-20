// The door: sign in, create an account, ask for a reset link, choose a new password.
// Credentials go to the server; nothing is decided in the browser.
import { $, esc } from './format.js';
import { api, ApiError } from './api.js';
import { state } from './store.js';
import { SITE, ACCOUNT_TYPES, wordmark } from './brand.js';

let mode = 'login';         // login | signup | forgot | sent | reset | expired
let resetToken = null;
let onDone = () => {};

const timezone = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; }
};

const COPY = {
  login:   { kicker: 'Sign in', title: 'Welcome back', sub: 'Sign in to your catalogue.', submit: 'Sign in' },
  signup:  { kicker: 'Create an account', title: 'Start your catalogue', sub: 'Free to use. Nothing you add is seen by anyone until you share it.', submit: 'Create account' },
  forgot:  { kicker: 'Password', title: 'Forgotten password', sub: 'Enter the email you signed up with and we’ll send a link to choose a new one.', submit: 'Send the link' },
  sent:    { kicker: 'Password', title: 'Check your email', sub: '', submit: 'Back to sign in' },
  reset:   { kicker: 'Password', title: 'Choose a new password', sub: 'This signs you out on every other device.', submit: 'Save and sign in' },
  expired: { kicker: 'Password', title: 'This link has run out', sub: 'Reset links work once, for an hour. Ask for a fresh one.', submit: 'Send a new link' }
};

/** A gallery signs up under the gallery's name; a person under their own. */
const NAME_LABEL = { collector: 'Your name', artist: 'Your name, as you sign your work', gallery: 'Gallery name' };

function show(el, on) { el.hidden = !on; }

const chosenType = () => document.querySelector('input[name="accountType"]:checked')?.value || '';

function paintTypeOptions(selected) {
  $('#typeOptions').innerHTML = ACCOUNT_TYPES.map(t => `
    <label class="type-opt">
      <input type="radio" name="accountType" value="${esc(t.key)}"${t.key === selected ? ' checked' : ''}>
      <span><b>${esc(t.name)}</b><small>${esc(t.line)}</small></span>
    </label>`).join('');
  document.querySelectorAll('input[name="accountType"]').forEach(r => {
    r.onchange = () => { $('#nameLabel').textContent = NAME_LABEL[chosenType()] || 'Your name'; message('#authErr', null); };
  });
  $('#nameLabel').textContent = NAME_LABEL[selected] || 'Your name';
}

function setMode(next, { keepMessages = false } = {}) {
  mode = next;
  const c = COPY[mode];
  $('#authKicker').textContent = c.kicker;
  $('#authTitle').textContent = c.title;
  $('#authSub').textContent = c.sub;
  $('#authSub').hidden = !c.sub;
  $('#authSubmit').textContent = c.submit;

  show($('#typeField'), mode === 'signup');
  show($('#nameField'), mode === 'signup');
  show($('#emailField'), mode === 'login' || mode === 'signup' || mode === 'forgot' || mode === 'expired');
  show($('#passField'), mode === 'login' || mode === 'signup' || mode === 'reset');
  show($('#forgotBtn'), mode === 'login');
  show($('#passHint'), mode === 'signup' || mode === 'reset');
  show($('#consent'), mode === 'signup');
  show($('#authSwitch'), mode !== 'sent');

  $('#passLabel').textContent = mode === 'reset' ? 'New password' : 'Password';
  $('#fPass').autocomplete = mode === 'login' ? 'current-password' : 'new-password';

  if (mode === 'login') { $('#switchText').textContent = `New to ${SITE}?`; $('#switchBtn').textContent = 'Create an account'; }
  else if (mode === 'signup') { $('#switchText').textContent = 'Already have an account?'; $('#switchBtn').textContent = 'Sign in'; }
  else { $('#switchText').textContent = 'Remembered it?'; $('#switchBtn').textContent = 'Back to sign in'; }

  if (!keepMessages) { message('#authErr', null); message('#authOk', null); }
  const type = chosenType();
  const url = mode === 'reset' ? `/reset?token=${encodeURIComponent(resetToken || '')}`
    : mode === 'signup' ? (type ? `/app?mode=signup&type=${type}` : '/app?mode=signup')
      : mode === 'forgot' ? '/app?mode=forgot' : '/app';
  if (location.pathname + location.search !== url && mode !== 'sent' && mode !== 'expired') history.replaceState({}, '', url);

  // Focus the first empty field with a mouse and keyboard; on a phone, don't pop the keyboard unasked.
  if (matchMedia('(pointer: fine)').matches) requestAnimationFrame(() => {
    const first = [...document.querySelectorAll('#authForm .input')].find(i => !i.closest('[hidden]') && !i.value);
    (first || $('#authSubmit')).focus({ preventScroll: true });
  });
}

function message(sel, html) {
  const el = $(sel);
  el.innerHTML = html || '';
  el.classList.toggle('hidden', !html);
}

const fail = (err) => message('#authErr', esc(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.'));

async function submit() {
  const email = $('#fEmail').value.trim();
  const password = $('#fPass').value;
  message('#authErr', null);

  if (mode === 'sent') return setMode('login');

  if (mode === 'signup' && !chosenType()) return message('#authErr', 'Please choose an account type: collector, artist or gallery.');
  if ((mode === 'login' || mode === 'signup' || mode === 'forgot' || mode === 'expired') && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return message('#authErr', 'Please enter your email address.');
  }
  if (mode === 'signup' && $('#fName').value.trim().length < 2) {
    return message('#authErr', chosenType() === 'gallery' ? 'Please enter the gallery’s name.' : 'Please tell us your name.');
  }
  if ((mode === 'signup' || mode === 'reset') && password.length < 8) return message('#authErr', 'Your password needs at least 8 characters.');
  if (mode === 'login' && !password) return message('#authErr', 'Please enter your password.');

  if (mode === 'login' || mode === 'signup') {
    const payload = { email, password, timezone: timezone() };
    if (mode === 'signup') {
      payload.displayName = $('#fName').value.trim();
      payload.accountType = chosenType();
    }
    const res = await api.post(mode === 'signup' ? '/api/auth/signup' : '/api/auth/login', payload);
    state.user = res.user;
    state.firstSignIn = !!res.firstSignIn;
    $('#authForm').reset();
    history.replaceState({}, '', '/app');
    return onDone();
  }

  if (mode === 'forgot' || mode === 'expired') {
    const res = await api.post('/api/auth/forgot', { email });
    setMode('sent');
    $('#authSub').hidden = false;
    $('#authSub').innerHTML = `If there’s an account for <b>${esc(email)}</b>, a link to choose a new password is on its way. It works once, for the next hour. Check your spam folder if it doesn’t arrive in a few minutes.`;
    // On a development machine there's no real email: point at the local outbox instead.
    if (res.outbox) message('#authOk', `Running locally, so nothing is really sent. <a href="${esc(res.outbox)}" target="_blank">Open the outbox</a> to find the email.`);
    return;
  }

  if (mode === 'reset') {
    const res = await api.post('/api/auth/reset', { token: resetToken, password });
    state.user = res.user;
    state.firstSignIn = false;
    $('#authForm').reset();
    history.replaceState({}, '', '/app');
    return onDone({ notice: 'Your password has been changed. Other devices have been signed out.' });
  }
}

export function initAuth({ onSignedIn }) {
  onDone = onSignedIn;
  $('#authBrand').innerHTML = wordmark();
  paintTypeOptions('');

  $('#switchBtn').onclick = () => setMode(mode === 'login' ? 'signup' : 'login');
  $('#forgotBtn').onclick = () => setMode('forgot');
  $('#revealBtn').onclick = () => {
    const input = $('#fPass');
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    $('#revealBtn').textContent = showing ? 'Show' : 'Hide';
    $('#revealBtn').setAttribute('aria-pressed', String(!showing));
    $('#revealBtn').setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
  };

  $('#authForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const button = $('#authSubmit');
    button.disabled = true;
    try { await submit(); }
    catch (err) {
      if (err instanceof ApiError && err.body?.error === 'reset_expired') { setMode('expired', { keepMessages: true }); }
      fail(err);
    } finally { button.disabled = false; }
  };
}

/**
 * The front page links in with ?mode= and, from the "three ways in" cards, ?type=; reset emails
 * link to /reset?token=. A type chosen on the front page arrives already selected.
 */
async function applyIntent() {
  const params = new URLSearchParams(location.search);

  if (location.pathname === '/reset') {
    resetToken = params.get('token') || '';
    try {
      const check = await api.get(`/api/auth/reset/${encodeURIComponent(resetToken)}`);
      setMode('reset');
      if (check.email) $('#authSub').textContent = `For ${check.email}. This signs you out on every other device.`;
    } catch {
      setMode('expired');
    }
    return;
  }

  const type = ACCOUNT_TYPES.some(t => t.key === params.get('type')) ? params.get('type') : '';
  paintTypeOptions(type);
  const wanted = params.get('mode');
  setMode(type || wanted === 'signup' ? 'signup' : wanted === 'forgot' ? 'forgot' : 'login');
}

export function showAuthScreen() {
  $('#app').classList.add('hidden');
  $('#authScreen').classList.remove('hidden');
  document.title = `${SITE} — sign in`;
  return applyIntent();
}
