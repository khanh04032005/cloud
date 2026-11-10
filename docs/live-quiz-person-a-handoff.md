# Bàn giao cuối phần người A — Backend Razzia

Ngày thực hiện: 10/11/2026, làm trước lịch dự kiến của tuần 5–8. Nhánh: `feat/razzia-multi-replica-room-state`. Tuần 5 có commit riêng `e5f3f17`. Các mô tả dưới đây là kết quả local và tài liệu phục vụ tích hợp, không phải kết quả nghiệm thu AWS.

## Phạm vi và trạng thái

| Mốc A trong bảng phân công                                | Kết quả hiện tại                                                                                                            |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Tuần 1–2: luồng game, tách process/đóng gói, schema       | Hoàn thành mã và tài liệu, commit 8a40574. Việc chạy fork local ban đầu do người dùng làm.                                  |
| Tuần 3: state dùng chung, Redis adapter                   | Hoàn thành, commit a0288df.                                                                                                 |
| Tuần 4: đáp án/outbox atomic, một điểm đúng, reconnect DB | Hoàn thành phía A, commit bbf52a9. Worker thật phải do B nối vào.                                                           |
| Tuần 5: lease, health, metrics                            | Hoàn thành và commit e5f3f17.                                                                                               |
| Tuần 6: sửa lỗi khi kiểm thử                              | Đã sửa các lỗi tái hiện tại local; có burst retry và ma trận phục hồi. Còn cần xử lý lỗi nếu load test AWS của D phát hiện. |
| Tuần 7: tham gia failure test                             | Kill backend process thật tại local đã chạy. Kill pod/drain node còn cần môi trường và thao tác của nhóm C/D.               |
| Tuần 8: báo cáo và demo                                   | Tài liệu phần A, chỉ dẫn chạy lại, giới hạn và kịch bản demo đã chuẩn bị. Số đo cloud phải bổ sung sau tích hợp.            |

## Những sửa cuối sau tuần 5

1. `services/game/index.ts: Game.reconnect()` và `handlers/game.ts: manager:reconnect` trả promise thay vì bỏ qua. Hàng đợi phòng chờ ghi socket host xong trước khi chạy lệnh kế tiếp; lỗi ghi được đưa vào luồng xử lý lỗi.
2. `services/game/round-manager.ts: publishAnswers()/resumeStage()` dựng lại SELECT_ANSWER khi DB đã ghi vòng open nhưng runtime vẫn ở SHOW_QUESTION do process dừng giữa hai lần ghi. Giữ closes_at cũ, không gia hạn câu.
3. `services/cloud-game.ts: saveReport()` lưu báo cáo, trạng thái finished của phòng, host và từng người chơi trong cùng transaction; dùng hạng từ điểm DB. Nếu chết sau commit nhưng trước thông báo Socket.IO, reconnect đã đọc được màn kết thúc đúng. Thông báo cuối có thể gửi lại mà không tạo thêm báo cáo.
4. `CloudGame.finishedHost()` và gateway fallback trả snapshot cuối cho đúng host sau khi engine đã được nhả khỏi RAM. Kiểm tra role manager và host_client_id trong DB.
5. `services/metrics.test.ts` kiểm tra histogram tích lũy, tổng/count và gauge, không có nhãn theo room/player. `answers.test.ts` tạo fixture và lease cùng transaction, kết thúc fixture sau từng test để không bị scanner nhận nhầm dữ liệu thử đã hết hạn.

Các đường services/ và handlers/ ở trên nằm trong `packages/socket/src/`.

## Nội dung báo cáo A: Containers và state

Gateway có thể chạy nhiều replica vì danh tính JWT, catalog, phòng, người chơi, đáp án và kết quả có nguồn dùng chung. PostgreSQL là nơi xác nhận dữ liệu bền. Redis phân phối Socket.IO và giữ lease/định tuyến có hạn. Registry, Game, RoundManager và timer vẫn tồn tại trong RAM nhưng được dựng lại từ snapshot. Do đó container không cần giữ độc quyền dữ liệu ván chơi trên filesystem của process.

