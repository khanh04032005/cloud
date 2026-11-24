# Test bất biến database và trạng thái room

Các test dùng migration chung 001–007. `pnpm test:cloud` tạo PostgreSQL 16/Redis riêng và hai backend từ source, chạy cả kiểm thử crash, sau đó dọn tài nguyên. Các file integration dùng chung DB chạy lần lượt; trong bài burst, 64 request vẫn chạy đồng thời. `pnpm test:streaming` dựng thêm Kafka và các worker thật. Không dùng database dev/AWS.

## Bất biến nghiệp vụ

| Bất biến                                 | Dữ liệu / thao tác                                                                                                         | Điều kiện kiểm tra                                                                                                               | Nơi kiểm tra                                                                  |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Một người tối đa một đáp án mỗi round    | INSERT lặp cùng/chọn khác, 64 lần retry; UPDATE khóa bị trùng; nhiều người và nhiều round                                  | PK round_id/player_id chặn trùng; giữ nguyên lựa chọn, correctness, accepted_at và event_id đầu tiên; round mới vẫn trả lời được | streaming/test/round-answer-invariants.mjs; socket/src/test/answers.test.ts   |
| Answer và outbox commit cùng nhau        | Trigger gây lỗi trước INSERT answer, trước INSERT outbox, sau INSERT outbox                                                | Lỗi rollback cả hai về 0 dòng; retry hợp lệ tạo đúng một cặp; gửi lại không thêm event                                           | socket/src/test/answers.test.ts                                               |
| Không nhận đáp án ngoài thời gian hợp lệ | Round pending/closed/expired; room cancelled/finished; deadline hết khi chờ khóa transaction                               | Không có accepted mới, answer hay outbox; retry đáp án đã commit sau hạn chỉ trả duplicate                                       | socket/src/test/answers.test.ts                                               |
| Event trùng không tăng điểm              | Gửi lại event theo thứ tự thường/đảo ngược nhiều lần; gửi lại qua Kafka thật                                               | Marker duy nhất; điểm và số đáp án thống kê không đổi                                                                            | streaming/test/scoring-invariants.mjs; streaming/scripts/integration.test.mjs |
| Điểm đúng quy tắc                        | Hai người × năm round: người thứ nhất đúng 3, người thứ hai sai hết; thêm người không trả lời. Thay thời gian và maxPoints | Điểm 3/0/0, audit 0 sai lệch; 10 marker cho 10 event, replay không tăng. Backend xác nhận maxPoints 0/1000 không đổi correctness | streaming/test/scoring-invariants.mjs; socket/src/test/answers.test.ts        |
| Crash không mất dữ liệu đã commit        | Sau ACK và transaction tính điểm, SIGKILL coordinator; chờ gateway khác tăng epoch và tiếp quản                            | Answer, event_id và điểm đã commit giữ nguyên; closes_at không được gia hạn; reconnect giữ đáp án; ván kết thúc được             | socket/src/test/failover.test.ts                                              |
| Sửa catalog không đổi lịch sử            | PATCH quiz trước khi chơi và sau khi kết thúc; đổi solutions/subject                                                       | Round question_snapshot giữ nguyên, game vẫn chấm theo snapshot, report không thay đổi                                           | streaming/scripts/integration.test.mjs                                        |
| Chỉ coordinator hợp lệ được ghi          | Thiếu lease, token/epoch sai, lease DB hết hạn, lease hợp lệ nhưng của room khác; owner cũ sau takeover                    | Từ chối trước ghi room/player/answer/phase/cache; owner mới hợp lệ vẫn ghi được. Renew/release không phá lease của successor     | socket/src/test/answers.test.ts; room-state.test.ts                           |

Cặp answer/outbox được kiểm tra qua transaction nhận đáp án thực tế. Không thêm trigger production hay FK vòng; script SQL thủ công vẫn cần tuân thủ hợp đồng ghi này. Các trigger gây lỗi chỉ tồn tại trong database test và được xóa trong finally.

## Admission, game mode và phục hồi trạng thái

