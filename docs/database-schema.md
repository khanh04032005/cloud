# Database và hợp đồng A–B–D

Nguồn schema duy nhất là `packages/socket/migrations/*.sql`, áp dụng theo thứ tự bằng image `migrate`. Cả app, worker, Lambda và test dùng schema này; không có bộ schema fixture riêng cho B/D.

## Bảng và quyền ghi

| Bảng                      | Dữ liệu                                                 | Thành phần ghi                               |
| ------------------------- | ------------------------------------------------------- | -------------------------------------------- |
| `quizzes`                 | `id text`, subject, game_mode                           | Catalog API, Lambda import                   |
| `questions`               | quiz_id, position bắt đầu từ 1, definition JSONB        | Catalog API, Lambda import                   |
| `rooms`                   | Phòng, trạng thái game, snapshot runtime, lease/epoch   | Backend A                                    |
| `players`                 | Người chơi theo phòng, username, socket/session state   | Backend A                                    |
| `rounds`                  | Câu đang chơi, question_snapshot, deadline              | Backend A                                    |
| `answers`                 | Đáp án đã xác nhận, correctness và thời gian nhận       | Backend A                                    |
| `outbox`                  | event_id, round_id, player_id, created_at, published_at | A tạo; publisher B đánh dấu đã gửi           |
| `results`                 | Tổng điểm theo (room_id, player_id)                     | Score worker B                               |
| `processed_answer_events` | Event đã tính điểm                                      | Score worker B, cùng transaction với results |
| `stats_processed_events`  | Event đã tính thống kê                                  | Stats worker B                               |
| `answer_rate_buckets`     | Số đáp án theo phòng và giây                            | Stats worker B                               |
| `game_reports`            | Snapshot báo cáo cuối ván                               | Backend A                                    |
| `data_imports`            | Marker import catalog từ file local                     | Backend A                                    |
| `quiz_imports`            | Nguồn S3, ETag, SHA-256, license, quiz_id               | Lambda import D                              |

`schema_migrations` theo dõi phiên bản đã áp dụng. `score_audit` là view tính từ players/answers/outbox/results/marker, không lưu thêm bản sao điểm.

## Outbox và sự kiện Kafka

Outbox không lưu `room_id` hay `payload`. Nó tham chiếu đáp án bằng `(round_id, player_id)`; đáp án được ghi cùng transaction với outbox và không bị sửa khi retry. Publisher JOIN answers, khóa riêng hàng outbox bằng `FOR UPDATE OF o SKIP LOCKED`, dựng event rồi gửi Kafka. Chỉ ghi published_at sau broker ACK. Nếu gửi xong nhưng transaction DB lỗi, lần sau vẫn dùng cùng event_id.

Topic `answers`, key `room_id`; tất cả ID sự kiện/phòng/lượt/người chơi là UUID. Payload:

```json
{
  "event_id": "00000000-0000-4000-8000-000000000001",
  "room_id": "10000000-0000-4000-8000-000000000001",
  "round_id": "30000000-0000-4000-8000-000000000001",
  "player_id": "20000000-0000-4000-8000-000000000001",
  "choice": 1,
  "answer_keys": [1],
  "is_correct": true,
  "accepted_at": "2026-11-19T07:00:00.000Z"
}
```

`choice` là integer không âm hoặc null; `answer_keys` giữ toàn bộ lựa chọn, bao gồm nhiều đáp án hoặc giá trị estimation. Không suy diễn lại is_correct ở worker: backend đã xác thực nó khi nhận đáp án. Điểm đúng là 1, sai là 0.

Trước khi xử lý cả event mới lẫn event trùng, score/stats worker JOIN outbox/answers để xác thực event_id, room_id, round_id, player_id và nội dung đáp án. Chỉ dữ liệu khớp nguồn DB mới được ghi điểm, bucket hoặc Redis HLL. Điều này chặn event bị đổi phòng ngay cả khi cùng client tham gia nhiều phòng. Replay cần giữ các hàng answers/outbox gốc.

Score worker chèn processed_answer_events và cập nhật results trong cùng transaction. Sau commit, publish Redis channel `razzia:leaderboard` với `{"room_id":"<UUID>"}`. Gateway đọc snapshot từ results; không truyền một bản leaderboard khác qua Redis. Score/stats commit Kafka offset sau khi xử lý thành công. Hai consumer group có marker riêng để không chặn lẫn nhau.

## Import và export

Lambda import ghi quizzes/questions và quiz_imports trong cùng transaction. Giữ nguyên definition câu hỏi, không tách thành một bộ questions khác. quiz_imports chỉ giữ provenance; không lưu document, subject hay question_count lặp lại. Cùng bucket/key/ETag thì rollback quiz mới và trả duplicate. ETag mới tạo revision catalog mới để không thay câu hỏi đã dùng. Xóa quiz giữ provenance với quiz_id null.

Export dùng players.username, điểm từ results thông qua score_audit, JOIN outbox để lấy event_id và xuất cả answer_keys. Toàn bộ truy vấn export dùng cùng snapshot REPEATABLE READ. Người không trả lời vẫn có trong CSV với 0 điểm. Khi xuất nhiều phòng, hạng được tính riêng từng phòng.