Cần phân biệt scale gateway với scale phòng: mọi socket có thể nối vào replica bất kỳ; mỗi phòng vẫn chỉ có một coordinator đang giữ lease. Tăng replica giúp phân phối kết nối và nhiều phòng, không chia engine của cùng một phòng chạy đồng thời. Khóa hàng phòng còn tuần tự hóa ghi của coordinator; một phòng rất lớn có thể chạm giới hạn đó. Chưa có số đo đủ để tuyên bố sức chứa 1000 người hay đặt pool/TTL theo tải production.

Nếu coordinator chết, socket trên gateway còn sống giữ kết nối. Socket trên process chết phải reconnect; chúng không tự di chuyển. Replica khác scan lease hết hạn, giành quyền, tải dữ liệu, phục hồi deadline và reconnect các socket còn sống. Host không còn kết nối vẫn giữ được định danh để quay lại, trong thời hạn quản lý phòng.

## Nội dung báo cáo A: Elasticity, partitioning và caching

Phân quyền theo room_id; Redis adapter định tuyến lệnh đến coordinator. Kafka key room_id là hợp đồng cho B. Đây là hai cơ chế khác nhau: Redis phục vụ giao tiếp realtime, Kafka phục vụ xử lý sự kiện bền qua outbox.

Cache/notification Redis có thể mất. Unique DB bảo vệ đáp án đầu tiên và event ID bảo vệ worker idempotent. Hạn lease DB và epoch chặn chủ cũ khi Redis key biến mất hoặc process chạy lại muộn. Khi Redis/DB không sẵn sàng, ưu tiên không ghi bằng quyền không chắc chắn; readiness loại replica khỏi nhận traffic mới. Socket đang mở còn phụ thuộc cách C triển khai và client reconnect.

HPA/Cluster Autoscaler, số node, topology spread và ALB thuộc C. A cung cấp endpoint và hợp đồng env; D thu số đo so sánh fixed replica/autoscale. Không suy ra hiệu năng cloud từ số test đã qua.

## Nội dung báo cáo A: Cloud storage và schema

- `001_live_quiz.sql`: catalog, rooms, players, rounds, answers, outbox, results, processed_answer_events và các khóa/index.
- `002_shared_room_state.sql`: chế độ game, khóa phòng, theo dõi import file.
- `003_durable_answers.sql`: runtime, vị trí câu, session/hiển thị người chơi, answer_keys, báo cáo DB.
- `004_room_leases.sql`: token/epoch/lease_until, kết nối host, host state, deadline pha/auto-advance, closed_at và index scan lease hết hạn.

Đáp án và outbox cùng transaction, ACK sau commit. Khóa phòng/round/player cùng kiểm tra giờ DB bảo vệ deadline. Retry cùng round/player đọc lại đáp án đầu tiên, không sửa nội dung. Worker của B phải chèn event marker và cộng điểm cùng transaction; gateway chờ marker trước công bố kết quả. Báo cáo cuối đối chiếu điểm DB với đáp án đúng rồi lưu snapshot kết thúc atomically.

S3, Lambda import/export thuộc D. A cung cấp schema/catalog/reports để D tích hợp. Media/branding file cũ vẫn cần vị trí lưu chung hoặc tuyến phục vụ phù hợp; chưa chuyển mọi loại file sang S3.

## Kiểm thử thực tế

Kết quả lần chạy đầy đủ ngày 10/11/2026: **239/239 test đạt, 21 tệp**, gồm các test cloud không skip (51,33 giây). Lint các tệp thay đổi, kiểm tra TypeScript backend/frontend và build production đạt. Đây là thời gian bộ kiểm thử, không phải recovery time hay benchmark ứng dụng.

Chạy `pwsh -File scripts/test-cloud.ps1` từ root với Docker, Node 24 và pnpm. Runner tạo DB/Redis tạm, chạy SQL 001–004 và backend thật. Các file test cloud tự skip khi thiếu CLOUD_TEST_*; một lần pnpm test không có các biến này không chứng minh failover đã chạy.

