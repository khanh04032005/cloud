# RDS PostgreSQL + ElastiCache Redis, cấu hình rẻ nhất còn dùng được cho thí nghiệm.

resource "aws_security_group" "data" {
  name        = "${var.name}-data"
  description = "Postgres va Redis, chi mo cho node EKS"
  vpc_id      = module.vpc.vpc_id

  ingress {
    description     = "Postgres tu node"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [module.eks.node_security_group_id]
  }
  ingress {
    description     = "Redis tu node"
    from_port       = 6379
    to_port         = 6379
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

resource "aws_db_subnet_group" "pg" {
  name       = var.name
  subnet_ids = module.vpc.private_subnets
}

resource "aws_db_instance" "pg" {
  identifier     = var.name
  engine         = "postgres"
  engine_version = "16"
  instance_class = "db.t4g.micro" # Graviton, rẻ nhất

  allocated_storage = 20
  storage_type      = "gp3"

  db_name                     = "razzia"
  username                    = "razzia"
  manage_master_user_password = true # mật khẩu ở Secrets Manager, không nằm trong state

  db_subnet_group_name   = aws_db_subnet_group.pg.name
  vpc_security_group_ids = [aws_security_group.data.id]

  # Môi trường thí nghiệm, dựng và hủy mỗi buổi:
  multi_az                     = false # Multi-AZ gấp đôi giá. Chỉ nêu trong báo cáo
  backup_retention_period      = 0     # không backup tự động: tạo nhanh hơn, không tốn phí snapshot
  skip_final_snapshot          = true  # không để lại snapshot mồ côi sau destroy
  delete_automated_backups     = true
  deletion_protection          = false
  performance_insights_enabled = false
  apply_immediately            = true
}

resource "aws_elasticache_subnet_group" "redis" {
  name       = var.name
  subnet_ids = module.vpc.private_subnets
}

resource "aws_elasticache_cluster" "redis" {
  cluster_id               = var.name
  engine                   = "redis"
  node_type                = "cache.t4g.micro"
  num_cache_nodes          = 1
  port                     = 6379
  subnet_group_name        = aws_elasticache_subnet_group.redis.name
  security_group_ids       = [aws_security_group.data.id]
  snapshot_retention_limit = 0
}
