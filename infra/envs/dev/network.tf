locals {
  azs  = ["${var.region}a", "${var.region}b"]
  cidr = "10.0.0.0/16"
}

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 6.0"

  name            = var.name
  cidr            = local.cidr
  azs             = local.azs
  public_subnets  = ["10.0.0.0/24", "10.0.1.0/24"]   # ALB, NAT
  private_subnets = ["10.0.10.0/23", "10.0.12.0/23"] # node, pod, RDS, Redis, Kafka (/23 vì VPC CNI cấp IP cho từng pod)

  # NAT Gateway managed chỉ khi nat_mode = gateway. Mặc định dùng NAT instance ở dưới.
  enable_nat_gateway = var.nat_mode == "gateway"
  single_nat_gateway = true # 1 NAT cho cả 2 AZ: đánh đổi độ sẵn sàng lấy chi phí

  enable_dns_hostnames = true

  public_subnet_tags  = { "kubernetes.io/role/elb" = 1 }
  private_subnet_tags = { "kubernetes.io/role/internal-elb" = 1 }
}

# ---------- S3 Gateway Endpoint: MIỄN PHÍ ----------
# Layer image của ECR thực chất tải từ S3, nên node kéo image không đi qua NAT nữa
# (bớt phí data NAT, và bớt tải cho NAT instance nhỏ). Lambda của D đọc/ghi S3 cũng đi đường này.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = module.vpc.vpc_id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = module.vpc.private_route_table_ids
}

# ---------- NAT instance (fck-nat) thay cho NAT Gateway ----------
# t4g.nano ~0,005 USD/giờ so với NAT Gateway ~0,059 USD/giờ + 0,059 USD/GB.
# Đánh đổi: 1 máy, không HA, băng thông vài Gbps. Đủ cho môi trường thí nghiệm.
# Đưa vào báo cáo: đây là IaaS tự vận hành thay cho dịch vụ managed.

data "aws_ami" "fck_nat" {
  count       = var.nat_mode == "instance" ? 1 : 0
  most_recent = true
  owners      = ["568608671756"] # tài khoản phát hành AMI của dự án fck-nat
  filter {
    name   = "name"
    values = ["fck-nat-al2023-*-arm64-ebs"]
  }
}

resource "aws_security_group" "nat" {
  count       = var.nat_mode == "instance" ? 1 : 0
  name        = "${var.name}-nat"
  description = "NAT instance: nhan traffic tu VPC, di ra internet"
  vpc_id      = module.vpc.vpc_id

  ingress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [local.cidr]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_instance" "nat" {
  count                       = var.nat_mode == "instance" ? 1 : 0
  ami                         = data.aws_ami.fck_nat[0].id
  instance_type               = "t4g.micro"
  subnet_id                   = module.vpc.public_subnets[0]
  vpc_security_group_ids      = [aws_security_group.nat[0].id]
  associate_public_ip_address = true
  source_dest_check           = false # bắt buộc để máy chuyển tiếp gói tin không phải của nó

  tags = { Name = "${var.name}-nat" }
}

resource "aws_route" "private_nat" {
  # single_nat_gateway = true nên module chỉ tạo 1 route table private dùng chung cho 2 subnet.
  count                  = var.nat_mode == "instance" ? length(module.vpc.private_route_table_ids) : 0
  route_table_id         = module.vpc.private_route_table_ids[count.index]
  destination_cidr_block = "0.0.0.0/0"
  network_interface_id   = aws_instance.nat[0].primary_network_interface_id
}
