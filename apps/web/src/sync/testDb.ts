import type { SyncDb, SyncTx } from './oplog'

interface Stmt {
  run(...p: unknown[]): unknown
  all(...p: unknown[]): unknown[]
  get(...p: unknown[]): unknown
}
interface Sqlite {
  exec(sql: string): void
  prepare(sql: string): Stmt
}
const BUILTIN = 'node:sqlite' // a variable, so neither Vite nor tsc tries to resolve the built-in

/** Real SQLite (node:sqlite) with the tables the writer touches, for unit tests. Transactions roll back on throw. */
export async function makeTestDb() {
  const { DatabaseSync } = (await import(/* @vite-ignore */ BUILTIN)) as { DatabaseSync: new (path: string) => Sqlite }
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`
    CREATE TABLE op_log (id TEXT PRIMARY KEY, store_id TEXT, device_id TEXT, actor_user_id TEXT, local_seq INTEGER,
      hlc TEXT, idempotency_key TEXT UNIQUE, entity_type TEXT, entity_id TEXT, op_type TEXT, schema_version INTEGER,
      payload TEXT, created_at TEXT);
    CREATE TABLE device_state (id TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE stock_balance (id TEXT PRIMARY KEY, tenant_id TEXT, store_id TEXT, product_id TEXT, qty_milli INTEGER,
      oversold INTEGER, movement_count INTEGER);
    CREATE TABLE khata_balance (id TEXT PRIMARY KEY, tenant_id TEXT, party_id TEXT, balance_paise INTEGER, entry_count INTEGER);
  `)
  const tx: SyncTx = {
    async execute(sql, params = []) {
      sqlite.prepare(sql).run(...(params as never[]))
    },
    async getAll<T>(sql: string, params: unknown[] = []) {
      return sqlite.prepare(sql).all(...(params as never[])) as T[]
    },
  }
  const db: SyncDb = {
    async writeTransaction(cb) {
      sqlite.exec('BEGIN')
      try {
        const result = await cb(tx)
        sqlite.exec('COMMIT')
        return result
      } catch (e) {
        sqlite.exec('ROLLBACK')
        throw e
      }
    },
  }
  return { sqlite, db }
}