| Nhóm             | Bằng chứng                                                                                                                                                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| answers.test.ts  | ACK atomic/rollback, retry, deadline, socket cũ, stale epoch, lease release muộn; burst 64 retry cho một người chỉ có 1 accepted, 63 duplicate, 1 answer và 1 outbox.                                                  |
| cloud.test.ts    | Hai gateway, chờ B, đổi socket, điểm một, đồng hạng, báo cáo và reconnect qua replica khác.                                                                                                                            |
| failover.test.ts | Kill coordinator sau ACK; giữ deadline/đáp án và hoàn thành ván. Thử thêm lobby, prepared, question, open-gap, expired, results/auto-advance; host và player quay lại, closed_at không ghi lại, báo cáo không lặp câu. |
| metrics.test.ts  | Bucket tích lũy, count/sum, gauge/counter và nhãn không tăng theo người chơi.                                                                                                                                          |
| readiness        | Khi kết nối Redis của service bị ngắt, ready chuyển false; ba HTTP endpoint đáp ứng trong các kịch bản tích hợp.                                                                                                       |

Burst 64 retry là regression tính đúng, không phải benchmark 64 người. Score fixture giả lập transaction của B, không phải Kafka worker thực. Chưa chạy k6, EKS drain node, RDS/Redis failover, Kafka broker failover hoặc đo chi phí.

## Hợp đồng bàn giao

**Cho B:** giữ event_id khi publisher retry; topic answers, key room_id; chỉ đánh dấu published_at sau Kafka ACK. Marker event và cộng điểm một lần cùng transaction. Publish channel razzia:leaderboard sau commit. Xem live-quiz-week-4.md cho truy vấn outbox và trường payload.

**Cho C:** dùng target web/socket, Node socket mặc định 3001, web 3000; /api và /ws đến socket, WebSocket transport; JWT_SECRET giống nhau (tối thiểu 32 ký tự), DATABASE_URL/REDIS_URL và MANAGER_PASSWORD. TTL mặc định 9000 ms. Health và metrics ở socket service. Đặt NTP/giờ các node đồng bộ vì deadline giao diện và mở câu dùng Date.now(), kiểm tra nhận đáp án/lease dùng giờ DB. Giữ metrics nội bộ. Khi nâng từ bản chưa có fencing, dừng replica cũ trước khi chạy đồng thời bản mới; migration không làm bản cũ tự có fencing. SQL chạy một lần đúng thứ tự, không drop schema để nâng cấp.

**Cho D:** giữ roundId khi retry, giữ JWT/clientId khi reconnect; đo riêng server ACK histogram và RTT client. Trước khi kết luận điểm cuối, đối chiếu answers/results/processed_answer_events. Ghi workload, thời điểm kill, epoch, closes_at/closed_at, recovery time, p50/p95, lỗi, lag, CPU/RAM và chi phí trong môi trường đo. Phần A chưa thay thế script k6 hay bảng số liệu của D.

## Kịch bản demo A

1. Trình bày schema và luồng /api → /ws → coordinator → answers/outbox → worker B → results → gateway.
2. Chạy runner local để tái hiện failure cases tự động, hoặc hai replica cùng PG/Redis và worker thật của B để demo giao diện.
3. Tạo một quiz một đáp án đúng; host và player qua replica khác nhau. Trả lời và thử lại: lựa chọn đầu không đổi.
4. Tắt riêng coordinator giữa câu. Quan sát epoch tăng; deadline không đặt lại; reconnect giữ đáp án. Sau B xử lý, điểm đúng bằng một.
5. Kết thúc ván; đọc báo cáo và reconnect cả host/player sau khi phòng rời Registry. Mở /metrics và giải thích ACK là server processing time.
6. Với AWS, C chuẩn bị kill pod/drain node, D đo recovery và tải. Chỉ bổ sung số liệu đã đo; test local không thay bằng chứng này.

## Tra cứu tài liệu

- live-quiz-week-1-2.md: kiến trúc gốc, sự kiện A/B, triển khai A/C.
- live-quiz-week-4.md: đáp án, worker contract, reconnect/report.
- live-quiz-week-5.md: lease/fencing, engine recovery, probe/metrics.
- configuration.md và testing.md: env, migration, lệnh chạy.
- Báo cáo HTML cá nhân Desktop giữ đầy đủ lịch sử và giải thích theo tuần; không đưa AGENTS.md cục bộ vào Git.
