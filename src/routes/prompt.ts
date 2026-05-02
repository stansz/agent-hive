import type { FastifyInstance } from "fastify";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve, basename } from "node:path";
import { rmSync } from "node:fs";
import {
  createManagedSession,
  getSession,
  resolveProvider,
} from "../sessions/manager.js";
import { runCodeReview, runReviewLoop } from "../loops/review.js";

const execFileAsync = promisify(execFile);
const WORKSPACE = resolve(process.env.WORKSPACE || "/tmp/hive-workspace");

function safeName(name: string): string {
  const base = basename(name);
  if (base !== name || base.includes("..") || base.includes("/")) {
    throw new Error("Invalid name: " + name);
  }
  return base;
}

function toSshUrl(repoUrl: string): string {
  const match = repoUrl.match(/https?:\/\/github\.com\/([^/]+\/[^/]+)/);
  if (match) {
    let path = match[1];
    if (!path.endsWith(".git")) path += ".git";
    return "git@github.com:" + path;
  }
  return repoUrl;
}

const DEFAULT_SYSTEM_PROMPT =
  process.env.HIVE_SYSTEM_PROMPT ||
  "You are a senior software developer. Be direct and concise, show code, skip filler. Don't gold-plate, but don't leave it half-done. Be thorough: check multiple locations, consider naming conventions. Flag risks, don't over-explain the obvious. If unsure, say so. Prefer established patterns.";

export default async function promptRoute(app: FastifyInstance) {
  app.post("/prompt", async (req, reply) => {
    const body = req.body as {
      prompt?: string;
      sessionId?: string;
      provider?: string;
      model?: string;
      thinkingLevel?: string;
      systemPromptOverride?: string;
      repo?: string;
      branch?: string;
      reviewCycles?: number;
      reviewModel?: string;
      autoReview?: boolean;
    };

    const reviewCycles = typeof body.reviewCycles === "number" ? body.reviewCycles : 0;
    const reviewModel: string | undefined = body.reviewModel;

    if (!body.prompt) {
      return reply.code(400).send({ error: "prompt is required" });
    }

    let agentSession;
    let repoDir = "";
    let sessionId = "";
    let baseSha = "";

    // Resume existing session
    if (body.sessionId) {
      agentSession = getSession(body.sessionId)?.session;
      if (!agentSession) {
        return reply.code(404).send({ error: "Session not found" });
      }
    }

    if (body.repo && !body.sessionId) {
      // Clone repo first
      try {
        sessionId = crypto.randomUUID();
        const repoUrl = body.repo;
        const parts = repoUrl.replace(/\.git$/, "").split("/");
        const repoName = safeName(parts[parts.length - 1]);
        repoDir = join(WORKSPACE, sessionId, repoName);
        const sshUrl = toSshUrl(repoUrl);
        const cloneArgs = ["clone", "--depth", "1"];
        if (body.branch) cloneArgs.push("--branch", body.branch);
        cloneArgs.push(sshUrl, repoDir);
        await execFileAsync("git", cloneArgs, { timeout: 60000, maxBuffer: 1024 * 1024 });
        app.log.info({ sessionId, repo: sshUrl, path: repoDir }, "Repo cloned");

        // Configure git author
        await execFileAsync("git", ["config", "user.name", "oatclaw88"], { cwd: repoDir });
        await execFileAsync("git", ["config", "user.email", "oatclaw88@users.noreply.github.com"], { cwd: repoDir });

        // Capture pre-task SHA for diff-based code review
        try {
          const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
            cwd: repoDir,
            timeout: 5000,
          });
          baseSha = stdout.trim();
          app.log.info({ sessionId, baseSha }, "Captured pre-task SHA");
        } catch {
          // Fresh repo with no commits — baseSha stays empty, review will diff against empty tree
          app.log.info({ sessionId }, "No prior commits, review will diff against empty tree");
        }

        // Create session with cwd=repoDir so AGENTS.md is auto-discovered
        const managed = await createManagedSession({
          provider: body.provider,
          model: body.model,
          thinkingLevel: body.thinkingLevel,
          cwd: repoDir,
        });
        agentSession = managed.session;
        sessionId = managed.sessionId;
      } catch (err: any) {
        app.log.error({ err: err.message, sessionId }, "Clone or session creation failed");
        if (repoDir) {
          try { rmSync(join(WORKSPACE, sessionId), { recursive: true, force: true }); } catch {}
        }
        return reply.code(500).send({ error: "Failed to clone repo: " + err.message });
      }
    } else if (!body.sessionId) {
      // No repo, no existing session — create fresh
      try {
        const managed = await createManagedSession({
          provider: body.provider,
          model: body.model,
          thinkingLevel: body.thinkingLevel,
        });
        agentSession = managed.session;
        sessionId = managed.sessionId;
      } catch (err: any) {
        return reply.code(503).send({ error: err.message });
      }
    }

    if (!agentSession) {
      return reply.code(500).send({ error: "Failed to create session" });
    }

    const systemPrompt = body.systemPromptOverride || DEFAULT_SYSTEM_PROMPT;
    let promptPrefix = "";
    if (repoDir) {
      promptPrefix = "The repo is at " + repoDir + ". Read AGENTS.md for project context. Work in that directory. Read files, make changes, commit and push when done.\n\n";
    }
    const fullPrompt = systemPrompt + "\n\n" + promptPrefix + body.prompt;

    (async () => {
      let mainOutput = "";
      let unsubCollect: (() => void) | null = null;

      // For non-repo review (legacy text-based), collect output
      if (reviewCycles > 0 && !repoDir) {
        unsubCollect = agentSession.subscribe((event: any) => {
          if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
            mainOutput += event.assistantMessageEvent.delta;
          }
        });
      }

      try {
        await agentSession.prompt(fullPrompt);
      } catch (err: any) {
        app.log.error({ err: err.message, sessionId }, "Prompt error");
        return;
      } finally {
        unsubCollect?.();
      }

      // Auto-review
      if (reviewCycles > 0) {
        try {
          const provider = resolveProvider(body.provider);

          if (repoDir && baseSha) {
            // Proper code review: diff-based, fixes in repo
            const result = await runCodeReview(repoDir, baseSha, {
              cycles: reviewCycles,
              provider,
              reviewModel,
              mainModel: body.model,
            });
            app.log.info(
              { sessionId, reviewed: result.reviewed, issuesFound: result.issuesFound, diffSize: result.diffSize },
              "Code review complete (" + reviewCycles + " cycle" + (reviewCycles > 1 ? "s" : "") + ")"
            );
          } else if (repoDir && !baseSha) {
            // Repo but no prior commits — try diff against staged
            app.log.info({ sessionId }, "Skipping review: no base commit to diff against");
          } else {
            // Non-repo task: legacy text-based review
            const finalOutput = await runReviewLoop(mainOutput, {
              cycles: reviewCycles,
              provider,
              reviewModel,
              mainModel: body.model,
            });
            app.log.info({ sessionId, length: finalOutput.length }, "Text review complete");
          }
        } catch (err: any) {
          app.log.error({ err: err.message, sessionId }, "Review error");
        }
      }

      // Cleanup workspace
      if (repoDir) {
        try {
          rmSync(join(WORKSPACE, sessionId), { recursive: true, force: true });
          app.log.info({ sessionId }, "Workspace cleaned up");
        } catch {}
      }
    })();

    return { sessionId, status: "running", repoPath: repoDir || undefined };
  });

  app.get("/system-prompt", async (_req, reply) => {
    return { systemPrompt: DEFAULT_SYSTEM_PROMPT };
  });
}
