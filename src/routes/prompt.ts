import type { FastifyInstance } from "fastify";
import { createManagedSession, getSession } from "../sessions/manager.js";

export default async function promptRoute(app: FastifyInstance) {
  app.post("/prompt", async (req, reply) => {
    const body = req.body as {
      prompt?: string;
      sessionId?: string;
      provider?: string;
      model?: string;
      thinkingLevel?: string;
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

    // Start prompt (non-blocking)
    agentSession.prompt(body.prompt).catch((err: Error) => {
      app.log.error({ err: err.message }, "Session prompt error");
    });

    return {
      sessionId: agentSession.sessionId,
      status: "running",
    };
  });
}
