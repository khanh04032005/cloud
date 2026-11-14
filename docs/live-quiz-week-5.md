# Backend người A — tuần 5

## Kết quả và cách chạy

Coordinator dùng Redis lease với TTL và PostgreSQL fencing. Replica khác dựng lại engine, người chơi, lịch sử và hạn đóng câu từ DB khi chủ cũ mất quyền. Áp dụng migration `004_room_leases.sql` sau 001–003. Dùng DATABASE_URL, REDIS_URL, JWT_SECRET chung và MANAGER_PASSWORD trên mọi replica. `ROOM_LEASE_TTL_MS` mặc định 9000 ms, tối thiểu 1000 ms.

Chạy từ repo root: `pwsh -File scripts/test-cloud.ps1`. Script cần Node 24, pnpm và Docker, tạo PostgreSQL 16/Redis 7 tạm, áp dụng bốn migration, khởi động hai backend rồi chạy Vitest. Failover test tạo backend thứ ba và tắt đột ngột coordinator. Process/container được dừng trong finally; không dùng DB production.

## Tệp và thành phần

Các đường services/ và handlers/ nằm dưới packages/socket/src/.

| Tệp                             | Hàm/thành phần                                                              | Thay đổi                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| migrations/004_room_leases.sql  | rooms, rounds                                                               | Token, epoch, hạn lease, socket host, host snapshot, deadline pha và auto-advance, closed_at. |
| services/leases.ts              | acquireLocked, acquireLease, renewLease, withLease, releaseLease            | SET NX + TTL, Lua so token, khóa hàng phòng và kiểm tra epoch/hạn lease.                      |
| services/coordinator.ts         | RoomCoordinator.cycle/ensure/recover/load/stop                              | Heartbeat, scan phòng hết hạn, tiếp quản một lần, dựng snapshot, nối socket đang sống.        |
| services/cloud.ts               | createRoom, phase, saveLobby, savePlayer, prunePlayers, removeRoom          | Fencing các ghi; tạo phòng và lease cùng transaction; chỉ đóng vòng từ open.                  |
| services/cloud-game.ts          | transaction, broadcast, managerState, managerConnection, accept, saveReport | Ghi state bền có fencing; reconnect đọc DB độc lập tại gateway.                               |
| services/game/index.ts          | constructor, attachLease, assertOwner, resume, sendStatus                   | Game nhận snapshot phục hồi; chỉ phát khi còn quyền; lưu host state.                          |
| services/game/round-manager.ts  | restore, resumeStage, answerWindow, scheduleAutoAdvance                     | Phục hồi pha, hạn câu mở và tự chuyển từ deadline đã lưu.                                     |
| services/game/cooldown-timer.ts | until, abort                                                                | Đếm thời gian còn lại, ngừng khi mất lease; giữ nhịp abort tương thích baseline.              |
| handlers/game.ts                | routeCommand, installRoomRouting, runCommand                                | Chờ phục hồi hoàn tất trước lệnh; xác nhận quyền trong hàng đợi phòng; đo ACK.                |
| index.ts, services/registry.ts  | shutdown, releaseGame                                                       | Dừng engine RAM và nhả lease để tiếp quản, không hủy ván khi dừng replica bình thường.        |
| app.ts, services/metrics.ts     | /metrics, Metrics                                                           | Gauge kết nối/phòng; counter lease/tiếp quản/đóng vòng; histogram ACK.                        |

## Quyết định kỹ thuật

- PostgreSQL giữ dữ liệu bền; Redis giữ lease/định tuyến. RAM chứa cache và engine có thể dựng lại. Đây không phải tuyên bố process hoàn toàn không giữ state.
- Redis SET NX riêng lẻ chưa ngăn process cũ ghi tiếp. Transaction của coordinator khóa hàng phòng rồi so token, epoch, lease_until theo giờ DB. Chủ cũ không thể nhận đáp án, đóng vòng, lưu snapshot hoặc báo cáo sau takeover.
- Hạn lease DB dùng thời điểm lấy trước lệnh Redis; hạn cục bộ dùng performance.now(). Không lạc quan kéo dài quyền do trễ lệnh Redis. Heartbeat sau tối đa min(1000, TTL/3) ms; phục hồi còn phụ thuộc scan, DB, adapter và dựng snapshot.
- Lua gia hạn/xóa chỉ chạy nếu token khớp. Release muộn không xóa lease mới. DB expiry vẫn chặn cấp quyền quá sớm nếu Redis mất key.
- Không đặt lại rounds.closes_at khi tiếp quản. closed_at chỉ ghi khi open → closed. Không mở lại vòng đã đóng.
- Socket.IO là thông báo tạm; reconnect đọc DB. Lệnh host bị mất phản hồi không tự retry để tránh advance hai lần.
- Dừng process bình thường nhả lease để replica khác tiếp quản. Người dùng chủ động rời phòng vẫn theo luật hủy/giữ phòng của game.

## Probe và metrics cho C

GET /health/live xác nhận HTTP đáp ứng; /health/ready kiểm tra PostgreSQL và hai kết nối Redis. GET /metrics trả Prometheus text, không gắn nhãn room/player:

- razzia_connections và razzia_owned_rooms.
- razzia_leases_acquired_total, razzia_leases_lost_total, razzia_rooms_recovered_total, razzia_rounds_closed_total.
- razzia_answer_ack_seconds_bucket, _sum, _count: từ gateway nhận sự kiện trả lời, gồm hàng đợi, đến lệnh hoàn tất/thất bại. Gồm retry và lệnh lỗi; không phải RTT trình duyệt.

C cấu hình quyền truy cập và scrape endpoint nội bộ; phần A không tự triển khai Prometheus/Grafana.

## Kiểm thử tại mốc tuần 5

229 test đạt trên 20 tệp với PostgreSQL/Redis thật và các backend process thật. Lint các tệp sửa, TypeScript backend/frontend và build production đạt.

- failover.test.ts: host/player qua gateway còn sống; nhận đáp án đầu rồi kill process coordinator; epoch tăng một, token đổi, closes_at giữ nguyên; retry trả đáp án cũ; tiếp tục đến báo cáo cuối ván, không trùng outbox.
- answers.test.ts: chặn chiếm lease còn hiệu lực; đổi epoch rồi thử ghi/gia hạn/nhả bằng chủ cũ; token mới giữ nguyên, chủ cũ bị từ chối.
- score-fixture.ts chỉ giả lập transaction dữ liệu của B. Chưa xác minh broker/publisher/consumer Kafka thật. AWS kill pod/drain node, benchmark 100/500/1000 người và autoscale thuộc môi trường C/D, không suy ra từ test local.
