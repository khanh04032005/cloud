# Báo cáo phần B — Data streaming

## Mục tiêu và phạm vi

Phần B tiếp nhận các đáp án đã được backend xác thực, chuyển chúng qua Kafka, tính điểm và thống kê theo luồng. Backend A xác nhận câu hỏi còn mở, kiểm tra đáp án và ghi đáp án cùng outbox trong một transaction PostgreSQL. Phần B đọc outbox, gửi event Kafka rồi xử lý ở hai consumer group độc lập: `razzia-score` và `razzia-stats`.

Mỗi event mang `event_id`, `room_id`, `round_id`, `player_id`, `choice`, `is_correct`, `accepted_at`. `room_id` được dùng làm Kafka key. Topic có 3 partition để giữ thứ tự event trong từng phòng, đồng thời cho phép các phòng khác nhau xử lý song song. Số partition cũng giới hạn mức song song tối đa của mỗi consumer group ở 3 worker.

## Độ tin cậy và tính điểm

Publisher khóa các hàng outbox chưa gửi bằng `FOR UPDATE SKIP LOCKED`, gửi với `acks=all`, rồi đánh dấu `published_at`. Nếu publisher bị dừng sau khi broker nhận event nhưng trước khi PostgreSQL commit, event có thể được gửi lại. Consumer chỉ commit Kafka offset sau khi xử lý thành công; do đó hệ thống dùng ngữ nghĩa **at least once** ở đường đi này. [Tài liệu thiết kế Kafka](https://kafka.apache.org/41/design/design/) cũng nêu khả năng gửi lại khi producer không biết request trước đã thành công hay chưa.

Để không cộng điểm hai lần, score worker ghi `event_id` vào `score_processed_events` có khóa duy nhất trong cùng transaction với cập nhật `player_scores`. Đáp án đúng cộng 1 điểm, đáp án sai cộng 0 điểm, không xét thời gian. Stats worker dùng khóa duy nhất tương tự cho bảng `answer_rate_buckets`. Sau khi commit DB, score worker phát snapshot leaderboard qua Redis; nếu việc phát Redis lỗi, Kafka offset chưa commit nên worker thử lại mà không cộng điểm trùng.

## Thống kê luồng

Stats worker gom các đáp án theo cửa sổ một giây dựa trên `accepted_at`, lưu số event ở `answer_rate_buckets`. Redis HyperLogLog nhận `PFADD` với `player_id` và trả ước lượng số người chơi khác nhau qua `PFCOUNT`; đây là **ước lượng**, không dùng làm dữ liệu tính điểm. [Tài liệu Redis](https://redis.io/docs/latest/data-types/probabilistic/hyperloglogs/) mô tả cách dùng HyperLogLog cho đếm phần tử duy nhất.

Bloom filter trong RAM chỉ là bộ lọc nhanh: nếu event có thể đã thấy, worker hỏi PostgreSQL trước; nếu chưa thấy, worker bỏ qua truy vấn kiểm tra trước. Lệnh `INSERT ... ON CONFLICT DO NOTHING` và khóa duy nhất của PostgreSQL luôn quyết định cuối cùng, kể cả sau khi worker khởi động lại hoặc Bloom filter báo dương tính giả. Chế độ `STATS_DEDUP_MODE=db` luôn truy vấn trước để so sánh với chế độ `bloom`.

## Hạ tầng IaaS và vận hành

Theo phân công, Kafka chạy chế độ KRaft trên EC2 do C cấp máy và security group. B cấu hình broker và topic. EC2 là máy ảo do nhóm chịu trách nhiệm cài đặt, giám sát, cập nhật và khôi phục Kafka. Một broker với replication factor 1 là điểm lỗi đơn, phù hợp phạm vi thí nghiệm nhưng không có khả năng failover. [Amazon MSK](https://docs.aws.amazon.com/msk/) là lựa chọn managed để giảm công vận hành; báo cáo so sánh dịch vụ này, còn phần làm thật dùng EC2.

Theo dõi `razzia_kafka_consumer_lag`, số event đã xử lý, số event trùng, số truy vấn DB trước khi chèn và dương tính giả Bloom. Khi worker chậm, lag tăng vì offset chưa được commit; nhóm có thể tăng worker tới mức số partition, điều chỉnh batch/poll hoặc đo nút thắt ở DB/Kafka trước khi tăng partition.

## Thí nghiệm local với dịch vụ thật

Ngày 01/11/2026 (giờ Việt Nam), chạy Docker Compose với Kafka 3.9.1 KRaft, PostgreSQL 16 và Redis 7. Publisher và hai worker chạy bằng Node.js 24. Sau khi gửi ba đáp án ở `live-test`, truy vấn trả về 2 người chơi duy nhất, hai người cùng 1 điểm, và hai đáp án đến trong cùng giây được gom vào một bucket có `answer_count = 2`.

**Replay:** dừng hai worker, chạy `replay.mjs reset` để đưa offset của cả hai nhóm về đầu topic, rồi khởi động lại. `replay.mjs verify` trả thành công. Metrics ghi nhận 3 bản trùng ở score worker và 3 bản trùng ở stats worker; lag của cả hai nhóm về 0.

| Chỉ số                                       | Trước replay | Sau replay |
| -------------------------------------------- | -----------: | ---------: |
| Tổng điểm                                    |            2 |          2 |
| Tổng đáp án đã nhận                          |            3 |          3 |
| Số event trùng được chặn ở score / stats     |        0 / 0 |      3 / 3 |
| Consumer lag cuối thí nghiệm (score / stats) |        0 / 0 |      0 / 0 |

**Bloom so với DB-only:** chạy 10 event mới ở chế độ `bloom` và 10 event mới ở chế độ `db`, mỗi chế độ trong một phòng riêng. Cả hai đều ghi đủ 10 đáp án, 10 điểm và `PFCOUNT = 10`. Trên 10 event mới, chế độ Bloom thực hiện **0** truy vấn kiểm tra trùng trước khi chèn; DB-only thực hiện **10**. Không ghi nhận dương tính giả Bloom trong mẫu nhỏ này. Phép đo chỉ chứng minh số truy vấn kiểm tra trước, chưa đo thời gian xử lý hoặc hiệu năng ở tải lớn.

Trong lượt DB-only, một lần đọc `/metrics` cho thấy consumer lag 8 khi sự kiện đang được xử lý; lần đọc sau khi hoàn tất cho thấy lag 0. Đây là quan sát tức thời, chưa phải số lag cực đại. Khi triển khai trên EC2/Kubernetes của nhóm, cần lặp lại phép đo tải và ghi lag cực đại, thời gian bắt kịp, CPU và độ trễ DB trước khi kết luận về backpressure hoặc tăng số worker. Số liệu AWS chưa có vì hạ tầng C và luồng ghi đáp án của A chưa được tích hợp.
