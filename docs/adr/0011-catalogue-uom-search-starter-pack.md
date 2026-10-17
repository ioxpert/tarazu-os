# ADR 0011: Catalogue: units of measure, search, duplicates, starter packs, barcodes

Status: accepted (17 Oct 2026)

## Decision
- **Units.** Quantity is milli-units of the product's BASE unit and price is paise per base unit, always. `uom` is
  `{base, units:[{unit, qtyMilli}]}` where `qtyMilli` is how many milli-base-units one of that unit holds
  (piece base: packet 12000, case 288000; kg base: g = 1). Any chain length works ("1 case = 24 packets = 288
  pieces"); loose items use kg/litre with g/ml. The cart always stores the base unit, so receipts and stock agree.
- **Search.** Everything is reduced to a phonetic key (Devanagari is romanised first; vowel length, `ph/f`, `w/v`,
  doubled letters, trailing `h` and similar folds), indexed in memory with prefix and one-edit matching. A Hindi
  query matches an English name and the other way round through `localName`. Measured P95: under 1 ms at 5,000 items
  in Node and in Chromium, with a CI assertion at 100 ms.
- **Duplicates are surfaced, never merged.** An existing barcode blocks a second item (open the existing one). Same
  phonetic name + brand + pack size asks the human ("different - add anyway"). A different size or brand is not a
  duplicate. The server independently raises a `duplicate_barcode` flag for races between devices.
- **Starter packs** (`grocery` 600 SKUs, `general` 226) are JSON chunks built by `npm run build:starter-pack` from an
  authored table. Product ids derive from (store type, packSku), so seeding twice changes nothing. MRPs and tax rates
  are INDICATIVE and typed from general knowledge; barcodes are null on purpose (none are invented; scanning attaches
  the real one). Billing uses the server tax rule for the HSN first and the item rate only as a fallback. Packaged
  items get an MRP price only (retail falls back to MRP), loose items a retail price.
  Treat the data table as append-only: SKUs are positional.
- **Barcodes.** USB keyboard-wedge scanners are detected by timing (a burst ended by Enter), camera scanning uses
  `BarcodeDetector` or lazily loaded zxing-wasm served from our own origin (never a CDN). An unknown barcode looks
  in the local catalogue, then the platform master (`GET /v1/catalogue/master/{barcode}`, 1.5 s budget) and pre-fills
  the form; offline it simply opens an empty form.
- **Platform master** (`master_product`) is global reference data without `tenant_id`, the second exception to rule 3
  after `tax_rule` (ADR 0003). The app role can only read it; ops loads it.
