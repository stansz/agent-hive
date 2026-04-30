#!/usr/bin/env bash
# install.sh - Agent Hive installer
# Run: curl -sL https://raw.githubusercontent.com/stansz/agent-hive/main/install.sh | bash

set -euo pipefail

APP_DIR="${HOME}/agent-hive"
REPO="https://github.com/stansz/agent-hive.git"

echo ""
echo "  Agent Hive Installer"
echo "  Self-hosted coding agent server"
echo ""

# Check Node
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js >= 18 is required. Install it first:"
  echo "  https://nodejs.org/"
  exit 1
fi

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  echo "ERROR: Node.js >= 18 required, found $(node -v)"
  exit 1
fi
echo "  Node: $(node -v) ✓"

# Check git
if ! command -v git &>/dev/null; then
  echo "ERROR: git is required but not found."
  exit 1
fi
echo "  Git: $(git --version | head -1) ✓"

# Clone or update
if [ -d "$APP_DIR" ]; then
  echo ""
  echo "  $APP_DIR already exists, updating..."
  cd "$APP_DIR"
  git pull --ff-only
else
  echo ""
  echo "  Cloning to $APP_DIR ..."
  git clone --depth 1 "$REPO" "$APP_DIR"
  cd "$APP_DIR"
fi

# Install deps
echo ""
echo "  Installing dependencies..."
npm install --omit=dev

# Build
echo ""
echo "  Building..."
npm run build

# .env setup
if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo "  Created .env from .env.example"
  echo "  >>> EDIT .env and set: API_TOKEN and at least one LLM provider key <<<"
else
  echo ""
  echo "  .env already exists, keeping your settings"
fi

echo ""
echo "  === Done ==="
echo ""
echo "  Next steps:"
echo "    1. Edit $APP_DIR/.env"
echo "    2. Start: node $APP_DIR/dist/index.js"
echo "    3. Test: curl http://localhost:8080/health"
echo ""
echo "  For systemd setup, see the repo README."
echo ""
