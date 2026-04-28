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

// Auth middleware — skip public paths
app.addHook("onRequest", async (req, reply) => {
  const publicPaths = ["/health", "/", "/docs", "/public/"];
  if (publicPaths.some((p) => req.url === p)) return;
  // Skip static assets (landing page + UI)
  if (req.url.startsWith("/public/") || req.url.startsWith("/ui/")) return;
  if (req.url.startsWith("/assets/") || req.url.endsWith(".css") || req.url.endsWith(".js") || req.url.endsWith(".ico")) return;

  const token =
    req.headers.authorization?.replace("Bearer ", "") ||
    (req.query as Record<string, string>).token;
  if (token !== API_TOKEN) {
    reply.code(401).send({ error: "Unauthorized" });
  }
});

await app.register(fWebSocket);

const __dirname = dirname(fileURLToPath(import.meta.url));
await app.register(fStatic, {
  root: join(__dirname, "..", "public"),
  prefix: "/public/",
  decorateReply: true,
});

// Public routes
app.get("/", async (_req, reply) => {
  return reply.sendFile("landing.html");
});
app.get("/docs", async (_req, reply) => {
  return reply.sendFile("landing.html");
});

// Redirect /ui and /ui/ to index.html (needs auth)
app.get("/ui", async (_req, reply) => {
  return reply.sendFile("index.html");
});
app.get("/ui/", async (_req, reply) => {
  return reply.sendFile("index.html");
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
