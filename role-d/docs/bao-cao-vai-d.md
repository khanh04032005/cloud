# Báo cáo vai D — Live Quiz trên Razzia

Nhóm bốn người, 26/10–20/12/2026. Tài liệu này là phần D viết và D chủ biên: giới thiệu dịch vụ, data center và chi phí, lưu trữ, FaaS, cách đo elasticity. Các chương hypervisor, Kubernetes, IaC chi tiết và streaming để C và B viết. Số đo để trống có chủ đích: cụm AWS chưa có số liệu tại thời điểm soạn.

Mã bám fork `khanh04032005/cloud`, Razzia 4.0.2, commit `8345663f7f` (28/10/2026). Pipeline điểm nằm ở nhánh `feature/role-b-streaming`, commit `82a335978d`.

## 1. Bài toán

Quiz trực tiếp có tải không đều. Người chơi vào cùng lúc trước giờ, rồi nộp bài dồn về cuối câu. Nhiều phòng chạy song song. Một replica chết không được làm mất điểm hoặc cộng điểm hai lần khi người chơi gửi lại.

MVP của môn: câu trắc nghiệm một đáp án đúng, đúng được 1 điểm, sai hoặc không nộp được 0, cùng điểm thì cùng hạng. Host đóng và mở câu. Tốc độ không cộng điểm. Razzia gốc làm ngược lại ở chỗ điểm: câu trả lời nhanh được điểm cao hơn, trạng thái nằm trong RAM, quiz và kết quả là file. Phần đo baseline trên một replica vì vậy chưa phải số của hệ đã sửa. Báo cáo tách hai cột: baseline Razzia gốc, và hệ sau khi có RDS, Redis, Kafka.

## 2. IaaS, PaaS, SaaS

Cách xếp theo đề bài, không theo brochure của AWS.

| Thành phần | Nhóm dùng nó để | Loại | Vì sao |
| --- | --- | --- | --- |
| EC2 worker của EKS | Chạy pod web, socket, worker | IaaS | Nhóm chọn cỡ máy, AZ, và vẫn thấy VM. Hypervisor là của AWS (C viết). |
| EC2 Kafka | Broker KRaft một node | IaaS | Tự cài Kafka 3.9, không dùng MSK trong phần làm. MSK chỉ đưa vào phần so sánh. |
| EC2 phát tải | Chạy k6 | IaaS | Tách khỏi cụm để CPU của k6 không bị ghi nhầm thành CPU của quiz. |
| EKS | Điều khiển replica, probe, HPA | Dịch vụ managed | Control plane do AWS chạy. Node bên dưới vẫn là EC2. |
| RDS PostgreSQL | Phòng, đáp án, outbox, điểm | Dịch vụ managed (PaaS cơ sở dữ liệu) | AWS vá máy, backup, storage. Schema và SQL là của nhóm. |
| ALB | HTTP và WebSocket | Dịch vụ managed | Nhóm không tự chạy Nginx trên EC2 cho đường vào. |
| Lambda | Nạp câu hỏi, xuất CSV | FaaS | Không giữ process. Chạy khi có file hoặc khi gọi invoke. |
| S3 | File câu hỏi, CSV kết quả | Object storage | Không phải đĩa gắn vào pod. |
| ECR | Image | Registry managed | |
| ElastiCache hoặc Redis trên EC2 | Adapter Socket.IO, lease, HyperLogLog | Managed nếu là ElastiCache, IaaS nếu C cài trên EC2 | C chốt kiểu triển khai. Báo cáo ghi đúng cái đã apply, không đoán. |
| Prometheus + Grafana trên cụm | Metric ứng dụng | Phần mềm tự chạy trên EKS | Khác CloudWatch, vốn là dịch vụ managed. |
| Sản phẩm quiz với giảng viên và người chơi | Họ chỉ mở trình duyệt | SaaS đối với người dùng cuối | Họ không thấy EC2, pod, hay Kafka. |

Một dịch vụ managed không có nghĩa là hết việc vận hành. RDS vẫn cần lớp lưu trữ, backup và security group. EKS vẫn cần node và giới hạn CPU. Lambda trong VPC vẫn lạnh hơn Lambda ngoài VPC, và vẫn phụ thuộc số kết nối của RDS.

## 3. Data center, region, chi phí

### Region

Nhóm ở Việt Nam. Region đề xuất là **ap-southeast-1 (Singapore)**: đủ EKS, RDS, ALB, Lambda, và gần hơn us-east-1. us-east-1 thường rẻ hơn nhưng RTT cao hơn, làm bẩn số đo WebSocket. ap-southeast-2 và ap-east-1 đắt hơn mà không gần hơn với người chơi trong nước.