| Nhóm                          | Case cụ thể                                                                                     | Điều kiện kiểm tra                                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Room khóa                     | Xin join qua cả hai gateway sau khi khóa                                                        | HTTP 403, không thêm membership                                                                             |
| Vé cấp trước khi khóa         | Xin ticket khi room còn mở, redeem bằng WebSocket sau khi khóa                                  | game:reset với game.locked; không thêm player                                                               |
| Reconnect và mở lại room      | Người đã tham gia reconnect khi khóa; unlock rồi nhận người mới                                 | Người cũ giữ danh tính; người mới chỉ vào được sau unlock                                                   |
| Phạm vi khóa                  | Khóa room A, xin vào room B                                                                     | B vẫn nhận người mới                                                                                        |
| Game mode độc lập catalog     | Cả quiz→survey và survey→quiz trên catalog                                                      | rooms.game_mode và subject giữ snapshot lúc tạo                                                             |
| Xóa game mode / quiz          | PATCH thiếu gameMode, SQL gán NULL, DELETE quiz                                                 | PATCH 400, SQLSTATE 23502; xóa quiz chỉ làm rooms.quiz_id NULL, không đổi room mode; reconnect giữ mode gốc |
| Takeover sau thay đổi catalog | Đổi quiz sang survey, xóa quiz rồi kill coordinator của room quiz                               | Replica mới phục hồi đúng mode quiz và snapshot cũ; điểm/lịch sử không đổi                                  |
| Runtime + vị trí              | Có đáp án round 1, chuyển runtime sang round 2; xóa cache Redis; tạo CloudGame mới để reconnect | Đúng trang/câu thứ 2, điểm round 1 còn nguyên, không lấy nhầm acceptedAnswer/result của round 1             |
| Thời gian còn lại             | Runtime SELECT_ANSWER còn deadline ngắn; sau đó thử expired/closed                              | Không reset countdown; deadline DB không đổi; closed về WAIT; expired có time=0 và không nhận đáp án        |
| Đáp án đã nhận                | Reconnect sau khi trả lời                                                                       | WAIT và đáp án/acceptedAt cũ; socket mới retry không tạo outbox khác                                        |
| State cá nhân                 | SHOW_RESULT cùng state_position với current_position; đối chiếu state cũ khác vị trí            | State cùng round được phục hồi; state round cũ bị bỏ qua                                                    |
| Trạng thái lobby              | runtime NULL, current_position=0                                                                | WAIT waitingForPlayers, currentQuestion NULL                                                                |
| Membership không hợp lệ       | Room cancelled hoặc player inactive                                                             | Không phục hồi, không cập nhật socket identity                                                              |
| Host và settings              | Host reconnect qua gateway khác sau PATCH settings và khóa room                                 | Settings/locked đúng DB; manager_socket_id/connected cập nhật đúng                                          |
| Host cuối ván                 | Xóa cache và reconnect host khi engine đã kết thúc                                              | Đọc được host_state, vị trí, lock, điểm; từ chối host ID khác và role player                                |

## Các trường quản lý room được kiểm tra

| Trường                                | Kiểm tra                                                                                                 |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| status, finished_at                   | Chuyển trạng thái hợp lệ, CHECK tương ứng, không nhận đáp án sau cancelled/finished                      |
| locked, settings                      | Persist khi host cập nhật, kiểm tra admission và host reconnect                                          |
| game_mode, subject, quiz_id           | Snapshot độc lập catalog; quiz_id SET NULL khi quiz bị xóa                                               |
| runtime, current_position             | Reconnect đọc DB, đúng round và nội dung hiển thị                                                        |
| manager_socket_id, manager_connected  | Kết nối/ngắt host, thay host socket khi reconnect                                                        |
| host_state, host_state_position       | Lưu snapshot host; đổi round xóa snapshot cũ; lưu vị trí mới                                             |
| stage_deadline, auto_advance_at       | Persist/clear khi chuyển pha; recovery không đặt lại deadline                                            |
| owner_token, owner_epoch, lease_until | Renew không đổi identity; takeover tăng epoch; lease sai/hết hạn/sai room bị chặn; release ngăn ghi tiếp |

## Cách chạy

```bash
pnpm --filter @razzia/streaming test
pnpm test:cloud
pnpm test:streaming
```

Test SQL PGlite và PostgreSQL dùng chung các helper bất biến. Trong test worker trực tiếp, Redis/producer được thay bằng bộ ghi nhận lời gọi để phát hiện ghi sai. Lượt Kafka dùng broker và worker thật. Kiểm thử crash dùng SIGKILL process Node thật; test deadline dựa vào trạng thái và giờ PostgreSQL, không dùng số benchmark để suy ra tính đúng.

Các test này xác nhận quan hệ dữ liệu và hành vi backend; chưa phải kiểm thử tải lớn, RDS failover hay nghiệm thu AWS.

## Kết quả đã chạy ngày 19/11/2026

| Lệnh                                 | Kết quả               | Phạm vi                                                                                                         |
| ------------------------------------ | --------------------- | --------------------------------------------------------------------------------------------------------------- |
| pnpm --filter @razzia/streaming test | 31/31 đạt             | PGlite, schema chung, quan hệ phòng, một answer/round, tổng điểm/replay, import/export                          |
| pnpm test:cloud                      | 53/53 đạt, không skip | PostgreSQL 16, Redis, hai backend; atomicity, deadline, SIGKILL, lease, lock/mode, trạng thái room và reconnect |
| pnpm test:streaming                  | 22/22 đạt             | Các bất biến trên PostgreSQL và ván qua Kafka thật; 4 đáp án, điểm [2,0], replay 8 message, audit 0 sai lệch    |

Các lệnh có tái sử dụng case; tổng của Node test runner còn bao gồm test cha, không cộng ba dòng để tính số kịch bản độc lập. TypeScript backend, lint các file thay đổi và kiểm tra whitespace đạt.

Regression quan trọng: test đã tái hiện việc dùng lease còn hiệu lực của room B để đổi phase của room A. withLease hiện nhận room đích tường minh và bắt buộc lease.gameId khớp room đó trước khi kiểm tra token/epoch/thời hạn. Game và CloudGame cũng từ chối gắn lease của phòng khác. Không thêm cột/schema để sửa lỗi này.

Một lượt chạy các file song song bị timeout pool trong burst 64; runner đã tách file integration chạy lần lượt để tránh tranh tài nguyên giữa fixture. Không giảm số request của burst và không tăng timeout production.
