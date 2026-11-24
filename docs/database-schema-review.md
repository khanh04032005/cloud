# Schema database sau tích hợp A–B–D

Đối chiếu trực tiếp migration 001–007 ngày 19/11/2026. Đây là schema trong code; migration mới chưa áp dụng vào database dev/AWS. Có 14 bảng nghiệp vụ, 1 bảng kỹ thuật và 1 view.

PK: khóa chính. FK: khóa ngoại. UNIQUE: duy nhất. Cột “Cho phép NULL” ghi theo khai báo PostgreSQL. Các khóa ghép và CHECK được ghi bên dưới từng bảng; FK không ghi ON DELETE dùng hành vi mặc định NO ACTION.

## quizzes

Catalog bộ câu hỏi.

| Trường | Kiểu dữ liệu | Cho phép NULL | Khóa | Mặc định |
| --- | --- | --- | --- | --- |
| `id` | `text` | Không | PK | — |
| `subject` | `text` | Không | — | — |
| `game_mode` | `text` | Không | — | `'quiz'::text` |

| Khóa / quan hệ / ràng buộc | Định nghĩa |
| --- | --- |
| Kiểm tra | `CHECK ((game_mode = ANY (ARRAY['quiz'::text, 'survey'::text])))` |
| Khóa chính | `PRIMARY KEY (id)` |

## questions

Nội dung câu hỏi, dùng chung cho API và Lambda import.

| Trường | Kiểu dữ liệu | Cho phép NULL | Khóa | Mặc định |
| --- | --- | --- | --- | --- |
| `id` | `uuid` | Không | PK | `gen_random_uuid()` |
| `quiz_id` | `text` | Không | FK, UNIQUE ghép | — |
| `position` | `integer` | Không | UNIQUE ghép | — |
| `definition` | `jsonb` | Không | — | — |

| Khóa / quan hệ / ràng buộc | Định nghĩa |
| --- | --- |
| Kiểm tra | `CHECK ((jsonb_typeof(definition) = 'object'::text))` |
| Kiểm tra | `CHECK (("position" > 0))` |
| Khóa ngoại | `FOREIGN KEY (quiz_id) REFERENCES quizzes(id) ON DELETE CASCADE` |
| Khóa chính | `PRIMARY KEY (id)` |
| Duy nhất | `UNIQUE (quiz_id, "position")` |

## rooms

Phòng chơi, snapshot trạng thái và quyền coordinator.

| Trường | Kiểu dữ liệu | Cho phép NULL | Khóa | Mặc định |
| --- | --- | --- | --- | --- |
| `id` | `uuid` | Không | PK | — |
| `invite_code` | `text` | Không | — | — |
| `host_client_id` | `uuid` | Không | — | — |
| `quiz_id` | `text` | Có | FK | — |
| `subject` | `text` | Không | — | — |
| `status` | `text` | Không | — | `'lobby'::text` |
| `settings` | `jsonb` | Không | — | `'{}'::jsonb` |
| `created_at` | `timestamp with time zone` | Không | — | `now()` |
| `finished_at` | `timestamp with time zone` | Có | — | — |
| `locked` | `boolean` | Không | — | `false` |
| `runtime` | `jsonb` | Có | — | — |
| `current_position` | `integer` | Không | — | `0` |
| `game_mode` | `text` | Không | — | `'quiz'::text` |
| `owner_token` | `text` | Có | — | — |
| `owner_epoch` | `integer` | Không | — | `0` |
| `lease_until` | `timestamp with time zone` | Không | — | `'-infinity'::timestamp with time zone` |
| `manager_socket_id` | `text` | Không | — | `''::text` |
| `manager_connected` | `boolean` | Không | — | `false` |
| `host_state` | `jsonb` | Có | — | — |
| `host_state_position` | `integer` | Không | — | `0` |
| `stage_deadline` | `timestamp with time zone` | Có | — | — |
| `auto_advance_at` | `timestamp with time zone` | Có | — | — |

