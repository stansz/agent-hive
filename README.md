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

## License

BSD 3-Clause