Ít nhất hai AZ trong region đó, đúng phần mạng của C. Một buổi test vẫn nên cố định region. Đổi region giữa các lần chạy thì không so được độ trễ.

PUE/WUE của AWS chỉ để nêu trong một đoạn: nhóm không đo được điện của data center, và không dùng nó để kết luận hiệu năng quiz. Nguồn để trích là báo cáo bền vững công khai của AWS, ghi ngày truy cập trong thư mục tài liệu.

### Tiền nào thực sự tốn

EKS tính tiền control plane theo giờ dù không có người chơi. NAT gateway tính tiền theo giờ cộng dữ liệu đi ra Internet. RDS và EC2 tính cả lúc cụm để không. S3 và Lambda của phần D nhỏ hơn nhiều so với NAT và EKS.

Vì vậy script dựng và hủy của C là một phần của bài đo, không chỉ là tiện tay. Mỗi lần chạy ghi giờ bật và giờ tắt. Chi phí một lần chạy bằng chi phí có tag `RunId` trong Cost Explorer, không lấy tổng cả tháng rồi chia đều.

Tag bắt buộc, C gắn lên mọi resource, D đã gắn default tag `Project=razzia-live-quiz` cho bucket và Lambda:

- `Project=razzia-live-quiz`
- `RunId=<ngày>-<tên thí nghiệm>`
- `Role=loadgen` trên EC2 k6

### Bảng giá để điền, không phải hóa đơn

Đơn giá lấy từ AWS Pricing Calculator đúng region, đúng ngày nhóm apply. Không chép đơn giá từ tài liệu cũ vào bài nộp. Bảng dưới là chỗ điền.

| Hạng mục | Đơn giá | Số lượng | Số giờ | Thành tiền | Nguồn |
| --- | --- | --- | --- | --- | --- |
| EKS control plane |  | 1 |  |  | Calculator, ngày … |
| NAT gateway |  | 1 |  |  |  |
| Dữ liệu NAT xử lý |  | GB |  |  |  |
| EC2 worker |  | ≥ 2 |  |  | loại instance C chọn |
| RDS |  | 1 |  |  |  |
| EC2 Kafka |  | 1 |  |  |  |
| EC2 k6 |  | 1 |  |  |  |
| ALB + LCU |  |  |  |  |  |
| S3 + Lambda |  |  |  |  | thường nhỏ, vẫn ghi |

Một buổi tối bật cụm rồi quên tắt có thể đắt hơn cả chục lần chạy k6. Cảnh báo AWS Budgets là của C. D ghi vào báo cáo số tiền của từng `RunId` sau khi số liệu Cost Explorer xuất hiện (thường trễ vài giờ đến một ngày).

Kafka một broker và một NAT là lựa chọn cố ý để vừa tiền, không phải kiến trúc chịu lỗi. Báo cáo nói rõ failover của Kafka, RDS và Redis nằm ngoài phạm vi đo.

## 4. Lưu trữ

### S3

Hai bucket, không public, có versioning và mã hóa SSE-S3.

- Import: object dưới `imports/*.json`. Sau 30 ngày chuyển STANDARD_IA. Đây là mức sớm nhất mà lớp IA cho phép.
- Export: object dưới `exports/`. Sau 90 ngày chuyển GLACIER. CSV kết quả là dữ liệu bài nộp, ít khi đọc lại.

Upload lại cùng nội dung giữ nguyên ETag thì Lambda không tạo bộ câu hỏi thứ hai. Upload nội dung mới tạo ETag mới và một `question_set` mới. Bộ cũ vẫn còn, để một lần chạy k6 không bị đổi câu giữa chừng.

### RDS

D giữ `question_sets` và `questions`. A giữ phòng, vòng, người chơi, đáp án. B giữ outbox, điểm và khóa chống xử lý trùng. Sơ đồ và lý do từng cột nằm ở `docs/hop-dong-schema.md`.

File JSON Razzia vẫn được lưu nguyên trong `question_sets.document` để A còn nạp được đúng format editor, không chỉ các cột đã tách.

### Bộ câu hỏi

Nguồn là OpenTriviaQA, commit ghi trong `questions/out/manifest.json`, giấy phép CC BY-SA 4.0. Script bỏ câu không phải một đáp án đúng, câu có hơn bốn lựa chọn, và câu mà dòng `^` không khớp nguyên văn một lựa chọn. Tập đo tải có 8 câu để một lần chạy vừa khoảng vài phút. Không sửa lời câu hỏi.

Khi phát lại bộ câu hoặc trích câu trong báo cáo thì ghi công OpenTriviaQA và giữ CC BY-SA 4.0. Đoạn ghi công nằm ở `questions/out/ATTRIBUTION.md`.

## 5. Lambda

Hai hàm, runtime Node.js 20, 256 MB.

