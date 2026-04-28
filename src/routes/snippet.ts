import type { FastifyInstance } from "fastify";
import { createManagedSession } from "../sessions/manager.js";

export default async function snippetRoute(app: FastifyInstance) {
  app.post("/snippet", async (req, reply) => {
    const body = req.body as {
      prompt?: string;
      code?: string;
      language?: string;
      provider?: string;
      model?: string;
    };

    if (!body.prompt) {
      return reply.code(400).send({ error: "prompt is required" });
    }

    let session;
    try {
      session = await createManagedSession({
        provider: body.provider,
        model: body.model,
      });
    } catch (err: any) {
      return reply.code(503).send({ error: err.message });
    }

    const fullPrompt = body.code
      ? `${body.prompt}\n\nCode:\n\`\`\`${body.language || "text"}\n${body.code}\n\`\`\``
      : body.prompt;

    // Collect all text deltas
    let result = "";
    const unsub = session.subscribe((event: any) => {
      if (
        event.type === "message_update" &&
        (event as any).assistantMessageEvent?.type === "text_delta"
      ) {
        result += (event as any).assistantMessageEvent.delta;
      }
    });

    try {
      await session.prompt(fullPrompt);
    } finally {
      unsub();
      session.dispose();
    }

    return { result };
  });
}
