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
import userRoute from "./routes/user.js";

dotenv.config();

// Multi-token support — backwards compatible with single API_TOKEN
const API_TOKEN = process.env.API_TOKEN;
const API_TOKENS: Record<string, { name: string; role?: string }> = {};

if (process.env.API_TOKENS) {
  try {
    const parsed = JSON.parse(process.env.API_TOKENS);
    for (const [tok, profile] of Object.entries(parsed)) {
      API_TOKENS[tok] = profile as any;
    }
  } catch {
    console.warn("Failed to parse API_TOKENS, falling back to single token");
  }
}

if (!Object.keys(API_TOKENS).length && API_TOKEN) {
  API_TOKENS[API_TOKEN] = { name: "Admin" };
}

if (!Object.keys(API_TOKENS).length) {
  console.error("FATAL: API_TOKEN or API_TOKENS not set in .env");
  process.exit(1);
}

const PORT = parseInt(process.env.PORT || "8080", 10);

const app = Fastify({ logger: true });

// Auth middleware — skip public paths, store user on request
app.addHook("onRequest", async (req, reply) => {
  const publicPaths = ["/health", "/", "/docs", "/public/", "/ui", "/ui/"];
  if (publicPaths.some((p) => req.url === p)) return;
  if (req.url.startsWith("/public/") || req.url.startsWith("/ui/")) return;
  if (req.url.startsWith("/assets/") || req.url.endsWith(".css") || req.url.endsWith(".js") || req.url.endsWith(".ico") || req.url.endsWith(".woff2") || req.url.endsWith(".ttf") || req.url.endsWith(".mjs")) return;

  const token =
    req.headers.authorization?.replace("Bearer ", "") ||
    (req.query as Record<string, string>).token;

  const userProfile = API_TOKENS[token || ""];
  if (!userProfile) {
    reply.code(401).send({ error: "Unauthorized" });
    return;
  }

  (req as any).hiveUser = { token: token!, name: userProfile.name, role: userProfile.role || "user" };
});

await app.register(fWebSocket);

const __dirname = dirname(fileURLToPath(import.meta.url));

// Serve public static files (landing page)
await app.register(fStatic, {
  root: join(__dirname, "..", "public"),
  prefix: "/public/",
  decorateReply: true,
});

// Serve the new pi-web-ui build
await app.register(fStatic, {
  root: join(__dirname, "..", "ui", "dist"),
  prefix: "/ui/",
  decorateReply: false
});

// Public routes
app.get("/", async (_req, reply) => {
  return reply.sendFile("landing.html");
});
app.get("/docs", async (_req, reply) => {
  return reply.sendFile("landing.html");
});

// Serve new UI at /ui
app.get("/ui", async (_req, reply) => {
  return reply.sendFile("index.html", join(__dirname, "..", "ui", "dist"));
});
app.get("/ui/", async (_req, reply) => {
  return reply.sendFile("index.html", join(__dirname, "..", "ui", "dist"));
});

app.register(promptRoute);
app.register(statusRoute);
app.register(abortRoute);
app.register(snippetRoute);
app.register(eventsRoute);
app.register(githubRoute);
app.register(userRoute);

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