Chạy `role-d/experiments/score-audit.sql` sau khi worker đã xử lý hết. View phát hiện sai điểm, thiếu result khi có đáp án, thiếu outbox, và thiếu marker tính điểm. Audit trong lúc ván đang chạy có thể hiển thị event đang chờ; đó chưa phải kết luận mất dữ liệu.

## Migration và chuyển từ các fixture cũ

001–004 giữ nguyên. 005 thêm bảng thống kê; 006 thêm provenance import; 007 thêm audit view. Dùng `compose.full.yml` để chạy toàn hệ thống, thay cho Compose/schema độc lập trước đây của B. Image migration tự lấy đủ các file mới.

Các fixture cũ của B/D chưa từng là schema chung: đã bỏ player_scores, score_processed_events, question_sets và D.questions khỏi mã/schema hoạt động. Không có alias, view tương thích, trigger hay cột payload bổ sung. Nếu có database thử nghiệm được tạo riêng bằng các fixture cũ, cần xuất dữ liệu và đánh giá chuyển đổi riêng; migration này không tự xóa hoặc giả định chuyển được dữ liệu đó.

## Kiểm tra

`pnpm test:streaming` tự build và dựng project Compose riêng, chạy ván thật rồi dọn container/volume test khi kết thúc (kể cả khi lỗi). Mặc định dùng cổng 18080/25432/26379/13001/13002/29092; đổi bằng `INTEGRATION_APP_PORT`, `INTEGRATION_PG_PORT`, `INTEGRATION_REDIS_PORT`, `INTEGRATION_SOCKET_A_PORT`, `INTEGRATION_SOCKET_B_PORT`, `INTEGRATION_KAFKA_PORT`. Không dùng volume của môi trường dev.

- `pnpm --filter @razzia/streaming test`: chạy SQL thật trên PGlite, dùng toàn bộ migration chung; kiểm tra rollback/replay, import/export và audit.
- `node --test role-d/lambda/export-results/logic.test.mjs`: CSV, ranking và kế hoạch import.
- `pnpm --filter @razzia/streaming test:integration`: dùng môi trường riêng với INTEGRATION_BASE_URL, INTEGRATION_DATABASE_URL, INTEGRATION_KAFKA_BROKERS. Có thể chỉ định INTEGRATION_SOCKET_A/B để host và player qua hai gateway. Runner import quiz, chơi hết ván, thử gửi trùng, phát lại event qua Kafka thật và kiểm tra báo cáo/điểm/thống kê/audit. Không mô phỏng score worker.

## Test bất biến và tách dữ liệu giữa các phòng

`packages/streaming/test/room-invariants.mjs` chứa 13 nhóm test dùng chung, chạy trên PGlite bằng `pnpm --filter @razzia/streaming test` và trên PostgreSQL 16 thật bằng `pnpm test:streaming`.

| Bất biến                                 | Cách kiểm tra                                                                                                                 |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Đáp án thuộc đúng phòng/lượt             | Thử toàn bộ cặp phòng/lượt khác nhau trong fixture ba phòng, kể cả một client có mặt ở cả ba                                  |
| Người trả lời có membership đúng phòng   | Dùng player UUID hợp lệ nhưng chỉ tồn tại trong phòng khác                                                                    |
| UPDATE không phá quan hệ                 | Đổi room_id/round_id/player_id và UPDATE nhiều dòng; lỗi phải giữ nguyên dữ liệu                                              |
| Điểm thuộc membership đúng phòng         | Thử INSERT/UPDATE results với phòng và người chơi không khớp                                                                  |
| Outbox tham chiếu đúng đáp án            | Ghép round/player có thật nhưng không có đáp án tương ứng; thử cả INSERT/UPDATE                                               |
| Unique và CHECK                          | Một answer/outbox mỗi lượt/người; một lượt open/phòng; điểm/count không âm; answer_keys dạng array; finished khớp finished_at |
| Worker không tin routing/nội dung bị sửa | Đổi phòng, lượt, người chơi, lựa chọn, correctness, thời gian hoặc event_id; không được thay điểm/marker/bucket               |
| Dedup không mở đường ghi nhầm phòng      | Thử event đã xử lý, với cả Bloom và DB-only; Redis cũng không được nhận PFADD sai phòng                                       |
| Cùng client ở nhiều phòng vẫn độc lập    | Đối chiếu điểm, bucket, export và Kafka key riêng từng phòng                                                                  |

Mỗi phép ghi bị từ chối đối chiếu SQLSTATE và/hoặc snapshot trước/sau. PostgreSQL chạy cùng bộ migration trong schema test riêng để publisher/scanner của ván Kafka không can thiệp fixture; schema này được xóa khi test kết thúc. Không thay schema dev hay thêm cột để phục vụ test.

Xem [ma trận test nghiệp vụ và room](database-test-cases.md) cho các case atomicity, deadline, crash, catalog, game mode, admission và phục hồi trạng thái. `pnpm test:cloud` chạy các case này với PostgreSQL/Redis và hai backend thật; các test cần biến CLOUD_TEST_* sẽ không bị skip trong runner này.
