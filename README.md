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

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check (no auth) |
| POST | `/prompt` | Start a task |
| GET | `/status/:id` | Session state |
| POST | `/abort/:id` | Cancel operation |
| DELETE | `/session/:id` | Destroy session |
| POST | `/snippet` | Quick code work (no repo) |
| WS | `/events/:id` | Streaming events |

### Auth

All endpoints except `/health` require `Authorization: Bearer <token>`.

### Example

```bash
# Start a task
curl -X POST http://localhost:8080/prompt \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Write a hello world in Python"}'

# Check status
curl http://localhost:8080/status/<sessionId> \
  -H "Authorization: Bearer $API_TOKEN"
```

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
| `PI_TELEMETRY` | `0` | Disable pi telemetry |

## GitHub Deploy Key Setup

Agent Hive uses SSH deploy keys to clone repos and push code. One key per repo, no PATs needed.

### Adding a New Repo

1. **Generate key on VPS:**
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/{name}_deploy -N '' -C '{name}-deploy-key'
   ```

2. **Add to GitHub repo (from any machine with `gh` CLI + write access):**
   ```bash
   gh api repos/{owner}/{repo}/keys \
     -f title="Hive VPS Deploy Key" \
     -f key="$(cat ~/.ssh/{name}_deploy.pub)" \
     -f read_only=false
   ```

3. **Update VPS SSH config** (`~/.ssh/config`):
   ```
   Host github.com
     HostName github.com
     User git
     IdentityFile ~/.ssh/{name}_deploy
     IdentitiesOnly no
   ```

4. **Test:**
   ```bash
   git clone git@github.com:{owner}/{repo}.git /tmp/test && rm -rf /tmp/test
   ```

### Current Keys

| Repo | Key | 
|------|-----|
| `stansz/agent-hive` | `~/.ssh/agent_hive_deploy` |
| `stansz/geo-scripts` | `~/.ssh/geo_scripts_deploy` |

## License

BSD 3-Clause
