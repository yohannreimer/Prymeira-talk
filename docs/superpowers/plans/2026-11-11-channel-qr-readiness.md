# Channel QR Readiness Implementation Plan

**Goal:** Offer scanning only for verified WhatsApp pairing content and prevent overlapping primary QR generation.

**Architecture:** A pure pairing validator plus bounded browser image decoder feed the shared renderer. The renderer owns source-keyed async results and passes readiness to the instruction view. Existing channel/provider routing stays intact.

**Tech Stack:** React, TypeScript, qrcode, jsQR, Vitest/jsdom.

- [x] Add failing validator/renderer tests for placeholder images/text, valid synthetic pairing data, expiry and stale async completion.
- [x] Implement validation/decoding and deterministic black-and-white rendering in qr-display.ts and ChannelQrView.tsx.
- [x] Gate QrStep scan instruction/countdown on renderer readiness; guard primary QR in-flight requests in ChannelsPage and disable the panel action.
- [x] Verify with channel suites, web tests/typecheck/build; inspect only this change's diff and run regression cases.
- [x] Record observed production evidence and remaining limitations separately; prepare reviewable patch without resetting sessions.

Observed validation: 708 web tests in 101 files passed; web typecheck and production build passed; frozen lockfile installation passed. No API or provider code changed. Production deployment remains separate from local validation. WAHA historical failure cause and the actual blue QR content remain unconfirmed.
