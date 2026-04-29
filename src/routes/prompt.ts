import type { FastifyInstance } from "fastify";
import { createManagedSession, getSession } from "../sessions/manager.js";

const DEFAULT_SYSTEM_PROMPT =
  process.env.HIVE_SYSTEM_PROMPT ||
  `You are a senior software developer. Be direct and concise, show code, skip filler. Don't gold-plate, but don't leave it half-done. Be thorough: check multiple locations, consider naming conventions. Flag risks, don't over-explain the obvious. If unsure, say so. Prefer established patterns.`;

export default async function promptRoute(app: FastifyInstance) {
  app.post("/prompt", async (req, reply) => {
    const body = req.body as {
      prompt?: string;
      sessionId?: string;
      provider?: string;
      model?: string;
      thinkingLevel?: string;
      systemPromptOverride?: string;
    };

    if (!body.prompt) {
      return reply.code(400).send({ error: "prompt is required" });
    }

    // Resume existing session or create new
    let agentSession = body.sessionId
      ? getSession(body.sessionId)?.session
      : undefined;

    if (body.sessionId && !agentSession) {
      return reply.code(404).send({ error: "Session not found" });
    }

    if (!agentSession) {
      try {
        agentSession = await createManagedSession({
          provider: body.provider,
          model: body.model,
          thinkingLevel: body.thinkingLevel,
        });
      } catch (err: any) {
        return reply.code(503).send({ error: err.message });
      }
    }

    const sessionId = agentSession.sessionId;

    // Build full prompt with system instructions prepended
    const systemPrompt = body.systemPromptOverride || DEFAULT_SYSTEM_PROMPT;
    const fullPrompt = `${systemPrompt}\n\n${body.prompt}`;

    // Run prompt (fire-and-forget, events stream via WebSocket)
    agentSession.prompt(fullPrompt).catch((err: Error) => {
      app.log.error({ err: err.message, sessionId }, "Prompt error");
    });

    return {
      sessionId,
      status: "running",
    };
  });

  // Endpoint to get the current system prompt
  app.get("/system-prompt", async (_req, reply) => {
    return { systemPrompt: DEFAULT_SYSTEM_PROMPT };
  });
}
