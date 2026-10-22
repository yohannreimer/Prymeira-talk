-- One canonical inbound message can certify only one native click.
-- Ambiguous later click metadata never creates a second conversion.
CREATE UNIQUE INDEX "ctwa_attributions_scoped_message_key"
ON "ctwa_attributions"("workspace_id", "channel_id", "message_id");
