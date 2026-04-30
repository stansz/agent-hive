# Agent Hive

Self-hosted coding agent server. One VPS, one API, any orchestrator.

Powered by [pi.dev](https://pi.dev) SDK (BSD 3-Clause).

## Quick Start

```bash
cp .env.example .env
# Edit .env — set API_TOKEN and at least one LLM provider key
npm install
npm run build
npm start
```

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

### POST /prompt

Run a task with optional repo cloning and review cycles.

```json
{
  "prompt": "Review and improve the parser",
  "repo": "https://github.com/owner/repo.git",
  "provider": "deepseek",
  "model": "deepseek-v4-pro",
  "reviewCycles": 1,
  "reviewModel": "deepseek-v4-flash"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `prompt` | yes | Task description |
| `repo` | no | Git repo URL (HTTPS — converted to SSH for auth) |
| `branch` | no | Branch to clone |
| `provider` | no | LLM provider |
| `model` | no | Model ID |
| `reviewCycles` | no | Auto-review rounds (default 0) |
| `reviewModel` | no | Different model for review (cheaper/faster) |
| `sessionId` | no | Resume existing session |
| `systemPromptOverride` | no | Custom system prompt |

### AGENTS.md Auto-Discovery

Agent Hive uses the [pi.dev](https://pi.dev) SDK, which natively discovers `AGENTS.md` files in the working directory. Place an `AGENTS.md` in your repo root with project context — the agent reads it automatically. No prompt hacks needed.

## Configuration

See `.env.example` for all options.

| Variable | Default | Description |
|----------|---------|-------------|
| `API_TOKEN` | (required) | Bearer token for API auth |
| `PORT` | `8080` | Server port |
| `MAX_CONCURRENT_SESSIONS` | `3` | Max parallel sessions |
| `SESSION_IDLE_TIMEOUT_MS` | `1800000` | 30 min idle timeout |
| `DEFAULT_PROVIDER` | `anthropic` | Default LLM provider |
| `DEFAULT_MODEL` | `claude-sonnet-4-20250514` | Default model |
| `DEEPSEEK_API_KEY` | | Direct DeepSeek access |
| `OPENROUTER_API_KEY` | | OpenRouter gateway |
| `PI_TELEMETRY` | `0` | Disable pi telemetry |
| `WORKSPACE` | `/tmp/hive-workspace` | Repo clone directory |

## MCP Client

Connect any MCP-compatible client (Claude Code, Cursor, OpenClaw, etc.):

```bash
npx github:stansz/hive-mcp
```

See [stansz/hive-mcp](https://github.com/stansz/hive-mcp) for setup details.

## SSH Deploy Key Pattern

Agent Hive uses SSH deploy keys to authenticate with private repos. One key per repo.

**To add a repo:**
1. Generate an ed25519 key on the VPS
2. Add the public key as a deploy key via `gh api repos/{owner}/{repo}/keys`
3. Add the key to the VPS SSH config

The server automatically converts HTTPS repo URLs to SSH URLs for deploy key auth.

## License

BSD 3-Clause

## Web UI

Agent Hive includes a built-in web UI at the root URL:

- **Landing page** (`/`) — public docs, API reference, setup guide
- **App** (`/ui/`) — chat interface and GitHub panel (requires API_TOKEN)

No separate frontend server needed — served directly by Hive's Fastify server.
