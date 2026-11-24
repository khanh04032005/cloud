# Chạy MỘT LẦN, state để local. Bucket này chứa state của envs/dev, không bao giờ destroy.
#   terraform -chdir=infra/bootstrap init
#   terraform -chdir=infra/bootstrap apply -var bucket_name=razzia-tfstate-<tên-nhóm>
# Chi phí: vài KB state, gần như 0 USD/tháng.

terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

variable "region" {
  type    = string
  default = "ap-southeast-1"
}

variable "bucket_name" {
  type        = string
  description = "Tên bucket chứa state, phải duy nhất toàn cầu, ví dụ razzia-tfstate-nhom7"
}

provider "aws" {
  region = var.region
}

resource "aws_s3_bucket" "tfstate" {
  bucket = var.bucket_name
}

resource "aws_s3_bucket_versioning" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  versioning_configuration { status = "Enabled" }
}

# Giữ tối đa 30 ngày cho các phiên bản state cũ để versioning không phình mãi.
resource "aws_s3_bucket_lifecycle_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  rule {
    id     = "expire-old-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration { noncurrent_days = 30 }
  }
}

resource "aws_s3_bucket_public_access_block" "tfstate" {
  bucket                  = aws_s3_bucket.tfstate.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

output "bucket" {
  value = aws_s3_bucket.tfstate.bucket
}

# ---------- Cảnh báo chi phí: để ở bootstrap để không bị xóa khi down ----------
# 2 budget đầu tiên của tài khoản miễn phí.

variable "budget_email" {
  type        = string
  default     = ""
  description = "Email nhận cảnh báo. Để trống thì không tạo budget."
}

variable "budget_limit_usd" {
  type    = number
  default = 20
}

resource "aws_budgets_budget" "monthly" {
  count        = var.budget_email == "" ? 0 : 1
  name         = "razzia-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.budget_limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  # 50% thực tế: nhắc kiểm tra. 100% dự báo: sắp vượt, có thể đang quên tắt cụm.
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 50
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_email]
  }
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.budget_email]
  }
}

# Phát hiện chi tiêu bất thường (ví dụ ALB mồ côi chạy cả tuần). Miễn phí.
resource "aws_ce_anomaly_monitor" "services" {
  count             = var.budget_email == "" ? 0 : 1
  name              = "razzia-services"
  monitor_type      = "DIMENSIONAL"
  monitor_dimension = "SERVICE"
}

resource "aws_ce_anomaly_subscription" "daily" {
  count            = var.budget_email == "" ? 0 : 1
  name             = "razzia-daily"
  frequency        = "DAILY"
  monitor_arn_list = [aws_ce_anomaly_monitor.services[0].arn]
  subscriber {
    type    = "EMAIL"
    address = var.budget_email
  }
  threshold_expression {
    dimension {
      key           = "ANOMALY_TOTAL_IMPACT_ABSOLUTE"
      match_options = ["GREATER_THAN_OR_EQUAL"]
      values        = ["3"]
    }
  }
}

# ---------- ECR: để ở bootstrap để image còn nguyên qua các lần down/up ----------

resource "aws_ecr_repository" "app" {
  for_each             = toset(["web", "socket", "worker", "migrate"])
  name                 = "razzia/${each.key}"
  force_delete         = true
  image_tag_mutability = "IMMUTABLE" # tag = git SHA, không ghi đè
}

# ECR tính 0,10 USD/GB-tháng. Mỗi lần CI push 4 image, nên chỉ giữ 5 bản mới nhất.
resource "aws_ecr_lifecycle_policy" "app" {
  for_each   = aws_ecr_repository.app
  repository = each.value.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Chi giu 5 image moi nhat"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 5 }
      action       = { type = "expire" }
    }]
  })
}

output "ecr_registry" {
  value = split("/", aws_ecr_repository.app["web"].repository_url)[0]
}
