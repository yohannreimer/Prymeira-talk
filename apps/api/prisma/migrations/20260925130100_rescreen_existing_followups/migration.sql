-- Existing visible candidates were never screened when they were created.
-- Recheck them before they can appear as scheduled or reach the delivery worker.
UPDATE "conversation_followups"
SET "status" = 'evaluating', "locked_at" = NULL
WHERE "status" = 'scheduled' AND "active_key" = 'active';
