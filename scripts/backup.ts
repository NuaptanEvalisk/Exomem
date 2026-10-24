import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
const db = new Database(process.env.EXOMEM_DATABASE ?? "data/exomem.sqlite", {
  readonly: true,
});
const dir = process.env.EXOMEM_BACKUP_DIR ?? "backups";
mkdirSync(dir, { recursive: true });
const target = resolve(
  dir,
  `exomem-${new Date().toISOString().replaceAll(":", "-")}.sqlite`,
);
await db.backup(target);
db.close();
console.log(target);
