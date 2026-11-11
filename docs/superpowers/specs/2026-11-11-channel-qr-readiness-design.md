# Verified WhatsApp pairing QR display

User-authorized behavior: wait before inviting scanning, and display only the actual WhatsApp pairing QR. A blue provider image is not proof of validity or invalidity: Evolution can configure the QR color.

Validate pairing structure from raw text or decoded provider images; generate verified data consistently in black and white. Reject URLs unrelated to WhatsApp pairing, arbitrary text, malformed images and expired data. Keep scan instructions and countdown behind the same ready state. On a replacement, hide the previous QR synchronously and fence asynchronous image decoding/rendering by the complete source identity. Preserve provider/channel event scoping and existing connection lifecycle behavior.

Prevent overlapping Evolution QR requests from the same UI using an in-flight ref and disable its button while pending. Do not restart/reset sessions, alter provider configuration, or automatically relink phones as part of display validation.

Tests: real generated synthetic QR images, raw legacy and linked-devices payloads, unrelated blue QR, malformed image, expiry, stale async completion, provider isolation, duplicate clicks and existing channel flows. No production QR content or customer messages in fixtures.

Production investigation: HTTP request counts are not manual click counts or successful pairings. Provider failure causality beyond observed connection states remains separate from the display fix.
