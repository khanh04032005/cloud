# Backend game tuần 4

Phần A nhận đáp án bằng transaction PostgreSQL, đọc điểm do worker của B cập nhật và khôi phục phiên người chơi từ DB. Áp dụng migration `003_durable_answers.sql` sau hai migration trước rồi khởi động socket với `DATABASE_URL`, `REDIS_URL` và `JWT_SECRET` dùng chung.

## Nhận đáp án

Trong cloud mode, `SELECT_ANSWER` có thêm `roundId`. Client gửi lại ID đó khi trả lời hoặc thử lại.

```json
{
  "gameId": "0193bd11-a101-7d4e-a0a3-13e72a53cf48",
  "roundId": "0193bd11-a102-7e4e-a0a3-13e72a53cf48",
  "data": { "answerKeys": [1] }
}
```

`player:answerAck` trả `status` bằng `accepted`, `duplicate`, `closed`, `invalid` hoặc `forbidden`. Khi chấp nhận hoặc nhận lại đáp án cũ, payload có `roundId`, `answerKeys` và `acceptedAt`. Thông tin đúng/sai chỉ xuất hiện khi hiển thị kết quả vòng. Client cũ vẫn gửi được payload thiếu `roundId`, khi đó server sử dụng vòng hiện tại của coordinator.

`CloudGame.accept()` giữ khóa chia sẻ trên phòng, vòng và thành viên. Hàm xác nhận người chơi còn trong phòng và gửi từ kết nối hiện tại. Nếu đã có đáp án, hàm trả lại đáp án đã lưu, kể cả vòng đã đóng. Với đáp án mới, server lấy giờ DB sau khi giữ khóa và kiểm tra `status` cùng `closes_at`, xác thực lựa chọn, rồi ghi `answers` và `outbox` trong một transaction. Chỉ sau commit mới phát ack thành công. Mã đóng vòng giữ khóa phòng trước khi cập nhật vòng để đồng bộ với các lần gửi đáp án đồng thời.

`players.active` giữ lại dữ liệu thành viên cũ khi họ bị loại khỏi phòng, bảo toàn tham chiếu của đáp án đã nhận. `socket_id` và `connected` quản lý kết nối hiện tại. Luật điểm của cloud mode là mỗi đáp án đúng được một điểm.

## Hợp đồng bàn giao cho B

Publisher và worker Kafka thuộc phần B. Publisher lấy các trường dưới đây từ các hàng outbox chưa gửi, với topic `answers`, key `room_id` và `event_id` giữ nguyên khi thử lại.

```sql
SELECT o.event_id, a.room_id, a.round_id, a.player_id,
       a.choice, a.answer_keys, a.is_correct, a.accepted_at
FROM outbox o
JOIN answers a USING (round_id, player_id)
WHERE o.published_at IS NULL
ORDER BY o.created_at, o.event_id
LIMIT 100
FOR UPDATE OF o SKIP LOCKED;
```

- Với MVP trắc nghiệm một đáp án, `choice` vẫn là chỉ số nguyên bắt đầu từ 0. `answer_keys` bổ sung danh sách lựa chọn để giữ khả năng xử lý các dạng câu hỏi Razzia đang hỗ trợ. Với câu ước lượng hoặc nhiều lựa chọn, `choice` có thể là `null`.
- Sau khi Kafka xác nhận gửi với `acks=all`, publisher đánh dấu `published_at`. Publisher có thể gửi lại cùng event khi bị ngắt giữa lần gửi Kafka và commit DB.
- Score worker chèn `event_id` vào `processed_answer_events` bằng `ON CONFLICT DO NOTHING`. Chỉ cộng `is_correct ? 1 : 0` vào `results(room_id, player_id)` khi chèn được event mới. Hai thao tác phải nằm trong cùng transaction. Sự kiện đáp án sai cũng phải được ghi nhận là đã xử lý.
- Sau commit, worker có thể publish `{"room_id":"..."}` vào Redis channel `razzia:leaderboard`. Các gateway đọc leaderboard từ DB rồi phát `player:updateLeaderboard` cho client cục bộ. Hạng dùng `RANK()` theo điểm để người bằng điểm đồng hạng.
- Giữ lại `processed_answer_events` để replay Kafka vẫn có thể nhận ra event cũ. Dữ liệu `answers` là nguồn đối chiếu cho số điểm cuối cùng.

## Chờ điểm và hoàn thành ván

Sau khi đóng vòng, backend chờ mọi outbox của vòng có ID trong `processed_answer_events`, rồi đọc điểm từ `results` và lựa chọn từ `answers`. Trong thời gian chờ, thao tác advance của host được giữ lại ở màn hiện tại. Auto-advance bắt đầu sau khi kết quả đã được xử lý. Nếu worker đang dừng, vòng chờ đến khi worker trở lại. Dừng game sẽ kết thúc việc chờ.

Khi kết thúc ván, backend kiểm tra điểm trong `results` khớp tổng đáp án đúng đã chấp nhận và ghi báo cáo vào `game_reports`. API `/api/results` đọc được báo cáo qua mọi socket replica. Báo cáo file cũ vẫn có thể được đọc bằng API hiện có. Phần chấm điểm theo tốc độ của bản standalone tiếp tục phục vụ baseline.

## Khôi phục phiên

`player:reconnect` giữ nguyên giao thức. Backend đọc thành viên, pha hiển thị, vòng hiện tại, đáp án đã nhận và điểm từ PostgreSQL, cập nhật socket hiện tại rồi trả `player:successReconnect`. Payload có thêm `acceptedAnswer` gồm `answerKeys` và `acceptedAt`, hoặc `null`. Phiên đã trả lời nhận trạng thái chờ để bảo toàn đáp án đầu tiên. Dữ liệu câu đang mở tiếp tục bỏ lời giải.

Nếu gateway không liên lạc được coordinator, nó vẫn có thể khôi phục bản chụp phiên từ DB và tham gia Socket.IO room. Việc tiếp quản game engine và timer sau khi coordinator chết thuộc mốc lease tuần 5. Tắt tiến trình bình thường vẫn thực hiện quy trình hủy phòng đang hoạt động của tuần 3.

## Kiểm thử

Chạy `pnpm test` với hai socket process và các biến `CLOUD_TEST_*` theo `docs/testing.md`. Database dành cho test phải có cả ba migration. Dùng `GAME_SPEED=5` để rút ngắn bộ đếm giờ.

- `test/answers.test.ts` kiểm tra gửi đồng thời, gửi lại sau khi vòng đóng, deadline, kết nối cũ, người ngoài phòng, lựa chọn không hợp lệ, cạnh tranh với transaction đóng vòng và phục hồi khi thiếu cache Redis.
- `test/cloud.test.ts` kiểm tra hai replica, retry đáp án, đổi kết nối, chờ xử lý điểm, đồng hạng, thông báo leaderboard và báo cáo cuối ván đọc qua replica khác.
- `test/score-fixture.ts` chỉ giả lập transaction dữ liệu mà B phải cung cấp. Test này kiểm chứng hợp đồng của A bằng PostgreSQL và Redis, chưa bao gồm broker hoặc mã worker Kafka của B.
