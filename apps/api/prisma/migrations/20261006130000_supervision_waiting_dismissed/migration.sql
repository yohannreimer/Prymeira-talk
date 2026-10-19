-- The supervisor marked "não precisa responder": customer messages up to this moment no longer count as waiting.
ALTER TABLE "conversations" ADD COLUMN "waiting_dismissed_at" TIMESTAMP(3);
