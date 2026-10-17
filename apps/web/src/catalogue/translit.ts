/**
 * Phonetic folding for matching item names typed in Latin or Devanagari. The SAME function (phoneticTokens) is used
 * for the index and for the query, so a Hindi query finds a Latin name and vice versa. Keys are lossy on purpose:
 * they only ever decide "could this be the same word", never what is displayed.
 */

// ---- Devanagari -> Latin ---------------------------------------------------------------------------------------

const CONS: Record<string, string> = {
  'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'ng', 'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'ny',
  'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n', 'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
  'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm', 'य': 'y', 'र': 'r', 'ल': 'l', 'ळ': 'l', 'व': 'v',
  'श': 'sh', 'ष': 'sh', 'स': 's', 'ह': 'h',
}
/** Consonant + nukta (U+093C) */
const NUKTA: Record<string, string> = { 'क': 'q', 'ख': 'kh', 'ग': 'g', 'ज': 'z', 'ड': 'r', 'ढ': 'rh', 'फ': 'f', 'य': 'y' }
const VOWELS: Record<string, string> = {
  'अ': 'a', 'आ': 'aa', 'इ': 'i', 'ई': 'ii', 'उ': 'u', 'ऊ': 'uu', 'ऋ': 'ri', 'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au',
  'ऑ': 'o', 'ऍ': 'e', 'ऎ': 'e', 'ऒ': 'o',
}
const MATRAS: Record<string, string> = {
  'ा': 'aa', 'ि': 'i', 'ी': 'ii', 'ु': 'u', 'ू': 'uu', 'ृ': 'ri', 'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au',
  'ॉ': 'o', 'ॅ': 'e', 'ॆ': 'e', 'ॊ': 'o',
}
const DIGITS = '०१२३४५६७८९'
const VIRAMA = '्'
const NUKTA_MARK = '़'
const SCHWA = 'ə'

const DEVA = /[ऀ-ॿ]/
export function hasDevanagari(s: string): boolean {
  return DEVA.test(s)
}

interface Syl {
  c: string
  v: string
}

function wordToLatin(word: string): string {
  const sy: Syl[] = []
  const chars = Array.from(word)
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]
    const last = sy[sy.length - 1]
    if (ch === 'ज' && chars[i + 1] === VIRAMA && chars[i + 2] === 'ञ') {
      sy.push({ c: 'gy', v: SCHWA }) // ज्ञ -> gya
      i += 2
    } else if (CONS[ch]) {
      sy.push({ c: CONS[ch], v: SCHWA })
    } else if (ch === NUKTA_MARK) {
      if (last && last.v === SCHWA) {
        const prev = Object.keys(CONS).find((k) => CONS[k] === last.c)
        const mapped = prev && NUKTA[prev]
        if (mapped) last.c = mapped
      }
    } else if (ch === VIRAMA) {
      if (last && last.v === SCHWA) last.v = ''
    } else if (MATRAS[ch]) {
      if (last && last.v === SCHWA) last.v = MATRAS[ch]
      else sy.push({ c: '', v: MATRAS[ch] })
    } else if (VOWELS[ch]) {
      sy.push({ c: '', v: VOWELS[ch] })
    } else if (ch === 'ं' || ch === 'ँ' || ch === 'ॅ') {
      if (last) last.v = (last.v === SCHWA ? 'a' : last.v) + 'n'
    } else if (ch === 'ः') {
      if (last) last.v = (last.v === SCHWA ? 'a' : last.v) + 'h'
    } else {
      const d = DIGITS.indexOf(ch)
      sy.push({ c: d >= 0 ? String(d) : '', v: '' })
    }
  }
  // schwa deletion: word-final, then medial (V C(ə) C V)
  if (sy.length > 1 && sy[sy.length - 1].v === SCHWA) sy[sy.length - 1].v = ''
  for (let i = 1; i < sy.length - 1; i++) {
    if (sy[i].v === SCHWA && sy[i - 1].v !== '' && sy[i + 1].v !== '' && sy[i + 1].v !== SCHWA) sy[i].v = ''
  }
  return sy.map((s) => s.c + (s.v === SCHWA ? 'a' : s.v)).join('')
}

/** Romanises every Devanagari run in `text`; other characters are untouched. Words are romanised separately. */
export function romanizeDevanagari(text: string): string {
  const t = text.normalize('NFC').replace(/[‌‍]/g, '').replace(/।/g, ' ')
  return t.replace(/[ऀ-ॿ]+/g, (run) => wordToLatin(run))
}

// ---- Latin phonetic key -----------------------------------------------------------------------------------------

function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '')
}

/**
 * Collapses spelling variants of ONE lowercase ascii word into a key. Lossy: 'parley'~'parle', 'phool'~'fool',
 * 'wheat'~'vheat', 'biscuit'~'biskut', 'bhujia'~'bujia'.
 */
export function phoneticKey(word: string): string {
  let s = word.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!s) return ''
  if (/^\d+$/.test(s)) return s
  // digraphs first
  s = s.replace(/chh/g, 'C').replace(/tch/g, 'C').replace(/ch/g, 'C').replace(/ck/g, 'k').replace(/ph/g, 'f').replace(/sh/g, 's')
  s = s.replace(/([bdgkjtzvw])h/g, '$1').replace(/([^aeiou0-9])\1+/g, '$1')
  // letters that Indians interchange; c/g go soft before e, i, y
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    const next = s[i + 1] ?? ''
    switch (ch) {
      case 'c':
        out += /[eiy]/.test(next) ? 's' : 'k'
        break
      case 'g':
        out += /[eiy]/.test(next) ? 'j' : 'g'
        break
      case 'q':
        out += 'k'
        break
      case 'x':
        out += 'ks'
        break
      case 'w':
        out += 'v'
        break
      case 'z':
        out += 'j'
        break
      default:
        out += ch
    }
  }
  s = out
  // y: after a vowel it only colours it (parley, may, boy); between consonants/at the end it is an 'i'
  s = s.replace(/([aeiou])y/g, '$1').replace(/(?<=[^aeiou0-9])y(?![aeiou])/g, 'i')
  // vowel digraphs and long vowels
  s = s.replace(/ai/g, 'a').replace(/au/g, 'o').replace(/ui/g, 'u').replace(/ee/g, 'i').replace(/ii/g, 'i').replace(/oo/g, 'u')
  s = s.replace(/ie$/, 'i')
  // double letters
  s = s.replace(/(.)\1+/g, '$1')
  // trailing h (allah, sunrich, bhaiyah)
  if (s.length > 2) s = s.replace(/h$/, '')
  return s
}

/** Spoken names of single letters that appear as brand suffixes ('Parle G' is said "parle jee"). */
const LETTER_NAMES: Record<string, string> = { g: 'ji' }

/** Raw lowercase latin/digit tokens of a string, after Devanagari romanisation. Digits and letters are split ('56g' -> 56, g). */
export function rawTokens(text: string): string[] {
  const t = stripDiacritics(romanizeDevanagari(text)).toLowerCase()
  return (t.match(/[a-z]+|[0-9]+/g) ?? []).filter(Boolean)
}

/** The phonetic keys of every word in `text` (index and query use this same function). */
export function phoneticTokens(text: string): string[] {
  const out: string[] = []
  for (const raw of rawTokens(text)) {
    const key = phoneticKey(LETTER_NAMES[raw] ?? raw)
    if (key) out.push(key)
  }
  return out
}

/** Space-joined phonetic key of a whole string, e.g. for equality checks between two names. */
export function phoneticString(text: string): string {
  return phoneticTokens(text).join(' ')
}
