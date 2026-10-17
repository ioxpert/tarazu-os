import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { hasDevanagari, phoneticKey, phoneticString, phoneticTokens, romanizeDevanagari } from './translit'

describe('romanizeDevanagari', () => {
  it.each([
    ['पारले जी', 'paarle jii'],
    ['मैगी', 'maigii'],
    ['टाटा नमक', 'taataa namak'],
    ['अमूल बटर', 'amuul batar'],
    ['चावल', 'chaaval'],
    ['नमकीन', 'namkiin'],
    ['हल्दी', 'haldii'],
    ['बिस्कुट', 'biskut'],
    ['आटा', 'aataa'],
    ['दूध', 'duudh'],
    ['क्षमा', 'kshamaa'],
    ['ज्ञान', 'gyaan'],
    ['फ़ोन', 'fon'],
    ['गेहूं', 'gehuun'],
    ['५०० ग्राम', '500 graam'],
  ])('%s -> %s', (deva, latin) => {
    expect(romanizeDevanagari(deva)).toBe(latin)
  })
  it('leaves Latin and digits alone and detects Devanagari', () => {
    expect(romanizeDevanagari('Tata Salt 1 kg')).toBe('Tata Salt 1 kg')
    expect(hasDevanagari('पारले')).toBe(true)
    expect(hasDevanagari('parle')).toBe(false)
  })
  it('covers every consonant, vowel and matra without leaving Devanagari behind', () => {
    const all = 'अआइईउऊऋएऐओऔकखगघङचछजझञटठडढणतथदधनपफबभमयरलळवशषसह' + 'ािीुूृेैोौॉंँः' + 'क़ख़ग़ज़ड़ढ़फ़य़' + 'क्ष त्र ज्ञ श्र'
    expect(hasDevanagari(romanizeDevanagari(all))).toBe(false)
  })
})

describe('phoneticKey: spelling variants collapse', () => {
  const same: string[][] = [
    ['parle', 'parley', 'paarle'],
    ['phool', 'fool', 'fuul'],
    ['wheat', 'vheat', 'veat'],
    ['cola', 'kola'],
    ['rock', 'rok'],
    ['zeera', 'jeera', 'jira'],
    ['gee', 'ji', 'jee'],
    ['maggi', 'magi', 'maggie'],
    ['bhujia', 'bujia', 'bujiya'],
    ['dhaniya', 'daniya'],
    ['sugar', 'sugarr'],
    ['biscuit', 'biskut', 'biscut'],
    ['mooli', 'muli', 'mulee'],
    ['khichdi', 'kichdi'],
    ['shampoo', 'sampu', 'sampoo'],
  ]
  it.each(same)('%s', (...words) => {
    const keys = new Set(words.map(phoneticKey))
    expect([...keys].length, `${words.join(' / ')} -> ${[...keys].join(' / ')}`).toBe(1)
  })
  it('keeps clearly different words apart', () => {
    const words = ['salt', 'sugar', 'butter', 'biscuit', 'parle', 'tata', 'amul', 'maggi', 'dettol', 'colgate', 'surf', 'rice', 'atta']
    expect(new Set(words.map(phoneticKey)).size).toBe(words.length)
  })
  it('never returns characters outside [a-zC0-9]', () => {
    fc.assert(fc.property(fc.string({ maxLength: 20 }), (w) => /^[a-zC0-9]*$/.test(phoneticKey(w))))
  })
})

describe('phoneticTokens: Hindi and Latin land on the same keys', () => {
  it('Parle-G in every spelling', () => {
    const keys = ['parle g', 'parley gee', 'parle-g', 'Parle G', 'पारले जी', 'पारले-जी', 'Paarle Jee'].map(phoneticString)
    expect(new Set(keys).size).toBe(1)
  })
  it('Maggi', () => {
    expect(new Set(['maggi', 'magi', 'मैगी'].map(phoneticString)).size).toBe(1)
  })
  it('Tata Salt / Tata Namak', () => {
    expect(phoneticString('टाटा नमक')).toBe(phoneticString('tata namak'))
    expect(phoneticTokens('Tata Salt 1 kg')).toEqual(['tata', 'salt', '1', 'kg'])
  })
  it('splits digits from letters', () => {
    expect(phoneticTokens('56g')).toEqual(['56', 'ji'])
    expect(phoneticTokens('500ml')).toEqual(['500', 'ml'])
  })
})
