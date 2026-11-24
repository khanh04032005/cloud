# EXPERIMENTS: nhật ký thí nghiệm

> Mỗi thí nghiệm ghi đủ: mục tiêu, giả thuyết, cấu hình, cách làm, kết quả, kết luận. **Không điền số chưa đo.**
> Bảng số cho báo cáo: `role-d/experiments/results-template.csv`. Chi phí lấy theo tag `RunId` trong Cost Explorer (thường trễ vài giờ đến một ngày).
> Thời gian bật và tắt mỗi lần chạy trên AWS được tự ghi vào `infra/runs.csv`.

## Mẫu

```markdown
### Exx: <tên ngắn>
- Ngày / người chạy / RunId:
- Mục tiêu: câu hỏi cần trả lời
- Giả thuyết: kết quả dự đoán và lý do
- Cấu hình: commit, image tag, môi trường (local/AWS), instance, replica, số người, số phòng, kiểu chờ
- Cách làm: lệnh đã chạy
- Kết quả: số đo, ảnh Grafana, log
- Kết luận: giả thuyết đúng hay sai; điều gì thay đổi trong thiết kế
- Chi phí:
```

## Chỉ số chuẩn (theo báo cáo của D)

`answer_ack_ms` p50/p95 (từ lúc gửi `player:selectedAnswer` đến khi nhận `WAIT`), đáp án nhận mỗi giây, tỉ lệ lỗi k6, `razzia_kafka_consumer_lag`, CPU máy k6 và CPU app (để biết nút thắt nằm ở đâu), số dòng `score-audit` khác 0, chi phí theo RunId.

---

## Đã chạy

### E00: Smoke test toàn hệ thống ở local
- **Ngày:** 15/11/2026, máy cá nhân, không tốn tiền.
- **Mục tiêu:** image build được chưa; các tầng có nối được với nhau không.
- **Cấu hình:** nhánh `dev` sau commit `cc05af6`, cộng các thay đổi chưa commit. `compose.full.yml`: Postgres 16, Redis 7, Kafka 3.9.1 KRaft (1 node), 2 replica socket, web, proxy nginx, 3 worker.
- **Cách làm:** `docker compose -f compose.full.yml up -d --build`, sau đó curl và đọc log.
- **Kết quả:**

| Kiểm tra | Kết quả |
|---|---|
| Build 4 target | Đạt. Kích thước: web 29 MB, socket 244 MB, worker 258 MB, migrate 28 MB |
| Migration 001–004 | Đạt, ghi vào `schema_migrations` |
| Topic `answers`, 3 partition | Đạt |
| `socket-1`, `socket-2` healthy | Đạt |
| `GET /` qua proxy | 200 |
| `GET /health/ready` qua proxy | 200 |
| WebSocket `/ws` qua proxy | `101 Switching Protocols` |
| publisher | **Lỗi**: `column "room_id" does not exist` |
| score, stats | Khởi động được, chưa có event để xử lý |

- **Kết luận:** phần Docker và nối tầng chạy được. Luồng tính điểm bị chặn bởi xung đột hợp đồng của B (§2.3 mục 1). Chưa chơi thử được một ván trọn vẹn.

### E00b: Kiểm tra tĩnh Terraform
- **Ngày:** 15/11/2026.
- **Kết quả:** `terraform validate` đạt ở cả `infra/bootstrap` và `infra/envs/dev` (Terraform 1.13.4, provider AWS ~> 6.0, module VPC ~> 6.0, EKS ~> 21.0, IAM ~> 6.0). Chưa `plan` hay `apply` trên tài khoản thật.

---

