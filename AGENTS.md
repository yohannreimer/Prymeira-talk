# Messaging changes

Before changing ingress, canonical identity/transactions, provider history, outbound delivery, effects, or their migrations, read [the messaging reference](docs/messaging/README.md) and its source map. Preserve its invariants and qualify the exact candidate revision with [the release gate](docs/operations/release-validation.md).

Use synthetic, owned loopback fixtures only. Production inspection, replay, resets, provider pairing, deployment and publication need explicit task authorization. Never treat a broker ACK, provider acceptance, or uncertain send as delivery proof. Do not automatically resend uncertain operations.
