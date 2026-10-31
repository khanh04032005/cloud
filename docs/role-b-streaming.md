# Vai B — Data streaming

Package `packages/streaming` cung cấp pipeline `outbox → Kafka → score/stats workers`. Nó dùng PostgreSQL cho trạng thái bền, Redis Pub/Sub cho leaderboard, Redis HyperLogLog cho số người chơi duy nhất. Code Razzia gốc hiện chưa có PostgreSQL/outbox; vai A cần nối phần ghi đáp án theo hợp đồng bên dưới.

## Chạy local

Yêu cầu: Node.js 24, pnpm theo `packageManager` của repo, Docker Compose.

1. `pnpm install`
2. `docker compose -f compose.streaming.yml up -d`
3. `node packages/streaming/scripts/create-topic.mjs`
4. Mở ba terminal, chạy `pnpm --filter @razzia/streaming start:publisher`, `pnpm --filter @razzia/streaming start:score`, `pnpm --filter @razzia/streaming start:stats`.

PostgreSQL local được khởi tạo từ `db/001_streaming.sql` và `db/002_dev_outbox.sql`. File thứ hai chỉ là mẫu hợp đồng để chạy local; trên ứng dụng thật, A tạo bảng outbox. Topic `answers` có 3 partition, key là `room_id`: mọi đáp án trong một phòng vào cùng partition và giữ thứ tự; các phòng khác có thể xử lý song song. Một broker có replication factor 1, phù hợp thí nghiệm, không có failover.

Biến môi trường: `KAFKA_BROKERS` (mặc định `localhost:9092`, phân tách bằng dấu phẩy), `KAFKA_TOPIC` (`answers`), `DATABASE_URL`, `REDIS_URL`, `OUTBOX_POLL_MS` (`500`), `OUTBOX_BATCH_SIZE` (`100`), `STATS_DEDUP_MODE` (`bloom` hoặc `db`), `METRICS_PORT` (ghi đè cổng metric của từng process). Metrics ở `:9101`, `:9102`, `:9103/metrics` nếu chạy ba process trên cùng máy.

Để tạo một event thử mà không cần code của A, chạy `node packages/streaming/scripts/seed-answer.mjs demo-room demo-player true`. Publisher sẽ gửi rồi đánh dấu `published_at`. Xem kết quả bằng `node packages/streaming/scripts/stats-query.mjs demo-room`.

## Hợp đồng A ↔ B

Vai A tạo bảng `outbox` theo mẫu trong migration và ghi hàng vào **cùng transaction** với đáp án đã nhận. A phải bảo đảm `UNIQUE(round_id, player_id)` ở bảng answers; B bảo vệ lần nữa bằng `event_id`. Chỉ tạo event khi server đã xác nhận round còn mở và đáp án hợp lệ. `is_correct` phải được tính trên server, không lấy từ client.

```json
{
  "event_id": "a02686ac-e98f-487c-b768-a880a28c0177",
  "room_id": "room-123",
  "round_id": "round-1",
  "player_id": "player-42",
  "choice": [1],
  "is_correct": true,
  "accepted_at": "2026-10-31T12:00:00.250Z"
}
```

`event_id` là UUID ổn định khi retry. `player_id` là định danh người chơi ổn định qua reconnect, không dùng socket ID. A đọc bảng `player_scores` (`room_id`, `player_id`, `points`) hoặc lắng nghe channel `razzia:leaderboard:<room_id>` để hiện bảng điểm. Worker cộng **1 điểm cho đáp án đúng, 0 điểm cho đáp án sai**, không phụ thuộc thời gian.

Khi tích hợp, A dùng `db/002_dev_outbox.sql` làm mẫu rồi chuyển cấu trúc đó vào migration của A. Migration B chỉ tạo các bảng kết quả/khóa chống trùng.

## Hợp đồng B ↔ C / chạy EC2

C tạo EC2, subnet/security group cho Kafka và cho pod đi tới TCP 9092 bằng private IP. Trên EC2, cài Java và Kafka 3.9.1, đặt `KAFKA_HOME` và `PRIVATE_IP`, chạy `kafka/setup-ec2.sh` để format storage KRaft một lần; sau đó chạy lệnh start được script in ra. **Không chạy format lại trên volume đã có dữ liệu.** Cấu hình dùng dynamic quorum một node theo [hướng dẫn Kafka 3.9](https://kafka.apache.org/39/operations/kraft/). Từ host/pod có kết nối mạng tới broker, đặt `KAFKA_BROKERS=<private-ip>:9092` và chạy `scripts/create-topic.mjs`. Chỉ cho phép truy cập broker từ security group của ứng dụng; ví dụ này dùng PLAINTEXT trong mạng riêng cho bài tập.

Pod cần `DATABASE_URL`, `REDIS_URL`, `KAFKA_BROKERS`. C triển khai ba process bằng command trong `package.json`, mỗi process một Deployment để scale và restart riêng. Scrape cổng metrics của từng process; worker expose consumer lag và số event/duplicate. AWS MSK là dịch vụ Kafka managed, giảm việc tự cài và vận hành broker, còn EC2 ở đây minh họa IaaS theo đề.

## Ngữ nghĩa và thí nghiệm

Publisher dùng `SELECT ... FOR UPDATE SKIP LOCKED` để nhiều replica không lấy cùng hàng tại một thời điểm. Nó gửi với `acks=all`, sau đó mới đánh dấu đã gửi. Nếu crash sau khi Kafka nhận nhưng trước commit DB, event có thể xuất hiện lại: đây là **at least once**. Score/stats worker chỉ commit offset sau khi xử lý thành công. `score_processed_events` và `stats_processed_events` chặn cộng điểm/đếm thống kê trùng bằng khóa duy nhất của PostgreSQL. Redis publish có thể lặp, nên consumer UI phải dùng snapshot leaderboard mới nhất.

Stats worker gom event theo giây của `accepted_at` vào `answer_rate_buckets`. Redis `PFADD`/`PFCOUNT` ước lượng số player khác nhau trong mỗi phòng; chạy `node packages/streaming/scripts/stats-query.mjs <room_id>` để xem. Bloom filter là bộ lọc trong RAM: khi cho là event chưa thấy, bỏ qua truy vấn kiểm tra trước; PostgreSQL vẫn là chốt chống trùng. So sánh `STATS_DEDUP_MODE=bloom` với `db` qua `razzia_stats_db_prechecks_total` và `razzia_stats_bloom_false_positive_total`.

Replay: dừng hai worker, chạy `node packages/streaming/scripts/replay.mjs reset`, khởi động lại workers, đợi `razzia_kafka_consumer_lag` về 0 rồi chạy `node packages/streaming/scripts/replay.mjs verify`. Tổng điểm và số đáp án/giây phải giữ nguyên. Cần để các worker dừng khi reset offset; nếu còn chạy, Kafka sẽ từ chối reset.

Backpressure: consumer xử lý từng event trước khi commit offset; khi chậm, lag tăng và không mất event. Theo dõi lag, tốc độ xử lý, CPU/DB và tăng replica hoặc partition sau khi đo. Với 3 partition, mỗi consumer group dùng tối đa 3 worker xử lý song song.

Kiểm thử nhanh: `pnpm --filter @razzia/streaming test`. Bài test dùng PostgreSQL chạy trong bộ nhớ để kiểm tra SQL, replay, cửa sổ 1 giây và retry outbox. Chưa thay thế được bài test end-to-end với Kafka/Redis thật.
