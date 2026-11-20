#!/bin/bash
# Zoelae — double-click this file to start the app on a Mac.
# It sets everything up the first time, and just starts the server after that.

cd "$(dirname "$0")" || exit 1

echo ""
echo "  Zoelae"
echo "  ───────────────────────────────────────────────"
echo "  Folder: $(pwd)"
echo ""

# --- 1. Is Node installed? ---------------------------------------------------
if ! command -v node > /dev/null 2>&1; then
  echo "  ✗ Node.js is not installed."
  echo ""
  echo "    Zoelae needs Node 18 or newer. Install it one of these ways:"
  echo ""
  echo "      • Download the macOS installer from https://nodejs.org  (pick the LTS button)"
  echo "      • Or, if you use Homebrew:   brew install node"
  echo ""
  echo "    Then double-click this file again."
  echo ""
  read -r -p "  Press return to close. "
  exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "  ✗ Node $(node -v) is too old — Zoelae needs 18 or newer."
  echo "    Update it from https://nodejs.org and run this again."
  echo ""
  read -r -p "  Press return to close. "
  exit 1
fi
echo "  ✓ Node $(node -v)"

# --- 2. Dependencies ---------------------------------------------------------
if [ ! -d node_modules ]; then
  echo "  → Installing dependencies (first run only, about a minute)…"
  if ! npm install; then
    echo ""
    echo "  ✗ npm install failed."
    echo "    The usual cause on macOS is missing build tools. Run this, then try again:"
    echo ""
    echo "        xcode-select --install"
    echo ""
    read -r -p "  Press return to close. "
    exit 1
  fi
else
  echo "  ✓ Dependencies already installed"
fi

# --- 3. Database -------------------------------------------------------------
npm run migrate --silent > /dev/null 2>&1 || npm run migrate
echo "  ✓ Database ready"

ACCOUNTS=$(node -e "
  try { const db = require('better-sqlite3')(require('./server/config').dbFile, { readonly: true });
        console.log(db.prepare('SELECT COUNT(*) AS c FROM users').get().c); } catch { console.log(0); }
" 2>/dev/null)
if [ "${ACCOUNTS:-0}" = "0" ]; then
  echo "  ✓ The site is empty: create the first account in your browser"
else
  echo "  ✓ ${ACCOUNTS} account(s) on this machine"
fi

# --- 4. Go -------------------------------------------------------------------
echo ""
echo "  ───────────────────────────────────────────────"
echo "  Opening http://localhost:3000 in your browser."
echo "  Emails (password resets) land in the outbox:"
echo "  http://localhost:3000/dev/outbox"
echo ""
echo "  Leave this window open while you use the app."
echo "  Press Control-C here when you're finished."
echo "  ───────────────────────────────────────────────"
echo ""

( sleep 2 && open http://localhost:3000 ) &
npm start
