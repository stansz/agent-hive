import type { FastifyInstance } from "fastify";
import { getSession, touchIdleTimer } from "../sessions/manager.js";

export default async function statusRoute(app: FastifyInstance) {
  app.get("/status/:sessionId", async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    const managed = getSession(sessionId);

    if (!managed) {
      return reply.code(404).send({ error: "Session not found" });
    }

    return {
      sessionId: managed.sessionId,
      isStreaming: managed.session.isStreaming,
      messageCount: managed.session.messages.length,
      model: managed.session.model?.id,
      thinkingLevel: managed.thinkingLevel,
      createdAt: managed.createdAt,
      lastActivity: managed.lastActivity,
    };
  });
}
