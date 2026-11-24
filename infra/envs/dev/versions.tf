terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }

  # Cấu hình backend truyền lúc init để không ghi cứng tên bucket:
  #   terraform init -backend-config=backend.hcl
  # (xem backend.hcl.example). use_lockfile: Terraform >= 1.10 khóa state bằng file trên S3.
  backend "s3" {}
}

provider "aws" {
  region = var.region

  # Mọi tài nguyên đều mang tag RunId để D tách chi phí từng lần chạy trong Cost Explorer.
  # Nhớ bật tag RunId và Project trong Billing → Cost allocation tags (làm 1 lần).
  default_tags {
    tags = {
      Project = var.name
      Env     = "dev"
      RunId   = var.run_id
    }
  }
}