| Khóa / quan hệ / ràng buộc | Định nghĩa |
| --- | --- |
| Kiểm tra | `CHECK (((status = 'finished'::text) = (finished_at IS NOT NULL)))` |
| Kiểm tra | `CHECK ((game_mode = ANY (ARRAY['quiz'::text, 'survey'::text])))` |
| Kiểm tra | `CHECK ((invite_code ~ '^[0-9]{6}$'::text))` |
| Kiểm tra | `CHECK ((jsonb_typeof(settings) = 'object'::text))` |
| Kiểm tra | `CHECK ((status = ANY (ARRAY['lobby'::text, 'running'::text, 'finished'::text, 'cancelled'::text])))` |
| Khóa ngoại | `FOREIGN KEY (quiz_id) REFERENCES quizzes(id) ON DELETE SET NULL` |
| Khóa chính | `PRIMARY KEY (id)` |
| Index có điều kiện | `CREATE UNIQUE INDEX rooms_active_invite_code_idx ON public.rooms USING btree (invite_code) WHERE (status = ANY (ARRAY['lobby'::text, 'running'::text]))` |
| Index có điều kiện | `CREATE INDEX rooms_recovery_idx ON public.rooms USING btree (lease_until) WHERE (status = ANY (ARRAY['lobby'::text, 'running'::text]))` |

## players

Danh tính và trạng thái người chơi theo phòng.

| Trường | Kiểu dữ liệu | Cho phép NULL | Khóa | Mặc định |
| --- | --- | --- | --- | --- |
| `room_id` | `uuid` | Không | FK, PK ghép | — |
| `id` | `uuid` | Không | PK ghép | — |
| `username` | `text` | Không | — | — |
| `joined_at` | `timestamp with time zone` | Không | — | `now()` |
| `active` | `boolean` | Không | — | `true` |
| `connected` | `boolean` | Không | — | `false` |
| `socket_id` | `text` | Không | — | `''::text` |
| `state` | `jsonb` | Có | — | — |
| `state_position` | `integer` | Không | — | `0` |

| Khóa / quan hệ / ràng buộc | Định nghĩa |
| --- | --- |
| Khóa ngoại | `FOREIGN KEY (room_id) REFERENCES rooms(id)` |
| Khóa chính | `PRIMARY KEY (room_id, id)` |

## rounds

Lượt câu hỏi thực tế, giữ snapshot khi catalog thay đổi.

| Trường | Kiểu dữ liệu | Cho phép NULL | Khóa | Mặc định |
| --- | --- | --- | --- | --- |
| `id` | `uuid` | Không | PK, UNIQUE ghép | `gen_random_uuid()` |
| `room_id` | `uuid` | Không | FK, UNIQUE ghép, UNIQUE ghép | — |
| `question_id` | `uuid` | Có | FK | — |
| `position` | `integer` | Không | UNIQUE ghép | — |
| `question_snapshot` | `jsonb` | Không | — | — |
| `status` | `text` | Không | — | `'pending'::text` |
| `closes_at` | `timestamp with time zone` | Có | — | — |
| `closed_at` | `timestamp with time zone` | Có | — | — |

| Khóa / quan hệ / ràng buộc | Định nghĩa |
| --- | --- |
| Kiểm tra | `CHECK (("position" > 0))` |
| Kiểm tra | `CHECK ((jsonb_typeof(question_snapshot) = 'object'::text))` |
| Kiểm tra | `CHECK ((status = ANY (ARRAY['pending'::text, 'open'::text, 'closed'::text])))` |
| Khóa ngoại | `FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE SET NULL` |
| Khóa ngoại | `FOREIGN KEY (room_id) REFERENCES rooms(id)` |
| Khóa chính | `PRIMARY KEY (id)` |
| Duy nhất | `UNIQUE (room_id, id)` |
| Duy nhất | `UNIQUE (room_id, "position")` |
| Index có điều kiện | `CREATE UNIQUE INDEX rounds_one_open_per_room_idx ON public.rounds USING btree (room_id) WHERE (status = 'open'::text)` |

## answers

Đáp án server đã chấp nhận; retry giữ đáp án đầu tiên.

| Trường | Kiểu dữ liệu | Cho phép NULL | Khóa | Mặc định |
| --- | --- | --- | --- | --- |
| `room_id` | `uuid` | Không | FK ghép, FK ghép | — |
| `round_id` | `uuid` | Không | FK ghép, PK ghép | — |
| `player_id` | `uuid` | Không | FK ghép, PK ghép | — |
| `choice` | `integer` | Có | — | — |
| `is_correct` | `boolean` | Không | — | — |
| `accepted_at` | `timestamp with time zone` | Không | — | `clock_timestamp()` |
| `answer_keys` | `jsonb` | Không | — | — |

