# ADR 0009: Receipts, printing and sharing

Status: accepted (17 Oct 2026)

## Decision
- One `ReceiptData` feeds every output: ESC/POS bytes, 80/58 mm HTML for the browser print dialog, a PDF and the
  WhatsApp text. Layouts differ by width (32 / 48 columns, 384 / 576 dots).
- **Text path** (all-Latin receipts): ESC/POS text in CP858 with native `GS ( k` QR. **Raster path** (any Devanagari,
  i.e. Hindi or bilingual receipts): the layout is drawn on a canvas with system fonts, thresholded to 1 bit and sent
  as `GS v 0` bands, because thermal printers cannot print Devanagari. The PDF embeds the same bitmap, so Hindi needs
  no font embedding.
- **Transports**: WebUSB, Web Serial, Web Bluetooth (BLE services of common thermal printers) behind one interface with
  chunked writes. Firefox and iOS Safari have none of these: the CSS print fallback is the route there.
- **QR**: a static receipt QR carries the merchant UPI ID; when part of the bill is "customer owes" the QR is dynamic
  (`upi://pay?pa&pn&am&cu=INR`, amount = the unpaid part). A card tender stores only an optional last-4/slip
  reference; a 13-19 digit Luhn-valid string is refused.
- **WhatsApp** uses a `wa.me` link opened from a tap. Offline, the receipt text is queued in the local-only
  `share_queue`; Home offers "send" once the device is online (an intent must start from a user gesture).
- **Not verified on hardware.** All printing is tested against fakes and golden bytes. The Phase 1 exit hardware
  matrix (58 and 80 mm printers over USB/BLE, code pages, native QR support, cutter command, Devanagari shaping, real
  time-to-first-paper) is still to be run.
