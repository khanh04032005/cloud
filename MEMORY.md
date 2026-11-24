# MEMORY: ngữ cảnh cho phiên làm việc tiếp theo

> Đọc file này đầu tiên khi mở phiên mới. Cập nhật mục **Trạng thái** và **Việc tiếp theo** ở cuối mỗi phiên.
> Thí nghiệm và số đo: [EXPERIMENTS.md](EXPERIMENTS.md). Bài học: [LEARNINGS.md](LEARNINGS.md).
> Cập nhật lần cuối: 21/11/2026. Người dùng yêu cầu lưu checkpoint, nghỉ và làm tiếp ngày mai.

## Dự án

- **Đề tài:** Live Quiz trên nền Razzia (fork Rahoot), môn Cloud Computing. Nhóm 4 người, 26/10 đến **20/12/2026**.
- **Mục tiêu kỹ thuật:** đưa state của Razzia (gốc nằm trong RAM của một process) ra Postgres và Redis để chạy nhiều replica; tính điểm qua Kafka; chạy trên AWS (EKS); Lambda nạp câu hỏi.
- **Luật điểm:** đúng 1 điểm, tốc độ không ảnh hưởng (khác Razzia gốc).
- **Mục tiêu cá nhân:** làm xong phần lõi trong khoảng 2 tuần (đến ~29/11), còn ~3 tuần dự phòng.
- Tài liệu gốc: `Phân công dự án Live Quiz (Razzia) - 4 người, 8 tuần.pdf`, `docs/role-c-guideline.md` (kế hoạch chi tiết của vai C).

## Vai trò

| Vai      | Phần                                                                                                              | Trạng thái 19/11                                                                                         |
| -------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| A        | Backend socket: tách web/socket, migration 001–004, Redis adapter, outbox, lease/fencing, `/health/*`, `/metrics` | Xong                                                                                                     |
| B        | `packages/streaming`: publisher, score-worker, stats-worker, Bloom, HLL, replay                                   | Đã dùng schema chung; game và replay Kafka thật đạt tại local                                            |
| C (mình) | Tích hợp, Docker, Terraform, K8s/Helm, CI, autoscale, script bật/tắt                                              | Docker và Terraform xong, chưa chạy trên AWS                                                             |
| D        | `role-d/`: Lambda import/export, S3, k6, Grafana, báo cáo                                                         | SQL import/export/audit đã theo schema A; chưa nghiệm thu Lambda AWS; runtime Terraform còn `nodejs20.x` |

## Quyết định đã chốt

- **Schema của A là chuẩn.** B và D sửa theo A.
- **Region triển khai hiện tại:** `ap-southeast-2` (Sydney), đúng Region được gán cho AWS project. Singapore `ap-southeast-1` bị SCP chặn. Khi chuẩn bị pha EKS, cần truyền region Sydney rõ ràng vì code dev hiện vẫn mặc định Singapore.
- **Cách cộng tác:** hướng dẫn deploy từng pha để người dùng tự chạy, chờ kết quả rồi sang pha tiếp. Chỉ thực hiện thay khi người dùng yêu cầu rõ; lượt 20/11 chỉ được yêu cầu làm giúp pha bootstrap Sydney.
- **Tiết kiệm chi phí đã chốt 21/11:** giữ EKS nhưng chỉ 1 node x86_64 `t3.small` (2 GiB), Spot, min/max đều 1; NAT fck-nat `t4g.micro` (ARM64, 1 GiB; nano bị Free Tier từ chối); RDS/Redis loại t4g.micro, single-AZ, không backup; Kafka t4g.small (2 GiB, heap hiện 512 MiB–1 GiB); EKS standard support; S3 Gateway Endpoint. Khi triển khai app: mỗi app 1 replica, HPA/Prometheus/Grafana tắt, không cài Cluster Autoscaler/metrics-server khi chưa cần; CoreDNS 1 replica cho demo. Đây là cấu hình test nhỏ, chưa xác nhận sức chứa hay RAM thực tế. Không chuyển node app sang ARM vì image ECR hiện x86_64.
- **Tách Terraform 2 tầng:** `infra/bootstrap` luôn giữ (bucket state, ECR, Budgets); `infra/envs/dev` dựng và hủy mỗi buổi test.
- **Cổng vào là ALB** (AWS Load Balancer Controller đọc Ingress). nginx trong pod web chỉ trả file tĩnh. Không dùng ingress-nginx.
- **Không sticky session:** client chỉ dùng transport websocket.
- **Đo baseline Razzia gốc trước**, rồi ánh xạ mỗi điểm hỏng sang thành phần giải quyết nó. Làm song song với việc deploy, không dừng việc deploy.
- **Phương án S3 + CloudFront** cho file tĩnh chỉ ghi vào báo cáo như hướng tối ưu, chưa làm.

