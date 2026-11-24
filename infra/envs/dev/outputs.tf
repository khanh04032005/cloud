output "cluster_name" {
  value = module.eks.cluster_name
}

output "vpc_id" {
  value = module.vpc.vpc_id
}

output "private_subnets" {
  value = module.vpc.private_subnets
}

output "node_security_group_id" {
  value = module.eks.node_security_group_id
}

output "alb_controller_role_arn" {
  value = module.irsa_alb_controller.arn
}

output "cluster_autoscaler_role_arn" {
  value = module.irsa_cluster_autoscaler.arn
}

output "rds_address" {
  value = aws_db_instance.pg.address
}

output "rds_secret_arn" {
  description = "Secrets Manager chứa mật khẩu master của RDS (JSON có trường password)."
  value       = aws_db_instance.pg.master_user_secret[0].secret_arn
}

output "redis_url" {
  value = "redis://${aws_elasticache_cluster.redis.cache_nodes[0].address}:6379"
}

output "kafka_brokers" {
  value = "${aws_instance.kafka.private_ip}:9092"
}

output "kafka_instance_id" {
  description = "Vào máy: aws ssm start-session --target <id>"
  value       = aws_instance.kafka.id
}
