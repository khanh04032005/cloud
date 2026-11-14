# Vai C — Guideline thực chiến: merge, đóng gói, hạ tầng, deploy

> Viết ngày 14/11/2026, sau khi đọc 4 nhánh trên `origin`. Đọc theo thứ tự từ trên xuống, mỗi phần có **Làm ngay**, **Bản chất** và **Xong khi** (tiêu chí hoàn thành).
> Mục tiêu: **dựng một bộ sườn chạy được từ đầu đến cuối trước**, rồi mới làm dày và tối ưu.

---

## 0. Tóm tắt trong 1 phút

1. **Trạng thái các nhánh:** A đã xong code. B đã xong code. D đã xong phần code và kịch bản, **còn thiếu tích hợp và số đo** (số đo phải chờ hạ tầng của bạn). Main vẫn là Razzia 4.0.2 gốc.
2. **Git merge ba nhánh không báo xung đột, nhưng hệ thống chưa chạy được.** Ba người viết schema DB và hợp đồng event riêng, không khớp nhau (xem §2.3). Đây là việc lớn nhất của bạn tuần này.
3. **Thứ tự làm:** merge và sửa hợp đồng → chạy cả hệ thống ở local bằng Docker Compose → Terraform → CI đẩy image → Helm lên EKS → probe, HPA, monitoring → script bật/tắt.
4. **Đang trễ lịch:** mốc tuần 2 (baseline trên AWS) chưa có. Mốc tuần 4 (16/11–22/11) là "nhiều replica + Kafka end-to-end". Phần 9 có lịch dồn lại.

---

## 1. Tư duy trước khi gõ lệnh

### 1.1 Walking skeleton: bộ khung đi được trước

Bộ sườn là phiên bản **mỏng nhất nhưng đi qua đủ mọi tầng**: trình duyệt → ALB → pod web/socket → RDS/Redis → outbox → Kafka → worker → leaderboard quay lại trình duyệt. Mỗi tầng chỉ cần chạy được, chưa cần đẹp.

Lý do: lỗi khó nhất của dự án này nằm **ở chỗ nối giữa các tầng** (security group chặn cổng, sai URL, sai tên bảng, ALB cắt WebSocket). Nếu bạn làm Terraform thật hoàn hảo trong 2 tuần rồi mới deploy, các lỗi nối sẽ dồn về cuối khi không còn thời gian. Đó chính là **tối ưu cục bộ**: một phần rất tốt nhưng tổng thể vẫn chưa chạy.

### 1.2 Bốn tầng ưu tiên, không nhảy cóc

| Tầng | Câu hỏi | Ví dụ việc |
| --- | --- | --- |
| 1. Chạy được | Có đi hết luồng không? | 1 replica, không HPA, instance nhỏ |
| 2. Đúng | Điểm có khớp đáp án không? | Hợp đồng A↔B↔D, migration, score audit |
| 3. Bền | Kill pod hay drain node có mất gì không? | Probe, PDB, topology spread, 2 node |
| 4. Nhanh và rẻ | Bao nhiêu người, tốn bao nhiêu tiền? | HPA, Cluster Autoscaler, chọn instance, tắt môi trường |

Chỉ chuyển sang tầng sau khi tầng trước đã đạt **Xong khi**.

### 1.3 Ba nguyên tắc vận hành

- **Bất biến (immutable):** không bao giờ `kubectl exec` vào pod để sửa. Muốn đổi gì thì sửa code, build image mới có tag là git SHA, rồi deploy lại. Như vậy mọi trạng thái đều tái tạo được.
- **Khai báo (declarative):** Terraform và Helm mô tả *trạng thái mong muốn*, công cụ tự tính chênh lệch. Mọi thay đổi bằng tay trên AWS Console sẽ bị lần `apply` sau ghi đè. Console chỉ dùng để **xem**.
- **Một nguồn sự thật cho mỗi thứ:** schema DB thuộc migration của A, tài nguyên AWS thuộc Terraform của bạn, cấu hình app thuộc `values.yaml`. Không có bản sao thứ hai.

---

## 2. Giai đoạn 0 — Đọc nhánh và merge code

### 2.1 Bản đồ nhánh

| Nhánh | Người | Commit cuối | Nội dung | Trạng thái |
| --- | --- | --- | --- | --- |
| `main` | — | `8345663` (Razzia 4.0.2) | Code gốc | Baseline |
| `feat/razzia-distributed-quiz-backend` | A | `4331c9b`, 10/11 | Tách web/socket, migration 001–004, Redis adapter, outbox, lease/fencing, `/health/*`, `/metrics`, 239 test | **Xong** phần A (tài liệu ghi nhầm tên nhánh là `feat/razzia-multi-replica-room-state`) |
| `feature/role-b-streaming` | B | `82a3359`, 01/11 | `packages/streaming`: publisher, score-worker, stats-worker, Bloom, HLL, replay, cấu hình Kafka KRaft | **Xong code**, nhưng viết **trước** khi có schema của A, nên lệch hợp đồng |
| `feature/role-d` | D | `e7a6a6a`, 13/11 | Thư mục `role-d-razzia/role-d/`: convert câu hỏi, 2 Lambda + Terraform S3, k6, host.mjs, Grafana, báo cáo | **Xong code chuẩn bị, chưa xong tích hợp và đo.** Upload qua web nên nằm lệch thư mục và schema tự đề xuất không khớp A |

**Trả lời câu "D xong chưa":** D làm đủ các hạng mục được giao, nhưng ở dạng "chuẩn bị sẵn". Ba việc còn thiếu: (1) chỉnh SQL của Lambda và audit theo schema thật của A, (2) đổi runtime Lambda, (3) toàn bộ số đo p50/p95, lag, chi phí. Việc (3) **phụ thuộc vào bạn**, nên C đang là nút cổ chai của D.

### 2.2 Bản chất của merge