## File mình tạo (CHƯA commit, nhánh `dev`)

| File                                        | Nội dung                                                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `Dockerfile`                                | Thêm `COPY packages/streaming/package.json`, target `worker` (pnpm deploy `--legacy`), target `migrate`   |
| `docker/migrate.sh`                         | Chạy migration theo thứ tự, ghi vào `schema_migrations`, đổi `sslmode=no-verify` thành `require` cho psql |
| `compose.full.yml`                          | Toàn bộ hệ thống ở local, project `razzia-full`                                                           |
| `deploy/local-alb.conf`                     | nginx giả lập ALB                                                                                         |
| `.dockerignore`                             | Loại `infra`, `role-d`, `deploy`, `scripts/aws`, `compose.*.yml`, `*.pdf`                                 |
| `infra/bootstrap/main.tf`                   | Bucket state, ECR (giữ 5 image), Budget, Cost Anomaly                                                     |
| `infra/envs/dev/*.tf`                       | VPC, NAT instance, S3 endpoint, EKS v21 + IRSA, RDS, Redis, Kafka EC2 (user_data dùng script của B)       |
| `scripts/aws/{common,up,down,leftovers}.sh` | Bật, tắt, kiểm tra đồ sót; ghi `infra/runs.csv`                                                           |
| `infra/README.md`                           | Hướng dẫn và bảng chi phí                                                                                 |

Trang sơ đồ kiến trúc (riêng tư, cần Share cho nhóm): https://claude.ai/artifact/BLkjnduYvHoJpAFWnTxFib

## Lệnh hay dùng

```bash
docker compose -f compose.full.yml up -d --build    # cả hệ thống ở local, http://localhost:8080 (manager: admin)
docker compose -f compose.full.yml down -v
# Cổng host: APP_PORT=8080, PG_PORT=15432, REDIS_PORT=16379 (máy có sẵn Postgres ở 5432)

scripts/aws/up.sh          # Tự apply và cài addon; không dùng cho quy trình hướng dẫn từng pha hiện tại
scripts/aws/down.sh        # Hủy môi trường dev; chỉ hướng dẫn/thực hiện khi được yêu cầu, lưu ý dữ liệu
scripts/aws/leftovers.sh   # kiểm tra còn gì tính tiền
```

Người dùng đã cài AWS CLI 2.41.2 và Terraform 1.17.2 tại `~/.local/bin`. IAM đang dùng là `cloud-computing` trong account `251783110206`, CLI region Sydney. Đã có kubectl, kind và Helm 3.19.0 tại `.tools/helm/helm`.

## Trạng thái và vấn đề mở

1. **A–B–D đã thống nhất schema** ngày 19/11. Không thêm room_id/payload vào outbox; publisher JOIN answers. Score ghi results + processed_answer_events, Redis notification theo A. Bỏ schema/Compose/seed riêng của B và SQL đề xuất D.
2. **D:** import vào quizzes/questions, provenance ở quiz_imports; export dùng username và event_id từ outbox. Audit phát hiện cả thiếu result/outbox/marker. Runtime Terraform Lambda vẫn cần xử lý ở bước AWS.
3. **Media:** `docker/nginx-static.conf` trả `/media`, `/branding` từ `/app/config` trên đĩa. Trên EKS sẽ không có thư mục này. Cần hỏi A và D xem quiz có dùng media không; nếu có thì chuyển lên S3.
4. **Bootstrap AWS đã apply thành công ngày 20/11:** 12 added, 0 changed, 0 destroyed tại Sydney. Bucket `razzia-tfstate-251783110206-ap-southeast-2` có versioning và chặn public; 4 ECR repo `razzia/{web,socket,worker,migrate}` đã có, tag immutable và lifecycle giữ 5 image. Registry `251783110206.dkr.ecr.ap-southeast-2.amazonaws.com`. Cấu hình cục bộ ở `infra/bootstrap/sydney.auto.tfvars` (Git bỏ qua), state ở `infra/bootstrap/terraform.tfstate`. Người dùng đã push 4 image lên ECR, tag chung **`kind-tested-20261120-152859`**.
5. **Dev đã apply một phần:** backend S3 đã cấu hình ở `infra/envs/dev/backend.hcl` (key `dev/terraform.tfstate`, region Sydney). Đã tạo VPC/subnet/route/SG, IAM role/policy, KMS và sau đó EKS đã tiến đến tạo launch template/node group. Chưa có `Apply complete!`; node group và addon đang lỗi quyền; RDS subnet group lỗi SLR. EKS cluster nhiều khả năng đã tồn tại và có phí dù chưa có node; không tự ý dừng/hủy tài nguyên khi người dùng nghỉ. Luôn tạo plan mới sau apply thất bại, giữ state và kiểm tra trước apply; không chạy lại plan cũ.
6. K8s `1.35` còn standard support đến 27/03/2027 theo tài liệu AWS đã tra. Phí control plane standard là 0,10 USD/giờ (73 USD/730 giờ), chưa gồm tài nguyên khác/thuế và chưa trừ credit; không coi số ~0,25 USD/giờ trong script là báo giá đã kiểm chứng. Free Tier eligible vẫn tiêu hao credit; tài khoản Free Plan do AWS quản lý Organizations, chưa cần nâng cấp/advanced features.

