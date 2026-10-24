import { McpServer } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import Fastify from "fastify";
import { z } from "zod";
import { eventTimeSchema, searchSchema, type Entry } from "../shared/schema.js";
import { Store, AppError, type Actor } from "./store.js";

const token = z
  .string()
  .trim()
  .uuid()
  .describe(
    "UUID read from token.txt attached to this conversation. Required on every call.",
  );
const request_id = z
  .string()
  .min(1)
  .max(200)
  .describe(
    "Unique ID for this operation. Reuse exactly the same ID and arguments when retrying; use a new ID for new or changed operations.",
  );
const expected_revision = z
  .number()
  .int()
  .positive()
  .describe(
    "Revision obtained by reading this record. On conflict, read again and merge before writing with a new request_id.",
  );
const id = z.uuid().describe("Record ID returned by Exomem.");
const summary = (entry: Entry) => ({
  ...entry,
  content: entry.content.slice(0, 300),
  contentTruncated: entry.content.length > 300,
});

export function createMcp(store: Store) {
  const server = new McpServer(
    { name: "Exomem", version: "0.1.0" },
    {
      instructions:
        "Exomem stores persistent memory in the space selected by token.txt. Read that file in the current conversation and pass its UUID on EVERY call. Begin with memory_bootstrap. Search relevant memories before using them; save useful changes incrementally. If the file is unavailable, ask the user for a replacement. Never guess, reveal, or save the token in memory. Organize notes and tags freely. Dates stay dates; precise times must include an offset and are stored in UTC. Writes require request_id; edits require expected_revision. Retry unchanged requests with the same request_id. Tool success confirms persistence; no background saving occurs.",
    },
  );
  function tool(
    name: string,
    description: string,
    schema: z.ZodObject<any>,
    read: boolean,
    fn: (args: any, actor: Actor, spaceId: string) => unknown,
  ) {
    server.registerTool(
      name,
      {
        description,
        inputSchema: schema,
        annotations: {
          readOnlyHint: read,
          destructiveHint: !read && !name.endsWith("_create"),
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (args) => {
        try {
          const actor: Actor = { type: "token", token: String(args.token) };
          const auth = store.authorize(actor, undefined, !read);
          const value = fn(args, actor, auth.spaceId);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(value) }],
          };
        } catch (error) {
          const known = error instanceof AppError;
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  code: known ? error.code : "OPERATION_FAILED",
                  message: known
                    ? error.message
                    : error instanceof z.ZodError
                      ? z.prettifyError(error)
                      : "The operation did not complete. Please try again.",
                }),
              },
            ],
          };
        }
      },
    );
  }
  tool(
    "memory_bootstrap",
    "Use at the beginning of a memory conversation or after context loss. Returns this token’s space, server UTC time, recent events, recent note summaries, and tags. More records are available through search.",
    z.object({ token }),
    true,
    (_, _actor, spaceId) => ({
      serverTime: new Date().toISOString(),
      space: store.space(spaceId),
      tags: store.tags(spaceId),
      timeline: {
        ...store.search(spaceId, { kind: "timeline", limit: 8 }),
        items: store
          .search(spaceId, { kind: "timeline", limit: 8 })
          .items.map(summary),
      },
      notes: {
        ...store.search(spaceId, { kind: "note", limit: 12 }),
        items: store
          .search(spaceId, { kind: "note", limit: 12 })
          .items.map(summary),
      },
    }),
  );
  for (const kind of ["note", "timeline"] as const) {
    const prefix = kind === "note" ? "notes" : "timeline";
    tool(
      `${prefix}_search`,
      `Search ${kind === "note" ? "notes by title, tags and content" : "events by description and time"}. q is a literal Unicode substring, including one-character CJK. Empty q lists records. Date bounds are inclusive; provide instantFrom/instantTo with offsets for local-day filtering. Results contain previews; use ${prefix}_get for content.`,
      searchSchema.omit({ kind: true, deleted: true }).extend({ token }),
      true,
      (args, _, spaceId) => {
        const result = store.search(spaceId, { ...args, kind });
        return { ...result, items: result.items.map(summary) };
      },
    );
    tool(
      `${prefix}_get`,
      "Read one record and its revision. Long content is paginated; follow nextOffset until null. Offsets use JavaScript UTF-16 string positions.",
      z.object({
        token,
        id,
        offset: z.number().int().min(0).default(0),
        maxCharacters: z.number().int().min(100).max(50_000).default(20_000),
      }),
      true,
      (args, _, spaceId) => {
        const entry = store.get(spaceId, args.id);
        if (entry.kind !== kind || entry.deletedAt)
          throw new AppError("NOT_FOUND", "Record not found or deleted.", 404);
        let end = Math.min(
          entry.content.length,
          args.offset + args.maxCharacters,
        );
        if (
          end < entry.content.length &&
          /[\uD800-\uDBFF]/.test(entry.content[end - 1])
        )
          end--;
        return {
          ...entry,
          content: entry.content.slice(args.offset, end),
          offset: args.offset,
          totalCharacters: entry.content.length,
          nextOffset: end < entry.content.length ? end : null,
        };
      },
    );
    const fields =
      kind === "note"
        ? {
            title: z.string().min(1).max(300),
            tags: z.array(z.string().min(1).max(100)).max(100).default([]),
            content: z.string().min(1).max(500_000),
          }
        : {
            time: eventTimeSchema,
            content: z
              .string()
              .min(1)
              .max(500_000)
              .describe("Description of the event."),
          };
    tool(
      `${prefix}_create`,
      "Save a new record. Returns the committed record and revision. Reuse request_id for an unchanged retry.",
      z.object({ token, request_id, ...fields }),
      false,
      (args, actor, spaceId) =>
        store.create(actor, spaceId, args.request_id, { ...args, kind }),
    );
    tool(
      `${prefix}_update`,
      "Replace a record’s editable fields. Read first, preserve content that should remain, and supply expected_revision. A conflict makes no changes.",
      z.object({ token, request_id, id, expected_revision, ...fields }),
      false,
      (args, actor, spaceId) => {
        if (store.get(spaceId, args.id).kind !== kind)
          throw new AppError("NOT_FOUND", "Record not found.", 404);
        return store.update(
          actor,
          spaceId,
          args.id,
          args.request_id,
          args.expected_revision,
          { ...args, kind },
        );
      },
    );
    tool(
      `${prefix}_delete`,
      "Move a record to the recycle bin. Recoverable in the WebUI; requires the current revision.",
      z.object({ token, request_id, id, expected_revision }),
      false,
      (args, actor, spaceId) => {
        if (store.get(spaceId, args.id).kind !== kind)
          throw new AppError("NOT_FOUND", "Record not found.", 404);
        return store.remove(
          actor,
          spaceId,
          args.id,
          args.request_id,
          args.expected_revision,
        );
      },
    );
  }
  return server;
}

export function mcpApp(store: Store) {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  app.get("/healthz", async () => ({ status: "ok", service: "exomem-mcp" }));
  app.all("/mcp", async (request, reply) => {
    const server = createMcp(store);
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    reply.hijack();
    reply.raw.on("close", () => {
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });
  return app;
}
