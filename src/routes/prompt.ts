import type { FastifyInstance } from "fastify";
import { createManagedSession, getSession } from "../sessions/manager.js";
import { autoThinkLevel } from "../utils/auto-router.js";

const REVIEW_PROMPT = `Review the changes you just made:

1. Check for syntax errors, broken imports, or unused variables
2. Run any available tests (npm test, pytest, go test, etc.)
3. Fix any issues you find
4. If everything looks good, say "LGTM" and nothing else

Do NOT make unnecessary changes. Only fix actual problems.`;

const DEFAULT_SYSTEM_PROMPT =
  process.env.HIVE_SYSTEM_PROMPT ||
  `You are a senior software developer. Be direct and concise, show code, skip filler. Don't gold-plate, but don't leave it half-done. Be thorough: check multiple locations, consider naming conventions. Flag risks, don't over-explain the obvious. If unsure, say so. Prefer established patterns.`;

function buildFullPrompt(prompt: string): string {
  return `${DEFAULT_SYSTEM_PROMPT}\n\n${prompt}`;
}

export default async function promptRoute(app: FastifyInstance) {
  app.post("/prompt", async (req, reply) => {
    const body = req.body as {
      prompt?: string;
      sessionId?: string;
      provider?: string;
      model?: string;
      thinkingLevel?: string;
      autoReview?: boolean;
      autoPR?: boolean;
      baseBranch?: string;
      systemPromptOverride?: string;
    };

    if (!body.prompt) {
      return reply.code(400).send({ error: "prompt is required" });
    }

    // Use systemPromptOverride if provided, otherwise use default
    const systemPrompt = body.systemPromptOverride || DEFAULT_SYSTEM_PROMPT;

    // Resume existing session or create new
    let agentSession = body.sessionId
      ? getSession(body.sessionId)?.session
      : undefined;

    if (body.sessionId && !agentSession) {
      return reply.code(404).send({ error: "Session not found" });
    }

    if (!agentSession) {
      try {
        const thinkingLevel = body.thinkingLevel || autoThinkLevel(body.prompt!);
        agentSession = await createManagedSession({
          provider: body.provider,
          model: body.model,
          thinkingLevel,
        });
      } catch (err: any) {
        return reply.code(503).send({ error: err.message });
      }
    }

    const sessionId = agentSession.sessionId;

    // Build full prompt with system instructions prepended
    const fullPrompt = buildFullPrompt(body.prompt);

    // Run prompt, then optional review + PR pipeline
    runPipeline(agentSession, { ...body, prompt: fullPrompt }).catch((err: Error) => {
      app.log.error({ err: err.message, sessionId }, "Pipeline error");
    });

    return {
      sessionId,
      status: "running",
      thinkingLevel: body.thinkingLevel || autoThinkLevel(body.prompt!),
    };
  });

  // Enhanced endpoint: prompt + auto-commit + PR in one shot
  app.post("/prompt/pr", async (req, reply) => {
    const body = req.body as {
      prompt?: string;
      provider?: string;
      model?: string;
      thinkingLevel?: string;
      autoReview?: boolean;
      repo?: string;
      branch?: string;
      baseBranch?: string;
      prTitle?: string;
      systemPromptOverride?: string;
    };

    if (!body.prompt) {
      return reply.code(400).send({ error: "prompt is required" });
    }

    const thinkingLevel = body.thinkingLevel || autoThinkLevel(body.prompt!);

    try {
      const agentSession = await createManagedSession({
        provider: body.provider,
        model: body.model,
        thinkingLevel,
      });

      const sessionId = agentSession.sessionId;

      // Build full prompt with system instructions
      const systemPrompt = body.systemPromptOverride || DEFAULT_SYSTEM_PROMPT;
      const fullPrompt = `${systemPrompt}\n\n${body.prompt}`;

      // Full pipeline: prompt → review → commit → PR
      runPipeline(agentSession, { ...body, prompt: fullPrompt, autoPR: true }).catch((err: Error) => {
        app.log.error({ err: err.message, sessionId }, "PR pipeline error");
      });

      return {
        sessionId,
        status: "running",
        pipeline: ["prompt", body.autoReview ? "review" : null, "commit", "pr"].filter(Boolean),
        thinkingLevel,
      };
    } catch (err: any) {
      return reply.code(503).send({ error: err.message });
    }
  });

  // Endpoint to get the current system prompt
  app.get("/system-prompt", async (_req, reply) => {
    return { systemPrompt: DEFAULT_SYSTEM_PROMPT };
  });
}

async function runPipeline(
  session: any,
  opts: {
    prompt: string;
    autoReview?: boolean;
    autoPR?: boolean;
    baseBranch?: string;
    repo?: string;
    branch?: string;
    prTitle?: string;
  }
) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execAsync = promisify(execFile);

  // Step 1: Main prompt
  await session.prompt(opts.prompt);

  // Step 2: Optional self-review (opt-in)
  if (opts.autoReview === true) {
    await session.prompt(REVIEW_PROMPT);
  }

  // Step 3: Optional auto-commit + PR
  if (opts.autoPR) {
    await autoCommitAndPR(session, opts, execAsync);
  }
}

async function autoCommitAndPR(
  session: any,
  opts: {
    repo?: string;
    branch?: string;
    baseBranch?: string;
    prTitle?: string;
  },
  execAsync: (cmd: string, args: string[], opts: any) => Promise<{ stdout: string; stderr: string }>
) {
  const { resolve, basename } = await import("node:path");
  const { existsSync } = await import("node:fs");

  const cwd = process.cwd();

  try {
    const { stdout: branch } = await execAsync("git", ["branch", "--show-current"], { cwd, timeout: 5000 });
    const currentBranch = branch.trim();

    await execAsync("git", ["add", "-A"], { cwd, timeout: 10000 });

    const { stdout: status } = await execAsync("git", ["status", "--short"], { cwd, timeout: 5000 });
    if (!status.trim()) {
      console.log(`[autoPR] No changes to commit for session ${session.sessionId}`);
      return;
    }

    const messages = session.messages || [];
    const lastAssistant = [...messages].reverse().find((m: any) => m.role === "assistant" && m.content);
    const commitMsg = opts.prTitle || lastAssistant
      ? lastAssistant.content.slice(0, 200).split("\n")[0]
      : "Update from Agent Hive";

    await execAsync("git", ["commit", "-m", commitMsg], { cwd, timeout: 10000 });
    await execAsync("git", ["push", "origin", "HEAD", "--force-with-lease"], { cwd, timeout: 30000 });

    const baseBranch = opts.baseBranch || "main";
    if (currentBranch && currentBranch !== baseBranch) {
      try {
        const { stdout: prOut } = await execAsync(
          "gh",
          ["pr", "create", "--title", commitMsg, "--body", `Automated PR from Agent Hive\n\nSession: ${session.sessionId}`, "--base", baseBranch, "--head", currentBranch],
          { cwd, timeout: 15000 }
        );
        console.log(`[autoPR] PR created: ${prOut.trim()}`);
      } catch (err: any) {
        console.error(`[autoPR] PR creation failed: ${err.message}`);
      }
    }

    console.log(`[autoPR] Committed and pushed: ${commitMsg}`);
  } catch (err: any) {
    console.error(`[autoPR] Error: ${err.message}`);
  }
}