- Git chỉ so sánh **văn bản**. Hai người sửa hai file khác nhau thì merge "sạch".
- Nhưng **xung đột ngữ nghĩa** (semantic conflict) git không thấy được: A ghi vào bảng `results`, B cộng điểm vào bảng `player_scores`. Code compile, merge sạch, vậy mà điểm luôn bằng 0.
- Vì vậy người tích hợp phải đọc **hợp đồng** (schema, tên topic, channel, payload), không chỉ đọc conflict marker.
- Dùng **nhánh tích hợp** thay vì merge thẳng vào `main`. Khi có sự cố, `main` vẫn sạch để quay lại.

### 2.3 Các xung đột ngữ nghĩa đã tìm thấy

Đề xuất: **lấy schema của A làm chuẩn**. A có migration đầy đủ và 239 test, còn B và D viết khi chưa có schema của A và đều ghi rõ "A sẽ chốt".

| # | Chỗ lệch | A (chuẩn) | B / D hiện tại | Ai sửa, sửa gì |
| --- | --- | --- | --- | --- |
| 1 | Bảng outbox | `outbox(event_id, round_id, player_id, created_at, published_at)`, payload lấy bằng JOIN `answers` | B đọc cột `payload jsonb`, `room_id` (`002_dev_outbox.sql`) | **B**: `outbox.mjs` dùng câu SELECT JOIN trong `docs/live-quiz-week-4.md`, tự dựng event từ các cột |
| 2 | Bảng điểm | `results(room_id uuid, player_id uuid, points)` | B ghi `player_scores` | **B**: `score.mjs` ghi `results` |
| 3 | Bảng chống trùng | `processed_answer_events` | B dùng `score_processed_events` | **B**: đổi tên. Gateway của A **chờ** event có trong `processed_answer_events` rồi mới qua câu, nên nếu không sửa thì **game treo ở màn kết quả** |
| 4 | Redis channel | `razzia:leaderboard`, payload `{"room_id": "..."}` | B publish `razzia:leaderboard:<room_id>` kèm cả leaderboard | **B**: publish đúng channel và payload của A |
| 5 | Trường `choice` | `choice` là integer hoặc null, thêm `answer_keys` dạng mảng | B bắt buộc `choice` là mảng (`contract.mjs`) | **B**: `parseAnswerEvent` chấp nhận `choice: int\|null` và `answer_keys: int[]` |
| 6 | Bảng `questions` | A đã có `quizzes` + `questions(quiz_id, position, definition jsonb)` | D tạo **một bảng khác cùng tên** `questions(set_id, …)` | **D**: Lambda import ghi vào `quizzes`/`questions` của A để quiz nạp xong là chơi được ngay. Giữ `question_sets` làm nhật ký import (A có sẵn `data_imports`) |
| 7 | Export và audit | điểm ở `results`, `answers` có sẵn `room_id` | D đọc `player_scores`, id dạng text | **D**: sửa `export-results/logic.mjs` và `011_score_audit.sql` |
| 8 | Runtime Lambda | — | `nodejs20.x` (Node 20 đã hết hỗ trợ) | **D**: đổi sang `nodejs22.x` hoặc mới hơn |
| 9 | Vị trí thư mục D | — | `role-d-razzia/role-d/` | **C** (khi merge): chuyển vào `role-d/` hoặc `packages/role-d/` |
| 10 | Dockerfile | Builder chỉ copy `package.json` của common/web/socket/e2e | Thêm `packages/streaming` vào workspace | **C**: thêm `COPY packages/streaming/package.json` và target `worker` (§4) |
| 11 | `pnpm-lock.yaml` | Git tự gộp được | Lockfile gộp tự động dễ hỏng | **C**: chạy `pnpm install` để tạo lại lockfile, rồi commit. (Ngày 14/11 đã thử: merge A+B+D không có conflict, và `docker build --target socket` chạy qua.) |

> **Cách làm việc với team:** bạn là người tích hợp, không phải người viết lại code của người khác. Gửi bảng trên vào nhóm chat và tag từng người. Nếu gấp, bạn tự sửa phần "glue" trong một PR riêng rồi nhờ chính chủ review. Hợp đồng bị lệch là lỗi quy trình chung, không phải lỗi của riêng ai.

### 2.4 Làm ngay: lệnh merge

```bash
git fetch --all --prune
git switch main && git pull
git switch -c integration/week4          # nhánh tích hợp

git merge --no-ff origin/feat/razzia-distributed-quiz-backend   # A trước: A là nền
git merge --no-ff origin/feature/role-b-streaming               # B
git merge --no-ff origin/feature/role-d                         # D

git mv role-d-razzia/role-d role-d && git commit -m "chore: move role D into role-d/"
pnpm install                     # tạo lại lockfile cho workspace mới
git add pnpm-lock.yaml && git commit -m "chore: regenerate lockfile after merge"

pnpm build && pnpm test          # test cloud của A tự skip nếu thiếu CLOUD_TEST_*
pnpm --filter @razzia/streaming test
git push -u origin integration/week4     # mở PR integration/week4 → main
```

Vì sao merge A trước: các nhánh sau sẽ được đặt lên trên nền của A. Dùng `--no-ff` để lịch sử giữ lại dấu "đã merge nhánh X", về sau dễ revert cả một nhánh.

**Xong khi:** `pnpm build` chạy qua, test chạy qua, và đã gửi bảng §2.3 cho team.

---

## 3. Giai đoạn 1 — Chạy cả hệ thống ở local trước khi lên cloud

**Bản chất:** lỗi tích hợp phát hiện ở local chỉ tốn vài phút. Phát hiện trên EKS thì tốn cả tiền lẫn 20 phút mỗi vòng thử. Docker Compose là "cụm Kubernetes của người nghèo": cùng image, cùng biến môi trường, cùng cổng.

Tạo `compose.full.yml`. File này dùng image build từ chính Dockerfile sẽ chạy trên EKS:

