output "imports_bucket" {
  value = aws_s3_bucket.imports.bucket
}

output "exports_bucket" {
  value = aws_s3_bucket.exports.bucket
}

output "import_function" {
  value = aws_lambda_function.import.function_name
}

output "export_function" {
  value = aws_lambda_function.export.function_name
}
