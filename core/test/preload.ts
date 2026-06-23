// Preloaded before any test file (see bunfig.toml). src/db.ts and src/orders.ts each open a
// SQLite singleton AT IMPORT against DB_PATH / PENDING_DB_PATH, which default to the prod
// /var/lib paths. Point both at :memory: so merely importing those modules in a test never
// touches (or fails to create) the real stores. Tests that need isolated state call openDb(":memory:")
// directly; this only neutralises the import-time singletons.
//
// FORCE the assignment (not `??=`): a dev shell often exports the prod DB_PATH / PENDING_DB_PATH (the
// operator's profile, or a sourced /etc/nullsink.env), and with `??=` that ambient value wins —
// the singleton then tries to open the real /var/lib store and the whole run errors with SQLITE_CANTOPEN.
// Tests must NEVER touch prod data, so override unconditionally. (CI has a clean env; this matters locally.)
process.env.DB_PATH = ":memory:";
process.env.PENDING_DB_PATH = ":memory:";
