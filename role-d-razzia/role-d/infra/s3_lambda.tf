resource "random_id" "suffix" {
  byte_length = 2
}

locals {
  imports_bucket = "${var.name_prefix}-imports-${random_id.suffix.hex}"
  exports_bucket = "${var.name_prefix}-exports-${random_id.suffix.hex}"
  in_vpc         = length(var.vpc_subnet_ids) > 0
}

resource "aws_s3_bucket" "imports" {
  bucket = local.imports_bucket
}

resource "aws_s3_bucket" "exports" {
  bucket = local.exports_bucket
}

resource "aws_s3_bucket_public_access_block" "imports" {
  bucket                  = aws_s3_bucket.imports.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_public_access_block" "exports" {
  bucket                  = aws_s3_bucket.exports.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "imports" {
  bucket = aws_s3_bucket.imports.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_versioning" "exports" {
  bucket = aws_s3_bucket.exports.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "imports" {
  bucket = aws_s3_bucket.imports.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "exports" {
  bucket = aws_s3_bucket.exports.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "imports" {
  bucket = aws_s3_bucket.imports.id

  rule {
    id     = "imports-to-standard-ia"
    status = "Enabled"

    filter {
      prefix = "imports/"
    }

    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "exports" {
  bucket = aws_s3_bucket.exports.id

  rule {
    id     = "exports-to-glacier"
    status = "Enabled"

    filter {
      prefix = "exports/"
    }

    transition {
      days          = 90
      storage_class = "GLACIER"
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  name               = "${var.name_prefix}-quiz-lambda-${random_id.suffix.hex}"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

data "aws_iam_policy_document" "lambda" {
  statement {
    actions   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["arn:aws:logs:*:*:*"]
  }

  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.imports.arn}/imports/*"]
  }

  statement {
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.exports.arn}/exports/*"]
  }

  dynamic "statement" {
    for_each = local.in_vpc ? [1] : []

    content {
      actions = [
        "ec2:CreateNetworkInterface",
        "ec2:DescribeNetworkInterfaces",
        "ec2:DeleteNetworkInterface",
      ]
      resources = ["*"]
    }
  }
}

resource "aws_iam_role_policy" "lambda" {
  name   = "quiz-data"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda.json
}

resource "aws_cloudwatch_log_group" "import" {
  name              = "/aws/lambda/${var.name_prefix}-import-questions-${random_id.suffix.hex}"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "export" {
  name              = "/aws/lambda/${var.name_prefix}-export-results-${random_id.suffix.hex}"
  retention_in_days = 14
}

resource "aws_lambda_function" "import" {
  function_name = "${var.name_prefix}-import-questions-${random_id.suffix.hex}"
  role          = aws_iam_role.lambda.arn
  runtime       = "nodejs20.x"
  handler       = "index.handler"
  filename      = var.import_zip_path
  timeout       = 30
  memory_size   = 256

  source_code_hash = filebase64sha256(var.import_zip_path)

  environment {
    variables = {
      DATABASE_URL     = var.database_url
      QUESTION_LICENSE = var.question_license
    }
  }

  dynamic "vpc_config" {
    for_each = local.in_vpc ? [1] : []

    content {
      subnet_ids         = var.vpc_subnet_ids
      security_group_ids = var.vpc_security_group_ids
    }
  }

  depends_on = [aws_cloudwatch_log_group.import]
}

resource "aws_lambda_function" "export" {
  function_name = "${var.name_prefix}-export-results-${random_id.suffix.hex}"
  role          = aws_iam_role.lambda.arn
  runtime       = "nodejs20.x"
  handler       = "index.handler"
  filename      = var.export_zip_path
  timeout       = 60
  memory_size   = 256

  source_code_hash = filebase64sha256(var.export_zip_path)

  environment {
    variables = {
      DATABASE_URL  = var.database_url
      EXPORT_BUCKET = aws_s3_bucket.exports.bucket
    }
  }

  dynamic "vpc_config" {
    for_each = local.in_vpc ? [1] : []

    content {
      subnet_ids         = var.vpc_subnet_ids
      security_group_ids = var.vpc_security_group_ids
    }
  }

  depends_on = [aws_cloudwatch_log_group.export]
}

resource "aws_lambda_permission" "s3_import" {
  statement_id  = "AllowImportBucket"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.import.function_name
  principal     = "s3.amazonaws.com"
  source_arn    = aws_s3_bucket.imports.arn
}

resource "aws_s3_bucket_notification" "imports" {
  bucket = aws_s3_bucket.imports.id

  lambda_function {
    lambda_function_arn = aws_lambda_function.import.arn
    events              = ["s3:ObjectCreated:*"]
    filter_prefix       = "imports/"
    filter_suffix       = ".json"
  }

  depends_on = [aws_lambda_permission.s3_import]
}
