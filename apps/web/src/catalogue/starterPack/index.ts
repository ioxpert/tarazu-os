import type { StarterPackFile, StoreType } from './types'

export type { StarterItem, StarterPackFile, StoreType } from './types'
export { CATEGORY_IDS, CATEGORY_TILES, type CategoryTile } from './categories'

/**
 * Lazy: each pack is its own chunk and is fetched only when a merchant picks a store type, never in first-load JS.
 * (The service worker precaches the chunk, so a device that installed the app has it offline.)
 */
export async function loadStarterPack(type: StoreType): Promise<StarterPackFile> {
  const mod = type === 'grocery' ? await import('./grocery.json') : await import('./general.json')
  return mod.default as unknown as StarterPackFile
}