| Khóa / quan hệ / ràng buộc | Định nghĩa |
| --- | --- |
| Kiểm tra | `CHECK ((choice >= 0))` |
| Kiểm tra | `CHECK ((jsonb_typeof(answer_keys) = 'array'::text))` |
| Khóa ngoại | `FOREIGN KEY (room_id, player_id) REFERENCES players(room_id, id)` |
| Khóa ngoại | `FOREIGN KEY (room_id, round_id) REFERENCES rounds(room_id, id)` |
| Khóa chính | `PRIMARY KEY (round_id, player_id)` |

## outbox

Tham chiếu đáp án chờ publisher gửi Kafka; không có room_id/payload.

| Trường | Kiểu dữ liệu | Cho phép NULL | Khóa | Mặc định |
| --- | --- | --- | --- | --- |
| `event_id` | `uuid` | Không | PK | `gen_random_uuid()` |
| `round_id` | `uuid` | Không | FK ghép, UNIQUE ghép | — |
| `player_id` | `uuid` | Không | FK ghép, UNIQUE ghép | — |
| `created_at` | `timestamp with time zone` | Không | — | `now()` |
| `published_at` | `timestamp with time zone` | Có | — | — |

| Khóa / quan hệ / ràng buộc | Định nghĩa |
| --- | --- |
| Khóa ngoại | `FOREIGN KEY (round_id, player_id) REFERENCES answers(round_id, player_id)` |
| Khóa chính | `PRIMARY KEY (event_id)` |
| Duy nhất | `UNIQUE (round_id, player_id)` |
| Index có điều kiện | `CREATE INDEX outbox_pending_idx ON public.outbox USING btree (created_at, event_id) WHERE (published_at IS NULL)` |

## results

Nguồn tổng điểm duy nhất; score worker cập nhật cùng marker trong một transaction.

| Trường | Kiểu dữ liệu | Cho phép NULL | Khóa | Mặc định |
| --- | --- | --- | --- | --- |
| `room_id` | `uuid` | Không | FK ghép, PK ghép | — |
| `player_id` | `uuid` | Không | FK ghép, PK ghép | — |
| `points` | `integer` | Không | — | `0` |

| Khóa / quan hệ / ràng buộc | Định nghĩa |
| --- | --- |
| Kiểm tra | `CHECK ((points >= 0))` |
| Khóa ngoại | `FOREIGN KEY (room_id, player_id) REFERENCES players(room_id, id)` |
| Khóa chính | `PRIMARY KEY (room_id, player_id)` |

## processed_answer_events

Marker chống tính điểm trùng. event_id liên kết logic với outbox; không có FK trong schema hiện tại.

| Trường | Kiểu dữ liệu | Cho phép NULL | Khóa | Mặc định |
| --- | --- | --- | --- | --- |
| `event_id` | `uuid` | Không | PK | — |
| `processed_at` | `timestamp with time zone` | Không | — | `now()` |

| Khóa / quan hệ / ràng buộc | Định nghĩa |
| --- | --- |
| Khóa chính | `PRIMARY KEY (event_id)` |

## stats_processed_events

Mới ở 005. Marker thống kê riêng; event_id liên kết logic với outbox, không có FK.

| Trường | Kiểu dữ liệu | Cho phép NULL | Khóa | Mặc định |
| --- | --- | --- | --- | --- |
| `event_id` | `uuid` | Không | PK | — |
| `processed_at` | `timestamp with time zone` | Không | — | `now()` |

| Khóa / quan hệ / ràng buộc | Định nghĩa |
| --- | --- |
| Khóa chính | `PRIMARY KEY (event_id)` |

## answer_rate_buckets

Mới ở 005. Số đáp án theo phòng và cửa sổ một giây.

| Trường | Kiểu dữ liệu | Cho phép NULL | Khóa | Mặc định |
| --- | --- | --- | --- | --- |
| `room_id` | `uuid` | Không | FK, PK ghép | — |
| `bucket_start` | `timestamp with time zone` | Không | PK ghép | — |
| `answer_count` | `integer` | Không | — | `0` |

| Khóa / quan hệ / ràng buộc | Định nghĩa |
| --- | --- |
| Kiểm tra | `CHECK ((answer_count >= 0))` |
| Khóa ngoại | `FOREIGN KEY (room_id) REFERENCES rooms(id)` |
| Khóa chính | `PRIMARY KEY (room_id, bucket_start)` |