```yaml
x-app-env: &app-env
  DATABASE_URL: postgres://razzia:razzia@postgres:5432/razzia
  REDIS_URL: redis://redis:6379
  JWT_SECRET: local-dev-secret-at-least-32-characters-long
  MANAGER_PASSWORD: admin
  KAFKA_BROKERS: kafka:9092

services:
  postgres:
    image: postgres:16-alpine
    environment: { POSTGRES_DB: razzia, POSTGRES_USER: razzia, POSTGRES_PASSWORD: razzia }
    healthcheck: { test: ["CMD", "pg_isready", "-U", "razzia"], interval: 2s }
  redis:
    image: redis:7-alpine
  kafka:
    image: apache/kafka:3.9.1          # một node KRaft, giống EC2
  migrate:                              # job chạy migration một lần, giống Helm hook (§6.4)
    image: postgres:16-alpine
    depends_on: { postgres: { condition: service_healthy } }
    volumes: ["./packages/socket/migrations:/m:ro", "./deploy/migrate.sh:/migrate.sh:ro"]
    environment: { DATABASE_URL: postgres://razzia:razzia@postgres:5432/razzia }
    command: ["sh", "/migrate.sh", "/m"]
  socket-1: &socket
    build: { context: ., target: socket }
    environment: *app-env
    depends_on: { migrate: { condition: service_completed_successfully } }
  socket-2: *socket                     # 2 replica để thử Redis adapter + lease
  web:
    build: { context: ., target: web }
  proxy:                                # đóng vai ALB: / → web, /api và /ws → socket
    image: nginx:alpine
    ports: ["8080:80"]
    volumes: ["./deploy/local-alb.conf:/etc/nginx/conf.d/default.conf:ro"]
  publisher: &worker
    build: { context: ., target: worker }
    command: ["node", "src/publisher.mjs"]
    environment: *app-env
  score: { <<: *worker, command: ["node", "src/score-worker.mjs"] }
  stats: { <<: *worker, command: ["node", "src/stats-worker.mjs"] }
```

`deploy/local-alb.conf` (`upstream` với 2 server giả lập ALB chia tải round-robin):

```nginx
upstream socket { server socket-1:3001; server socket-2:3001; }
map $http_upgrade $conn { default upgrade; '' close; }
server {
  listen 80;
  location /api { proxy_pass http://socket; }
  location /ws  { proxy_pass http://socket; proxy_http_version 1.1;
                  proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection $conn;
                  proxy_read_timeout 3600s; }
  location /    { proxy_pass http://web:3000; }
}
```

Sau khi game chạy, tạo topic một lần: `docker compose -f compose.full.yml exec kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --create --topic answers --partitions 3`.

**Xong khi:** mở `http://localhost:8080`, host và 2 tab người chơi chơi hết một quiz; điểm 1/câu đúng hiện ra; `docker compose stop socket-1` giữa câu mà game vẫn tiếp tục (lease của A tự chuyển sang socket-2); `SELECT * FROM results` khớp với số câu đúng.

---

## 4. Giai đoạn 2 — Container image

### Bản chất

- **Container không phải VM.** Container là một process Linux bình thường, bị cô lập bằng **namespaces** (thấy filesystem, mạng, PID riêng) và bị giới hạn tài nguyên bằng **cgroups** (CPU, RAM). Không có kernel riêng, nên khởi động trong vài trăm ms. `requests/limits` của Kubernetes cuối cùng được ghi thành cgroup.
- **Multi-stage build:** stage `builder` có pnpm, TypeScript, devDependencies; stage chạy chỉ copy kết quả build sang. Image nhỏ hơn, ít lỗ hổng hơn, kéo về node nhanh hơn, nên scale out cũng nhanh hơn.
- **Layer cache:** copy `package.json` + lockfile và `pnpm install` *trước*, copy source *sau*. Sửa code không làm cài lại dependency.
- **Stateless:** container có thể bị giết bất cứ lúc nào, nên không giữ gì quan trọng trên đĩa hay RAM. A đã đưa state vào RDS và Redis, đây là điều kiện để chạy nhiều replica.

### Làm ngay

Dockerfile của A đã có target `web` (nginx, cổng 3000) và `socket` (node, cổng 3001). Bạn thêm 2 chỗ:

```dockerfile
# trong stage builder, cạnh các dòng COPY package.json khác
COPY packages/streaming/package.json ./packages/streaming/
# ... sau RUN pnpm build:
RUN pnpm --filter @razzia/streaming deploy --prod /out/streaming
#   (nếu pnpm báo lỗi về inject-workspace-packages thì thêm --legacy)

# ---- WORKER (publisher / score / stats dùng chung 1 image, khác command) ----
FROM node-runtime AS worker
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /out/streaming /app
USER node
CMD ["node", "src/score-worker.mjs"]
```

Ba process chung một image vì chung code và dependency. Khác nhau ở `command`, do Helm khai báo. Tách image chỉ đáng khi dependency khác nhau.

Kiểm tra:

```bash
docker build --target socket -t razzia-socket:dev .
docker build --target web    -t razzia-web:dev .
docker build --target worker -t razzia-worker:dev .
docker images | grep razzia     # so sánh kích thước, để ghi vào báo cáo
```

**Xong khi:** build được cả 3 target và `compose.full.yml` chạy bằng chính các image này.

---

## 5. Giai đoạn 3 — Terraform (IaC)

### Bản chất

- **Declarative:** bạn viết "muốn có VPC 2 AZ", Terraform so sánh với **state** (file ghi tài nguyên đang có) và tính ra kế hoạch (`plan`), rồi mới thực hiện (`apply`).
- **State là trái tim.** Mất state thì Terraform "quên" tài nguyên: lần sau nó tạo trùng, hoặc không xóa được. Vì vậy state đặt ở **S3** (remote state, cả nhóm thấy chung), bật **lock** (2 người không `apply` cùng lúc) và bật versioning (khôi phục khi hỏng). Bảng phân công quy định "chỉ C hoặc CI chạy apply" cũng vì lý do này.
- **Dùng module cộng đồng** (`terraform-aws-modules/*`) cho VPC và EKS. Tự viết EKS từ đầu mất vài ngày và rất dễ sai IAM. Khi chấm, điều quan trọng là bạn hiểu các tài nguyên module tạo ra, không phải tự gõ hết.

