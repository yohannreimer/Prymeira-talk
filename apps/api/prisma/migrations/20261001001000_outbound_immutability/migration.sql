-- Append-only private evidence: a scope-owned parent deletion may cascade for
-- retention/workspace removal, but direct edits/deletions cannot rewrite proof.
CREATE FUNCTION outbound_immutable_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND pg_trigger_depth()>1 THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Outbound evidence is immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER outbound_results_immutable BEFORE UPDATE OR DELETE ON outbound_results FOR EACH ROW EXECUTE FUNCTION outbound_immutable_evidence();
CREATE TRIGGER outbound_bindings_immutable BEFORE UPDATE OR DELETE ON outbound_bindings FOR EACH ROW EXECUTE FUNCTION outbound_immutable_evidence();
CREATE FUNCTION outbound_immutable_frontier() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='outbound_intents' THEN
    IF (to_jsonb(OLD)-'state'-'reason') IS DISTINCT FROM (to_jsonb(NEW)-'state'-'reason') THEN
      RAISE EXCEPTION 'Outbound request and origin are immutable' USING ERRCODE='23514';
    END IF;
  ELSE
    IF (to_jsonb(OLD)-'phase') IS DISTINCT FROM (to_jsonb(NEW)-'phase') THEN
      RAISE EXCEPTION 'Outbound attempt source and fences are immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER outbound_intents_immutable BEFORE UPDATE ON outbound_intents FOR EACH ROW EXECUTE FUNCTION outbound_immutable_frontier();
CREATE TRIGGER outbound_attempts_immutable BEFORE UPDATE ON outbound_attempts FOR EACH ROW EXECUTE FUNCTION outbound_immutable_frontier();
ALTER TABLE outbound_intents ADD CONSTRAINT outbound_intents_state CHECK(state IN ('prepared','dispatching','accepted_unbound','uncertain','review','canceled','definitively_rejected','bound'));
ALTER TABLE outbound_attempts ADD CONSTRAINT outbound_attempts_phase CHECK(phase IN ('dispatching','accepted','uncertain','definitively_rejected'));
ALTER TABLE outbound_results ADD CONSTRAINT outbound_results_outcome CHECK(outcome IN ('accepted','uncertain','definitively_rejected'));
ALTER TABLE outbound_intents ADD CONSTRAINT outbound_intents_nonempty_origin CHECK(length(origin_id)>0 AND length(request_key)>0 AND action_ordinal>=0);
-- Only a proven local pre-I/O validation rejection may release this frontier.
-- Any uncertain/accepted observation permanently prevents another dispatcher.
CREATE UNIQUE INDEX outbound_attempts_single_frontier ON outbound_attempts(workspace_id,channel_id,intent_id) WHERE phase IN ('dispatching','accepted','uncertain');
