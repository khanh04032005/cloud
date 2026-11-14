# Hợp đồng schema — đề xuất của vai D

A chưa đẩy migration. Các file SQL trong `db/` là hợp đồng để Lambda và câu đối chiếu điểm biên dịch được. Nếu A đổi tên cột, chỉ sửa `lambda/export-results/logic.mjs` và `db/011_score_audit.sql`.

## Đã chốt với B (không đổi)

Event `answer_accepted`, topic `answers`, key `room_id`:

```json
{
  "event_id": "uuid",
  "room_id": "text",
  "round_id": "text",
  "player_id": "text",
  "choice": [1],
  "is_correct": true,
  "accepted_at": "2026-10-31T12:00:00.250Z"
}
```

`player_id` là `clientId`, không phải socket id. Bảng `player_scores(room_id, player_id, points)` và `outbox` thuộc B. Điểm đúng là 1, điểm sai là 0.

## D tạo và sở hữu

`db/010_question_sets.sql`: `question_sets`, `questions`. Lambda nạp câu hỏi ghi hai bảng này trong một transaction. Cùng `(s3_bucket, s3_key, s3_etag)` thì lần ghi sau bị bỏ qua.

## D cần A tạo

`db/000_proposed_for_A.sql`: `rooms`, `players`, `rounds`, `answers`.

`answers` có `PRIMARY KEY (round_id, player_id)` và `event_id` duy nhất. `choice` là JSON mảng số, cùng kiểu với field `choice` của B.

`question_sets.id` là đích của `rooms.question_set_id`. Cột đó để nullable cho đến khi A nối phòng với bộ câu hỏi.

## Đối chiếu điểm

Sau khi A và B đã tạo bảng, chạy `db/011_score_audit.sql` rồi `experiments/score-audit.sql`. `point_delta` khác 0 là lỗi. Razzia 4.0.2 vẫn tính điểm theo thời gian trong bộ nhớ, nên câu SQL này chỉ có nghĩa sau khi pipeline 1 điểm/câu của A và B chạy thật.
