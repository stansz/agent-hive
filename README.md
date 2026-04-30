# Agent Hive

**Self-hosted coding agent server.** Your own private coding AI on a VPS. Clone repos, write code, push changes — all through a simple API or web UI.

Powered by [pi.dev](https://pi.dev) SDK (BSD 3-Clause).

---

## Quick Start

```bash
# 1. Install
curl -sL https://raw.githubusercontent.com/stansz/agent-hive/main/install.sh | bash
cd agent-hive

# 2. Generate an API token
openssl rand -hex 32
# Copy the output — you'll need it below

# 3. Edit .env — paste your API token and add LLM provider keys
nano .env
# API_TOKEN=<paste-token-here>
# DEEPSEEK_API_KEY=sk-...  (or OPENROUTER_API_KEY, or ZAI_CODE, etc.)

# 4. Start the server
node dist/index.js
```

### Web UI

Once the server is running, open your browser:

| URL | What it is |
|-----|------------|
| `http://localhost:8080/` | Landing page — API docs, setup guide |
| `http://localhost:8080/ui/` | Chat interface — send tasks, check results |

The web UI uses the same `API_TOKEN` from your `.env`. No separate frontend needed.

### Or Use MCP

Connect any MCP-compatible client (Claude Code, Cursor, OpenClaw):

```bash
export HIVE_URL=http://localhost:8080
export HIVE_TOKEN=your-api-token
npx github:stansz/hive-mcp
```

See [stansz/hive-mcp](https://github.com/stansz/hive-mcp) for full setup.

---

## What It Does

Agent Hive runs coding LLMs on your own infrastructure. No data leaves your VPS. It can:

- **Read, write, edit code** in any repo it can clone
- **Push changes** back to GitHub via SSH deploy keys
- **Run review cycles** — auto-review its own work with a different model
- **Work with any repo** — private or public, one deploy key per repo

## How It Works

```
HTTP client ──→ Agent Hive ──→ pi.dev SDK ──→ LLM API
                    │
                    └── clones repo → works → pushes changes
```

1. Send a task via API: "Review and improve trails/regroup.py"
2. Hive clones the repo into an ephemeral workspace
3. The LLM reads `AGENTS.md` (auto-discovered), explores the code, makes changes, and pushes
4. Optionally runs a self-review cycle with a second model
5. Session data is cleaned up — nothing persists

## API

All endpoints except `/health` require `Authorization: Bearer <token>`.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check (no auth) |
| POST | `/prompt` | Start a coding task |
| GET | `/status/:id` | Session state |
| GET | `/messages/:id` | Session messages |
| POST | `/abort/:id` | Cancel running session |
| DELETE | `/session/:id` | Destroy session |
| POST | `/snippet` | Quick code task (no repo) |
| WS | `/events/:id` | Streaming events |

### Start a Task

```bash
curl -X POST http://localhost:8080/prompt \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Review and improve the parser module",
    "repo": "https://github.com/owner/repo.git",
    "provider": "deepseek",
    "model": "deepseek-v4-pro",
    "reviewCycles": 1
  }'
```

Request fields:

| Field | Required | Description |
|-------|----------|-------------|
| `prompt` | yes | Task description |
| `repo` | no | Git repo URL (HTTPS — auto-converted to SSH for deploy key auth) |
| `provider` | no | LLM provider |
| `model` | no | Model ID |
| `reviewCycles` | no | Auto-review rounds (default 0) |
| `reviewModel` | no | Different model for review cycles |
| `branch` | no | Branch to clone |

### Check Status

```bash
curl http://localhost:8080/status/{sessionId} \
  -H "Authorization: Bearer $API_TOKEN"
```

### Streaming Events

Connect to the WebSocket endpoint for real-time streaming:

```
ws://localhost:8080/events/{sessionId}
```

## AGENTS.md Auto-Discovery

Place an `AGENTS.md` in your repo root with project context — Hive reads it automatically.

The session is created with `cwd` pointing to the cloned repo, so [pi.dev](https://pi.dev)'s built-in `AGENTS.md` discovery kicks in. No prompt hacks needed. The prompt also includes "Read AGENTS.md for project context" as a fallback.

## Configuration

Your API token and LLM provider keys go in the `.env` file:

```bash
# Generate a token (any secure random string works)
openssl rand -hex 32
```

| Variable | Default | Description |
|----------|---------|-------------|
| `API_TOKEN` | (required) | Bearer token for all API calls |
| `PORT` | `8080` | Server port |
| `MAX_CONCURRENT_SESSIONS` | `3` | Max parallel sessions |
| `SESSION_IDLE_TIMEOUT_MS` | `1800000` | 30 min idle timeout |
| `DEFAULT_PROVIDER` | `anthropic` | Default LLM provider |
| `DEFAULT_MODEL` | `claude-sonnet-4-20250514` | Default model |
| `DEEPSEEK_API_KEY` | | Direct DeepSeek access |
| `OPENROUTER_API_KEY` | | OpenRouter gateway |
| `PI_TELEMETRY` | `0` | Disable pi telemetry |
| `WORKSPACE` | `/tmp/hive-workspace` | Repo clone directory |

## Deployment

### Quick (install script)

```bash
curl -sL https://raw.githubusercontent.com/stansz/agent-hive/main/install.sh | bash
cd agent-hive
# Edit .env
node dist/index.js
```

### Manual

```bash
git clone https://github.com/stansz/agent-hive.git
cd agent-hive
cp .env.example .env
# Edit .env
npm install --omit=dev
npm run build
node dist/index.js
```

### Systemd

```ini
[Unit]
Description=Agent Hive API Server
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/home/youruser/agent-hive
ExecStart=/usr/bin/node /home/youruser/agent-hive/dist/index.js
Restart=always
RestartSec=5
EnvironmentFile=/home/youruser/agent-hive/.env

[Install]
WantedBy=multi-user.target
```

## SSH Deploy Keys (for private repos)

Hive uses SSH deploy keys to authenticate with private repos — one key per repo.

**To add a repo:**
1. Generate an ed25519 key on the server
2. Add the public key as a deploy key via GitHub API
3. Add the key to your SSH config

The server automatically converts HTTPS repo URLs to SSH URLs for deploy key auth.

## License

BSD 3-Clause
