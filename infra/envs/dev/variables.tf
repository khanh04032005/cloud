variable "region" {
  type    = string
  default = "ap-southeast-1"
}

variable "name" {
  type    = string
  default = "razzia"
}

variable "run_id" {
  type        = string
  default     = "manual"
  description = "Tag RunId gắn vào mọi tài nguyên. scripts/aws/up.sh tự đặt theo thời điểm bật."
}

variable "kubernetes_version" {
  type        = string
  default     = "1.35"
  description = "Chọn bản còn STANDARD support (aws eks describe-cluster-versions). Bản extended support tốn 0,60 USD/giờ thay vì 0,10."
}

# ---------- Tiết kiệm chi phí ----------

variable "nat_mode" {
  type        = string
  default     = "instance"
  description = "instance = fck-nat trên t4g.nano (~0,005 USD/giờ). gateway = NAT Gateway managed (~0,059 USD/giờ + 0,059 USD/GB)."
  validation {
    condition     = contains(["instance", "gateway"], var.nat_mode)
    error_message = "nat_mode phải là instance hoặc gateway."
  }
}

variable "node_capacity_type" {
  type        = string
  default     = "SPOT"
  description = "SPOT rẻ hơn on-demand ~60-70%. Đổi sang ON_DEMAND cho lần đo chính thức nếu muốn số liệu ổn định."
}

variable "node_arch" {
  type        = string
  default     = "x86_64"
  description = "arm64 = Graviton t4g, rẻ hơn ~20%, nhưng image trên ECR phải build multi-arch (buildx --platform linux/amd64,linux/arm64)."
  validation {
    condition     = contains(["x86_64", "arm64"], var.node_arch)
    error_message = "node_arch phải là x86_64 hoặc arm64."
  }
}

variable "node_min" {
  type    = number
  default = 2
}

variable "node_max" {
  type        = number
  default     = 4
  description = "Trần cho Cluster Autoscaler, cũng là trần chi phí node."
}

variable "kafka_instance_type" {
  type    = string
  default = "t4g.small"
}
