# ADR 0001: Web-first PWA, one monorepo, one Spring Boot modular monolith

Status: accepted (17 Oct 2026)

## Context
Target merchants run cheap Android devices and Windows counter PCs; we need offline billing, one team,
and low infrastructure cost (core infra target a few rupees per merchant per month at scale).

## Decision
- Client: React PWA first (installable, offline via SQLite WASM on OPFS with PowerSync Web SDK). Android/iOS later via Capacitor wrapping the same build; React Native is the fallback.
- Backend: Java 21 + Spring Boot modular monolith (Spring Modulith). Go was the alternative; revisit if the team lacks JVM depth.
- Repo: one monorepo so contract, API and clients change in one PR. Split only for separate native teams, access boundaries, or CI that path filters cannot fix.
- Contract: OpenAPI 3.1 is the single source for clients.
- No microservices in the MVP. Candidate splits on measured triggers: AI batch workers, WhatsApp/GST integration gateway.

## Consequences
- Browser storage can be evicted: request persistent storage, show unsynced counts, daily encrypted export, hardware/offline soak in the Phase 1 exit.
- WebUSB/Web Serial printing is Chrome/Edge only; iOS Safari and Firefox are unsupported for billing at launch.
- First spikes (each a PR with a pass/fail note): OPFS durability and multi-tab, WebUSB/Web Serial ESC/POS printing, Vosk WASM Hindi load, PowerSync Web end-to-end with `uploadData()`.
