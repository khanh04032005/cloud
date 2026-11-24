# Kafka tự dựng trên EC2 (IaaS) theo đề tài: 1 broker KRaft, cấu hình của B.
# t4g.small (Graviton, 2 GiB) ~0,021 USD/giờ. Java chạy tốt trên ARM.

data "aws_ssm_parameter" "al2023_arm64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

resource "aws_security_group" "kafka" {
  name        = "${var.name}-kafka"
  description = "Kafka 9092, chi mo cho node EKS"
  vpc_id      = module.vpc.vpc_id

  ingress {
    description     = "Kafka tu node"
    from_port       = 9092
    to_port         = 9092
    protocol        = "tcp"
    security_groups = [module.eks.node_security_group_id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# Vào máy bằng SSM Session Manager: không SSH key, không IP public.
resource "aws_iam_role" "kafka" {
  name = "${var.name}-kafka"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "kafka_ssm" {
  role       = aws_iam_role.kafka.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "kafka" {
  name = "${var.name}-kafka"
  role = aws_iam_role.kafka.name
}

resource "aws_instance" "kafka" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.value
  instance_type          = var.kafka_instance_type
  subnet_id              = module.vpc.private_subnets[0]
  vpc_security_group_ids = [aws_security_group.kafka.id]
  iam_instance_profile   = aws_iam_instance_profile.kafka.name

  root_block_device {
    volume_type = "gp3"
    volume_size = 20
  }

  # Dùng đúng file cấu hình và script của B trong packages/streaming/kafka.
  user_data = templatefile("${path.module}/kafka-user-data.sh.tftpl", {
    server_properties = file("${path.module}/../../../packages/streaming/kafka/server.properties.example")
    setup_script      = file("${path.module}/../../../packages/streaming/kafka/setup-ec2.sh")
  })
  user_data_replace_on_change = true

  tags = { Name = "${var.name}-kafka" }

  # Cần NAT để tải Java và Kafka lúc khởi động.
  depends_on = [aws_route.private_nat, module.vpc]
}