### E00c: Nghiệm thu tích hợp schema A–B–D với Kafka thật
- **Ngày:** 19/11/2026; local, project Compose test riêng.
- **Schema:** migration A 001–004 giữ nguyên; 005 thêm stats, 006 provenance import, 007 audit view. Không thêm room_id/payload vào outbox, không tạo bảng điểm/catalog thứ hai.
- **Cấu hình:** PostgreSQL 16, Redis 7, Kafka 3.9.1 KRaft 3 partition, hai gateway, publisher/score/stats thật; image Node 24. Runner host dùng Node 26 (máy hiện tại), không dùng số đo này làm benchmark.
- **Luồng kiểm tra:** thực thi SQL của Lambda import và kiểm tra S3 delivery trùng; API đọc quiz đã import; host và player qua hai gateway; chơi hai câu; thử gửi lại đáp án khác; đọc báo cáo, export SQL và audit; phát lại event qua Kafka thật.
- **Kết quả:** 4 đáp án accepted, điểm hai người [2, 0]; 8 message replay không thay đổi điểm; tổng thống kê vẫn 4; audit không có sai lệch; không có player_scores, score_processed_events hoặc question_sets.
- **Kiểm thử SQL:** 10 test PGlite dùng migration thật đạt; 4 test Lambda logic đạt. Test ứng dụng: 222 đạt, 17 cloud test skip. Lint phần tích hợp đạt; lint toàn repo còn lỗi có sẵn trong load/questions.
- **Giới hạn:** chưa gọi S3/Lambda AWS, chưa đo hiệu năng cloud hoặc failover trong lượt này.
- **Chạy lại:** pnpm test:streaming, tự dựng và dọn môi trường test riêng.

---

### E00d: Bất biến database và tách dữ liệu theo phòng
- **Ngày:** 19/11/2026; schema test riêng, không thay database dev.
- **Mục tiêu:** không ghép sai phòng/lượt/người chơi khi INSERT hoặc UPDATE; một client tham gia nhiều phòng vẫn có điểm, thống kê và export độc lập.
- **Regression đã tái hiện:** worker cũ tin room_id của event. Với client có membership ở cả hai phòng, event bị đổi phòng không bị từ chối; dedup stats còn có thể PFADD Redis vào phòng sai. Các test mới thất bại trước khi sửa.
- **Sửa:** JOIN outbox/answers để xác thực identity và nội dung event trước marker/score/bucket/Redis, kể cả đường dedup. Không thêm cột hoặc sửa schema.
- **Kết quả:** 24 test SQL/unit đạt; 13 nhóm bất biến chạy lại trên PostgreSQL 16 đều đạt. Lệnh pnpm test:streaming đạt 15/15 test gồm các bất biến và ván Kafka thật: 4 đáp án, replay 8 message, điểm [2,0], thống kê 4, audit 0 sai lệch.
- **Kiểm tra khác:** lint streaming đạt; test ứng dụng 222 đạt, 17 cloud test skip. Toàn bộ tài nguyên test được dọn sau chạy.
- **Phạm vi:** kiểm tra toàn vẹn quan hệ và xử lý event; đây không phải benchmark hoặc nghiệm thu AWS. Replay cần dữ liệu answers/outbox gốc.

---

### E00e: Bất biến nghiệp vụ và trường quản lý room
- **Ngày:** 19/11/2026; dependency Docker riêng, không thay DB dev/AWS.
- **Phạm vi:** một answer/round/player; atomic answer/outbox; deadline; duplicate và tổng điểm; kill coordinator sau commit; lịch sử và game mode độc lập catalog; valid coordinator; locked admission; runtime/current_position, host state và lease fields.
- **Regression:** lease hợp lệ của room B có thể đóng round của room A; test PostgreSQL thật thất bại trước sửa. Đã buộc withLease so khớp room đích, thêm guard attachLease cho Game/CloudGame.
- **Cách làm:** trigger fault injection ở ba điểm transaction; PostgreSQL constraints/snapshot; HTTP/Socket.IO qua hai gateway; SIGKILL process Node thật và chờ takeover; đổi/xóa catalog trước kill và khi ván kết thúc; replay qua Kafka thật.
- **Kết quả:** SQL/unit 31/31; backend thực 53/53 (5 file, 47,91 giây, không skip); PG/Kafka 22/22, điểm [2,0], thống kê 4, audit 0 sai lệch. Backend tsc và lint phần sửa đạt.
- **Tái lập:** pnpm test:cloud và pnpm test:streaming tự dựng/dọn môi trường riêng. File cloud integration chạy tuần tự; 64 request trong bài burst vẫn concurrent. Một lượt chạy file song song đã gặp timeout pool, không tăng timeout production để bỏ qua lỗi.
- **Giới hạn:** đây là kiểm thử correctness tại local; chưa benchmark tải lớn, chưa failover RDS hoặc triển khai AWS.

---

## Kế hoạch

