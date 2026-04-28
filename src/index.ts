import Fastify from "fastify";
import fWebSocket from "@fastify/websocket";
import dotenv from "dotenv";
import promptRoute from "./routes/prompt.js";
import statusRoute from "./routes/status.js";
import abortRoute from "./routes/abort.js";
import snippetRoute from "./routes/snippet.js";
import eventsRoute from "./routes/events.js";

dotenv.config();

const API_TOKEN = process.env.API_TOKEN;
if (!API_TOKEN) {
  console.error("FATAL: API_TOKEN not set in .env");
  process.exit(1);
}

const PORT = parseInt(process.env.PORT || "8080", 10);

const app = Fastify({ logger: true });

// Auth middleware — skip /health
app.addHook("onRequest", async (req, reply) => {
  if (req.url === "/health") return;
  const token =
    req.headers.authorization?.replace("Bearer ", "") ||
    (req.query as Record<string, string>).token;
  if (token !== API_TOKEN) {
    reply.code(401).send({ error: "Unauthorized" });
  }
});

await app.register(fWebSocket);

app.register(promptRoute);
app.register(statusRoute);
app.register(abortRoute);
app.register(snippetRoute);
app.register(eventsRoute);

app.get("/health", async () => ({
  status: "ok",
  uptime: Math.floor(process.uptime()),
  sessions: (await import("./sessions/manager.js")).getSessionCount(),
}));

try {
  await app.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`Agent Hive running on port ${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
