import type { FastifyInstance } from "fastify";
import { getSession, touchIdleTimer } from "../sessions/manager.js";

export default async function eventsRoute(app: FastifyInstance) {
  app.get(
    "/events/:sessionId",
    { websocket: true },
    (socket, req) => {
      const { sessionId } = (req.params || {}) as { sessionId: string };
      const managed = getSession(sessionId);

      if (!managed) {
        socket.close(4004, "Session not found");
        return;
      }

      touchIdleTimer(sessionId);

      const unsubscribe = managed.session.subscribe((event) => {
        if (socket.readyState === 1) {
          // OPEN
          try {
            socket.send(JSON.stringify(event));
          } catch {
            // Client disconnected
          }
        }
      });

      socket.on("close", () => {
        unsubscribe();
      });
    }
  );
}
