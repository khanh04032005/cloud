# Vai B — Data streaming

Pipeline dùng schema chung tại `packages/socket/migrations/`. Hợp đồng đầy đủ: [Database A–B–D](database-schema.md).

## Chạy local

```bash
docker compose -f compose.full.yml up -d --build
```

Compose chạy migration 001–007, tạo topic answers (3 partition), hai gateway, publisher, score và stats worker. Mở http://localhost:8080/manager, mật khẩu local `admin`. Không dùng schema/seed riêng của B; tạo đáp án qua game thật.

Worker dùng DATABASE_URL, REDIS_URL, KAFKA_BROKERS, KAFKA_TOPIC (answers), OUTBOX_POLL_MS (500), OUTBOX_BATCH_SIZE (100), STATS_DEDUP_MODE (bloom/db). METRICS_PORT ghi đè cổng mặc định publisher/score/stats 9101/9102/9103.

## Hợp đồng và xử lý

Publisher JOIN outbox/answers theo round_id/player_id, khóa riêng hàng outbox bằng SKIP LOCKED. Payload có choice integer/null và answer_keys array; các ID là UUID, accepted_at ISO timestamp. Kafka key room_id. Gửi acks=all rồi mới đánh dấu published_at. Crash giữa broker ACK và DB commit có thể phát lại cùng event_id (at least once).

Cả score/stats worker đối chiếu event với outbox/answers trước dedup và trước mọi ghi DB/Redis. Event bị đổi phòng hoặc nội dung bị từ chối; cùng một client ở nhiều phòng không làm mất cách ly dữ liệu. Giữ answers/outbox khi cần replay.

Score worker ghi processed_answer_events và results cùng transaction: đúng 1 điểm, sai 0. Sau commit phát channel Redis razzia:leaderboard với payload {"room_id":"<UUID>"}. Gateway A đọc lại results. Publish Redis lỗi thì Kafka offset chưa commit; retry không cộng điểm lần nữa và vẫn thử gửi notification.

Stats worker dùng stats_processed_events riêng, gom answer_rate_buckets theo giây của accepted_at và Redis PFADD/PFCOUNT theo room. Bloom chỉ giảm truy vấn kiểm tra trước; khóa duy nhất PostgreSQL quyết định chống trùng, kể cả sau restart. Cổng metrics cung cấp lag, event count, duplicate và số precheck.

## Replay và kiểm tra

Dừng publisher và cả hai worker khi chụp baseline/reset offset để không có dữ liệu mới trong lúc đối chiếu. Chạy scripts/replay.mjs reset trong môi trường có DATABASE_URL/KAFKA_BROKERS đúng; khởi động workers, đợi cả hai group lag về 0 rồi chạy verify với cùng file .replay-baseline.json. Replay so sánh từng hàng điểm và bucket, không chỉ tổng. Khi xong chạy role-d/experiments/score-audit.sql, kỳ vọng 0 dòng.

`pnpm --filter @razzia/streaming test` dùng toàn bộ migration thật trên PGlite. `test:integration` chơi một ván qua Kafka thật trong môi trường test riêng, gồm gửi trùng, phát lại event, export và audit; xem database-schema.md cho biến môi trường.

## AWS

Kafka KRaft 3.9.1 chạy trên EC2 theo kafka/setup-ec2.sh. Pod dùng private IP:9092, security group chỉ mở từ ứng dụng. Một broker, replication factor 1 không có broker failover. C triển khai publisher, score, stats thành ba Deployment dùng cùng worker image; mỗi group xử lý song song tối đa theo số partition.
