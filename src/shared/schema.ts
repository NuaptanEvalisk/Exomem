import { z } from "zod";

export const eventTimeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("instant"),
    at: z.iso
      .datetime({ offset: true })
      .transform((v) => new Date(v).toISOString()),
  }),
  z.object({ kind: z.literal("date"), date: z.iso.date() }),
]);
export type EventTime = z.infer<typeof eventTimeSchema>;
const content = z.string().min(1).max(500_000);
export const noteSchema = z.object({
  kind: z.literal("note"),
  title: z.string().trim().min(1).max(300),
  tags: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
  content,
});
export const timelineSchema = z.object({
  kind: z.literal("timeline"),
  time: eventTimeSchema,
  content,
});
export const entryInputSchema = z.discriminatedUnion("kind", [
  noteSchema,
  timelineSchema,
]);
export type EntryInput = z.infer<typeof entryInputSchema>;
export const spaceInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(2000).default(""),
});
export const searchSchema = z.object({
  kind: z.enum(["note", "timeline"]).optional(),
  q: z.string().max(500).default(""),
  tag: z.string().max(100).optional(),
  deleted: z.enum(["active", "deleted", "all"]).default("active"),
  dateFrom: z.iso.date().optional(),
  dateTo: z.iso.date().optional(),
  instantFrom: z.iso.datetime({ offset: true }).optional(),
  instantTo: z.iso.datetime({ offset: true }).optional(),
  cursor: z.string().max(1000).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type SearchInput = z.infer<typeof searchSchema>;
export interface Space {
  id: string;
  name: string;
  description: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  notes: number;
  timeline: number;
}
export interface Entry {
  id: string;
  spaceId: string;
  kind: "note" | "timeline";
  title: string;
  tags: string[];
  content: string;
  time: EventTime | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}
export interface TokenInfo {
  id: string;
  spaceId: string;
  name: string;
  state: "active" | "suspended" | "revoked";
  access: "read" | "write";
  createdAt: string;
  lastUsedAt: string | null;
}
export interface Revision {
  id: number;
  entryId: string;
  revision: number;
  action: string;
  actor: string;
  createdAt: string;
  snapshot: Entry;
}
export interface SearchResult {
  items: Entry[];
  nextCursor: string | null;
  total: number;
}
export const importSchema = z.object({
  format: z.literal("exomem/v1"),
  entries: z
    .array(z.object({ id: z.uuid().optional(), data: entryInputSchema }))
    .max(50_000),
});
