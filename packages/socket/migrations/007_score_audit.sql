BEGIN;

-- Include every player, including those missing a result or an outbox event.
CREATE VIEW score_audit AS
WITH counts AS (
    SELECT a.room_id, a.player_id,
           count(*)::integer AS accepted_answers,
           count(*) FILTER (WHERE a.is_correct)::integer AS expected_points,
           count(*) FILTER (WHERE o.event_id IS NULL)::integer AS missing_outbox,
           count(*) FILTER (WHERE o.event_id IS NOT NULL AND e.event_id IS NULL)::integer AS pending_score_events
    FROM answers a
    LEFT JOIN outbox o USING (round_id, player_id)
    LEFT JOIN processed_answer_events e USING (event_id)
    GROUP BY a.room_id, a.player_id
)
SELECT p.room_id, p.id AS player_id,
       COALESCE(r.points, 0) AS stored_points,
       COALESCE(c.expected_points, 0) AS expected_points,
       COALESCE(c.accepted_answers, 0) AS accepted_answers,
       COALESCE(r.points, 0) - COALESCE(c.expected_points, 0) AS point_delta,
       (r.player_id IS NULL AND COALESCE(c.accepted_answers, 0) > 0) AS missing_result,
       COALESCE(c.missing_outbox, 0) AS missing_outbox,
       COALESCE(c.pending_score_events, 0) AS pending_score_events
FROM players p
LEFT JOIN results r ON r.room_id = p.room_id AND r.player_id = p.id
LEFT JOIN counts c ON c.room_id = p.room_id AND c.player_id = p.id;

COMMIT;
