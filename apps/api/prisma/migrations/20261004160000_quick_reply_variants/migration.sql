-- A quick reply rewritten once by the AI for contacts without a name or company, reused afterwards.
ALTER TABLE "quick_replies" ADD COLUMN "variants" JSONB NOT NULL DEFAULT '{}';
