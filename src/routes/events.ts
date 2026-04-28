import type { FastifyInstance } from "fastify";
import { getSession, touchIdleTimer } from "../sessions/manager.js";

export default async function eventsRoute(app: FastifyInstance) {
  app.get(
    "/events/:sessionId",
    { websocket: true },
    (socket, req) => {
      // Auth: check token from query param (WebSocket can't send headers)
      const token =
        (req.query as Record<string, string>).token;
      const apiToken = process.env.API_TOKEN;
      if (token !== apiToken) {
        socket.close(4001, "Unauthorized");
        return;
      }

      const { sessionId } = (req.params || {}) as { sessionId: string };
      const managed = getSession(sessionId);

      if (!managed) {
        socket.close(4004, "Session not found");
        return;
      }

      touchIdleTimer(sessionId);

      const unsubscribe = managed.session.subscribe((event: any) => {
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
