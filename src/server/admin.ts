import Fastify from "fastify";
import staticFiles from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { entryInputSchema, spaceInputSchema } from "../shared/schema.js";
import { Store, AppError, admin } from "./store.js";

const key = z.string().min(1).max(200);
const revision = z.number().int().positive();
export function adminApp(store: Store) {
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 });
  app.setErrorHandler((error: Error, _req, reply) => {
    if (error instanceof AppError)
      return reply
        .code(error.status)
        .send({ code: error.code, message: error.message });
    if (error instanceof z.ZodError)
      return reply
        .code(400)
        .send({ code: "INVALID_INPUT", message: z.prettifyError(error) });
    console.error(error.message);
    return reply.code(500).send({
      code: "INTERNAL_ERROR",
      message: "The operation did not complete. Check the service logs.",
    });
  });
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    reply.header("Cache-Control", "no-store");
    // Authentication is delegated to Cloudflare Access. This only checks browser origin.
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.headers.origin;
      const allowed = process.env.EXOMEM_PUBLIC_ORIGIN;
      const local = [
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        `http://${req.headers.host}`,
      ];
      const origins = allowed
        ? [allowed, "http://127.0.0.1:3210", "http://localhost:3210"]
        : local;
      if (origin && !origins.includes(origin))
        throw new AppError(
          "ORIGIN_MISMATCH",
          "Please perform this action from the Exomem WebUI.",
          403,
        );
    }
  });
  app.get("/api/status", async () => ({
    status: "ok",
    version: "0.1.0",
    serverTime: new Date().toISOString(),
    commit: process.env.EXOMEM_COMMIT ?? "development",
  }));
  app.get("/api/spaces", async () => store.spaces());
  app.post("/api/spaces", async (req) => {
    const body = spaceInputSchema.parse(req.body);
    return store.createSpace(body.name, body.description);
  });
  app.put<{ Params: { spaceId: string } }>(
    "/api/spaces/:spaceId",
    async (req) =>
      store.updateSpace(
        req.params.spaceId,
        spaceInputSchema.extend({ archived: z.boolean() }).parse(req.body),
      ),
  );
  app.get<{ Params: { spaceId: string } }>(
    "/api/spaces/:spaceId/tokens",
    async (req) => store.tokens(req.params.spaceId),
  );
  app.post<{ Params: { spaceId: string } }>(
    "/api/spaces/:spaceId/tokens",
    async (req) => {
      const body = z
        .object({
          name: z.string().trim().min(1).max(200),
          access: z.enum(["read", "write"]).default("write"),
        })
        .parse(req.body);
      return store.createToken(req.params.spaceId, body.name, body.access);
    },
  );
  app.patch<{ Params: { spaceId: string; id: string } }>(
    "/api/spaces/:spaceId/tokens/:id",
    async (req) =>
      store.setTokenState(
        req.params.spaceId,
        req.params.id,
        z
          .object({ state: z.enum(["active", "suspended", "revoked"]) })
          .parse(req.body).state,
      ),
  );
  app.get<{ Params: { spaceId: string } }>(
    "/api/spaces/:spaceId/tags",
    async (req) => store.tags(req.params.spaceId),
  );
  app.get<{ Params: { spaceId: string } }>(
    "/api/spaces/:spaceId/entries",
    async (req) => store.search(req.params.spaceId, req.query),
  );
  app.get<{ Params: { spaceId: string; id: string } }>(
    "/api/spaces/:spaceId/entries/:id",
    async (req) => store.get(req.params.spaceId, req.params.id),
  );
  app.post<{ Params: { spaceId: string } }>(
    "/api/spaces/:spaceId/entries",
    async (req) => {
      const body = z
        .object({ requestId: key, data: entryInputSchema })
        .parse(req.body);
      return store.create(admin, req.params.spaceId, body.requestId, body.data);
    },
  );
  app.put<{ Params: { spaceId: string; id: string } }>(
    "/api/spaces/:spaceId/entries/:id",
    async (req) => {
      const body = z
        .object({
          requestId: key,
          expectedRevision: revision,
          data: entryInputSchema,
        })
        .parse(req.body);
      return store.update(
        admin,
        req.params.spaceId,
        req.params.id,
        body.requestId,
        body.expectedRevision,
        body.data,
      );
    },
  );
  app.delete<{ Params: { spaceId: string; id: string } }>(
    "/api/spaces/:spaceId/entries/:id",
    async (req) => {
      const body = z
        .object({ requestId: key, expectedRevision: revision })
        .parse(req.body);
      return store.remove(
        admin,
        req.params.spaceId,
        req.params.id,
        body.requestId,
        body.expectedRevision,
      );
    },
  );
  app.post<{ Params: { spaceId: string; id: string } }>(
    "/api/spaces/:spaceId/entries/:id/restore",
    async (req) => {
      const body = z
        .object({
          requestId: key,
          expectedRevision: revision,
          targetRevision: revision.optional(),
        })
        .parse(req.body);
      return store.restore(
        req.params.spaceId,
        req.params.id,
        body.requestId,
        body.expectedRevision,
        body.targetRevision,
      );
    },
  );
  app.get<{ Params: { spaceId: string }; Querystring: { entryId?: string } }>(
    "/api/spaces/:spaceId/history",
    async (req) => store.history(req.params.spaceId, req.query.entryId),
  );
  app.get<{ Params: { spaceId: string } }>(
    "/api/spaces/:spaceId/export",
    async (req, reply) =>
      reply
        .header(
          "Content-Disposition",
          'attachment; filename="exomem-export.json"',
        )
        .send(store.export(req.params.spaceId)),
  );
  app.post<{ Params: { spaceId: string } }>(
    "/api/spaces/:spaceId/import",
    async (req) => {
      const body = z
        .object({ requestId: key, data: z.unknown() })
        .parse(req.body);
      return store.import(req.params.spaceId, body.requestId, body.data);
    },
  );
  const root = resolve("dist/web");
  if (existsSync(root)) app.register(staticFiles, { root });
  return app;
}
