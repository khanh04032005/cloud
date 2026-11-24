locals {
  node_profiles = {
    # Khai báo nhiều loại cùng cỡ (2 vCPU / 4 GiB) để Spot có nhiều "bể" hơn, ít bị thu hồi,
    # và Cluster Autoscaler vẫn tính đúng sức chứa.
    x86_64 = { ami_type = "AL2023_x86_64_STANDARD", instance_types = ["t3.small"] }
    arm64  = { ami_type = "AL2023_ARM_64_STANDARD", instance_types = ["t4g.medium"] }
  }
  node = local.node_profiles[var.node_arch]
}

module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 21.0"

  name               = var.name
  kubernetes_version = var.kubernetes_version

  # Hết standard support thì AWS tự nâng version thay vì tính phí extended support (gấp 6 lần).
  upgrade_policy = { support_type = "STANDARD" }

  endpoint_public_access                   = true
  enable_cluster_creator_admin_permissions = true
  enable_irsa                              = true

  # Không bật log control plane: CloudWatch Logs tính tiền theo GB, môi trường thí nghiệm không cần.
  enabled_log_types = []

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets

  addons = {
    vpc-cni    = { before_compute = true }
    coredns    = {}
    kube-proxy = {}
  }

  eks_managed_node_groups = {
    default = {
      ami_type       = local.node.ami_type
      instance_types = local.node.instance_types
      capacity_type  = var.node_capacity_type

      min_size     = var.node_min
      desired_size = var.node_min
      max_size     = var.node_max

      labels = { "razzia/capacity" = lower(var.node_capacity_type) }
    }
  }

  # Kafka EC2 cần nhận kết nối 9092 từ node, RDS/Redis tham chiếu SG này.
  node_security_group_tags = { "razzia/role" = "node" }
}

# ---------- IAM cho controller chạy trong cụm (IRSA, không dùng access key) ----------

module "irsa_alb_controller" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts"
  version = "~> 6.0"

  name                                   = "${var.name}-alb-controller"
  attach_load_balancer_controller_policy = true

  oidc_providers = {
    this = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["kube-system:aws-load-balancer-controller"]
    }
  }
}

module "irsa_cluster_autoscaler" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts"
  version = "~> 6.0"

  name                             = "${var.name}-cluster-autoscaler"
  attach_cluster_autoscaler_policy = true
  cluster_autoscaler_cluster_names = [module.eks.cluster_name]

  oidc_providers = {
    this = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["kube-system:cluster-autoscaler"]
    }
  }
}
