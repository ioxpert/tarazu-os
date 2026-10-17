# Tarazu OS: product requirements

The living PRD (v1.1, web-first) is maintained as a Claude Doc:
https://claude.ai/code/artifact/55bc8dba-c6b3-460f-9fb8-14755bdda194

Export a snapshot to this file at each phase gate so code review can reference a fixed version.

## Decisions that shape the code (from the PRD)
- Local-first: the device database is the system of record; Postgres in India is the merge point.
- Web first (React PWA on Chrome/Edge: Windows counters and Android), Capacitor Android/iOS apps later from the same code.
- One Java 21 / Spring Boot modular monolith, one OpenAPI contract, self-hosted PowerSync for sync.
- Phase 1 (weeks 0-10): counter MVP for kirana and convenience stores. Phase 2: wholesaler module. Phase 3: channels and finance groundwork.
- Phase 1 exit includes a PWA hardware matrix (USB scanner, 80 mm and Bluetooth printers, camera scan) and a 30-day offline soak.
