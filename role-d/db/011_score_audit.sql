-- Chạy sau khi A đã tạo rounds/answers và B đã tạo player_scores.
-- Điểm kỳ vọng của môn học: 1 điểm cho mỗi đáp án đúng, 0 điểm nếu sai hoặc bỏ trống.
-- Cùng điểm thì cùng hạng (hạng cuộc thi: 1, 2, 2, 4).

CREATE OR REPLACE VIEW score_audit AS
SELECT
  ps.room_id,
  ps.player_id,
  ps.points AS stored_points,
  COALESCE(counts.correct_count, 0) AS expected_points,
  COALESCE(counts.accepted_count, 0) AS accepted_answers,
  ps.points - COALESCE(counts.correct_count, 0) AS point_delta
FROM player_scores AS ps
LEFT JOIN (
  SELECT
    r.room_id,
    a.player_id,
    COUNT(*) AS accepted_count,
    COUNT(*) FILTER (WHERE a.is_correct) AS correct_count
  FROM answers AS a
  JOIN rounds AS r ON r.id = a.round_id
  GROUP BY r.room_id, a.player_id
) AS counts
  ON counts.room_id = ps.room_id
 AND counts.player_id = ps.player_id;

COMMENT ON VIEW score_audit IS
  'point_delta khác 0 nghĩa là điểm worker không khớp đáp án đã nhận. Razzia gốc tính điểm theo thời gian nên view này chỉ có nghĩa sau khi A/B đổi thành 1 điểm mỗi câu đúng.';