### Cấu trúc thư mục

```
infra/
  bootstrap/        # chạy 1 lần, state local: S3 bucket chứa state. Không bao giờ destroy
  envs/dev/         # root module: backend.tf, main.tf, variables.tf, outputs.tf
  modules/
    network/        # VPC, subnet, 1 NAT
    data/           # RDS, ElastiCache, SG
    kafka/          # EC2 Kafka + SG + user_data
    quiz-lambda/    # = thư mục infra/ của D, chuyển thành module
```

### Làm ngay: bootstrap state (chạy 1 lần)

```hcl
# infra/bootstrap/main.tf
provider "aws" { region = "ap-southeast-1" }
resource "aws_s3_bucket" "tfstate" { bucket = "razzia-tfstate-<tên-nhóm>" }
resource "aws_s3_bucket_versioning" "v" {
  bucket = aws_s3_bucket.tfstate.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_public_access_block" "b" {
  bucket = aws_s3_bucket.tfstate.id
  block_public_acls = true
  block_public_policy = true
  ignore_public_acls = true
  restrict_public_buckets = true
}
```

```hcl
# infra/envs/dev/backend.tf — Terraform >= 1.10 khóa state bằng file trên S3, không cần DynamoDB
terraform {
  backend "s3" {
    bucket       = "razzia-tfstate-<tên-nhóm>"
    key          = "dev/terraform.tfstate"
    region       = "ap-southeast-1"
    use_lockfile = true
    encrypt      = true
  }
}
```

### Làm ngay: bộ khung `envs/dev/main.tf`

Kiểm tra lại tên biến trong README của module **đúng version đã pin**. Module EKS đổi tên biến giữa các major version.

```hcl
locals { name = "razzia", azs = ["ap-southeast-1a", "ap-southeast-1b"] }

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 6.0"
  name    = local.name
  cidr    = "10.0.0.0/16"
  azs             = local.azs
  public_subnets  = ["10.0.0.0/24", "10.0.1.0/24"]     # ALB, NAT
  private_subnets = ["10.0.10.0/23", "10.0.12.0/23"]   # node, pod, RDS, Kafka (/23 vì VPC CNI ăn nhiều IP)
  enable_nat_gateway = true
  single_nat_gateway = true                             # tiết kiệm: 1 NAT thay vì 1 NAT mỗi AZ
  public_subnet_tags  = { "kubernetes.io/role/elb" = 1 }          # ALB controller tìm subnet nhờ tag
  private_subnet_tags = { "kubernetes.io/role/internal-elb" = 1 }
}

module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 21.0"
  name               = local.name
  kubernetes_version = "1.34"            # chọn bản EKS còn standard support
  endpoint_public_access                   = true
  enable_cluster_creator_admin_permissions = true
  enable_irsa                              = true
  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets
  addons = {
    vpc-cni    = { before_compute = true }
    coredns    = {}
    kube-proxy = {}
  }
  eks_managed_node_groups = {
    default = {
      instance_types = ["t3.medium"]
      min_size = 2, desired_size = 2, max_size = 4     # >= 2 node theo đề, max cho Cluster Autoscaler
    }
  }
}

resource "aws_ecr_repository" "app" {
  for_each     = toset(["web", "socket", "worker"])
  name         = "${local.name}/${each.key}"
  force_delete = true                    # để script hủy môi trường xóa được
  image_tag_mutability = "IMMUTABLE"     # tag = git SHA, không ghi đè
}
```

`modules/data` (rút gọn):

```hcl
resource "aws_security_group" "data" {
  vpc_id = var.vpc_id
  ingress { from_port = 5432, to_port = 5432, protocol = "tcp", security_groups = [var.node_sg_id] }
  ingress { from_port = 6379, to_port = 6379, protocol = "tcp", security_groups = [var.node_sg_id] }
}
resource "aws_db_subnet_group" "db" { subnet_ids = var.private_subnets }
resource "aws_db_instance" "pg" {
  identifier = "razzia"
  engine = "postgres", engine_version = "16"
  instance_class = "db.t4g.micro", allocated_storage = 20
  db_name = "razzia", username = "razzia"
  manage_master_user_password = true       # mật khẩu nằm trong Secrets Manager, không nằm trong state
  db_subnet_group_name   = aws_db_subnet_group.db.name
  vpc_security_group_ids = [aws_security_group.data.id]
  skip_final_snapshot = true, multi_az = false   # môi trường thí nghiệm
}
resource "aws_elasticache_subnet_group" "r" { name = "razzia", subnet_ids = var.private_subnets }
resource "aws_elasticache_cluster" "redis" {
  cluster_id = "razzia", engine = "redis", node_type = "cache.t4g.micro", num_cache_nodes = 1
  subnet_group_name = aws_elasticache_subnet_group.r.name
  security_group_ids = [aws_security_group.data.id]
}
```

Lưu ý: `node_sg_id` là `module.eks.node_security_group_id`. Lambda của D cũng cần vào RDS, nên thêm SG của Lambda vào ingress 5432.

`modules/kafka` (rút gọn): `aws_instance` loại `t3.small`, Amazon Linux 2023, đặt trong private subnet. SG mở `9092` **chỉ từ node SG**. Gắn IAM role có `AmazonSSMManagedInstanceCore` để vào máy bằng **SSM Session Manager**, không cần SSH key hay IP public. `user_data` cài `java-21-amazon-corretto-headless`, tải Kafka 3.9.1, rồi để B chạy `packages/streaming/kafka/setup-ec2.sh`. Output ra `private_ip` để đặt vào `KAFKA_BROKERS`.

`modules/quiz-lambda`: chép `infra/` của D sang, bỏ khối `provider` (module không khai báo provider), đổi `version = "~> 5.70"` thành `>= 5.70` để không xung đột với provider v6 của root, rồi truyền `vpc_subnet_ids = module.vpc.private_subnets`.

