# Razzia Helm chart

Triển khai phần ứng dụng Live Quiz lên Kubernetes: `web`, `socket`, `publisher`,
`score`, `stats` và Job migration. RDS/PostgreSQL, Redis, Kafka, EKS và các
controller do hạ tầng hiện có cung cấp.

## Điều kiện triển khai

- Helm 3.19+; Kubernetes 1.30+ (cấu hình EKS trong repo đang nhắm 1.35).
- Bốn image từ target `web`, `socket`, `worker`, `migrate` trong Dockerfile, cùng
  một tag Git SHA. Registry prefix bao gồm `/razzia`.
- Namespace và Secret cấu hình tồn tại **trước khi cài chart**. Image pull Secret
  nếu có cũng phải tạo trước vì Job migration chạy ở hook `pre-install`.
- ALB Controller khi bật Ingress; metrics-server khi bật HPA;
  Prometheus Operator cùng CRD ServiceMonitor khi bật monitoring.
- Pod kết nối được PostgreSQL, Redis và Kafka. Topic `answers` được Terraform
  khởi tạo trên Kafka EC2; chart không tạo topic.

## Cài đặt

Tạo namespace, rồi tạo Secret `razzia-env` trong namespace đó từ nguồn quản lý
secret của môi trường. Secret cần các key:

| Key                | Process sử dụng                                         |
| ------------------ | ------------------------------------------------------- |
| `DATABASE_URL`     | socket, publisher, score, stats, migrate                |
| `REDIS_URL`        | socket, score, stats                                    |
| `KAFKA_BROKERS`    | publisher, score, stats                                 |
| `JWT_SECRET`       | socket; tối thiểu 32 ký tự, dùng chung giữa các replica |
| `MANAGER_PASSWORD` | socket                                                  |

Không ghi giá trị secret vào `values.yaml` hoặc Git. Chart chỉ chứa tham chiếu
đến Secret; web không được cấp các biến này.

```bash
helm upgrade --install razzia deploy/helm/razzia \
  --namespace razzia \
  --set-string image.registry=123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/razzia \
  --set-string image.tag=<git-sha> \
  --wait --timeout 10m
```

Trong quy trình AWS của repo:

```bash
TAG=<git-sha> APP_NS=razzia scripts/aws/up.sh
TAG=<git-sha> APP_NS=razzia AUTOSCALING=true MONITORING=1 scripts/aws/up.sh
```

`up.sh` đọc registry từ output bootstrap; đặt `ECR_PREFIX=<registry>/razzia` nếu
bootstrap state nằm ở máy khác. Script tạo namespace trước Secret, giữ lại JWT
và manager password đang dùng; `MANAGER_PASSWORD` cho phép thay mật khẩu rõ ràng.
`configRevision` lấy từ resourceVersion của Secret để cập nhật environment trên
pod khi Secret thay đổi. Khi tự dùng Helm, tăng `configRevision` sau khi sửa Secret.

CI đẩy ECR/OIDC chưa nằm trong chart này. Trước khi deploy, cần bảo đảm đủ bốn
image tồn tại trong ECR và node kéo được image.

## Cấu hình và hành vi

| Cấu hình                                         | Mặc định | Ý nghĩa                                                  |
| ------------------------------------------------ | -------- | -------------------------------------------------------- |
| `apps.web.replicas`                              | 2        | Số pod frontend                                          |
| `apps.socket.replicas`                           | 2        | Số gateway khi HPA tắt                                   |
| `apps.socket.hpa.enabled`                        | false    | Bật sau khi có baseline cố định                          |
| `apps.socket.hpa.minReplicas/maxReplicas`        | 2 / 6    | Giới hạn autoscaling                                     |
| `apps.socket.hpa.targetCPUUtilizationPercentage` | 60       | Ngưỡng CPU so với requests                               |
| `apps.socket.pdb.enabled/minAvailable`           | true / 1 | Giữ một gateway khi eviction tự nguyện                   |
| `ingress.enabled`                                | true     | Ingress ALB công khai                                    |
| `monitoring.enabled`                             | false    | Tạo bốn ServiceMonitor cho socket và worker              |
| `monitoring.labels.release`                      | kps      | Khớp selector của kube-prometheus-stack                  |
| `migration.enabled`                              | true     | Chạy migration khi install/upgrade                       |
| `configRevision`                                 | rỗng     | Thay giá trị để restart socket/worker sau khi đổi Secret |