## Kiểm tra tích hợp 19/11

- Schema chuẩn: packages/socket/migrations/001–007; tài liệu docs/database-schema.md.
- Test ứng dụng thường: 222 đạt; các test cần môi trường được chạy đầy đủ bằng pnpm test:cloud.
- Streaming SQL/unit: 31/31 đạt. PostgreSQL/Kafka thật: 22/22 đạt. Backend PG/Redis + hai gateway: 53/53 đạt, không skip. Lambda logic phiên tích hợp: 4 test đạt; lint phần sửa và tsc backend đạt.
- Ván thật qua hai gateway, PG16/Redis7/Kafka3.9.1: hai người × hai câu, 4 đáp án, điểm [2, 0]; gửi trùng giữ đáp án đầu; phát lại 8 message không cộng thêm điểm/thống kê; audit 0 sai lệch. Không gọi S3/Lambda trên AWS.
- Chạy lại toàn luồng bằng pnpm test:streaming; môi trường test dùng project/volume riêng và tự dọn.
- Lint toàn repo còn lỗi ở mã load/questions của D có sẵn; không sửa lan sang bộ benchmark trong phiên tích hợp.

- Bổ sung 19/11: score/stats worker xác thực event với outbox/answers trước mọi ghi và trước dedup; chặn event bị đổi phòng ngay cả khi client thuộc cả hai phòng. Không đổi schema. Giữ answers/outbox khi cần replay. Bộ bất biến dùng chung ở packages/streaming/test/room-invariants.mjs chạy PGlite và PostgreSQL riêng.

- Bổ sung cuối 19/11: ma trận đầy đủ ở docs/database-test-cases.md. Test phát hiện lease room B ghi được phase room A; đã sửa withLease nhận target room, Game/CloudGame từ chối attach sai room. Có test atomic answer/outbox, deadline, SIGKILL giữ dữ liệu commit, catalog snapshot/mode, room lock, runtime/current_position và host/lease fields. Runner pnpm test:cloud không cần PowerShell, tự dựng/dọn dependency; chạy file tuần tự nhưng burst 64 vẫn concurrent.

## Việc tiếp theo (theo thứ tự)

1. Helm chart `deploy/helm/razzia` đã có: 5 Deployment/Service, Ingress ALB, migration hook, PDB, HPA/ServiceMonitor tùy chọn. Đã triển khai trên kind local theo `deploy/kind/` (dependency PG/Redis/Kafka, values, proxy). Người dùng xác nhận test chạy tốt ngày 20/11; chưa có số đo tải để kết luận sức chứa. 13 test manifest/script đạt; chưa nghiệm thu AWS/EKS. Script up giữ credential và truyền registry/tag/configRevision. Bootstrap thêm ECR migrate; migration image đã tự bao gồm 005–007.
2. Chốt baseline local: cập nhật kết quả mới trong ~/e01-nginx8k và ~/e01-direct, sửa timeout script chính rồi đo lại lượt chưa hợp lệ.
3. **Ưu tiên tiếp tục checkpoint IAM ở dưới:** image ECR và backend đã xong. Sửa quyền, xác nhận role RDS, tạo plan mới rồi mới hướng dẫn apply; sau khi hạ tầng thành công mới hướng dẫn kubeconfig/addon/Helm gói demo. Không chạy `scripts/aws/up.sh` mặc định vì tự apply và cài Cluster Autoscaler/metrics-server không phù hợp profile nhỏ. CI OIDC còn chưa làm.
4. Tích hợp Lambda AWS (runtime, VPC/SG/TLS), đo trên EC2 với máy phát tải riêng.
5. Monitoring, HPA/Cluster Autoscaler và các thí nghiệm tải/failure của D.

## Checkpoint nghỉ phiên 21/11 — tiếp tục tại đây

