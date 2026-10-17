import { LABELS, LABEL_KEYS, label, labelIn, labelLines, langNeedsRaster } from './labels'

describe('labels', () => {
  it('has en and hi for every key, pa/gu present but empty', () => {
    for (const k of LABEL_KEYS) {
      expect(LABELS[k].en).not.toBe('')
      expect(LABELS[k].hi).not.toBe('')
      expect(LABELS[k].pa).toBe('')
      expect(LABELS[k].gu).toBe('')
    }
  })
  it('falls back to English for empty languages', () => expect(labelIn('taxInvoice', 'pa')).toBe('Tax Invoice'))
  it('stacks bilingual labels', () => {
    expect(labelLines('customerOwes', 'en+hi')).toEqual(['Customer owes', 'ग्राहक पर बकाया'])
    expect(label('taxInvoice', 'en+hi')).toBe('Tax Invoice / कर चालान')
    expect(labelLines('creditNote', 'en')).toEqual(['Credit Note'])
  })
  it('flags languages that need the raster path', () => {
    expect(langNeedsRaster('en')).toBe(false)
    expect(langNeedsRaster('hi')).toBe(true)
    expect(langNeedsRaster('en+hi')).toBe(true)
  })
})
