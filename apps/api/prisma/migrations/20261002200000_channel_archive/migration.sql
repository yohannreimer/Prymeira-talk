-- Archived channels are hidden and stopped while their conversations are kept.
ALTER TABLE "channels" ADD COLUMN "archived_at" TIMESTAMP(3);
