# LEARNINGS: bài học, kinh nghiệm, kiến thức

> Mỗi mục ghi theo dạng: điều xảy ra (hoặc câu hỏi), vì sao, áp dụng thế nào. Ưu tiên những thứ có thể đưa vào báo cáo.

## Quy trình

**Đo trước, thiết kế sau.** Kiến trúc phân tán được dựng trước khi có số đo baseline của Razzia gốc. Vì vậy chưa trả lời được "kiến trúc này đã tối ưu chưa". Từ giờ, mỗi thành phần trong báo cáo cần đi theo chuỗi: điểm hỏng đo được, thành phần giải quyết điểm hỏng đó, số đo sau khi thêm. Có hai loại lý do cần tách bạch: giới hạn do thiết kế (state trong RAM thì không scale ngang được, chết là mất ván; không cần đo tải cũng thấy) và yêu cầu của môn học (Kafka, Lambda). Baseline không dùng để bác bỏ hai loại này, mà để lượng hóa cái giá của chúng.

**Merge sạch không có nghĩa là chạy đúng.** Git merge ba nhánh A, B, D không báo xung đột, nhưng ba người tự viết schema và hợp đồng event riêng: tên bảng, cột, channel Redis và kiểu dữ liệu đều lệch nhau. Git chỉ so văn bản, không thấy xung đột ngữ nghĩa. Bài học: chốt **hợp đồng** (schema, topic, channel, payload) ở một chỗ duy nhất trước khi các vai viết code; người tích hợp đọc hợp đồng chứ không chỉ đọc conflict marker.

**Walking skeleton.** Dựng phiên bản mỏng nhất đi qua đủ mọi tầng trước, rồi mới làm dày. Lỗi khó nhất nằm ở chỗ nối giữa các tầng (security group, URL, tên bảng, timeout của ALB).

**Thử ở local trước khi lên cloud.** `compose.full.yml` bắt lỗi nối tầng gần như miễn phí. Ví dụ: lỗi `room_id` của publisher lộ ra ngay ở E00, không mất tiền EKS.

## Kiến trúc

**ALB và nginx không trùng chức năng.**
- ALB là bộ định tuyến ở rìa VPC: có địa chỉ ổn định, trải 2 AZ, health check, tự theo dõi IP pod khi scale.
- nginx trong pod web chỉ là web server trả file tĩnh.
- Trên EKS không tránh được load balancer của AWS: dùng ingress-nginx thì AWS vẫn tạo NLB đứng trước. Như vậy ALB đứng thẳng trước pod là ít tầng nhất.
- Đường nóng `/ws` đi thẳng ALB → socket, không qua nginx.
- Nếu muốn bớt một thành phần: đưa file tĩnh lên S3 + CloudFront.

**Có 3 chỗ dùng nginx trong repo:** trả file tĩnh trong image `web`; image `runner` gốc (nginx và Node chung một container, đường dẫn proxy tới `127.0.0.1:3001`); `proxy` trong compose đóng vai ALB ở local.

**Outbox pattern.** Ghi đáp án và một dòng outbox trong cùng một transaction, nên không bao giờ có đáp án đã lưu mà event bị mất. Kafka đi theo kiểu at-least-once; consumer chống trùng bằng `processed_answer_events`. Cái giá phải trả: thêm độ trễ do poll (500 ms) và thêm hop qua Kafka.

**Lease và fencing.** Mỗi phòng có một coordinator giữ lease trong `rooms` (`owner_token`, `lease_until`, TTL 9 s) kèm `owner_epoch` tăng dần. Pod cũ sống lại vẫn mang epoch cũ nên mọi lệnh ghi của nó bị từ chối. Cơ chế này ngăn trường hợp có hai coordinator cùng lúc.

**Kết nối WebSocket gắn với một pod suốt đời của nó.** HPA thêm pod thì pod mới chỉ nhận kết nối mới. Pod chết thì client phải nối lại. Đây là hành vi cần đo, không phải lỗi.

**Media lưu trên đĩa local phá vỡ tính stateless.** `nginx-static.conf` trả `/media` từ `/app/config`. Có nhiều replica thì mỗi pod có đĩa riêng, nên media phải chuyển lên S3.

## AWS và chi phí

