# Agent Hive — AGENTS.md

## What This Is

Self-hosted coding agent server. Clones GitHub repos, runs LLM tasks, pushes changes back. Accessible via REST API and MCP tools.

## Two-Account GitHub Model

Hive uses **two GitHub identities** for isolation and least-privilege:

| Account | Role | Auth Method | Scope |
|---------|------|-------------|-------|
| **stansz** | Repo owner (Sz's account) | SSH deploy keys (per-repo) | Only repos with keys installed |
| **oatclaw88** | Hive's bot account | `gh` CLI OAuth token | Forks, PRs, API queries |

**Why two accounts?** Hive runs on a $2 VPS. If it gets compromised, the attacker only gets oatclaw88 (fork perms) and per-repo deploy keys — not full access to Sz's GitHub.

### Flow 1: Your Repos (stansz/*)

```
Hive prompt with repo=stansz/geo-scripts
  → git clone via SSH (deploy key: geo_scripts_deploy)
  → LLM works in cloned dir
  → git add -A && commit && push (author: oatclaw88, push via deploy key)
```

Deploy keys are installed on the **stansz** repo (Settings → Deploy Keys → Allow write access). Hive commits as oatclaw88 but pushes directly to stansz/repo because the deploy key has write access.

### Flow 2: External Repos (third-party/*)

```
Hive prompt with repo=someorg/somerepo
  → Fork into oatclaw88 via gh repo fork
  → Clone the fork via gh repo clone oatclaw88/somerepo
  → LLM works in cloned dir
  → Push to oatclaw88 fork
  → (Phase 2: open PR from oatclaw88 → someorg/somerepo)
```

## SSH Deploy Keys

One ed25519 key per repo. All stored in `~/.ssh/` on the Hive VPS.

| Key | Installed On | Access |
|-----|-------------|--------|
| `agent_hive_deploy` | stansz/agent-hive | read/write |
| `geo_scripts_deploy` | stansz/geo-scripts | read/write |

### SSH Config (`~/.ssh/config`)

```
Host github.com
  HostName github.com
  User git
  IdentityFile ~/.ssh/agent_hive_deploy
  IdentityFile ~/.ssh/geo_scripts_deploy
  IdentitiesOnly no
```

`IdentitiesOnly no` means SSH tries all keys against all repos. GitHub accepts whichever key matches. If no deploy key matches, the `gh` CLI auth (oatclaw88) handles it.

### Adding a New Repo

1. **Generate key on VPS:**
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/<repo>_deploy -N ""
   ```

2. **Add deploy key to stansz repo (from your local machine):**
   ```bash
   gh repo deploy-key add - --repo stansz/<repo> --title hive-$(date +%Y%m%d) --allow-write < ~/.ssh/<repo>_deploy.pub
   ```
   Or via GitHub web: repo Settings → Deploy keys → Add new → paste public key → check "Allow write access"

3. **Add to SSH config on VPS:**
   Append `IdentityFile ~/.ssh/<repo>_deploy` to the existing `Host github.com` block.

4. **Test:**
   ```bash
   ssh -T git@github.com 2>&1  # Should show stansz or oatclaw88
   git clone git@github.com:stansz/<repo>.git /tmp/test-clone
   ```

## Git Author

All commits from Hive are authored as:
- **Name:** oatclaw88
- **Email:** oatclaw88@users.noreply.github.com

Set in prompt.ts after cloning. If you want commits to show as stansz for your own repos, update the git config lines in `src/routes/prompt.ts`.

## gh CLI Auth

```bash
gh auth status
# → Logged in as oatclaw88
# → Git operations protocol: https
# → Token: ghp_...
```

Used for: `gh repo fork`, `gh repo clone`, `gh repo list`, `gh search repos`, and the Web UI repo browser.

The token has repo scope — oatclaw88 can fork any public repo and push to its own forks.

## Environment Variables

Key ones in `/home/jc/agent-hive/.env`:

| Variable | Purpose |
|----------|---------|
| `API_TOKEN` | Bearer auth for Hive API |
| `GITHUB_TOKEN` | oatclaw88's gh CLI token |
| `DEFAULT_PROVIDER` | LLM provider (openrouter/deepseek/zai) |
| `DEFAULT_MODEL` | Default LLM model |
| `DEEPSEEK_API_KEY` | DeepSeek direct access |
| `OPENROUTER_API_KEY` | OpenRouter gateway |
| `ZAI_CODE` | Z.AI coding endpoint |

## API Quick Reference

### Core Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (no auth) |
| POST | `/prompt` | Start a coding task |
| GET | `/status/:id` | Check session state |
| POST | `/abort/:id` | Cancel session |
| POST | `/snippet` | Quick code task, no repo |
| WS | `/events/:id` | Streaming events |

### GitHub Endpoints (via `gh` CLI)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/github/repos` | List oatclaw88 repos |
| POST | `/api/github/clone` | Clone repo to workspace |
| POST | `/api/github/pull` | Pull latest |
| POST | `/api/github/branch` | Create branch |
| POST | `/api/github/push` | Stage, commit, push |
| POST | `/api/github/fork` | Fork → clone (oatclaw88) |
| GET | `/api/github/files/:repo` | Browse files |
| GET | `/api/github/file/:repo` | Read file contents |
| GET | `/api/github/status/:repo` | Git status + recent commits |
| GET | `/api/github/search` | Search public repos |

## AGENTS.md Auto-Discovery (for your repos)

Hive automatically reads `AGENTS.md` from any repo it clones. If you want Hive to understand your project before it starts coding, add an `AGENTS.md` to your repo root with:

- **Project overview** — what it does, why it exists
- **Tech stack** — language, framework, key dependencies
- **Directory structure** — where things live
- **Conventions** — coding style, naming patterns, preferred approaches
- **Build/test/lint commands** — so the LLM can verify its work
- **Gotchas** — non-obvious design decisions, known issues, things not to touch

How it works: Hive sets `cwd` to the cloned repo, so pi.dev's built-in AGENTS.md discovery loads it automatically. The prompt also includes "Read AGENTS.md for project context" as a fallback. No configuration needed — just put the file there.

---

## VPS Details

- **IP:** 23.95.36.186
- **OS:** Debian 13 (trixie)
- **Node:** v22.22.2
- **Specs:** 1 core, 3GB RAM, 30GB disk
- **Services:** agent-hive (systemd), cloudflared (CF Tunnel)
- **Domain:** hive.ogsapps.cc → localhost:8080 via Cloudflare Tunnel
- **Firewall:** UFW, SSH only (no public API ports)