### Lệnh hằng ngày

```bash
cd infra/envs/dev
terraform init          # lần đầu, hoặc khi thêm module
terraform fmt && terraform validate
terraform plan -out tf.plan     # ĐỌC plan: có "destroy" bất ngờ không?
terraform apply tf.plan
aws eks update-kubeconfig --name razzia --region ap-southeast-1
kubectl get nodes               # thấy 2 node, mỗi AZ 1 node
```

**Xong khi:** `kubectl get nodes` thấy 2 node Ready ở 2 AZ; một pod `psql` tạm trong cụm kết nối được RDS (`kubectl run -it --rm pg --image=postgres:16-alpine -- psql "$URL"`).

---

## 6. Giai đoạn 4 — Kubernetes và Helm

### 6.1 Bản chất: các khái niệm cần thuộc

| Khái niệm | Ẩn dụ | Trong dự án |
| --- | --- | --- |
| **Pod** | 1 "máy" chạy container, có IP riêng | 1 process socket |
| **Deployment** | Người quản lý: "luôn giữ đủ N pod giống nhau", rolling update | web, socket, publisher, score, stats |
| **Service** | Tên DNS và IP ổn định trỏ tới nhóm pod (theo label) | `socket:3001`, `web:3000` |
| **Ingress** + AWS Load Balancer Controller | Controller đọc Ingress rồi **tạo ALB thật** trên AWS | `/` → web, `/api` và `/ws` → socket |
| **readinessProbe** | "Đã sẵn sàng nhận khách chưa?" Fail thì bị **rút khỏi** load balancer, không bị giết | `/health/ready` (A kiểm tra PG + Redis) |
| **livenessProbe** | "Còn sống không?" Fail thì **bị restart** | `/health/live`. Tuyệt đối không trỏ liveness vào ready: Redis chập chờn sẽ khiến mọi pod bị restart dây chuyền |
| **requests/limits** | requests để scheduler xếp chỗ, limits là trần cgroup | CPU vượt limit thì bị throttle, RAM vượt limit thì bị OOMKilled |
| **HPA** | Tự tăng hoặc giảm số pod theo metric | socket theo CPU |
| **PDB** | "Lúc drain node, luôn giữ tối thiểu N pod" | socket `minAvailable: 1` |
| **topologySpreadConstraints** | Trải pod đều theo AZ hoặc node | Chết 1 AZ không chết cả hệ thống |
| **IRSA** | Pod nhận IAM role qua ServiceAccount, không cần access key | ALB controller, Cluster Autoscaler |

**AWS VPC CNI** (phục vụ báo cáo của bạn): mỗi pod nhận **một IP thật trong VPC** (lấy từ ENI phụ của node). Vì vậy ALB dùng `target-type: ip` đi **thẳng tới pod**, bỏ qua kube-proxy và NodePort. Mặt trái: số pod trên mỗi node bị giới hạn bởi số ENI × số IP mỗi ENI của loại instance (t3.medium tối đa 17 pod), và subnet phải đủ rộng.

**WebSocket qua ALB:** A ép client dùng `transports: ['websocket']`, nên không có giai đoạn long-polling và **không cần sticky session**. Một kết nối WebSocket gắn với một pod suốt đời của nó. Redis adapter của A lo phần phát tin giữa các pod. Cần nâng `idle_timeout` của ALB (mặc định 60 giây) để kết nối không bị cắt.

### 6.2 Làm ngay: cài các controller nền

```bash
# AWS Load Balancer Controller (cần IAM role IRSA, tạo bằng Terraform module iam-role-for-service-accounts)
helm repo add eks https://aws.github.io/eks-charts
helm upgrade --install aws-load-balancer-controller eks/aws-load-balancer-controller -n kube-system \
  --set clusterName=razzia --set serviceAccount.create=true \
  --set serviceAccount.annotations."eks\.amazonaws\.com/role-arn"=<ALB_ROLE_ARN>

# metrics-server (HPA cần cái này để đọc CPU)
helm repo add metrics-server https://kubernetes-sigs.github.io/metrics-server/
helm upgrade --install metrics-server metrics-server/metrics-server -n kube-system
```

### 6.3 Làm ngay: Helm chart `deploy/helm/razzia`

```
deploy/helm/razzia/
  Chart.yaml
  values.yaml
  templates/
    deployments.yaml   # 1 template lặp qua .Values.apps
    services.yaml
    ingress.yaml
    hpa.yaml
    pdb.yaml
    migrate-job.yaml
    servicemonitor.yaml
```

`values.yaml`: chỗ duy nhất bạn chỉnh khi đổi cấu hình.

```yaml
image:
  registry: <account>.dkr.ecr.ap-southeast-1.amazonaws.com/razzia
  tag: "<git-sha>"                 # CI truyền vào bằng --set image.tag=...
secretName: razzia-env             # chứa DATABASE_URL, REDIS_URL, JWT_SECRET, MANAGER_PASSWORD, KAFKA_BROKERS

apps:
  web:
    image: web
    port: 3000
    replicas: 2
    probe: { live: /, ready: / }
    resources: { requests: { cpu: 50m, memory: 64Mi }, limits: { memory: 128Mi } }
  socket:
    image: socket
    port: 3001
    replicas: 2
    probe: { live: /health/live, ready: /health/ready }
    metricsPath: /metrics
    resources: { requests: { cpu: 250m, memory: 256Mi }, limits: { memory: 512Mi } }
    hpa: { min: 2, max: 6, cpu: 60 }
    pdb: { minAvailable: 1 }
  publisher: { image: worker, command: ["node", "src/publisher.mjs"],    metricsPort: 9101, replicas: 1 }
  score:     { image: worker, command: ["node", "src/score-worker.mjs"], metricsPort: 9102, replicas: 1 }
  stats:     { image: worker, command: ["node", "src/stats-worker.mjs"], metricsPort: 9103, replicas: 1 }
```