Routing `/` → web:3000, `/api` và `/ws` → socket:3001. Health và metrics của socket
không có route public riêng. ALB target group kiểm tra web tại `/`, socket tại
`/health/ready`. Client dùng WebSocket transport nên không cần sticky session.
ALB idle timeout là 3600 giây; deregistration delay 30 giây. HTTPS có thể cấu hình
bằng các annotation `certificate-arn`, `listen-ports`, `ssl-redirect` trong
`ingress.annotations`; bản mặc định dùng HTTP cho môi trường thí nghiệm.

Socket có startup/liveness tại `/health/live`, readiness tại `/health/ready`
(kiểm tra PostgreSQL/Redis). Worker hiện chỉ có HTTP `/metrics`; TCP probe chỉ
xác nhận process đã mở listener, **không chứng minh worker đã kết nối Kafka/DB
hoặc đang xử lý được event**. Nghiệm thu worker phải kiểm tra dữ liệu và lag.

Pod được ưu tiên trải theo node và AZ bằng `ScheduleAnyway`; đây là ưu tiên mềm.
PDB áp dụng cho eviction tự nguyện, không bảo đảm còn pod khi node chết đột ngột.
Rolling update cho phép một pod bổ sung, cần chừa tài nguyên node cho pod đó.
HPA CPU không chuyển những kết nối WebSocket đang mở sang pod mới.

## Migration và nâng cấp

Job dùng image `migrate`, gọi script có sẵn trong image, chỉ nhận `DATABASE_URL`.
Hook `pre-install,pre-upgrade` chặn triển khai manifest ứng dụng mới cho đến khi
Job thành công. Job không phụ thuộc ConfigMap hay ServiceAccount do chart tạo.
Job thành công được xóa; Job lỗi được giữ để xem log, tự hết hạn sau một ngày hoặc
bị xóa trước lần chạy hook tiếp theo. Retry tự động tắt để tránh chạy lặp SQL lỗi.

Khi upgrade, pod phiên bản cũ vẫn chạy trong lúc hook thực thi. Migration phải
tương thích với phiên bản đang chạy; trường hợp đổi fencing của backend phải
theo hướng dẫn chuyển phiên bản của A. Helm rollback **không hoàn tác schema DB**.
Script migration ghi nhận file đã chạy trong `schema_migrations`; nếu tiến trình
chết giữa lúc SQL commit và ghi marker, cần kiểm tra DB trước khi chạy lại. Không
deploy đồng thời nhiều release vào cùng database để chạy migration.

```bash
kubectl -n razzia get jobs -l app.kubernetes.io/component=migrate
kubectl -n razzia logs job/razzia-migrate
kubectl -n razzia get deployments,services,ingress,hpa,pdb
```

## Kiểm tra tự động, không cần cluster

Cần Helm, Python 3, PyYAML, Bash, jq, openssl. Test script AWS dùng lệnh giả,
không kết nối AWS hay thay đổi Kubernetes.

Nếu chưa cài Helm, trên Linux amd64/arm64 chạy lệnh sau một lần. Script tải
Helm 3.19.0 từ nguồn chính thức, kiểm tra SHA-256 rồi đặt binary tại
`.tools/helm/helm` trong repo (được Git bỏ qua). Không cần sudo; binary không
phụ thuộc vào thư mục `/tmp` sau khi cài.

```bash
bash scripts/setup-helm.sh
```

`scripts/test-helm.sh` tự tìm Helm trong PATH hoặc `.tools/helm/helm`. Bỏ biến
`HELM=/tmp/...` trong các lệnh cũ. Thư mục tạm có thể bị dọn giữa các phiên.

```bash
python3 -m venv /tmp/razzia-helm-tests
/tmp/razzia-helm-tests/bin/pip install -r deploy/helm/tests/requirements.txt
PYTHON=/tmp/razzia-helm-tests/bin/python bash scripts/test-helm.sh
```

Nếu dùng uv:

```bash
uv run --with pyyaml==6.0.3 --no-project bash scripts/test-helm.sh
```

Không thêm `--offline` vào lần tải dependency đầu tiên. Cache trong `/tmp` của
một phiên khác không bảo đảm còn tồn tại trên máy đang chạy test.

