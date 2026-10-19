# WAHA recovery pagination metadata

Pinned base: GOWS 2026.9.1 linux/amd64 digest 5a56c7610bd42336874efac3e2e43e51d7893f3274dcef73f27fa3120da134d6.

GOWS filters protocol/reaction records after database pagination. A zero-length HTTP array alone cannot certify exhaustion. The preload adds authenticated recovery-request response headers from the raw gRPC page count. Ordinary requests keep the original implementation. All sessions, events, storage and media handling remain in the pinned provider code.

The worker requires `x-talk-recovery-pagination: 1`, raw count, next raw offset and explicit exhaustion; missing metadata leaves coverage pending. Cursor progress follows canonical persistence. Only metadata is retained on ChannelConnection, and two identical completed window passes advance coverage. Migrations must precede the new worker; install this WAHA image before enabling the worker's filtered method. No automatic fallback to exhaustive polling.

Build: `docker build -f infra/waha-recovery/Dockerfile -t talk-waha-recovery .`.
Rollback: restore the prior worker image first, then the prior WAHA image. Keep added nullable cursor columns and existing sessions/volumes. Never reset recoveredThroughAt to the current time.