`templates/deployments.yaml`: một template sinh ra tất cả Deployment.

```yaml
{{- range $name, $app := .Values.apps }}
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: {{ $name }}, labels: { app: {{ $name }} } }
spec:
  {{- if not $app.hpa }}
  replicas: {{ $app.replicas }}
  {{- end }}
  selector: { matchLabels: { app: {{ $name }} } }
  template:
    metadata: { labels: { app: {{ $name }} } }
    spec:
      terminationGracePeriodSeconds: 45
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: ScheduleAnyway
          labelSelector: { matchLabels: { app: {{ $name }} } }
      containers:
        - name: {{ $name }}
          image: "{{ $.Values.image.registry }}/{{ $app.image }}:{{ $.Values.image.tag }}"
          {{- with $app.command }}
          command: {{ toJson . }}
          {{- end }}
          envFrom: [{ secretRef: { name: {{ $.Values.secretName }} } }]
          {{- with $app.port }}
          ports: [{ containerPort: {{ . }} }]
          {{- end }}
          {{- with $app.probe }}
          livenessProbe:  { httpGet: { path: {{ .live }},  port: {{ $app.port }} }, periodSeconds: 10, failureThreshold: 3 }
          readinessProbe: { httpGet: { path: {{ .ready }}, port: {{ $app.port }} }, periodSeconds: 5 }
          lifecycle: { preStop: { exec: { command: ["sleep", "15"] } } }   # chờ ALB rút target trước khi tắt
          {{- end }}
          resources: {{ toJson ($app.resources | default dict) }}
{{- end }}
```

Vì sao có `preStop sleep`: khi pod bị xóa, ALB cần vài giây để ngừng gửi kết nối mới tới pod. Không có sleep thì người chơi sẽ gặp lỗi 502 trong lúc rolling update. Thời gian dừng của A (`SIGTERM`, nhả lease) nằm sau khoảng sleep này, và phải ngắn hơn `terminationGracePeriodSeconds`.

`templates/ingress.yaml`:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: razzia
  annotations:
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/load-balancer-attributes: idle_timeout.timeout_seconds=3600
    alb.ingress.kubernetes.io/target-group-attributes: deregistration_delay.timeout_seconds=30
spec:
  ingressClassName: alb
  rules:
    - http:
        paths:   # path cụ thể đặt trước
          - { path: /api, pathType: Prefix, backend: { service: { name: socket, port: { number: 3001 } } } }
          - { path: /ws,  pathType: Prefix, backend: { service: { name: socket, port: { number: 3001 } } } }
          - { path: /,    pathType: Prefix, backend: { service: { name: web,    port: { number: 3000 } } } }
```

Trên Service `socket`, thêm annotation `alb.ingress.kubernetes.io/healthcheck-path: /health/ready` để target group của socket dùng health check của A (mặc định ALB gọi `/`).

Secret: tạm thời tạo bằng tay để đi nhanh, giai đoạn tối ưu mới chuyển sang External Secrets hoặc Secrets Store CSI:

```bash
kubectl create secret generic razzia-env \
  --from-literal=DATABASE_URL='postgres://razzia:<pw>@<rds-endpoint>:5432/razzia?sslmode=require' \
  --from-literal=REDIS_URL='redis://<elasticache-endpoint>:6379' \
  --from-literal=JWT_SECRET="$(openssl rand -hex 32)" \
  --from-literal=MANAGER_PASSWORD='<pw>' \
  --from-literal=KAFKA_BROKERS='<kafka-private-ip>:9092'
```

### 6.4 Migration DB: Job chạy trước mỗi lần deploy

**Bản chất:** migration của A **không idempotent** (`CREATE TABLE` không có `IF NOT EXISTS`), và A dặn "chạy một lần, đúng thứ tự". Vì vậy cần một bảng ghi lại migration nào đã chạy. Đây là ý tưởng cốt lõi của Flyway hay Liquibase, chỉ là bản tự viết 10 dòng.

`deploy/migrate.sh` (dùng cho cả Compose và Helm):

```sh
#!/bin/sh
set -eu
DIR="$1"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c \
  "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())"