`HELM` và `PYTHON` cho phép chỉ định binary riêng. Có kubeconform thì đặt thêm
`KUBECONFORM=kubeconform` để kiểm tra schema Kubernetes 1.35 và ServiceMonitor.
Bước schema cần truy cập mạng khi tải schema lần đầu.

Bộ test kiểm tra 16 tổ hợp bật/tắt HPA, monitoring, Ingress và migration; selector,
port và routing; Secret theo từng process; hook migration; tên release/namespace;
quyền ghi thư mục socket; cập nhật pod khi đổi cấu hình; cấu hình sai phải bị từ
chối. Test script deploy kiểm tra giữ credential, tạo namespace trước Secret và
truyền registry/tag, monitoring, HPA vào Helm. GitHub Actions chạy bộ kiểm tra này
trong workflow `Helm`.

## Chạy trên kind sau khi nạp image

Các lệnh dưới đây dùng riêng context `kind-razzia-test`, namespace `razzia-test`
và release `razzia`. Cần bốn image `razzia/web:local`, `razzia/socket:local`,
`razzia/worker:local`, `razzia/migrate:local` đã nạp vào kind. Dependency và proxy
dùng image công khai nên node vẫn cần tải chúng ở lần đầu.

Kiểm tra CoreDNS sẵn sàng, rồi dựng dữ liệu test. Manifest chỉ dành cho local,
có PostgreSQL password mẫu `razzia`; Redis không bật persistence. PostgreSQL và
Kafka dùng PVC trên node kind, giữ dữ liệu khi upgrade app và mất khi xóa cluster.

```bash
kubectl --context kind-razzia-test -n kube-system \
  rollout status deployment/coredns --timeout=180s
kubectl --context kind-razzia-test apply -f deploy/kind/dependencies.yaml
kubectl --context kind-razzia-test -n razzia-test \
  rollout status statefulset/postgres --timeout=300s
kubectl --context kind-razzia-test -n razzia-test \
  rollout status deployment/redis --timeout=300s
kubectl --context kind-razzia-test -n razzia-test \
  rollout status statefulset/kafka --timeout=300s
kubectl --context kind-razzia-test -n razzia-test \
  wait --for=condition=complete job/kafka-init --timeout=600s
```

Tạo Secret một lần cho môi trường test; JWT được tạo ngẫu nhiên, manager password
là `admin`. Giữ nguyên Secret khi thử upgrade để kiểm tra phiên đăng nhập. Nếu đã
có Secret này, bỏ qua bước tạo hoặc kiểm tra cấu hình đang dùng trước khi thay đổi.

```bash
kubectl --context kind-razzia-test -n razzia-test create secret generic razzia-env \
  --from-literal=DATABASE_URL='postgres://razzia:razzia@postgres:5432/razzia' \
  --from-literal=REDIS_URL='redis://redis:6379' \
  --from-literal=KAFKA_BROKERS='kafka:9092' \
  --from-literal=JWT_SECRET="$(openssl rand -hex 32)" \
  --from-literal=MANAGER_PASSWORD=admin
```

Cài ứng dụng. Profile kind tắt Ingress ALB, HPA và monitoring; dùng `Never` để
phát hiện ngay image ứng dụng chưa nạp vào node.

```bash
.tools/helm/helm upgrade --install razzia deploy/helm/razzia \
  --kube-context kind-razzia-test --namespace razzia-test \
  -f deploy/kind/values.yaml --wait --timeout 10m
kubectl --context kind-razzia-test -n razzia-test get pods
```

Web image chỉ trả file tĩnh. Để chơi trên trình duyệt, proxy local chuyển `/api`
và `/ws` đến socket Service và `/` đến web Service; proxy này dành cho test, chưa
xác minh hành vi ALB. Cài sau khi Helm đã tạo các Service:

```bash
kubectl --context kind-razzia-test apply -f deploy/kind/proxy.yaml
kubectl --context kind-razzia-test -n razzia-test \
  rollout status deployment/razzia-proxy --timeout=300s
kubectl --context kind-razzia-test -n razzia-test \
  port-forward service/razzia-proxy 8080:8080
```

Giữ terminal port-forward mở; truy cập `http://localhost:8080` và
`http://localhost:8080/manager`, mật khẩu `admin`. Nếu cổng 8080 đang được dùng,
đổi thành `18080:8080` rồi truy cập cổng 18080. Endpoint kiểm tra socket đi qua
proxy ở `http://localhost:8080/health/ready`.

