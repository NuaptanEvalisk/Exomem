import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { caseFold } from "unicode-case-folding";
import { z } from "zod";
import {
  entryInputSchema,
  importSchema,
  searchSchema,
  type Entry,
  type EntryInput,
  type Revision,
  type SearchResult,
  type Space,
  type TokenInfo,
} from "../shared/schema.js";

export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export type Actor = { type: "admin" } | { type: "token"; token: string };
export const admin: Actor = { type: "admin" };
export const normalizeSearch = (text: string) =>
  caseFold(text.normalize("NFC")).normalize("NFC");
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const now = () => new Date().toISOString();
type Row = Record<string, any>;

export class Store {
  db: Database.Database;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
  }
  private migrate() {
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version > 1)
      throw new Error("Database schema is newer than this application.");
    if (version === 1) return;
    this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE tokens (id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id), name TEXT NOT NULL, digest TEXT NOT NULL UNIQUE, state TEXT NOT NULL, access TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT);
        CREATE TABLE entries (id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id), kind TEXT NOT NULL, title TEXT NOT NULL, tags TEXT NOT NULL, content TEXT NOT NULL, time_kind TEXT, time_value TEXT, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, search_text TEXT NOT NULL);
        CREATE INDEX entries_space ON entries(space_id, kind, updated_at, id);
        CREATE INDEX entries_time ON entries(space_id, time_value, id);
        CREATE VIRTUAL TABLE entry_search USING fts5(text, tokenize='trigram case_sensitive 1');
        CREATE TABLE revisions (id INTEGER PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id), entry_id TEXT NOT NULL REFERENCES entries(id), revision INTEGER NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL, snapshot TEXT NOT NULL, UNIQUE(entry_id, revision));
        CREATE INDEX revisions_space ON revisions(space_id, id);
        CREATE TABLE requests (space_id TEXT NOT NULL REFERENCES spaces(id), actor TEXT NOT NULL, request_key TEXT NOT NULL, hash TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(space_id, actor, request_key));
        CREATE TABLE imports (space_id TEXT NOT NULL REFERENCES spaces(id), source_hash TEXT NOT NULL, entry_id TEXT NOT NULL REFERENCES entries(id), PRIMARY KEY(space_id, source_hash));
        PRAGMA user_version = 1;
      `);
    })();
  }
  close() {
    this.db.close();
  }
  private spaceRow(row: Row): Space {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      archived: Boolean(row.archived),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      notes: row.notes ?? 0,
      timeline: row.timeline ?? 0,
    };
  }
  spaces(): Space[] {
    return (
      this.db
        .prepare(
          `SELECT s.*, (SELECT count(*) FROM entries WHERE space_id=s.id AND kind='note' AND deleted_at IS NULL) notes, (SELECT count(*) FROM entries WHERE space_id=s.id AND kind='timeline' AND deleted_at IS NULL) timeline FROM spaces s ORDER BY archived, created_at, id`,
        )
        .all() as Row[]
    ).map((r) => this.spaceRow(r));
  }
  space(id: string): Space {
    const row = this.db.prepare("SELECT * FROM spaces WHERE id=?").get(id) as
      Row | undefined;
    if (!row) throw new AppError("NOT_FOUND", "Space not found.", 404);
    return this.spaceRow(row);
  }
  createSpace(name: string, description: string): Space {
    const id = randomUUID(),
      at = now();
    this.db
      .prepare("INSERT INTO spaces VALUES (?,?,?,0,?,?)")
      .run(id, name, description, at, at);
    return this.space(id);
  }
  updateSpace(
    id: string,
    data: { name: string; description: string; archived: boolean },
  ) {
    this.space(id);
    this.db
      .prepare(
        "UPDATE spaces SET name=?, description=?, archived=?, updated_at=? WHERE id=?",
      )
      .run(data.name, data.description, +data.archived, now(), id);
    return this.space(id);
  }
  private tokenRow(row: Row): TokenInfo {
    return {
      id: row.id,
      spaceId: row.space_id,
      name: row.name,
      state: row.state,
      access: row.access,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
    };
  }
  tokens(spaceId: string): TokenInfo[] {
    this.space(spaceId);
    return (
      this.db
        .prepare(
          "SELECT * FROM tokens WHERE space_id=? ORDER BY created_at DESC, id",
        )
        .all(spaceId) as Row[]
    ).map((r) => this.tokenRow(r));
  }
  createToken(spaceId: string, name: string, access: "read" | "write") {
    if (this.space(spaceId).archived)
      throw new AppError(
        "ARCHIVED",
        "Restore this space before making changes.",
      );
    const token = randomUUID(),
      id = randomUUID();
    this.db
      .prepare("INSERT INTO tokens VALUES (?,?,?,?,?,?,?,NULL)")
      .run(id, spaceId, name, digest(token), "active", access, now());
    return { token, info: this.tokens(spaceId).find((t) => t.id === id)! };
  }
  setTokenState(spaceId: string, id: string, state: TokenInfo["state"]) {
    const token = this.tokens(spaceId).find((t) => t.id === id);
    if (!token) throw new AppError("NOT_FOUND", "Token not found.", 404);
    if (token.state === "revoked")
      throw new AppError("REVOKED", "A revoked token cannot be resumed.");
    this.db
      .prepare("UPDATE tokens SET state=? WHERE id=? AND space_id=?")
      .run(state, id, spaceId);
    return { ...token, state };
  }
  authorize(
    actor: Actor,
    spaceId?: string,
    write = false,
  ): { spaceId: string; actor: string } {
    if (actor.type === "admin") {
      if (!spaceId)
        throw new AppError("SPACE_REQUIRED", "A space is required.");
      const space = this.space(spaceId);
      if (space.archived && write)
        throw new AppError(
          "ARCHIVED",
          "Restore this space before making changes.",
        );
      return { spaceId, actor: "web" };
    }
    const token = this.db
      .prepare("SELECT * FROM tokens WHERE digest=?")
      .get(digest(actor.token.trim().toLowerCase())) as Row | undefined;
    if (!token || token.state !== "active")
      throw new AppError(
        "TOKEN_UNAVAILABLE",
        "Token is unknown, suspended, or revoked. Read a valid token.txt from this conversation.",
        401,
      );
    if (spaceId && token.space_id !== spaceId)
      throw new AppError("NOT_FOUND", "Record not found.", 404);
    if (this.space(token.space_id).archived)
      throw new AppError("ARCHIVED", "This space is archived.", 403);
    if (write && token.access !== "write")
      throw new AppError("READ_ONLY", "This token is read-only.", 403);
    this.db
      .prepare("UPDATE tokens SET last_used_at=? WHERE id=?")
      .run(now(), token.id);
    return { spaceId: token.space_id, actor: `token:${token.id}` };
  }
  private entryRow(row: Row): Entry {
    return {
      id: row.id,
      spaceId: row.space_id,
      kind: row.kind,
      title: row.title,
      tags: JSON.parse(row.tags),
      content: row.content,
      time:
        row.time_kind === "instant"
          ? { kind: "instant", at: row.time_value }
          : row.time_kind === "date"
            ? { kind: "date", date: row.time_value }
            : null,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
    };
  }
  get(spaceId: string, id: string): Entry {
    const row = this.db
      .prepare("SELECT * FROM entries WHERE space_id=? AND id=?")
      .get(spaceId, id) as Row | undefined;
    if (!row) throw new AppError("NOT_FOUND", "Record not found.", 404);
    return this.entryRow(row);
  }
  search(spaceId: string, input: unknown): SearchResult {
    const query = searchSchema.parse(input);
    const where = ["e.space_id = ?"],
      args: (string | number)[] = [spaceId];
    if (query.kind) {
      where.push("e.kind=?");
      args.push(query.kind);
    }
    if (query.deleted !== "all")
      where.push(
        `e.deleted_at IS ${query.deleted === "active" ? "" : "NOT "}NULL`,
      );
    if (query.tag) {
      where.push("EXISTS (SELECT 1 FROM json_each(e.tags) WHERE value=?)");
      args.push(query.tag);
    }
    const q = normalizeSearch(query.q);
    if (q) {
      // The final literal check defines matching. FTS is only an accelerator.
      if ([...q].length >= 3 && !q.includes("\0")) {
        where.push(
          "e.rowid IN (SELECT rowid FROM entry_search WHERE text MATCH ?)",
        );
        args.push(`"${q.replaceAll('"', '""')}"`);
      }
      where.push("instr(e.search_text, ?) > 0");
      args.push(q);
    }
    if (
      query.dateFrom ||
      query.dateTo ||
      query.instantFrom ||
      query.instantTo
    ) {
      const date: string[] = ["e.time_kind='date'"],
        instant: string[] = ["e.time_kind='instant'"];
      const dateArgs: string[] = [],
        instantArgs: string[] = [];
      if (query.dateFrom) {
        date.push("e.time_value >= ?");
        dateArgs.push(query.dateFrom);
      }
      if (query.dateTo) {
        date.push("e.time_value <= ?");
        dateArgs.push(query.dateTo);
      }
      const from =
        query.instantFrom ??
        (query.dateFrom ? `${query.dateFrom}T00:00:00.000Z` : undefined);
      const to =
        query.instantTo ??
        (query.dateTo ? `${query.dateTo}T23:59:59.999Z` : undefined);
      if (from) {
        instant.push("e.time_value >= ?");
        instantArgs.push(new Date(from).toISOString());
      }
      if (to) {
        instant.push("e.time_value <= ?");
        instantArgs.push(new Date(to).toISOString());
      }
      where.push(`((${date.join(" AND ")}) OR (${instant.join(" AND ")}))`);
      args.push(...dateArgs, ...instantArgs);
    }
    const base = where.join(" AND ");
    const total = (
      this.db
        .prepare(`SELECT count(*) n FROM entries e WHERE ${base}`)
        .get(...args) as { n: number }
    ).n;
    const sort = query.kind === "timeline" ? "e.time_value" : "e.updated_at";
    if (query.cursor) {
      const cursor = z
        .object({ at: z.string(), id: z.string() })
        .parse(JSON.parse(Buffer.from(query.cursor, "base64url").toString()));
      where.push(`(${sort} < ? OR (${sort} = ? AND e.id < ?))`);
      args.push(cursor.at, cursor.at, cursor.id);
    }
    const rows = this.db
      .prepare(
        `SELECT e.*, ${sort} sort_at FROM entries e WHERE ${where.join(" AND ")} ORDER BY ${sort} DESC, e.id DESC LIMIT ?`,
      )
      .all(...args, query.limit + 1) as Row[];
    const more = rows.length > query.limit;
    const page = rows.slice(0, query.limit),
      last = page.at(-1);
    return {
      items: page.map((r) => this.entryRow(r)),
      total,
      nextCursor:
        more && last
          ? Buffer.from(
              JSON.stringify({ at: last.sort_at, id: last.id }),
            ).toString("base64url")
          : null,
    };
  }
  tags(spaceId: string): string[] {
    return (
      this.db
        .prepare(
          "SELECT DISTINCT value tag FROM entries, json_each(entries.tags) WHERE space_id=? AND deleted_at IS NULL ORDER BY value",
        )
        .all(spaceId) as { tag: string }[]
    ).map((r) => r.tag);
  }
  private save(entry: Entry, actor: string, action: string) {
    const text = normalizeSearch(
      [entry.title, ...entry.tags, entry.content].join("\n"),
    );
    this.db
      .prepare(
        `INSERT INTO entries (id,space_id,kind,title,tags,content,time_kind,time_value,revision,created_at,updated_at,deleted_at,search_text)
      VALUES (@id,@spaceId,@kind,@title,@tags,@content,@timeKind,@timeValue,@revision,@createdAt,@updatedAt,@deletedAt,@text)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,tags=excluded.tags,content=excluded.content,time_kind=excluded.time_kind,time_value=excluded.time_value,revision=excluded.revision,updated_at=excluded.updated_at,deleted_at=excluded.deleted_at,search_text=excluded.search_text`,
      )
      .run({
        ...entry,
        tags: JSON.stringify(entry.tags),
        timeKind: entry.time?.kind ?? null,
        timeValue:
          entry.time?.kind === "instant"
            ? entry.time.at
            : (entry.time?.date ?? null),
        text,
      });
    const { rowid } = this.db
      .prepare("SELECT rowid FROM entries WHERE id=?")
      .get(entry.id) as { rowid: number };
    this.db.prepare("DELETE FROM entry_search WHERE rowid=?").run(rowid);
    this.db
      .prepare("INSERT INTO entry_search (rowid,text) VALUES (?,?)")
      .run(rowid, text);
    this.db
      .prepare(
        "INSERT INTO revisions (space_id,entry_id,revision,action,actor,created_at,snapshot) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        entry.spaceId,
        entry.id,
        entry.revision,
        action,
        actor,
        entry.updatedAt,
        JSON.stringify(entry),
      );
    return entry;
  }
  private mutation<T>(
    actor: Actor,
    spaceId: string,
    key: string,
    payload: unknown,
    fn: (label: string) => T,
  ): T {
    return this.db.transaction(() => {
      const auth = this.authorize(actor, spaceId, true);
      const hash = digest(JSON.stringify(payload));
      const prior = this.db
        .prepare(
          "SELECT hash,result FROM requests WHERE space_id=? AND actor=? AND request_key=?",
        )
        .get(spaceId, auth.actor, key) as Row | undefined;
      if (prior) {
        if (prior.hash !== hash)
          throw new AppError(
            "IDEMPOTENCY_CONFLICT",
            "This request ID was already used for different content. Use a new request_id for a new operation.",
            409,
          );
        return JSON.parse(prior.result) as T;
      }
      const result = fn(auth.actor);
      this.db
        .prepare("INSERT INTO requests VALUES (?,?,?,?,?)")
        .run(spaceId, auth.actor, key, hash, JSON.stringify(result));
      return result;
    })();
  }
  private fresh(spaceId: string, data: EntryInput): Entry {
    const at = now();
    return {
      id: randomUUID(),
      spaceId,
      kind: data.kind,
      title: data.kind === "note" ? data.title : "",
      tags: data.kind === "note" ? [...new Set(data.tags)] : [],
      content: data.content,
      time: data.kind === "timeline" ? data.time : null,
      revision: 1,
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
    };
  }
  create(actor: Actor, spaceId: string, key: string, input: unknown) {
    const data = entryInputSchema.parse(input);
    return this.mutation(actor, spaceId, key, ["create", data], (label) =>
      this.save(this.fresh(spaceId, data), label, "create"),
    );
  }
  update(
    actor: Actor,
    spaceId: string,
    id: string,
    key: string,
    revision: number,
    input: unknown,
  ) {
    const data = entryInputSchema.parse(input);
    return this.mutation(
      actor,
      spaceId,
      key,
      ["update", id, revision, data],
      (label) => {
        const entry = this.get(spaceId, id);
        this.checkRevision(entry, revision);
        if (entry.deletedAt)
          throw new AppError(
            "DELETED",
            "Restore this record from the trash before editing.",
            409,
          );
        if (entry.kind !== data.kind)
          throw new AppError(
            "KIND_MISMATCH",
            "The record type cannot be changed.",
          );
        return this.save(
          {
            ...entry,
            title: data.kind === "note" ? data.title : "",
            tags: data.kind === "note" ? [...new Set(data.tags)] : [],
            content: data.content,
            time: data.kind === "timeline" ? data.time : null,
            revision: entry.revision + 1,
            updatedAt: now(),
          },
          label,
          "update",
        );
      },
    );
  }
  private checkRevision(entry: Entry, revision: number) {
    if (entry.revision !== revision)
      throw new AppError(
        "REVISION_CONFLICT",
        `The record is now at revision ${entry.revision}. Read it again and merge your changes. Your edits have not been saved.`,
        409,
      );
  }
  remove(
    actor: Actor,
    spaceId: string,
    id: string,
    key: string,
    revision: number,
  ) {
    return this.mutation(
      actor,
      spaceId,
      key,
      ["delete", id, revision],
      (label) => {
        const entry = this.get(spaceId, id);
        this.checkRevision(entry, revision);
        if (entry.deletedAt)
          throw new AppError("DELETED", "This record is already in the trash.");
        const at = now();
        return this.save(
          {
            ...entry,
            deletedAt: at,
            updatedAt: at,
            revision: entry.revision + 1,
          },
          label,
          "delete",
        );
      },
    );
  }
  history(spaceId: string, entryId?: string): Revision[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM revisions WHERE space_id=? ${entryId ? "AND entry_id=?" : ""} ORDER BY id DESC LIMIT 200`,
      )
      .all(...(entryId ? [spaceId, entryId] : [spaceId])) as Row[];
    return rows.map((r) => ({
      id: r.id,
      entryId: r.entry_id,
      revision: r.revision,
      action: r.action,
      actor: r.actor,
      createdAt: r.created_at,
      snapshot: JSON.parse(r.snapshot),
    }));
  }
  restore(
    spaceId: string,
    id: string,
    key: string,
    revision: number,
    targetRevision?: number,
  ) {
    return this.mutation(
      admin,
      spaceId,
      key,
      ["restore", id, revision, targetRevision],
      (label) => {
        const current = this.get(spaceId, id);
        this.checkRevision(current, revision);
        let source = current;
        if (targetRevision !== undefined) {
          const row = this.db
            .prepare(
              "SELECT snapshot FROM revisions WHERE space_id=? AND entry_id=? AND revision=?",
            )
            .get(spaceId, id, targetRevision) as
            { snapshot: string } | undefined;
          if (!row) throw new AppError("NOT_FOUND", "Revision not found.", 404);
          source = JSON.parse(row.snapshot);
        }
        return this.save(
          {
            ...source,
            revision: current.revision + 1,
            updatedAt: now(),
            deletedAt: null,
          },
          label,
          "restore",
        );
      },
    );
  }
  export(spaceId: string) {
    const space = this.space(spaceId);
    const entries = (
      this.db
        .prepare(
          "SELECT * FROM entries WHERE space_id=? AND deleted_at IS NULL ORDER BY created_at,id",
        )
        .all(spaceId) as Row[]
    ).map((r) => this.entryRow(r));
    return {
      format: "exomem/v1",
      exportedAt: now(),
      space: { name: space.name, description: space.description },
      entries: entries.map((e) => ({
        id: e.id,
        data: this.toInput(e),
        metadata: {
          createdAt: e.createdAt,
          updatedAt: e.updatedAt,
          revision: e.revision,
        },
      })),
    };
  }
  private toInput(e: Entry): EntryInput {
    return e.kind === "note"
      ? { kind: "note", title: e.title, tags: e.tags, content: e.content }
      : { kind: "timeline", time: e.time!, content: e.content };
  }
  import(spaceId: string, key: string, input: unknown) {
    const data = importSchema.parse(input);
    return this.mutation(admin, spaceId, key, ["import", data], (label) => {
      let created = 0,
        skipped = 0;
      for (const item of data.entries) {
        const hash = digest(JSON.stringify([item.id ?? null, item.data]));
        const existing = item.id
          ? (this.db
              .prepare("SELECT * FROM entries WHERE id=? AND space_id=?")
              .get(item.id, spaceId) as Row | undefined)
          : undefined;
        if (existing) {
          if (
            JSON.stringify(this.toInput(this.entryRow(existing))) !==
            JSON.stringify(item.data)
          )
            throw new AppError(
              "IMPORT_CONFLICT",
              `Record ${item.id} already exists with different content. No entries were imported. Resolve the difference in the original record.`,
              409,
            );
          skipped++;
          continue;
        }
        if (
          this.db
            .prepare("SELECT 1 FROM imports WHERE space_id=? AND source_hash=?")
            .get(spaceId, hash)
        ) {
          skipped++;
          continue;
        }
        const entry = this.save(
          this.fresh(spaceId, item.data),
          label,
          "import",
        );
        this.db
          .prepare("INSERT INTO imports VALUES (?,?,?)")
          .run(spaceId, hash, entry.id);
        created++;
      }
      return { created, skipped };
    });
  }
}
