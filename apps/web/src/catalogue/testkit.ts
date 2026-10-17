import type { CatalogueItem } from './types'

/** Test helpers only (never imported by app code). */
export function mkItem(p: Partial<CatalogueItem> & { id: string; name: string }): CatalogueItem {
  return {
    localName: null, brand: null, category: null, barcode: null, sku: null, packSku: null, hsn: null,
    unit: 'packet', uom: { base: 'packet', units: [] }, taxInclusive: true, taxRateBp: null, loose: false, pinned: false,
    active: true, mrpPaise: null, retailPaise: null, stockMilli: null, oversold: false,
    ...p,
  }
}

/** Small deterministic PRNG so synthetic catalogues are stable across runs. */
export function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const BRANDS = ['Parle', 'Britannia', 'Tata', 'Amul', 'Aashirvaad', 'Fortune', 'Nestle', 'ITC', 'Haldiram', 'Patanjali', 'Dabur', 'Himalaya',
  'Colgate', 'Dettol', 'Lifebuoy', 'Surf Excel', 'Ariel', 'Vim', 'Harpic', 'Godrej', 'Mother Dairy', 'Cadbury', 'Kissan', 'MDH', 'Everest',
  'Catch', 'Saffola', 'Dhara', 'Madhur', 'Nandini', 'Bikaji', 'Balaji', 'Kurkure', 'Lays', 'Pepsi', 'Coca Cola', 'Thums Up', 'Real', 'Paper Boat',
  'Wipro', 'Santoor', 'Pears', 'Lux', 'Rin', 'Wheel', 'Tide', 'Head & Shoulders', 'Clinic Plus', 'Pantene', 'Ponds', 'Vaseline', 'Nivea', 'Maaza']
const PRODUCTS = ['Biscuit', 'Salt', 'Butter', 'Cheese', 'Atta', 'Rice', 'Dal', 'Oil', 'Tea', 'Coffee', 'Noodles', 'Chips', 'Namkeen', 'Soap',
  'Shampoo', 'Toothpaste', 'Detergent', 'Juice', 'Cola', 'Ghee', 'Paneer', 'Curd', 'Masala', 'Sugar', 'Jam', 'Sauce', 'Pickle', 'Cream', 'Powder', 'Bhujia']
const FLAVOURS = ['Classic', 'Gold', 'Masala', 'Magic', 'Special', 'Premium', 'Fresh', 'Spicy', 'Sweet', 'Salted', 'Plain', 'Choco', 'Mango', 'Orange',
  'Lemon', 'Jeera', 'Elaichi', 'Kesar', 'Pudina', 'Tomato', 'Onion', 'Garlic', 'Crunchy', 'Creamy', 'Light', 'Active', 'Natural', 'Herbal', 'Family', 'Mini']
const SIZES = ['50 g', '56 g', '100 g', '200 g', '250 g', '500 g', '1 kg', '2 kg', '5 kg', '100 ml', '200 ml', '500 ml', '1 L', '2 L', '6 pcs', '12 pcs']
const CATS = ['biscuits', 'snacks', 'dairy', 'atta', 'rice', 'dal', 'oil', 'tea-coffee', 'beverages', 'personal-care', 'home-care', 'masala', 'packaged-food']

/** Realistic-looking synthetic catalogue: brand x flavour x product x size, unique names, deterministic. */
export function syntheticCatalogue(n: number, seed = 7): CatalogueItem[] {
  const r = rng(seed)
  const pick = <T,>(a: readonly T[]) => a[Math.floor(r() * a.length)]
  const out: CatalogueItem[] = []
  const names = new Set<string>()
  let guard = 0
  while (out.length < n && guard++ < n * 20) {
    const brand = pick(BRANDS)
    const name = `${brand} ${pick(FLAVOURS)} ${pick(PRODUCTS)} ${pick(SIZES)}`
    if (names.has(name)) continue
    names.add(name)
    const i = out.length
    out.push(
      mkItem({
        id: `00000000-0000-8000-8000-${String(i).padStart(12, '0')}`,
        name,
        brand,
        category: pick(CATS),
        barcode: r() < 0.7 ? '890' + String(Math.floor(r() * 1e10)).padStart(10, '0') : null,
        sku: r() < 0.2 ? `SKU${i}` : null,
        pinned: r() < 0.01,
        mrpPaise: 500 + Math.floor(r() * 50_000),
      }),
    )
  }
  return out
}
