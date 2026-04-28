import type { FastifyInstance } from "fastify";
import { getSession, destroySession } from "../sessions/manager.js";

export default async function abortRoute(app: FastifyInstance) {
  app.post("/abort/:sessionId", async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    const managed = getSession(sessionId);

    if (!managed) {
      return reply.code(404).send({ error: "Session not found" });
    }

    await managed.session.abort();
    return { sessionId: managed.sessionId, status: "aborted" };
  });

  app.delete("/session/:sessionId", async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    const managed = getSession(sessionId);

    if (!managed) {
      return reply.code(404).send({ error: "Session not found" });
    }

    await managed.session.abort();
    destroySession(sessionId);
    return { sessionId, status: "destroyed" };
  });
}