### E01: Baseline Razzia gốc ở local (ưu tiên cao nhất)
- **Mục tiêu:** tìm mức tải mà Razzia 4.0.2 gốc (1 process, state trong RAM) bắt đầu hỏng, và hỏng theo kiểu nào.
- **Giả thuyết** (viết trước khi đo):
  - H1: nút thắt đầu tiên là **CPU của một luồng Node**. Mỗi sự kiện bảng điểm phát tới N người (O(N)), event loop nghẽn. Dấu hiệu: p95 tăng vọt khi CPU kẹt 100% trên đúng 1 core, các core khác rảnh.
  - H2: **burst cuối câu** (kiểu chờ `end`) làm p95 xấu hơn nhiều so với `random` ở cùng số người.
  - H3: RAM theo số kết nối không phải nút thắt đầu tiên.
  - H4 (độ sẵn sàng, không phụ thuộc tải): kill process giữa ván thì mất toàn bộ ván.
- **Cấu hình:** image từ nhánh `main` (target `runner`, hoặc `ralex91/razzia:4.0.2`), 1 container. k6 dùng `role-d/load/k6/player.js`, host dùng `role-d/load/host.mjs`. Bậc tải 50, 100, 200, 500 (và 1000 nếu còn sống). 1 phòng, kiểu chờ `random`; lặp lại với `end`.
- **Lưu ý:** k6 và server chạy chung máy sẽ tranh CPU. Phải ghi CPU của k6, và chỉ coi kết quả này là bậc độ lớn.
- **Metric cho H1** (thêm 16/11): `cooldown_jitter_ms` (độ lệch nhịp `game:cooldown` so với 1000 ms, đại diện độ trễ event loop) và độ lan broadcast: chạy k6 với `BCAST_LOG=1 --console-output=<file>`, rồi `node load/bcast-spread.mjs <file>`. `SHOW_RESULT` được gửi từng người trong vòng `forEach`, nên độ lan của nó cho thấy chi phí O(N). Mỗi câu trả lời còn kích hoạt `game:playerAnswer` gửi cả phòng, nên tổng số tin là O(N²) mỗi câu (xem `ws_msgs_received`).
- **Kết quả:**

| N | mode | ack p50/p95 | join p95 | ws_connect p95 | jitter p95 | lan SHOW_RESULT max | lỗi | CPU server max/avg | CPU k6 max | ws_msgs_received |
|---|---|---|---|---|---|---|---|---|---|---|
| 20 (thử) | random | –/4 ms | – | – | 12 ms | 8 ms | 0% | – | – | – |
| 50 | random | 1,5/7 ms | 80 ms | 177 ms | (chưa có metric) | (chưa có) | 0% (1 VU chết vì bug setTimeout(0), đã sửa) | 11,9%/2,2% | 65% | 45.908 |

**Lượt 17/11/2026** (`scripts/bench/e01.sh`, server cpuset 0 = 1 core, k6 core 1–5, file `~/e01/summary.csv`). CPU server lấy mẫu `docker stats` mỗi 1 s nên đỉnh ngắn bị làm phẳng.

| N | mode | ack p50/p95/max (ms) | join p95 | ws_connect p95 | jitter p95 | lan SELECT/SHOW_RESULT max | lỗi player | CPU server max/avg | CPU k6 max | ws_msgs_received |
|---|---|---|---|---|---|---|---|---|---|---|
| 50 | random | 2/13/120 | 82 ms | 189 ms | 16 ms | 15/13 ms | 0% | 13,5%/3,4% | 33% | 46.275 |
| 100 | random | 2/39/519 | 122 ms | 425 ms | 36 ms | 26/48 ms | 0% | 32,7%/9,3% | 31% | 175.050 |
| 200 | random | 13/93/146 | 194 ms | 1.119 ms | 60 ms | 33/81 ms | 0% | 45,1%/19,9% | 200% | 680.100 |
| 500 | random | **không có câu trả lời nào** | 402 ms | 4.203 ms | (35 mẫu, không tin được) | – | 4,4% (22/500) | 76,9%/3,4% | 81% | 177.993 |
| 50 | end | 145/531/588 | 52 ms | 166 ms | 15 ms | 12/29 ms | 0% | 21,4%/2,1% | 44% | 47.118 |
| 100 | end | 348/637/741 | 111 ms | 342 ms | 24 ms | 31/9 ms | 0% | 45,2%/3,3% | 150% | 176.750 |
| 200 | end | 1.311/2.461/2.869 | 277 ms | 1.080 ms | 28 ms | 37/17 ms | 0% | 67,3%/11,7% | 300% | 683.500 |
| 500 | end | **không có câu trả lời nào** | 423 ms | 4.711 ms | 5 ms | – | 4,4% (22/500) | 76,5%/3,0% | 116% | 202.890 |

