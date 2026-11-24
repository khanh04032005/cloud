-- Run after score workers have drained. Expected: zero rows.
-- View is installed by the canonical migration 007_score_audit.sql.
SELECT *
FROM score_audit
WHERE point_delta <> 0
   OR missing_result
   OR missing_outbox > 0
   OR pending_score_events > 0
ORDER BY room_id, player_id;
