import type { FastifyInstance } from "fastify";

export default async function userRoute(app: FastifyInstance) {
  app.get("/api/user", async (req, reply) => {
    const user = (req as any).hiveUser;
    if (!user) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    return {
      name: user.name,
      role: user.role,
    };
  });
}
