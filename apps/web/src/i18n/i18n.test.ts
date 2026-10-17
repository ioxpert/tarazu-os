import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import en from './en.json'
import hi from './hi.json'
import { LANGUAGES } from './index'

type Tree = { [k: string]: string | Tree }

function flatten(tree: Tree, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([k, v]) => (typeof v === 'string' ? [prefix + k] : flatten(v, `${prefix}${k}.`)))
}

const enKeys = new Set(flatten(en as Tree))
const hiKeys = new Set(flatten(hi as Tree))
/** 'bill.items' is present when 'bill.items' or its plural forms 'bill.items_one' / '_other' exist. */
const has = (keys: Set<string>, k: string) => keys.has(k) || keys.has(`${k}_one`) || keys.has(`${k}_other`)

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return sourceFiles(p)
    return /\.tsx?$/.test(e.name) && !/\.test\./.test(e.name) ? [p] : []
  })
}

describe('i18n', () => {
  it('Hindi has every English key and nothing extra (Punjabi and Gujarati fall back to English)', () => {
    expect([...enKeys].filter((k) => !hiKeys.has(k))).toEqual([])
    expect([...hiKeys].filter((k) => !enKeys.has(k))).toEqual([])
    expect(LANGUAGES.map((l) => l.code)).toEqual(['en', 'hi', 'pa', 'gu'])
  })

  it('every literal t("key") in the UI exists in English', () => {
    const missing: string[] = []
    for (const file of sourceFiles(join(__dirname, '..', 'ui')).concat(join(__dirname, '..', 'App.tsx'))) {
      const src = readFileSync(file, 'utf8')
      for (const m of src.matchAll(/\bt\(\s*['"`]([a-zA-Z0-9_.]+)['"`]/g)) if (!has(enKeys, m[1])) missing.push(`${file}: ${m[1]}`)
      // dynamic keys: t(`prefix.${x}`) needs at least one key under prefix
      for (const m of src.matchAll(/\bt\(`([a-zA-Z0-9_.]+)\.\$\{/g)) if (![...enKeys].some((k) => k.startsWith(`${m[1]}.`))) missing.push(`${file}: ${m[1]}.*`)
    }
    expect(missing).toEqual([])
  })

  it('interpolation placeholders match between English and Hindi', () => {
    const get = (tree: Tree, key: string): string => key.split('.').reduce<string | Tree>((n, p) => (n as Tree)[p], tree) as string
    const ph = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort()
    for (const k of enKeys) expect(ph(get(hi as Tree, k)), k).toEqual(ph(get(en as Tree, k)))
  })
})