- `ws_msgs_received` tăng gần đúng N²: 46k → 175k → 680k khi N tăng gấp đôi (≈ ×3,8 và ×3,9), khớp phân tích O(N²) do `game:playerAnswer` gửi cả phòng.
- Kiểu `end` làm ack p95 tăng 20–40 lần so với `random` ở cùng N (200 người: 2,46 s so với 93 ms), CPU server vẫn chưa kẹt 100% theo mẫu 1 s. Ủng hộ H2.
- **N=500 hỏng do nginx trong image, không phải Node:** `error.log` ghi `1024 worker_connections are not enough, reusing connections` lúc 02:27:59 và 02:48:33 (UTC). Mỗi kết nối qua proxy tốn 2 slot (client + upstream), 478 WS đã chiếm khoảng 956. 22 VU nhận `EOF` ở `/api/auth/session` hoặc `/api/games/join`. 478 người vào phòng, nhận `SHOW_START`, nhưng không nhận câu hỏi nào; server vẫn chạy hết ván và lưu kết quả, các VU ngắt đúng lúc hết `SOCKET_MS` (5 phút). Đây là giới hạn cấu hình của bản gốc, cũng là một điểm hỏng hợp lệ, nhưng chưa đo được giới hạn của Node.
- Cần chạy lại 500 (và 300–400) với `worker_connections` lớn hơn, hoặc gọi thẳng cổng 3001 của Node, để tách hai giới hạn.

### E02: Baseline Razzia gốc trên một EC2
- **Mục tiêu:** số đo sạch hơn E01, k6 chạy trên một máy riêng (`role-d/load/ec2-loadgen.sh`).
- **Cấu hình:** 1 EC2 (ví dụ c6i.large) chạy Razzia gốc, 1 EC2 riêng cho k6, cùng AZ. Kết hợp đo t3 (burstable) với c6i cho chương hypervisor (xem `CPUCreditBalance`).
- **Chi phí dự kiến:** dưới 1 USD.
- **Kết quả:** _chưa chạy_

### E03 đến E14: Bộ thí nghiệm của D trên hệ mới
Ánh xạ vào 12 dòng của `role-d/experiments/results-template.csv`:

| # | Thí nghiệm | Câu hỏi |
|---|---|---|
| 1 | baseline 100/500/1000 người, 1 replica | So sánh trực tiếp với E01 và E02 |
| 2 | 1 phòng và 10 phòng | Partition theo `room_id` có chia tải đều không |
| 3 | burst cuối câu | Outbox và Kafka có tạo backpressure, lag tăng bao nhiêu |
| 4 | 2 replica cố định và HPA | Độ trễ scale (HPA, sau đó Cluster Autoscaler thêm node mất 2–4 phút); kết nối cũ không tự chuyển sang pod mới |
| 5 | gửi trùng và replay | Idempotent ở cả client lẫn consumer |
| 6 | kill pod, drain node | Lease chuyển trong khoảng 9 s; p95 reconnect; điểm cuối có khớp không |

**Điều kiện để bắt đầu:** hợp đồng B đã sửa và tích hợp local đạt ngày 19/11; còn cần Helm chart và `up.sh` chạy được trên AWS.

### Ý tưởng thí nghiệm thêm
- **Độ trễ hiện bảng điểm:** từ lúc đóng câu đến lúc mọi người chơi nhận bảng điểm. Outbox poll 500 ms cộng Kafka được kỳ vọng làm hệ mới **chậm hơn** bản gốc ở mức tải thấp. Cần đo và ghi thật vào báo cáo.
- **Chi phí trên 1.000 người chơi mỗi giờ:** so sánh hệ cố định với autoscale.
- **NAT instance và NAT Gateway:** thời gian kéo image, chi phí data.
