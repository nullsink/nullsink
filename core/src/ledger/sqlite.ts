// Open a SQLite database with the durability + concurrency PRAGMAs every store in this app needs,
// declared in ONE place instead of copied per store. WAL lets each owning process serve reads alongside its
// own writes and is crash-safe. busy_timeout: wait out a briefly-held
// write lock rather than erroring. synchronous=FULL: fsync every commit so a credited balance — and an
// order's irreplaceable index→hash link — survives power loss. Dropping to NORMAL (which can lose the
// last commits on power loss) is then a single deliberate, reviewed change HERE, not a silent per-store
// divergence. Each caller creates its own schema on the returned handle.
import { Database } from "bun:sqlite";

export function openSqlite(path: string): Database {
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA synchronous = FULL");
  return db;
}
