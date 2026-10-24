import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, admin, normalizeSearch } from "./store.js";

test("Unicode search: short CJK, canonical equivalents, case folding, and literal punctuation", () => {
  const store = new Store(":memory:");
  try {
    const space = store.createSpace("检索", "");
    const content =
      '今天去图书馆。日本語の勉強。한국어를 공부한다。𠮷野家的咖啡 café Straße Σίσυφος 👩🏽‍💻 "quoted" 100% a_b *literal*';
    const entry = store.create(admin, space.id, "seed", {
      kind: "note",
      title: "旅行笔记",
      tags: ["读书"],
      content,
    });
    for (const q of [
      "图",
      "书馆",
      "图书馆",
      "日本語",
      "韓",
      "한국어",
      "한국어",
      "𠮷",
      "𠮷野家",
      "cafe\u0301",
      "STRASSE",
      "σίΣΥΦΟΣ",
      "👩🏽‍💻",
      '"quoted"',
      "%",
      "_",
      "*literal*",
    ]) {
      const expected = normalizeSearch(
        [entry.title, ...entry.tags, content].join("\n"),
      ).includes(normalizeSearch(q));
      assert.equal(store.search(space.id, { q }).total, Number(expected), q);
    }
    assert.equal(store.search(space.id, { q: "不存在" }).total, 0);
    assert.equal(store.search(space.id, { tag: "读书" }).total, 1);
  } finally {
    store.close();
  }
});

test("Search index follows edits and deletion; keyset pagination does not repeat rows", () => {
  const store = new Store(":memory:");
  try {
    const space = store.createSpace("检索分页", "");
    const entries = Array.from({ length: 7 }, (_, i) =>
      store.create(admin, space.id, `create-${i}`, {
        kind: "note",
        title: `笔记 ${i}`,
        content: "旧关键词",
        tags: [],
      }),
    );
    const first = store.search(space.id, { limit: 3 });
    const second = store.search(space.id, {
      limit: 3,
      cursor: first.nextCursor,
    });
    assert.equal(
      new Set([...first.items, ...second.items].map((e) => e.id)).size,
      6,
    );
    const e = entries[0];
    const updated = store.update(admin, space.id, e.id, "update", 1, {
      kind: "note",
      title: e.title,
      tags: [],
      content: "新关键词",
    });
    assert.equal(store.search(space.id, { q: "旧关键词" }).total, 6);
    assert.equal(store.search(space.id, { q: "新关键词" }).total, 1);
    store.remove(admin, space.id, e.id, "remove", updated.revision);
    assert.equal(store.search(space.id, { q: "新关键词" }).total, 0);
    assert.equal(
      store.search(space.id, { q: "新关键词", deleted: "deleted" }).total,
      1,
    );
  } finally {
    store.close();
  }
});

test("Two database connections: retry is idempotent, stale revision conflicts, restore preserves history", () => {
  const dir = mkdtempSync(join(tmpdir(), "exomem-"));
  const a = new Store(join(dir, "test.sqlite")),
    b = new Store(join(dir, "test.sqlite"));
  try {
    const space = a.createSpace("并发", "");
    const data = { kind: "note", title: "草稿", content: "第一版", tags: [] };
    const original = a.create(admin, space.id, "create", data);
    assert.deepEqual(b.create(admin, space.id, "create", data), original);
    assert.throws(
      () =>
        b.create(admin, space.id, "create", { ...data, content: "不同操作" }),
      { code: "IDEMPOTENCY_CONFLICT" },
    );
    const saved = a.update(admin, space.id, original.id, "update-a", 1, {
      ...data,
      content: "第二版",
    });
    assert.throws(
      () =>
        b.update(admin, space.id, original.id, "update-b", 1, {
          ...data,
          content: "旧上下文修改",
        }),
      { code: "REVISION_CONFLICT" },
    );
    assert.deepEqual(
      b.update(admin, space.id, original.id, "update-a", 1, {
        ...data,
        content: "第二版",
      }),
      saved,
    );
    const restored = b.restore(space.id, original.id, "restore", 2, 1);
    assert.equal(restored.content, "第一版");
    assert.equal(restored.revision, 3);
    assert.equal(a.history(space.id, original.id).length, 3);
  } finally {
    a.close();
    b.close();
    rmSync(dir, { recursive: true });
  }
});

test("UTC instants and date-only events keep separate semantics across local-day boundaries", () => {
  const store = new Store(":memory:");
  try {
    const space = store.createSpace("时间", "");
    const instant = store.create(admin, space.id, "instant", {
      kind: "timeline",
      time: { kind: "instant", at: "2026-10-24T01:30:00+08:00" },
      content: "凌晨的事件",
    });
    const date = store.create(admin, space.id, "date", {
      kind: "timeline",
      time: { kind: "date", date: "2026-10-24" },
      content: "只记得日期",
    });
    assert.deepEqual(instant.time, {
      kind: "instant",
      at: "2026-10-23T17:30:00.000Z",
    });
    assert.deepEqual(date.time, { kind: "date", date: "2026-10-24" });
    assert.equal(
      store.search(space.id, { dateFrom: "2026-10-24", dateTo: "2026-10-24" })
        .total,
      1,
    );
    assert.equal(
      store.search(space.id, {
        dateFrom: "2026-10-24",
        dateTo: "2026-10-24",
        instantFrom: "2026-10-24T00:00:00+08:00",
        instantTo: "2026-10-24T23:59:59.999+08:00",
      }).total,
      2,
    );
    assert.throws(() =>
      store.create(admin, space.id, "invalid-date", {
        kind: "timeline",
        time: { kind: "date", date: "2026-02-30" },
        content: "日期输入错误",
      }),
    );
  } finally {
    store.close();
  }
});

test("Import is atomic, skips unchanged repeats, and does not silently overwrite an existing record", () => {
  const store = new Store(":memory:");
  try {
    const source = store.createSpace("来源", ""),
      target = store.createSpace("目标", "");
    const data = {
      kind: "note",
      title: "原文",
      tags: [],
      content: "导出的原始内容",
    };
    store.create(admin, source.id, "create", data);
    const exported = store.export(source.id);
    assert.deepEqual(store.import(target.id, "import-1", exported), {
      created: 1,
      skipped: 0,
    });
    assert.deepEqual(store.import(target.id, "import-2", exported), {
      created: 0,
      skipped: 1,
    });
    const existing = exported.entries[0];
    assert.throws(
      () =>
        store.import(source.id, "conflict", {
          format: "exomem/v1",
          entries: [
            { data: { ...data, title: "这条不应写入" } },
            { ...existing, data: { ...data, content: "内容已变" } },
          ],
        }),
      { code: "IMPORT_CONFLICT" },
    );
    assert.equal(store.search(source.id, {}).total, 1);
  } finally {
    store.close();
  }
});