## game_reports

Snapshot báo cáo cuối ván, khác với bảng điểm đang cập nhật.

| Trường | Kiểu dữ liệu | Cho phép NULL | Khóa | Mặc định |
| --- | --- | --- | --- | --- |
| `id` | `text` | Không | PK | — |
| `room_id` | `uuid` | Không | FK, UNIQUE | — |
| `report` | `jsonb` | Không | — | — |

| Khóa / quan hệ / ràng buộc | Định nghĩa |
| --- | --- |
| Kiểm tra | `CHECK ((jsonb_typeof(report) = 'object'::text))` |
| Khóa ngoại | `FOREIGN KEY (room_id) REFERENCES rooms(id)` |
| Khóa chính | `PRIMARY KEY (id)` |
| Duy nhất | `UNIQUE (room_id)` |

## data_imports

Marker import dữ liệu từ file local của backend A.

| Trường | Kiểu dữ liệu | Cho phép NULL | Khóa | Mặc định |
| --- | --- | --- | --- | --- |
| `name` | `text` | Không | PK | — |

| Khóa / quan hệ / ràng buộc | Định nghĩa |
| --- | --- |
| Khóa chính | `PRIMARY KEY (name)` |

## quiz_imports

Mới ở 006. Nguồn S3 và metadata; nội dung quiz nằm ở quizzes/questions.

| Trường | Kiểu dữ liệu | Cho phép NULL | Khóa | Mặc định |
| --- | --- | --- | --- | --- |
| `s3_bucket` | `text` | Không | PK ghép | — |
| `s3_key` | `text` | Không | PK ghép | — |
| `s3_etag` | `text` | Không | PK ghép | — |
| `quiz_id` | `text` | Có | FK | — |
| `sha256` | `text` | Không | — | — |
| `license` | `text` | Không | — | — |
| `imported_at` | `timestamp with time zone` | Không | — | `now()` |

| Khóa / quan hệ / ràng buộc | Định nghĩa |
| --- | --- |
| Kiểm tra | `CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text))` |
| Khóa ngoại | `FOREIGN KEY (quiz_id) REFERENCES quizzes(id) ON DELETE SET NULL` |
| Khóa chính | `PRIMARY KEY (s3_bucket, s3_key, s3_etag)` |

## schema_migrations

Bảng kỹ thuật do migration runner tạo để ghi phiên bản đã chạy.

| Trường | Kiểu dữ liệu | Cho phép NULL | Khóa | Mặc định |
| --- | --- | --- | --- | --- |
| `version` | `text` | Không | PK | — |
| `applied_at` | `timestamp with time zone` | Không | — | `now()` |

| Khóa / quan hệ / ràng buộc | Định nghĩa |
| --- | --- |
| Khóa chính | `PRIMARY KEY (version)` |

## score_audit — VIEW

Tính từ players, answers, outbox, results, processed_answer_events. Không lưu thêm bản sao điểm. JOIN của view là quan hệ truy vấn, không tạo khóa ngoại mới.

| Trường | Kiểu | Ý nghĩa |
| --- | --- | --- |
| `room_id` | `uuid` | Phòng |
| `player_id` | `uuid` | Người chơi |
| `stored_points` | `integer` | Điểm trong results, thiếu thì 0 |
| `expected_points` | `integer` | Số đáp án đúng |
| `accepted_answers` | `integer` | Tổng đáp án đã nhận |
| `point_delta` | `integer` | stored_points − expected_points |
| `missing_result` | `boolean` | Có đáp án nhưng thiếu dòng results |
| `missing_outbox` | `integer` | Số đáp án thiếu outbox |
| `pending_score_events` | `integer` | Số event outbox thiếu marker tính điểm |

Sau khi worker xử lý hết, audit đạt khi point_delta = 0, missing_result = false, missing_outbox = 0 và pending_score_events = 0.

## Các định nghĩa cũ đã bỏ khỏi repo

| Định nghĩa cũ | Thống nhất về |
| --- | --- |
| B.player_scores | results |
| B.score_processed_events | processed_answer_events |
| B.outbox có room_id/payload | outbox tham chiếu answers |
| D.questions và question_sets.document | quizzes/questions; quiz_imports chỉ giữ nguồn |

Không có lệnh DROP dữ liệu cũ trong migration mới. Cần kiểm kê riêng nếu database từng được dựng bằng các fixture độc lập trước đây.
