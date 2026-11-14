import type { Pool } from "pg"

/** Simulates B's committed database contract for A's integration tests. */
export const applyScoreFixture = (pool: Pool, roomId: string) =>
  pool.query(
    `WITH fresh AS (
     INSERT INTO processed_answer_events (event_id)
     SELECT o.event_id FROM outbox o JOIN answers a USING (round_id, player_id)
     WHERE a.room_id = $1 ON CONFLICT DO NOTHING RETURNING event_id
   ), increments AS (
     SELECT a.room_id, a.player_id, sum(CASE WHEN a.is_correct THEN 1 ELSE 0 END)::integer AS points
     FROM answers a JOIN outbox o USING (round_id, player_id) JOIN fresh USING (event_id)
     GROUP BY a.room_id, a.player_id
   )
   INSERT INTO results (room_id, player_id, points) SELECT room_id, player_id, points FROM increments
   ON CONFLICT (room_id, player_id) DO UPDATE SET points = results.points + EXCLUDED.points`,
    [roomId],
  )