for f in $(ls "$DIR"/*.sql | sort); do
  n=$(basename "$f")
  if [ -z "$(psql "$DATABASE_URL" -tAc "SELECT 1 FROM schema_migrations WHERE name='$n'")" ]; then
    echo "apply $n"
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f "$f"
    psql "$DATABASE_URL" -c "INSERT INTO schema_migrations(name) VALUES ('$n')"
  fi
done
```

Trên K8s: `migrate-job.yaml` là một `Job` có annotation `"helm.sh/hook": pre-install,pre-upgrade`, image `postgres:16-alpine`, mount các file SQL qua ConfigMap (dùng `.Files.Glob`, nên phải copy thư mục migrations vào trong chart). Thứ tự chạy: `001`–`004` của A, sau đó là bảng stats của B và bảng của D (đánh số `005`, `006`… sau khi sửa theo §2.3).

### 6.5 Deploy

```bash
helm upgrade --install razzia deploy/helm/razzia --set image.tag=$(git rev-parse --short HEAD) --wait
kubectl get pods -o wide            # pod nằm ở các node khác nhau?
kubectl get ingress razzia          # cột ADDRESS = DNS của ALB (chờ 2–3 phút)
```

**Xong khi:** mở DNS của ALB và chơi hết một ván với 2 thiết bị; `kubectl delete pod <socket-coordinator>` giữa câu mà ván vẫn tiếp tục.

> **Đường tắt cho mốc baseline tuần 2 (D đang cần gấp):** deploy *image gốc* của `main` (target `runner`, 1 replica, không DB) bằng chart này với `apps` chỉ có 1 mục. D có ngay URL để đo baseline trong lúc bạn làm tiếp phần còn lại.

---

## 7. Giai đoạn 5 — CI/CD: GitHub Actions đẩy image lên ECR

**Bản chất:** CI build image ở môi trường sạch, gắn tag bằng commit SHA, nên mỗi image truy ngược được về đúng một commit (immutable artifact). GitHub đăng nhập AWS bằng **OIDC**: AWS tin token tạm thời do GitHub phát, nên **không lưu access key** trong GitHub Secrets.

`.github/workflows/ecr.yml`:

```yaml
name: build-push
on: { push: { branches: [main, "integration/**"] } }
permissions: { id-token: write, contents: read }
jobs:
  image:
    runs-on: ubuntu-latest
    strategy: { matrix: { target: [web, socket, worker] } }
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with: { role-to-assume: "${{ vars.AWS_ROLE_ARN }}", aws-region: ap-southeast-1 }
      - id: ecr
        uses: aws-actions/amazon-ecr-login@v2
      - uses: docker/setup-buildx-action@v3
      - uses: docker/build-push-action@v6
        with:
          context: .
          target: ${{ matrix.target }}
          push: true
          tags: ${{ steps.ecr.outputs.registry }}/razzia/${{ matrix.target }}:${{ github.sha }}
          cache-from: type=gha,scope=${{ matrix.target }}
          cache-to: type=gha,mode=max,scope=${{ matrix.target }}
```

IAM role cho OIDC (provider `token.actions.githubusercontent.com`, điều kiện `sub = repo:khanh04032005/cloud:*`, quyền push ECR) nên khai báo trong Terraform.

Repo đang có `docker-release.yml` và `docker-scout.yml` của upstream (đẩy Docker Hub). Hãy tắt hoặc xóa chúng để tránh chạy lỗi vì thiếu secret.

Ban đầu chỉ cần CI **build và push**, còn deploy vẫn chạy `helm upgrade` bằng tay. Tự động deploy (job thứ hai, hoặc ArgoCD) để sang giai đoạn tối ưu.

---

## 8. Giai đoạn 6 — Monitoring, autoscale, script bật/tắt

### 8.1 Prometheus + Grafana

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm upgrade --install kps prometheus-community/kube-prometheus-stack -n monitoring --create-namespace \
  --set grafana.adminPassword=<pw>
```

Prometheus tự "kéo" (scrape) metric từ những target được khai báo bằng **ServiceMonitor**. Mặc định nó chỉ nhận ServiceMonitor có label `release: kps`. Cần tạo ServiceMonitor cho: `socket:3001/metrics` (metric của A), `publisher:9101`, `score:9102`, `stats:9103` (metric của B, trong đó có `razzia_kafka_consumer_lag`). Worker cần một Service để ServiceMonitor trỏ tới. Import dashboard `role-d/grafana/razzia-role-d.json` của D.

CloudWatch Container Insights: bật EKS add-on `amazon-cloudwatch-observability` trong Terraform và gắn `CloudWatchAgentServerPolicy` cho node role.

### 8.2 HPA và Cluster Autoscaler

- **HPA** (trong `hpa.yaml`): socket scale theo CPU 60%, từ 2 đến 6 pod.
  - Lưu ý cho báo cáo: WebSocket là kết nối dài, nên pod mới **chỉ nhận kết nối mới**. Kết nối cũ không tự chuyển sang. Đây là điểm khác với HTTP thường, D nên đo đúng hiện tượng này.
  - Worker **không vượt quá số partition (3)**: consumer thứ 4 trong cùng consumer group sẽ ngồi chơi.
- **Cluster Autoscaler:** khi pod ở trạng thái `Pending` vì thiếu chỗ, CA tăng `desired` của node group (giới hạn bởi `max_size = 4`). Cài bằng Helm chart `autoscaler/cluster-autoscaler` với `autoDiscovery.clusterName=razzia` và IRSA role. EKS managed node group đã tự gắn tag để CA tìm thấy.
- **Thứ tự nhân quả cần hiểu:** tải tăng → CPU pod tăng → HPA thêm pod → không còn chỗ → pod `Pending` → CA thêm node (khoảng 2–4 phút) → pod chạy. Độ trễ này là số liệu cho thí nghiệm 4 của D.

### 8.3 Script dựng và hủy

`scripts/up.sh`:

```bash
set -euo pipefail
terraform -chdir=infra/envs/dev apply -auto-approve
aws eks update-kubeconfig --name razzia --region ap-southeast-1
./scripts/install-addons.sh           # ALB controller, metrics-server, CA, kps (helm upgrade --install, idempotent)
./scripts/create-secret.sh            # đọc output terraform + Secrets Manager
helm upgrade --install razzia deploy/helm/razzia --set image.tag="${TAG:?}" --wait
kubectl get ingress razzia
```

`scripts/down.sh`. **Thứ tự rất quan trọng:**

```bash
set -euo pipefail
helm uninstall razzia || true         # 1. XÓA INGRESS TRƯỚC → controller xóa ALB
sleep 60                              #    chờ ALB và target group biến mất
helm uninstall -n monitoring kps || true
terraform -chdir=infra/envs/dev destroy -auto-approve   # 2. rồi mới hủy VPC/EKS
```

Nếu destroy Terraform trước, ALB do controller tạo (Terraform không biết tới nó) vẫn còn giữ ENI trong subnet. Lúc đó VPC không xóa được và ALB vẫn tính tiền. Đây là lỗi kinh điển.

Chi phí tham khảo (ap-southeast-1, kiểm lại bằng Pricing Calculator): EKS control plane, NAT, 2 × t3.medium, RDS và ElastiCache micro, ALB, Kafka t3.small cộng lại khoảng **0,4–0,5 USD/giờ**. Mỗi buổi test 3 giờ tốn khoảng 1,5 USD; để quên cả tuần thì mất khoảng 70 USD. Đặt **AWS Budgets** cảnh báo ở 20 USD ngay hôm đầu.

---

## 9. Lịch dồn lại cho C (từ 14/11)

| Ngày | Việc | Mở khóa cho ai |
| --- | --- | --- |
| T7–CN 14–15/11 | §2: nhánh tích hợp, gửi bảng xung đột cho B và D. §4: Dockerfile có target worker. Bắt đầu §3 Compose | B, D sửa hợp đồng |
| T2–T3 16–17/11 | §5: bootstrap state + VPC + EKS + ECR. §7: CI push image | — |
| T4 18/11 | Deploy **baseline** (image gốc, 1 replica) qua ALB | **D đo baseline** |
| T5–T6 19–20/11 | RDS, Redis, EC2 Kafka; migration Job; chart đầy đủ 5 app | B cấu hình broker trên EC2 |
| T7–CN 21–22/11 | Cả hệ thống end-to-end trên EKS, kill pod thử | **Mốc tuần 4** |
| Tuần 5 | HPA, CA, kube-prometheus-stack, Container Insights | D chạy thử 1.000 người |
| Tuần 6 | up/down script, tối ưu chi phí, chọn instance | D so sánh fixed và autoscale |
| Tuần 7–8 | Drain node, quay video demo dự phòng, viết báo cáo | Cả nhóm |

---

## 10. Sổ tay debug

Luôn đi theo thứ tự: **`kubectl get` → `describe` → `logs` → `events`**.

| Triệu chứng | Nguyên nhân thường gặp | Cách xem |
| --- | --- | --- |
| `ImagePullBackOff` | Sai tên hoặc tag image, node không có quyền đọc ECR | `kubectl describe pod`, phần Events |
| `CrashLoopBackOff` | App crash lúc khởi động, thường do thiếu env (env.ts của A **throw** khi thiếu biến) | `kubectl logs <pod> --previous` |
| Pod `Running` nhưng `0/1 Ready` | `/health/ready` fail vì không tới được RDS hoặc Redis (SG, sai URL, thiếu `sslmode`) | `kubectl exec` không được thì dùng `kubectl run` một pod tạm để `nc -zv host port` |
| `Pending` | Thiếu CPU hoặc RAM theo requests, hoặc hết IP trên node (VPC CNI) | `kubectl describe pod`, tìm dòng "Insufficient" |
| Ingress không có ADDRESS | Controller lỗi IAM, hoặc subnet thiếu tag `kubernetes.io/role/elb` | `kubectl logs -n kube-system deploy/aws-load-balancer-controller` |
| ALB 502/503 | Target unhealthy vì health check sai path | EC2 Console → Target Groups → Health |
| WebSocket rớt sau 60 giây | Chưa nâng `idle_timeout` | Annotation `load-balancer-attributes` |
| Worker không nhận event | Sai `KAFKA_BROKERS`, SG 9092, hoặc `advertised.listeners` của broker không phải private IP | Log của worker, `nc -zv <ip> 9092` từ pod tạm |
| Game treo ở màn kết quả | Score worker không ghi `processed_answer_events` (xung đột #3) | `SELECT count(*) FROM outbox o LEFT JOIN processed_answer_events p USING(event_id) WHERE p.event_id IS NULL` |
| `terraform destroy` kẹt ở VPC | ALB hoặc ENI do controller tạo còn sót | Chạy `helm uninstall` trước (§8.3) |

---

## 11. Nội dung báo cáo của C: ghi chép trong lúc làm

- **Hypervisor:** EC2 hiện đại chạy trên **AWS Nitro**. Phần ảo hóa mạng, lưu trữ và quản lý được đẩy xuống card phần cứng Nitro riêng, hypervisor còn lại rất mỏng (dựa trên KVM). Guest dùng driver **paravirtual**: **ENA** cho mạng và **NVMe** cho EBS. Guest biết mình đang được ảo hóa và nói chuyện thẳng với thiết bị ảo, không phải giả lập phần cứng cũ. Thí nghiệm nhỏ: `t3` (burstable, dùng **CPU credit**; tải kéo dài thì hết credit và bị hạ hiệu năng) so với `m6i`/`c6i` (hiệu năng ổn định). Chạy cùng một tải k6 rồi so sánh p95 và CloudWatch `CPUCreditBalance`. Lệnh xem trong node: `lspci`, `ethtool -i eth0` (driver ena), `nvme list`.
- **Container và K8s:** cgroups ↔ requests/limits; stateless; probe; rolling update; PDB và topology spread khi drain.
- **Mạng:** VPC 2 AZ, public subnet (ALB, NAT) và private subnet (node, data); vì sao chỉ dùng 1 NAT (đánh đổi chi phí với độ sẵn sàng); security group theo nguyên tắc tối thiểu (SG tham chiếu SG thay vì CIDR); VPC CNI cấp IP thật cho pod; ALB `target-type: ip` và WebSocket.
- **IaC:** state, plan/apply, remote state và lock, module; immutable image theo SHA; Helm values tách khỏi template.
- **Elasticity (cấu hình):** HPA, CA, chuỗi nhân quả ở §8.2; giới hạn partition của worker.

Mẹo: mỗi lần làm xong một giai đoạn, **chụp màn hình và lưu lệnh vào `docs/role-c-notes.md`**. Cuối kỳ viết báo cáo chỉ cần ghép lại.

---

## 12. Sau khi bộ sườn chạy: tối ưu theo đo đạc, không theo cảm giác

Chỉ làm những việc dưới đây khi đã có số đo của D chỉ ra nút thắt:

- Secret: chuyển từ tạo tay sang External Secrets Operator đọc Secrets Manager.
- Deploy: thêm job deploy trong CI, hoặc ArgoCD (GitOps).
- Node: thay `t3` bằng `m`/`c` nếu thấy CPU credit cạn; dùng Spot cho worker.
- Socket HPA: scale theo metric `razzia_connections` (cần prometheus-adapter) thay vì CPU.
- Kafka: 3 broker (B), RDS Multi-AZ, NAT mỗi AZ. Chỉ ghi trong báo cáo nếu không đủ ngân sách.
- Karpenter thay cho Cluster Autoscaler. Ghi vào phần so sánh, không bắt buộc.
