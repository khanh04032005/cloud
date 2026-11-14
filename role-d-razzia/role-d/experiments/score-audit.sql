-- Đối chiếu sau mỗi thí nghiệm. Kết quả mong đợi: 0 dòng.
-- Chưa có view thì chạy nguyên khối SELECT bên dưới.

SELECT
  room_id,
  player_id,
  stored_points,
  expected_points,
  accepted_answers,
  point_delta
FROM score_audit
WHERE point_delta <> 0
ORDER BY room_id, player_id;

-- Hạng cùng điểm phải trùng nhau.
WITH ranked AS (
  SELECT
    room_id,
    player_id,
    points,
    RANK() OVER (PARTITION BY room_id ORDER BY points DESC) AS rank
  FROM player_scores
)
SELECT room_id, points, COUNT(DISTINCT rank) AS distinct_ranks, COUNT(*) AS players
FROM ranked
GROUP BY room_id, points
HAVING COUNT(DISTINCT rank) <> 1;
