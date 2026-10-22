-- Canonical messaging does not require workspace_mirrors. Its unrelated row lock
-- would invert the messaging/settings lock order; scoped channel/conversation/message
-- foreign keys already enforce attribution tenant ownership.
ALTER TABLE "ctwa_attributions" DROP CONSTRAINT "ctwa_attributions_workspace_id_fkey";
