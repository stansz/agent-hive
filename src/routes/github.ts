import type { FastifyInstance } from "fastify";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve, basename } from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";

const execFileAsync = promisify(execFile);

const WORKSPACE = resolve(process.env.WORKSPACE || "/tmp/hive-workspace");
const GH_BIN = process.env.GH_BIN || "gh";

// Ensure workspace exists
import { mkdirSync } from "node:fs";
mkdirSync(WORKSPACE, { recursive: true });

function gh(args: string[], cwd?: string) {
  return execFileAsync(GH_BIN, args, {
    cwd,
    env: {
      ...process.env,
      GH_PROMPT_DISABLED: "1",
      GH_TUI_INVALID_TELEMETRY: "0",
    },
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
}

// Sanitize repo name to prevent path traversal
function safeName(name: string): string {
  const base = basename(name);
  if (base !== name || base.includes("..") || base.includes("/")) {
    throw new Error(`Invalid name: ${name}`);
  }
  return base;
}

// Sanitize path relative to workspace
function safePath(p: string): string {
  const resolved = resolve(WORKSPACE, p);
  if (!resolved.startsWith(WORKSPACE)) {
    throw new Error("Path traversal blocked");
  }
  return resolved;
}

export default async function githubRoute(app: FastifyInstance) {
  // List repos for the authenticated user
  app.get("/api/github/repos", async (_req, reply) => {
    try {
      const { stdout } = await gh([
        "repo",
        "list",
        "--limit",
        "50",
        "--json",
        "name,owner,description,url,defaultBranchRef,visibility,isArchived",
      ]);
      return JSON.parse(stdout);
    } catch (err: any) {
      app.log.error({ err: err.message }, "Failed to list repos");
      return reply.code(500).send({ error: err.message });
    }
  });

  // Clone a repo
  app.post("/api/github/clone", async (req, reply) => {
    const body = req.body as { repo?: string; branch?: string };
    if (!body.repo) return reply.code(400).send({ error: "repo is required" });

    const repoName = safeName(body.repo);
    const targetDir = join(WORKSPACE, repoName);

    if (existsSync(targetDir)) {
      return reply
        .code(409)
        .send({ error: "Repo already cloned. Use pull instead." });
    }

    try {
      const args = ["repo", "clone", body.repo, targetDir];
      if (body.branch) args.splice(2, 0, "--branch", body.branch);
      await gh(args);
      return { cloned: true, path: repoName };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // Pull latest changes
  app.post("/api/github/pull", async (req, reply) => {
    const body = req.body as { repo?: string };
    if (!body.repo) return reply.code(400).send({ error: "repo is required" });

    const repoName = safeName(body.repo);
    const targetDir = safePath(repoName);

    if (!existsSync(targetDir)) {
      return reply.code(404).send({ error: "Repo not found. Clone first." });
    }

    try {
      await gh(["repo", "sync", "--force"], targetDir);
      return { pulled: true, path: repoName };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // Create branch
  app.post("/api/github/branch", async (req, reply) => {
    const body = req.body as { repo?: string; branch?: string };
    if (!body.repo || !body.branch)
      return reply.code(400).send({ error: "repo and branch are required" });

    const repoName = safeName(body.repo);
    const targetDir = safePath(repoName);

    if (!existsSync(targetDir)) {
      return reply.code(404).send({ error: "Repo not found. Clone first." });
    }

    try {
      await gh(["repo", "set-default-branch", body.branch], targetDir);
      await execFileAsync("git", ["checkout", "-b", body.branch], {
        cwd: targetDir,
        timeout: 10000,
      });
      return { branch: body.branch, path: repoName };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // Push changes
  app.post("/api/github/push", async (req, reply) => {
    const body = req.body as { repo?: string; message?: string };
    if (!body.repo)
      return reply.code(400).send({ error: "repo is required" });

    const repoName = safeName(body.repo);
    const targetDir = safePath(repoName);

    if (!existsSync(targetDir)) {
      return reply.code(404).send({ error: "Repo not found. Clone first." });
    }

    try {
      // Stage all, commit, push
      await execFileAsync("git", ["add", "-A"], {
        cwd: targetDir,
        timeout: 10000,
      });
      await execFileAsync(
        "git",
        ["commit", "-m", body.message || "Update from Hive UI", "--allow-empty"],
        { cwd: targetDir, timeout: 10000 }
      );
      const { stdout } = await execFileAsync("git", ["push", "origin", "HEAD"], {
        cwd: targetDir,
        timeout: 30000,
      });
      return { pushed: true, path: repoName, output: stdout.trim() };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // List files in a cloned repo
  app.get("/api/github/files/:repo", async (req, reply) => {
    const { repo } = req.params as { repo: string };
    const { path: subPath = "" } = req.query as { path?: string };

    try {
      const repoName = safeName(repo);
      const targetDir = safePath(join(repoName, subPath || ""));

      if (!existsSync(targetDir) || !statSync(targetDir).isDirectory()) {
        return reply.code(404).send({ error: "Directory not found" });
      }

      const entries = readdirSync(targetDir, { withFileTypes: true });
      return {
        path: subPath || "",
        files: entries
          .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
          .map((e) => ({
            name: e.name,
            type: e.isDirectory() ? "dir" : "file",
            size: e.isFile() ? statSync(join(targetDir, e.name)).size : 0,
          }))
          .sort((a, b) => {
            if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
            return a.name.localeCompare(b.name);
          }),
      };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // Read a file from a cloned repo
  app.get("/api/github/file/:repo", async (req, reply) => {
    const { repo } = req.params as { repo: string };
    const { path: filePath } = req.query as { path?: string };

    if (!filePath) return reply.code(400).send({ error: "path is required" });

    try {
      const repoName = safeName(repo);
      const fullPath = safePath(join(repoName, filePath));

      if (!existsSync(fullPath) || statSync(fullPath).isDirectory()) {
        return reply.code(404).send({ error: "File not found" });
      }

      const { readFileSync } = await import("node:fs");
      const content = readFileSync(fullPath, "utf-8");
      const MAX_SIZE = 100_000;
      if (content.length > MAX_SIZE) {
        return {
          content: content.slice(0, MAX_SIZE),
          truncated: true,
          totalSize: content.length,
        };
      }
      return { content };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // List current git status for a repo
  app.get("/api/github/status/:repo", async (req, reply) => {
    const { repo } = req.params as { repo: string };

    try {
      const repoName = safeName(repo);
      const targetDir = safePath(repoName);

      if (!existsSync(targetDir)) {
        return reply.code(404).send({ error: "Repo not found. Clone first." });
      }

      const { stdout: branch } = await execFileAsync(
        "git",
        ["branch", "--show-current"],
        { cwd: targetDir, timeout: 5000 }
      );
      const { stdout: status } = await execFileAsync(
        "git",
        ["status", "--short"],
        { cwd: targetDir, timeout: 5000 }
      );
      const { stdout: log } = await execFileAsync(
        "git",
        ["log", "--oneline", "-5"],
        { cwd: targetDir, timeout: 5000 }
      );

      return { branch: branch.trim(), status: status.trim(), recentCommits: log.trim().split("\n") };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });
}