- Người dùng muốn **được hướng dẫn từng pha, tự chạy lệnh**. Không tự apply, thay IAM hay xóa tài nguyên. Yêu cầu cuối: “compact lại đi, mai làm việc tiếp”.
- Đã kiểm tra file thực tế: `network.tf` NAT = `t4g.micro`; `eks.tf` x86_64 instance_types = `["t3.small"]`; `sydney.auto.tfvars` có region Sydney, K8s1.35, node_arch=x86_64, node_min=1, node_max=1, node_capacity_type=SPOT, kafka_instance_type=t4g.small. `check.txt` là kết quả EC2 free-tier-eligible (có t3.small, t4g.micro/small, c7i-flex.large, m7i-flex.large...).
- Plan gần nhất trước apply: **23 to add, 0 change, 0 destroy**; apply đã tiến thêm, chưa lấy plan mới sau đó.
- Lỗi apply cuối: `eks:DescribeAddonVersions` cho coredns/kube-proxy/vpc-cni; `iam:GetRole` khi EKS kiểm tra `AWSServiceRoleForAmazonEKSNodegroup`; RDS CreateDBSubnetGroup báo `Missing necessary credentials`, cần kiểm tra `AWSServiceRoleForRDS`.
- Các policy đã hướng dẫn tạo/gắn (chưa xác thực toàn bộ trạng thái IAM): `RazziaTerraformPlanReads` (SSM AMI + EC2 DescribeImages), `RazziaTerraformDeploy-1/-2` (baseline Autopilot, đã giúp tạo nhiều tài nguyên), `RazziaServiceLinkedRoles` (CreateServiceLinkedRole giới hạn eks, eks-nodegroup, autoscaling, spot, rds, elasticache; PutRolePolicy chỉ SLR ElastiCache), `RazziaAddonAndServiceRoleReads`.
- Hai baseline JSON tạm ở `/tmp/razzia-iam-review-1vzidtou/`; có thể mất sau reboot. Chỉ là baseline đã kiểm tra cú pháp/kích thước, không tuyên bố đã đủ quyền toàn bộ. IAM Console `Allow (3 of 482 services), Show remaining 479, None` chỉ là danh mục dịch vụ không được cấp quyền; không chứng minh lỗi. Cảnh báo policy thật phải xem đúng action/resource/condition.
- **Kết quả xác nhận cuối:** `aws iam get-role --role-name AWSServiceRoleForRDS` vẫn AccessDenied: `no identity-based policy allows iam:GetRole`. Chưa biết role có tồn tại; không kết luận access key sai/hết hạn, không kết luận SCP mới chặn.
- Đã hướng dẫn kiểm tra `RazziaAddonAndServiceRoleReads` có trên **IAM → Users → cloud-computing → Permissions** không; tạo managed policy trong danh sách Policies thôi chưa đủ, phải attach. Bản JSON mới nhất giữ `eks:DescribeAddonVersions` Resource `*`, điều kiện `aws:RequestedRegion=ap-southeast-2`; statement `iam:GetRole` riêng không có điều kiện region, Resource gồm 4 ARN:
  - `arn:aws:iam::251783110206:role/AWSServiceRoleForRDS`
  - `arn:aws:iam::251783110206:role/aws-service-role/rds.amazonaws.com/AWSServiceRoleForRDS`
  - `arn:aws:iam::251783110206:role/AWSServiceRoleForAmazonEKSNodegroup`
  - `arn:aws:iam::251783110206:role/aws-service-role/eks-nodegroup.amazonaws.com/AWSServiceRoleForAmazonEKSNodegroup`
  Bổ sung ARN gốc để kiểm tra cả trường hợp theo tên; đây là điều chỉnh phạm vi, chưa xác minh là nguyên nhân thực tế của AccessDenied.
- **Lệnh tiếp theo người dùng sẽ chạy (chưa có output sau chỉnh policy):**
  ```bash
  aws iam get-role --role-name AWSServiceRoleForRDS --query 'Role.Arn' --output text
  ```
  Nếu vẫn AccessDenied: xem JSON thực sự đang lưu/gắn trên user, không tiếp tục đoán rồi mở rộng quyền hàng loạt. Nếu ARN: role tồn tại. Nếu NoSuchEntity: hướng dẫn `aws iam create-service-linked-role --aws-service-name rds.amazonaws.com --query 'Role.Arn' --output text`, dùng quyền SLR đã cấp; xử lý lỗi cụ thể nếu có. Sau khi thông quyền/role mới tạo lại `terraform -chdir=infra/envs/dev plan -out=dev.tfplan`, xem kết quả trước apply.
- Chưa deploy ứng dụng lên EKS, chưa đổi replica/addon trong profile Helm, chưa nghiệm thu AWS. Không tự dùng lệnh destroy/down khi mở lại phiên. Dọn môi trường có thể xóa dữ liệu: RDS hiện không backup và skip_final_snapshot=true.