- **Cách tiết kiệm lớn nhất là tắt môi trường khi không dùng.** Bật 24/7 tốn ~330 USD cho 5 tuần; chỉ bật khi test tốn ~25–35 USD.
- **NAT Gateway đắt** (0,059 USD/giờ + 0,059 USD/GB). NAT instance fck-nat trên t4g.nano chỉ ~0,005 USD/giờ. S3 Gateway Endpoint miễn phí và giúp kéo layer ECR không đi qua NAT.
- **EKS extended support tốn 0,60 USD/giờ**, gấp 6 lần standard. Ép bằng `upgrade_policy = { support_type = "STANDARD" }`.
- **Public IPv4 tính tiền** 0,005 USD/giờ mỗi IP, kể cả IP của ALB và NAT.
- **Budget và ECR phải đặt ở tầng không bao giờ destroy.** Đặt trong `envs/dev` thì mỗi lần `down` sẽ xóa luôn cảnh báo chi phí và toàn bộ image.
- **Thứ tự hủy:** `helm uninstall` (để controller xóa ALB) → chờ ALB biến mất → `terraform destroy`. Làm ngược lại thì ALB mồ côi vẫn tính tiền và giữ ENI, khiến VPC không xóa được.
- **Spot** rẻ hơn ~60–70%. Khai báo nhiều loại instance cùng cỡ để ít bị thu hồi. Lần đo chính thức nên dùng ON_DEMAND.
- **Graviton (t4g)** rẻ hơn ~20% nhưng cần image multi-arch.
- Gắn tag `RunId` qua `default_tags` của provider, và bật tag đó trong Billing → Cost allocation tags thì mới lọc được chi phí từng lần chạy.

## Docker và công cụ

- **`pnpm deploy`** (pnpm 10) yêu cầu `inject-workspace-packages`. Package không phụ thuộc workspace nào thì dùng `--legacy`.
- **Node `pg` hiểu `sslmode=no-verify`, `psql` thì không.** Script migrate phải đổi sang `require`. RDS Postgres 15+ mặc định bắt buộc TLS (`rds.force_ssl=1`).
- **apache/kafka:** đặt bất kỳ biến `KAFKA_*` nào là phải khai báo đủ cấu hình KRaft. `ADVERTISED_LISTENERS` phải là tên mà client nhìn thấy (`kafka:9092` trong compose, IP private trên EC2). Nếu không, client kết nối được lần đầu rồi bị trả về `localhost`.
- **Tên project của Compose mặc định là tên thư mục.** Nhiều file compose trong cùng thư mục sẽ dùng chung project và recreate container của nhau. Đặt `name:` riêng trong file.
- **Cổng host bị chiếm** (máy đã có Postgres ở 5432) thì dùng `${PG_PORT:-15432}` để đổi được.
- **kafkajs trên Node 24** in `TimeoutNegativeWarning` khi khởi động. Cảnh báo này vô hại. `GroupCoordinator not available` lúc đầu là chuyện bình thường khi broker vừa lên.
- **Module Terraform đổi tên biến giữa các major version** (EKS v21 dùng `name`, `kubernetes_version`, `addons`; IAM v6 dùng `name`, output `arn`). Luôn chạy `terraform validate` sau khi pin version.
- **VPC module** với `single_nat_gateway = true` chỉ tạo 1 route table private, nên phải đếm theo `length(private_route_table_ids)`, không đếm theo số AZ.
- **k6 không có global `URL`** (k6 v2.1). Code dùng chung Node/k6 (`role-d/load/protocol.js`) phải tự cắt chuỗi. Lỗi này làm mọi VU chết ngay sau `join` nhưng k6 vẫn báo `checks 100%`, nên phải xem log `ReferenceError`.
- **Metric `Rate` của k6 không có mẫu nào thì không xuất hiện trong summary** (jq ra `null`). Ghi `add(0)` khi thành công thì tỉ lệ lỗi mới có nghĩa.
- **Mỗi bậc tải là một ván riêng:** chạy k6 với `--vus N --iterations N`, đừng dùng `constant-vus`. Phòng đã khoá thì VU lặp lại sẽ dội `join` lỗi liên tục.

**Lease phải ràng buộc với phòng đích.** Token, epoch và thời hạn hợp lệ chưa đủ nếu hàm ghi kiểm tra lease của room B nhưng câu UPDATE lại nhắm room A. Test 19/11 đã tái hiện tình huống này trên PostgreSQL thật. withLease cần nhận room đích tường minh và so khớp lease.gameId trước khi mở đường ghi; attachLease cũng phải chặn sai phòng. Đây là lỗi cách ly dữ liệu dù schema và từng lease riêng lẻ đều hợp lệ.