**Nạp câu hỏi.** S3 gọi khi có `ObjectCreated` dưới `imports/`, đuôi `.json`. Hàm tải object, kiểm tra đúng luật Razzia (2–4 đáp án, cooldown 3–15, một `solutions`), rồi ghi `question_sets` và `questions` trong một transaction. Sai định dạng thì hàm lỗi và S3 có thể gọi lại. Lỗi trùng khóa duy nhất thì coi là đã nạp, không lỗi.

**Xuất kết quả.** Gọi bằng invoke, body `{ "roomId": "..." }`. Bỏ `roomId` thì xuất mọi phòng. Hai CSV: bảng điểm có hạng, và từng đáp án đã nhận. Hạng là hạng cuộc thi: điểm 3, 3, 1 thành hạng 1, 1, 3. Hàm trả về số người có `points` khác số câu đúng.

Lambda trong VPC mới mở được RDS ở subnet riêng. Cái giá là cold start và cần ENI. Phần này đưa vào chương FaaS như một hạn chế thật, không viết Lambda như thể nó vô hạn và tức thì. RDS Proxy không nằm trong phạm vi, trừ khi số kết nối lúc 1000 người chơi làm đầy `max_connections`.

Quyền IAM hẹp: hàm nạp chỉ `GetObject` trên `imports/*`, hàm xuất chỉ `PutObject` trên `exports/*`, cộng log. Không có quyền `s3:*`.

## 6. Cách đo

k6 không nói Socket.IO. Script tự gửi khung Engine.IO bản 4 trên WebSocket: `40` kèm token, `42` kèm tên sự kiện, và trả `3` khi server gửi ping `2`. Đường đi của một người chơi đúng tài liệu Razzia 4.0.2:

1. `POST /api/auth/session`
2. `POST /api/games/join` với mã phòng và tên `p<vu>`
3. Nối `/ws/?EIO=4&transport=websocket`, auth bằng token
4. `player:login` với ticket
5. Khi `SELECT_ANSWER`, chờ rồi gửi `player:selectedAnswer` đúng một lần
6. Ack đo tới lúc server gửi `WAIT` với `game:waitingForAnswers`

Ba kiểu chờ: ngẫu nhiên trong 70% thời gian câu, gần như ngay, hoặc sát cuối câu. Thí nghiệm reconnect đóng socket sau câu đầu rồi `POST /api/auth/session` lại với token cũ và `player:reconnect`. Reconnect trước lúc host bấm bắt đầu không có ghế để trở lại, vì Razzia xóa người chơi rớt ở lobby. Vì vậy reconnect chỉ tính sau khi đã nộp được một câu.

Host là process Node riêng, cùng cách đóng khung. Nó đăng nhập manager, tạo quiz, tạo phòng, in `INVITE_CODES`, chờ đủ người hoặc hết `WAIT_MS`, khoá phòng, `manager:startGame`, rồi `manager:advance` sau mỗi màn đáp án và leaderboard. Tập câu đo tải không có category nên nhịp này cố định: một lần advance rời màn đáp án, một lần nữa rời leaderboard.

Số cần ghi mỗi lần chạy, đúng đề:

- p50 và p95 của `answer_ack_ms`
- đáp án được nhận mỗi giây (`answers_accepted` chia thời gian nộp)
- tỉ lệ lỗi k6
- lag consumer Kafka (Grafana, metric `razzia_kafka_consumer_lag` của B)
- CPU máy k6 và CPU pod, để biết nút thắt nằm ở đâu
- chi phí `RunId`
- số dòng `score-audit` khác 0

Mẫu bảng: `experiments/results-template.csv`. Sáu thí nghiệm map vào mười hai dòng của file đó.

Thí nghiệm 5 có hai việc. k6 chứng minh client gửi lại không nhận thêm một `WAIT`. Replay của B chứng minh consumer xử lý lại không cộng điểm. Cả hai phải xong thì mới kết luận idempotent.

Thí nghiệm 6 là cả nhóm. D giữ số: request lỗi, p95 reconnect, và bảng điểm sau khi pod hoặc node chết. Kết nối WebSocket cũ không tự sang pod khác. Người chơi phải nối lại. Đó là hành vi cần đo, không phải lỗi của script.

## 7. Những gì báo cáo chưa được bịa

- p50, p95, throughput, lag, chi phí USD của từng lần chạy
- Razzia gốc đã tính 1 điểm mỗi câu
- k6 đã nói chuyện được với ALB của nhóm (chưa có URL)
- HPA nhanh hay chậm hơn replica cố định

Khi có số, điền CSV rồi chép bảng vào mục 6. Một câu trong phần kết luận chỉ được viết sau khi `score-audit` của lần chạy đó trả về không dòng.
