-- Stage 1B: strictly additive private progress and pending effect obligations.
CREATE UNIQUE INDEX ingress_frontiers_scope_event_key ON ingress_frontiers(workspace_id,channel_id,receipt_id,event_index);
CREATE TABLE ingress_event_progress (
  workspace_id TEXT NOT NULL, channel_id UUID NOT NULL, receipt_id UUID NOT NULL, event_index INTEGER NOT NULL,
  state TEXT NOT NULL, reason TEXT, observation_id UUID, action_id UUID, conversation_id UUID, message_id UUID,
  result JSONB NOT NULL, committed_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ingress_event_progress_pkey PRIMARY KEY(receipt_id,event_index),
  CONSTRAINT ingress_progress_position CHECK(event_index >= 0),
  CONSTRAINT ingress_progress_state CHECK(state IN ('applied','ignored','held','pending_recertification')),
  CONSTRAINT ingress_progress_reason CHECK(state NOT IN ('held','pending_recertification') OR reason IS NOT NULL),
  CONSTRAINT ingress_progress_message CHECK(message_id IS NULL OR conversation_id IS NOT NULL),
  CONSTRAINT ingress_progress_receipt_fkey FOREIGN KEY(workspace_id,channel_id,receipt_id) REFERENCES ingress_receipts(workspace_id,channel_id,id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT ingress_progress_frontier_fkey FOREIGN KEY(workspace_id,channel_id,receipt_id,event_index) REFERENCES ingress_frontiers(workspace_id,channel_id,receipt_id,event_index) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT ingress_progress_observation_fkey FOREIGN KEY(workspace_id,channel_id,observation_id) REFERENCES canonical_observations(workspace_id,channel_id,id) ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT ingress_progress_action_fkey FOREIGN KEY(workspace_id,channel_id,action_id) REFERENCES canonical_actions(workspace_id,channel_id,id) ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT ingress_progress_conversation_fkey FOREIGN KEY(workspace_id,channel_id,conversation_id) REFERENCES conversations(workspace_id,channel_id,id) ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT ingress_progress_message_fkey FOREIGN KEY(workspace_id,conversation_id,message_id) REFERENCES messages(workspace_id,conversation_id,id) ON DELETE NO ACTION ON UPDATE CASCADE
);
CREATE UNIQUE INDEX ingress_event_progress_scope_event_key ON ingress_event_progress(workspace_id,channel_id,receipt_id,event_index);
CREATE INDEX ingress_event_progress_scope_state_idx ON ingress_event_progress(workspace_id,channel_id,state,committed_at);
CREATE TABLE ingress_effects (
  id UUID NOT NULL, workspace_id TEXT NOT NULL, channel_id UUID NOT NULL, receipt_id UUID NOT NULL, event_index INTEGER NOT NULL,
  conversation_id UUID, message_id UUID, kind TEXT NOT NULL, logical_key TEXT NOT NULL, cause JSONB NOT NULL, frozen JSONB NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ingress_effects_pkey PRIMARY KEY(id),
  CONSTRAINT ingress_effect_pending CHECK(state = 'pending'),
  CONSTRAINT ingress_effect_message CHECK(message_id IS NULL OR conversation_id IS NOT NULL),
  CONSTRAINT ingress_effects_progress_fkey FOREIGN KEY(workspace_id,channel_id,receipt_id,event_index) REFERENCES ingress_event_progress(workspace_id,channel_id,receipt_id,event_index) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT ingress_effects_conversation_fkey FOREIGN KEY(workspace_id,channel_id,conversation_id) REFERENCES conversations(workspace_id,channel_id,id) ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT ingress_effects_message_fkey FOREIGN KEY(workspace_id,conversation_id,message_id) REFERENCES messages(workspace_id,conversation_id,id) ON DELETE NO ACTION ON UPDATE CASCADE
);
CREATE UNIQUE INDEX ingress_effects_scope_logical_kind_key ON ingress_effects(workspace_id,channel_id,logical_key,kind);
CREATE INDEX ingress_effects_state_created_at_idx ON ingress_effects(state,created_at);
-- Stage 1B cannot rewrite captured causality or mark unimplemented handlers done.
CREATE TRIGGER ingress_progress_immutable BEFORE UPDATE ON ingress_event_progress FOR EACH ROW EXECUTE FUNCTION ingress_immutable_fact();
CREATE TRIGGER ingress_effect_immutable BEFORE UPDATE ON ingress_effects FOR EACH ROW EXECUTE FUNCTION ingress_immutable_fact();
