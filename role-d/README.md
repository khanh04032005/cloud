# Vai D — dữ liệu, Lambda, k6, báo cáo

Bám [khanh04032005/cloud](https://github.com/khanh04032005/cloud) tại Razzia **4.0.2** (`8345663f7f`, 28/10/2026) và nhánh `feature/role-b-streaming` (`82a335978d`). Protocol người chơi là Socket.IO trên `/ws` của bản đó, không phải NestJS.

Chưa có schema của A và chưa có URL AWS. Phần chạy được trên máy và phần mô tả thì xong. Số p50/p95, lag, chi phí thật để trống trong `experiments/results-template.csv` cho đến buổi đo.

## Việc trong thư mục này

| Việc được giao | File |
| --- | --- |
| OpenTriviaQA → JSON Razzia, CC BY-SA 4.0 | `questions/` |
| Schema bộ câu hỏi | `db/010_question_sets.sql` |
| Đề xuất bảng cho A | `db/000_proposed_for_A.sql` |
| Hai Lambda + lifecycle S3 | `lambda/`, `infra/` |
| k6: vào phòng, trả lời, gửi lại, nối lại | `load/k6/player.js` |
| Host giữ phòng và bấm sang câu | `load/host.mjs` |
| Máy phát tải riêng | `load/ec2-loadgen.sh` |
| Sáu thí nghiệm + đối chiếu điểm | `experiments/`, `db/011_score_audit.sql` |
| Dashboard Grafana (metric của B) | `grafana/razzia-role-d.json` |
| Chương báo cáo của D | `docs/bao-cao-vai-d.md` |

## Câu hỏi

Cài bản clone nông của [OpenTriviaQA](https://github.com/uberspot/OpenTriviaQA) rồi:

```bash
node questions/convert-opentrivia.mjs \
  --root /đường/dẫn/OpenTriviaQA/categories \
  --out questions/out \
  --commit <commit-dataset>
```

Ra hai file:

- `opentrivia-load.json`: 8 câu, 10 giây, không category. Dùng cho k6. Không gắn category vì Razzia gộp các câu cùng category và bỏ bớt màn leaderboard, host sẽ lệch nhịp bấm.
- `opentrivia-bank.json`: 120 câu. Upload lên `s3://<bucket-import>/imports/opentrivia-bank.json`.

`maxPoints` đặt bằng 1. Razzia gốc vẫn nhân điểm theo tốc độ cho đến khi A sửa scorer. Không ghi trong báo cáo rằng baseline đã là 1 điểm/câu.

## Lambda

```bash
node lambda/package-lambdas.mjs
```

C apply `infra/` (state remote của C, không apply song song). Lambda phải nằm trong VPC nếu RDS ở subnet riêng. `DATABASE_URL` có `sslmode=require`. Biến này vào state Terraform.

Nạp: PUT object dưới prefix `imports/`, đuôi `.json`. Cùng ETag thì lần sau bỏ qua, không nhân đôi câu hỏi.

Xuất, sau khi A/B đã có bảng điểm:

```bash
aws lambda invoke \
  --function-name <export_function> \
  --payload '{"roomId":"<id>"}' \
  --cli-binary-format raw-in-base64-out \
  out.json
```

CSV nằm ở `exports/<roomId>/` trên bucket export. Kết quả trả về có `mismatches`: số người có điểm khác số câu đúng.

## k6

Hai process. Host trước.

```bash
BASE_URL=https://<alb> \
MANAGER_PASSWORD=... \
QUIZ_FILE=questions/out/opentrivia-load.json \
EXPECTED_PLAYERS=100 \
WAIT_MS=120000 \
node load/host.mjs
```

Khi thấy dòng `INVITE_CODES=......`:

```bash
BASE_URL=https://<alb> \
INVITE_CODES=...... \
PLAYERS=100 \
DURATION=4m \
ANSWER_MODE=random \
k6 run --summary-export experiments/run-100.json load/k6/player.js
```

`ANSWER_MODE=end` cho thí nghiệm dồn câu cuối (trả lời khi còn khoảng 1,5 giây). `SCENARIO=duplicate` gửi lại cùng lựa chọn sau 300 ms. `SCENARIO=reconnect` cứ 10 VU thì rớt mạng sau câu đầu và gọi `player:reconnect`.

Độ trễ ack trên Razzia 4.0.2 là thời gian từ `player:selectedAnswer` tới `game:status` `WAIT` / `game:waitingForAnswers`. Bản này không có socket ack. k6 tự đóng khung Engine.IO (`40`, `42...`) vì k6 không có client Socket.IO. Nếu ALB trả lỗi tay bắt tay, thử lại đúng một lần rồi mới tính tới Artillery.

Người chơi phải vào trước khi host khoá phòng. Host khoá phòng đúng lúc bắt đầu. Tắt host trước lúc bắt đầu là mất phòng: Razzia xoá lobby khi manager rớt.

Máy chạy k6 là EC2 khác cụm. `load/ec2-loadgen.sh` cài k6. Ghi `CPUUtilization` của instance đó vào cột `generator_cpu_max`.

## Sáu thí nghiệm

Điền `experiments/results-template.csv`. Mỗi dòng một lần chạy, cùng bộ câu `opentrivia-load.json`.

1. 100, rồi 500, rồi 1000 người, một phòng, một replica. Lấy p50/p95 `answer_ack_ms`, số đáp án nhận, tỉ lệ lỗi.
2. 500 người trong 1 phòng (`ROOMS=1`) so với 10 phòng (`ROOMS=10`, k6 tự chia VU theo mã).
3. `ANSWER_MODE=end` để dồn submit sát lúc đóng câu. Đọc lag Kafka trên Grafana.
4. Cố định số replica so với HPA. Cấu hình HPA là của C. D chỉ đổi số replica và ghi độ trễ trong lúc scale.
5. `SCENARIO=duplicate`, rồi thí nghiệm replay của B (`packages/streaming/scripts/replay.mjs`). `duplicate_acks` phải là 0. Sau replay, `score-audit.sql` vẫn 0 dòng.
6. Cả nhóm: xoá một pod, rồi drain một node, trong lúc 100 người đang ở giữa ván. Ghi request lỗi, thời gian reconnect, và đối chiếu điểm.

Sau mỗi lần có pipeline điểm: chạy `experiments/score-audit.sql`. Kỳ vọng không có dòng nào.

## Kiểm thử logic ở máy

```bash
node --test questions/parse-opentrivia.test.mjs lambda/export-results/logic.test.mjs load/protocol.test.mjs
node load/host.mjs --help
```

Chưa thay được một ván thật trên ALB.
