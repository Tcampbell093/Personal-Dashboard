-- DCC Slice 3 (review fix): genuinely-atomic recommendation supersession.
-- A single `SELECT supersede_daily_recommendation(...)` call is ONE SQL statement, so
-- PostgreSQL rolls the whole thing back on any failure. Inside the function statements run
-- SEQUENTIALLY (unlike writable CTEs, which are snapshot-isolated and cannot modify the same
-- row twice), so: deactivate the old row (superseded_at) → insert the new active row (which
-- now sees the old row deactivated, so the live-only partial unique index does not conflict)
-- → link the old row to the new one (superseded_by_id). All owner-scoped. Returns the new id,
-- or NULL when the old row was already inactive (a concurrent supersession won — the caller
-- then returns the current active row). Additive: creates a function only; no table/data change.
CREATE OR REPLACE FUNCTION supersede_daily_recommendation(
  p_user_id integer,
  p_old_id integer,
  p_recommendation_key varchar,
  p_domain varchar,
  p_signal_type varchar,
  p_source_refs jsonb,
  p_fingerprint varchar,
  p_presented_on date,
  p_snapshot jsonb,
  p_now timestamptz
) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE v_new_id integer;
BEGIN
  UPDATE daily_recommendations
    SET superseded_at = p_now, updated_at = p_now
    WHERE id = p_old_id AND user_id = p_user_id AND deleted_at IS NULL AND superseded_at IS NULL;
  IF NOT FOUND THEN
    RETURN NULL; -- old row was not active (concurrent supersession already won)
  END IF;
  INSERT INTO daily_recommendations
    (user_id, recommendation_key, domain, signal_type, source_refs, signal_fingerprint,
     presented_on, last_presented_at, presented_count, snapshot, response, verification_state,
     created_at, updated_at)
    VALUES (p_user_id, p_recommendation_key, p_domain, p_signal_type, p_source_refs, p_fingerprint,
     p_presented_on, p_now, 1, p_snapshot, 'pending', 'unverified', p_now, p_now)
    RETURNING id INTO v_new_id;
  UPDATE daily_recommendations
    SET superseded_by_id = v_new_id, updated_at = p_now
    WHERE id = p_old_id AND user_id = p_user_id;
  RETURN v_new_id;
END;
$$;
