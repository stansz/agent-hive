import Fastify from "fastify";
import fWebSocket from "@fastify/websocket";
import fStatic from "@fastify/static";
import dotenv from "dotenv";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import promptRoute from "./routes/prompt.js";
import statusRoute from "./routes/status.js";
import abortRoute from "./routes/abort.js";
import snippetRoute from "./routes/snippet.js";
import eventsRoute from "./routes/events.js";
import githubRoute from "./routes/github.js";

dotenv.config();

const API_TOKEN = process.env.API_TOKEN;
if (!API_TOKEN) {
  console.error("FATAL: API_TOKEN not set in .env");
  process.exit(1);
}

const PORT = parseInt(process.env.PORT || "8080", 10);

const app = Fastify({ logger: true });

// Auth middleware — skip /health and /ui (static files)
app.addHook("onRequest", async (req, reply) => {
  const skipPaths = ["/health", "/ui", "/ui/"];
  if (skipPaths.some((p) => req.url === p || req.url.startsWith("/ui/"))) return;
  // Skip static assets
  if (req.url.startsWith("/ui/assets/")) return;

  const token =
    req.headers.authorization?.replace("Bearer ", "") ||
    (req.query as Record<string, string>).token;
  if (token !== API_TOKEN) {
    reply.code(401).send({ error: "Unauthorized" });
  }
});

await app.register(fWebSocket);

// Serve static web UI
const __dirname = dirname(fileURLToPath(import.meta.url));
await app.register(fStatic, {
  root: join(__dirname, "..", "public"),
  prefix: "/ui",
  decorateReply: false,
});

app.register(promptRoute);
app.register(statusRoute);
app.register(abortRoute);
app.register(snippetRoute);
app.register(eventsRoute);
app.register(githubRoute);

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
