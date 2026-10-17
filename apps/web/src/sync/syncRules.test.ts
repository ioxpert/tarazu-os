import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { READ_MODEL_TABLES } from './schema'

/**
 * infra/powersync/sync-rules.yaml and READ_MODEL_TABLES must list the same columns for every table, or a device
 * silently loses (or never gets) a field. The yaml package is not installed, so the SELECTs are read with regexes:
 * every `- SELECT <columns> FROM <table>` entry; a column's name is its alias (`AS name`) or the bare identifier.
 * `id` is added by PowerSync and is not part of the column list.
 */
const RULES = readFileSync(resolve(__dirname, '../../../../infra/powersync/sync-rules.yaml'), 'utf8')

function parseRules(text: string): Map<string, string[]> {
  const withoutComments = text
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, ''))
    .join('\n')
  const tables = new Map<string, string[]>()
  for (const m of withoutComments.matchAll(/-\s+SELECT\s+([\s\S]+?)\s+FROM\s+(\w+)/g)) {
    const columns = m[1]
      .split(',')
      .map((c) => c.trim().replace(/\s+/g, ' '))
      .map((c) => {
        const alias = /\sAS\s+(\w+)$/i.exec(c)
        return alias ? alias[1] : c
      })
      .filter((name) => name !== 'id')
    expect(tables.has(m[2]), `table ${m[2]} appears twice in sync-rules.yaml`).toBe(false)
    tables.set(m[2], columns)
  }
  return tables
}

describe('sync-rules.yaml matches the local read-model schema', () => {
  const rules = parseRules(RULES)

  it('parses a plausible number of tables', () => {
    expect(rules.size).toBeGreaterThanOrEqual(Object.keys(READ_MODEL_TABLES).length)
  })

  it('every column name is a plain identifier (no unparsed expressions)', () => {
    for (const [table, columns] of rules) {
      for (const c of columns) expect(c, `${table}: ${c}`).toMatch(/^[a-z_][a-z0-9_]*$/)
    }
  })

  for (const [name, table] of Object.entries(READ_MODEL_TABLES)) {
    it(`${name}: same columns, same order`, () => {
      const expected = table.columns.map((c) => c.name)
      expect(rules.get(name), `${name} is missing from sync-rules.yaml`).toBeDefined()
      expect(rules.get(name)).toEqual(expected)
    })
  }

  it('syncs no table the app does not know', () => {
    expect([...rules.keys()].filter((t) => !(t in READ_MODEL_TABLES))).toEqual([])
  })

  it('the parser itself catches a missing and an extra column', () => {
    const broken = RULES.replace('local_name, brand,', 'brand,').replace('FROM shift WHERE', ', extra_col FROM shift WHERE')
    expect(parseRules(broken).get('product')).not.toEqual(parseRules(RULES).get('product'))
    expect(parseRules(broken).get('shift')).toContain('extra_col')
  })
})