Nếu có lỗi, lấy log ở đúng namespace:

```bash
kubectl --context kind-razzia-test -n razzia-test get pods,pvc,jobs
kubectl --context kind-razzia-test -n razzia-test get events --sort-by=.lastTimestamp
kubectl --context kind-razzia-test -n razzia-test logs statefulset/kafka --tail=80
kubectl --context kind-razzia-test -n razzia-test logs job/kafka-init --tail=80
kubectl --context kind-razzia-test -n razzia-test logs job/razzia-migrate --tail=80
```

Job migrate thành công bị Helm xóa nên log của nó chỉ còn khi Job chưa thành công.
Khi rebuild lại cùng tag `local`, cần nạp lại image vào kind và restart Deployment
ứng dụng để pod dùng image mới; Helm không tự restart nếu pod spec không đổi.

## Chiến lược nghiệm thu runtime

Các kiểm tra render không thay thế nghiệm thu trên cluster. Dùng database/topic
thử nghiệm riêng cho các bước ghi dữ liệu, migration và failure injection.

| Tầng             | Thử nghiệm                                                                                                     | Tiêu chí đạt                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Kubernetes local | Install với `ingress.enabled=false`, `monitoring.enabled=false`, HPA tắt; dữ liệu từ PG/Redis/Kafka thử nghiệm | Hook xong trước khi ứng dụng mới lên; 5 Deployment sẵn sàng                   |
| Kubernetes local | Upgrade cùng tag                                                                                               | Không chạy lại SQL đã ghi marker; quiz và kết quả giữ nguyên                  |
| Kubernetes local | Nâng tag với image migration lỗi có chủ đích                                                                   | Release báo lỗi; Deployment vẫn dùng image cũ; log Job giải thích lỗi         |
| Kubernetes local | Cài release mới với Secret thiếu key                                                                           | Job/pod báo lỗi cấu hình, không dùng cấu hình mặc định ngoài ý muốn           |
| Kubernetes local | Ngắt Redis sau khi socket sẵn sàng                                                                             | Readiness lỗi; liveness vẫn phản ánh process, tránh restart dây chuyền        |
| Kubernetes local | Xóa gateway đang giữ kết nối trong một ván                                                                     | Client reconnect; room/coordinator tiếp tục; đáp án và điểm không bị nhân đôi |
| Kubernetes local | Ván hai người, kiểm tra event trùng và Kafka replay                                                            | Điểm và thống kê đúng; audit không có sai lệch; worker tiêu thụ event thật    |
| EKS              | Truy cập qua ALB                                                                                               | Frontend, API, WebSocket và health check từng target group hoạt động          |
| EKS              | Rolling update trong ván và drain một node                                                                     | Ghi nhận reconnect, lỗi HTTP và gián đoạn; PDB giữ gateway khi eviction       |
| EKS              | Tạo tải có kiểm soát, bật HPA                                                                                  | Replica tăng/giảm trong giới hạn; đo cả độ trễ và lỗi ứng dụng                |
| EKS              | Bật monitoring                                                                                                 | Prometheus thấy đủ bốn target; metric event/consumer lag thay đổi theo tải    |

Với local không có Ingress controller, port-forward Service web và socket riêng;
kiểm tra luồng HTTP/WebSocket bằng client hoặc proxy thử nghiệm trỏ đúng hai
Service. Kiểm tra routing ALB thực tế dành cho EKS. Bộ game/Kafka tích hợp hiện có
ở `packages/streaming/scripts/integration.test.mjs` có thể dùng lại với endpoint và
DB/Kafka riêng; không trỏ vào dữ liệu nhóm đang dùng.

## Giới hạn hiện tại

Socket dùng `emptyDir` tại `/app/config` để đáp ứng bước khởi tạo của ứng dụng;
dữ liệu cloud của quiz/phòng/kết quả nằm ở PostgreSQL/Redis. Media và branding vẫn
được nginx đọc từ `/app/config` trên pod web, chưa có lưu trữ dùng chung. Không
được xem chart này là đã hỗ trợ upload media bền vững qua nhiều replica.

Tham khảo: [Helm hooks](https://helm.sh/docs/topics/charts_hooks/),
[ALB annotations](https://kubernetes-sigs.github.io/aws-load-balancer-controller/latest/guide/ingress/annotations/),
[Kubernetes HPA](https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/).
