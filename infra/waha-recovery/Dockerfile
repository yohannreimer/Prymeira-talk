FROM devlikeapro/waha:gows-2026.9.1@sha256:5a56c7610bd42336874efac3e2e43e51d7893f3274dcef73f27fa3120da134d6
COPY infra/waha-recovery/pagination.cjs /app/talk-recovery-pagination.cjs
COPY infra/waha-recovery/smoke.cjs /app/talk-recovery-smoke.cjs
ENV TALK_WAHA_RECOVERY_METADATA=true
ENV NODE_OPTIONS="--require=/app/talk-recovery-pagination.cjs"
# Only load modules; no session, provider account, network request or messages.
RUN node -e 'const x=require("/app/dist/core/engines/gows/session.gows.core"); if(!x.WhatsappSessionGoWSCore.prototype.getChatMessages.toString().includes("Missing raw recovery pagination")) process.exit(1); process.exit(0)'
