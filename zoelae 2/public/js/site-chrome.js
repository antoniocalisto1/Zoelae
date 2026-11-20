// Shared furniture for the public pages: the wordmark, the favicon, the header's scrolled state,
// and swapping "Sign in" for a way back into the app when the visitor already has a session.

import { wordmark, setFavicon } from './brand.js';

export function paintChrome({ current = '' } = {}) {
  const brand = (el, small) => { if (el) el.innerHTML = wordmark({ small }); };
  brand(document.getElementById('brandLink'), false);
  brand(document.getElementById('footerBrand'), true);
  setFavicon();

  document.querySelectorAll(`.site-nav a[href="${current}"]`).forEach(a => a.classList.add('current'));

  const header = document.getElementById('siteHeader');
  if (header) {
    const onScroll = () => header.classList.toggle('scrolled', window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }
}

/**
 * A visitor with a live session shouldn't be asked to sign in again. This is presentation only —
 * the server still decides what they may see once they get there.
 */
export async function reflectSession() {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (!res.ok) return null;
    const { user } = await res.json();

    const login = document.getElementById('loginLink');
    if (login) {
      login.textContent = 'Go to your collection';
      login.href = '/app';
    }
    const signup = document.getElementById('signupLink');
    if (signup) signup.remove();

    return user;
  } catch {
    return null;
  }
}
