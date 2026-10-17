/** The category tiles of the billing screen. `id` is what product.category stores; labels here are the default names. */
export interface CategoryTile {
  id: string
  en: string
  hi: string
}

export const CATEGORY_TILES: readonly CategoryTile[] = [
  { id: 'atta', en: 'Atta & Flour', hi: 'आटा और मैदा' },
  { id: 'rice', en: 'Rice', hi: 'चावल' },
  { id: 'dal', en: 'Dal & Pulses', hi: 'दालें' },
  { id: 'oil', en: 'Oil & Ghee', hi: 'तेल और घी' },
  { id: 'masala', en: 'Masala & Spices', hi: 'मसाले' },
  { id: 'sugar-salt', en: 'Sugar & Salt', hi: 'चीनी और नमक' },
  { id: 'biscuits', en: 'Biscuits & Cookies', hi: 'बिस्कुट' },
  { id: 'snacks', en: 'Snacks & Chips', hi: 'स्नैक्स' },
  { id: 'namkeen', en: 'Namkeen', hi: 'नमकीन' },
  { id: 'beverages', en: 'Cold Drinks & Juices', hi: 'कोल्ड ड्रिंक और जूस' },
  { id: 'tea-coffee', en: 'Tea & Coffee', hi: 'चाय और कॉफी' },
  { id: 'dairy', en: 'Dairy', hi: 'डेयरी' },
  { id: 'bread-eggs', en: 'Bread & Eggs', hi: 'ब्रेड और अंडे' },
  { id: 'personal-care', en: 'Personal Care', hi: 'पर्सनल केयर' },
  { id: 'home-care', en: 'Home Care', hi: 'घर की सफाई' },
  { id: 'stationery', en: 'Stationery', hi: 'स्टेशनरी' },
  { id: 'packaged-food', en: 'Packaged Food', hi: 'पैकेज्ड फूड' },
  { id: 'baby', en: 'Baby Care', hi: 'बेबी केयर' },
  { id: 'frozen-or-misc', en: 'Frozen & Misc', hi: 'फ्रोजन और अन्य' },
]

export const CATEGORY_IDS: ReadonlySet<string> = new Set(CATEGORY_TILES.map((c) => c.id))
