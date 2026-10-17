import { schema } from './schema'
import type { SyncDb, SyncTx } from './oplog'

/** Read/write handle used by billing, catalogue and printing code. PowerSyncDatabase and the test DB both satisfy it. */
export interface LocalDb extends SyncDb {
  getAll<T>(sql: string, params?: unknown[]): Promise<T[]>
  get<T>(sql: string, params?: unknown[]): Promise<T>
  execute(sql: string, params?: unknown[]): Promise<unknown>
}

interface Stmt {
  run(...p: unknown[]): unknown
  all(...p: unknown[]): unknown[]
}
interface Sqlite {
  exec(sql: string): void
  prepare(sql: string): Stmt
}
const BUILTIN = 'node:sqlite' // a variable, so neither Vite nor tsc tries to resolve the built-in

/**
 * Real SQLite (node:sqlite) with EVERY table of the PowerSync schema, built from schema.ts so tests can never drift
 * from the app's local schema. Each table gets PowerSync's text `id` primary key. insertOnly tables (op_log) get a
 * unique idempotency_key like the server. Transactions roll back on throw. Test-only: never imported by the app.
 */
export async function makeSchemaDb(): Promise<{ sqlite: Sqlite; db: LocalDb }> {
  const { DatabaseSync } = (await import(/* @vite-ignore */ BUILTIN)) as { DatabaseSync: new (path: string) => Sqlite }
  const sqlite = new DatabaseSync(':memory:')
  for (const table of schema.tables) {
    const cols = table.columns.map((c) => `"${c.name}" ${c.type}`).join(', ')
    sqlite.exec(`CREATE TABLE "${table.name}" (id TEXT PRIMARY KEY, ${cols})`)
  }
  sqlite.exec('CREATE UNIQUE INDEX op_log_idem ON op_log (idempotency_key)')
  const run = (sql: string, params: unknown[] = []) => sqlite.prepare(sql).run(...(params as never[]))
  const all = <T>(sql: string, params: unknown[] = []) => sqlite.prepare(sql).all(...(params as never[])) as T[]
  const tx: SyncTx = {
    async execute(sql, params) {
      run(sql, params)
    },
    async getAll<T>(sql: string, params?: unknown[]) {
      return all<T>(sql, params)
    },
  }
  let depth = 0
  const db: LocalDb = {
    async writeTransaction(cb) {
      if (depth > 0) throw new Error('nested writeTransaction')
      sqlite.exec('BEGIN')
      depth++
      try {
        const result = await cb(tx)
        sqlite.exec('COMMIT')
        return result
      } catch (e) {
        sqlite.exec('ROLLBACK')
        throw e
      } finally {
        depth--
      }
    },
    getAll: async (sql, params) => all(sql, params),
    get: async <T>(sql: string, params?: unknown[]) => {
      const rows = all<T>(sql, params)
      if (rows.length === 0) throw new Error('Result set is empty')
      return rows[0]
    },
    execute: async (sql, params) => run(sql, params),
  }
  return { sqlite, db }
}
