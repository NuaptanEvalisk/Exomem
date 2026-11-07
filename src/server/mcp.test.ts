import { test } from "node:test";
import assert from "node:assert/strict";
import { mcpApp } from "./mcp.js";
import { Store } from "./store.js";

test("MCP HTTP returns record bodies without a top-level content field and correct bootstrap counts", async () => {
  const store = new Store(":memory:");
  const space = store.createSpace("MCP regression", "");
  const { token } = store.createToken(space.id, "test", "write");
  const app = mcpApp(store);
  let address: string | undefined;
  try {
    address = await app.listen({ host: "127.0.0.1", port: 0 });
    let requestId = 0;
    async function rpc(method: string, params: unknown) {
      const response = await fetch(`${address}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-11-25",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
      });
      assert.equal(response.status, 200);
      const envelope = (await response.json()) as {
        result?: { content: Array<{ type: string; text?: string }>; isError?: boolean };
        error?: unknown;
      };
      assert.equal(envelope.error, undefined);
      return envelope.result!;
    }
    await rpc("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "exomem-regression-test", version: "1" },
    });
    async function call(name: string, args: Record<string, unknown>) {
      const result = await rpc("tools/call", { name, arguments: { token, ...args } });
      assert.notEqual(result.isError, true, name);
      assert.equal(result.content[0]?.type, "text");
      return JSON.parse(result.content[0].text!) as Record<string, any>;
    }

    const content = "ATHENA：完整笔记📘\n".repeat(90);
    const note = await call("notes_create", {
      request_id: "create-note",
      title: "ATHENA：知识工作站",
      tags: ["test"],
      content,
    });
    assert.equal(note.revision, 1);
    assert.equal(note.recordText, content);
    assert.equal(Object.hasOwn(note, "content"), false);

    const firstPage = await call("notes_get", {
      id: note.id,
      offset: 0,
      maxCharacters: 120,
    });
    assert.equal(firstPage.revision, 1);
    assert.equal(firstPage.recordText, content.slice(0, 120));
    assert.equal(firstPage.nextOffset, 120);
    assert.equal(Object.hasOwn(firstPage, "content"), false);
    const lastPage = await call("notes_get", { id: note.id, offset: 120 });
    assert.equal(firstPage.recordText + lastPage.recordText, content);
    assert.equal(lastPage.nextOffset, null);

    const event = await call("timeline_create", {
      request_id: "create-event",
      time: { kind: "date", date: "2026-11-03" },
      content: "同行访美记录",
    });
    assert.equal(event.recordText, "同行访美记录");
    assert.equal(Object.hasOwn(event, "content"), false);
    const eventRead = await call("timeline_get", { id: event.id });
    assert.equal(eventRead.recordText, "同行访美记录");
    assert.equal(eventRead.revision, 1);
    assert.equal(Object.hasOwn(eventRead, "content"), false);

    const search = await call("notes_search", { q: "ATHENA" });
    assert.equal(search.total, 1);
    assert.equal(search.items[0].content, content.slice(0, 300));
    assert.equal(search.items[0].contentTruncated, true);

    const bootstrap = await call("memory_bootstrap", {});
    assert.equal(bootstrap.space.notes, 1);
    assert.equal(bootstrap.space.timeline, 1);
    assert.equal(bootstrap.notes.total, 1);
    assert.equal(bootstrap.timeline.total, 1);

    const updated = await call("notes_update", {
      id: note.id,
      request_id: "update-note",
      expected_revision: 1,
      title: "ATHENA：知识工作站",
      tags: ["test"],
      content: "更新后正文",
    });
    assert.equal(updated.revision, 2);
    assert.equal(updated.recordText, "更新后正文");
    assert.equal(Object.hasOwn(updated, "content"), false);

    const deleted = await call("timeline_delete", {
      id: event.id,
      request_id: "delete-event",
      expected_revision: 1,
    });
    assert.equal(deleted.revision, 2);
    assert.equal(deleted.recordText, "同行访美记录");
    assert.equal(Object.hasOwn(deleted, "content"), false);
    const afterDelete = await call("memory_bootstrap", {});
    assert.equal(afterDelete.space.notes, 1);
    assert.equal(afterDelete.space.timeline, 0);
  } finally {
    await app.close();
    store.close();
  }
});
