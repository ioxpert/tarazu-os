/** Who is writing and where; comes from the device's SyncConfig. */
export interface CatalogueContext {
  tenantId: string
  storeId: string
  deviceId: string
  actorUserId?: string | null
}
