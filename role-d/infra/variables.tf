variable "aws_region" {
  type    = string
  default = "ap-southeast-1"
}

variable "name_prefix" {
  type    = string
  default = "razzia"
}

variable "database_url" {
  type        = string
  sensitive   = true
  description = "Chuỗi kết nối RDS. Sẽ nằm trong state Terraform: bucket state của C phải riêng tư."
}

variable "import_zip_path" {
  type        = string
  description = "Đường dẫn build/import-questions.zip sau khi chạy package-lambdas.mjs."
}

variable "export_zip_path" {
  type        = string
  description = "Đường dẫn build/export-results.zip."
}

variable "vpc_subnet_ids" {
  type        = list(string)
  default     = []
  description = "Subnet riêng để Lambda vào được RDS. Để trống khi chỉ thử bucket, Lambda sẽ không tới được RDS trong VPC."
}

variable "vpc_security_group_ids" {
  type    = list(string)
  default = []
}

variable "question_license" {
  type    = string
  default = "CC BY-SA 4.0"
}
