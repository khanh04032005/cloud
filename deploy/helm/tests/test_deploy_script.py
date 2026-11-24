"""Exercise up.sh with fake AWS/Kubernetes commands; never contact a cluster."""

import base64
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[3]
FAKE_TOOL = r'''#!/usr/bin/env python3
import json, os, pathlib, sys
tool = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
with open(os.environ["MOCK_LOG"], "a") as log:
    log.write(json.dumps([tool, *args]) + "\n")
if tool == "terraform" and "output" in args:
    key = args[-1]
    values = {
        "ecr_registry": "example.invalid", "rds_secret_arn": "fake-secret",
        "rds_address": "db.internal", "redis_url": "redis://cache.internal:6379",
        "kafka_brokers": "kafka.internal:9092", "kafka_instance_id": "i-fake",
        "vpc_id": "vpc-fake", "alb_controller_role_arn": "arn:fake:alb",
        "cluster_autoscaler_role_arn": "arn:fake:ca",
    }
    print(values[key])
elif tool == "aws" and args[:2] == ["secretsmanager", "get-secret-value"]:
    print(json.dumps({"password": "test/password"}))
elif tool == "kubectl":
    if "apply" in args:
        sys.stdin.read()
    elif "get" in args and "secret" in args:
        if any(a.startswith("jsonpath=") for a in args):
            print("42")
        else:
            print(os.environ.get("MOCK_EXISTING_SECRET", ""))
    elif "create" in args:
        print("kind: List\nitems: []")
'''


class DeployScriptContracts(unittest.TestCase):
    def run_deploy(self, existing=None, **overrides):
        with tempfile.TemporaryDirectory(prefix="razzia-up-test-") as folder:
            root = Path(folder)
            scripts = root / "scripts/aws"
            scripts.mkdir(parents=True)
            for name in ("up.sh", "common.sh"):
                shutil.copyfile(ROOT / "scripts/aws" / name, scripts / name)
            (root / "infra/envs/dev").mkdir(parents=True)
            (root / "infra/envs/dev/backend.hcl").touch()
            (root / "deploy/helm/razzia").mkdir(parents=True)
            binaries = root / "bin"
            binaries.mkdir()
            for tool in ("aws", "kubectl", "terraform", "helm"):
                binary = binaries / tool
                binary.write_text(FAKE_TOOL)
                binary.chmod(0o755)
            log = root / "calls.jsonl"
            env = dict(os.environ)
            for key in ("MANAGER_PASSWORD", "ECR_PREFIX", "MONITORING", "AUTOSCALING"):
                env.pop(key, None)
            env.update(PATH=f"{binaries}:{env['PATH']}", MOCK_LOG=str(log), TAG="abc1234", APP_NS="quiz-test")
            if existing:
                env["MOCK_EXISTING_SECRET"] = json.dumps({
                    "data": {k: base64.b64encode(v.encode()).decode() for k, v in existing.items()}
                })
            else:
                env["MOCK_EXISTING_SECRET"] = ""
            env.update(overrides)
            result = subprocess.run(["bash", str(scripts / "up.sh")], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            return [json.loads(line) for line in log.read_text().splitlines()]

    def test_credentials_preserved_namespace_and_image_wiring(self):
        calls = self.run_deploy(existing={"JWT_SECRET": "j" * 64, "MANAGER_PASSWORD": "old-password"})
        secret = next(c for c in calls if c[0] == "kubectl" and "generic" in c)
        self.assertIn("--from-literal=JWT_SECRET=" + "j" * 64, secret)
        self.assertIn("--from-literal=MANAGER_PASSWORD=old-password", secret)
        self.assertIn("--from-literal=DATABASE_URL=postgres://razzia:test%2Fpassword@db.internal:5432/razzia?sslmode=no-verify", secret)
        namespace = next(c for c in calls if c[:3] == ["kubectl", "create", "namespace"])
        self.assertLess(calls.index(namespace), calls.index(secret))
        self.assertEqual(namespace[3], "quiz-test")
        deploy = next(c for c in calls if c[:4] == ["helm", "upgrade", "--install", "razzia"])
        for arg in ("image.registry=example.invalid/razzia", "image.tag=abc1234", "configRevision=42", "monitoring.enabled=false", "apps.socket.hpa.enabled=false"):
            self.assertIn(arg, deploy)

    def test_new_credentials_and_explicit_configuration(self):
        calls = self.run_deploy(MANAGER_PASSWORD="override-password", ECR_PREFIX="registry.internal/razzia", MONITORING="1", AUTOSCALING="true")
        secret = next(c for c in calls if c[0] == "kubectl" and "generic" in c)
        self.assertIn("--from-literal=MANAGER_PASSWORD=override-password", secret)
        jwt = next(c.split("=", 2)[-1] for c in secret if c.startswith("--from-literal=JWT_SECRET="))
        self.assertEqual(len(jwt), 64)
        self.assertTrue(all(c in "0123456789abcdef" for c in jwt))
        deploy = next(c for c in calls if c[:4] == ["helm", "upgrade", "--install", "razzia"])
        for arg in ("image.registry=registry.internal/razzia", "monitoring.enabled=true", "apps.socket.hpa.enabled=true"):
            self.assertIn(arg, deploy)


if __name__ == "__main__":
    unittest.main()
