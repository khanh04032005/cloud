"""Helm manifest contracts. Requires Helm and PyYAML; no running cluster."""

import itertools
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[3]
CHART = ROOT / "deploy/helm/razzia"
HELM = os.environ.get("HELM", "helm")
IMAGE = {"registry": "example.invalid/razzia", "tag": "abc1234"}


def invoke(values=None, release="razzia", namespace="quiz-test", configured=True):
    override = {"image": IMAGE} if configured else {}
    override.update(values or {})
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json") as config:
        json.dump(override, config)
        config.flush()
        return subprocess.run(
            [HELM, "template", release, str(CHART), "-n", namespace, "-f", config.name],
            capture_output=True, text=True, check=False,
        )


def render(**kwargs):
    result = invoke(**kwargs)
    if result.returncode:
        raise AssertionError(result.stderr)
    return [doc for doc in yaml.safe_load_all(result.stdout) if doc]


def component(docs, kind, name):
    return next(
        doc for doc in docs
        if doc["kind"] == kind
        and doc["metadata"]["labels"]["app.kubernetes.io/component"] == name
    )


def container(deployment):
    return deployment["spec"]["template"]["spec"]["containers"][0]


class ChartContracts(unittest.TestCase):
    def test_kind_profile_and_browser_proxy_match_chart(self):
        profile = yaml.safe_load((ROOT / "deploy/kind/values.yaml").read_text())
        docs = render(values=profile, namespace="razzia-test")
        self.assertFalse(any(d["kind"] in ("Ingress", "ServiceMonitor", "HorizontalPodAutoscaler") for d in docs))
        self.assertEqual(component(docs, "Deployment", "socket")["spec"]["replicas"], 2)
        for doc in docs:
            if doc["kind"] == "Deployment":
                app = container(doc)
                self.assertTrue(app["image"].startswith("razzia/"))
                self.assertTrue(app["image"].endswith(":local"))
                self.assertEqual(app["imagePullPolicy"], "Never")
        proxy = list(yaml.safe_load_all((ROOT / "deploy/kind/proxy.yaml").read_text()))
        config = next(d for d in proxy if d["kind"] == "ConfigMap")["data"]["default.conf"]
        for name in ("web", "socket"):
            service = component(docs, "Service", name)
            endpoint = f'http://{service["metadata"]["name"]}:{service["spec"]["ports"][0]["port"]}'
            self.assertIn(endpoint, config)
        dependencies = list(yaml.safe_load_all((ROOT / "deploy/kind/dependencies.yaml").read_text()))
        for name in ("postgres", "redis", "kafka"):
            service = next(d for d in dependencies if d["kind"] == "Service" and d["metadata"]["name"] == name)
            workload = next(d for d in dependencies if d["kind"] in ("Deployment", "StatefulSet") and d["metadata"]["name"] == name)
            self.assertEqual(service["spec"]["selector"], workload["spec"]["template"]["metadata"]["labels"])
            self.assertEqual(service["metadata"]["namespace"], "razzia-test")

    def test_default_install(self):
        docs = render()
        self.assertEqual(sum(d["kind"] == "Deployment" for d in docs), 5)
        self.assertEqual(sum(d["kind"] == "Service" for d in docs), 5)
        self.assertEqual(sum(d["kind"] == "Job" for d in docs), 1)
        self.assertFalse(any(d["kind"] == "Secret" for d in docs))
        socket = component(docs, "Deployment", "socket")
        self.assertEqual(socket["spec"]["replicas"], 2)
        self.assertEqual(container(socket)["image"], "example.invalid/razzia/socket:abc1234")

    def test_ecr_image_and_custom_host(self):
        registry = "123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/razzia"
        docs = render(values={"image": {"registry": registry, "tag": "abc1234"}, "ingress": {"host": "quiz.example.com"}})
        self.assertEqual(container(component(docs, "Deployment", "socket"))["image"], f"{registry}/socket:abc1234")
        ingress = next(d for d in docs if d["kind"] == "Ingress")
        self.assertEqual(ingress["spec"]["rules"][0]["host"], "quiz.example.com")

    def test_feature_matrix(self):
        for hpa, monitoring, ingress, migration in itertools.product([False, True], repeat=4):
            with self.subTest(hpa=hpa, monitoring=monitoring, ingress=ingress, migration=migration):
                docs = render(values={
                    "apps": {"socket": {"hpa": {"enabled": hpa}}},
                    "monitoring": {"enabled": monitoring},
                    "ingress": {"enabled": ingress},
                    "migration": {"enabled": migration},
                })
                counts = {kind: sum(d["kind"] == kind for d in docs) for kind in (
                    "HorizontalPodAutoscaler", "ServiceMonitor", "Ingress", "Job"
                )}
                self.assertEqual(counts["HorizontalPodAutoscaler"], int(hpa))
                self.assertEqual(counts["ServiceMonitor"], 4 if monitoring else 0)
                self.assertEqual(counts["Ingress"], int(ingress))
                self.assertEqual(counts["Job"], int(migration))
                socket = component(docs, "Deployment", "socket")
                self.assertEqual("replicas" in socket["spec"], not hpa)

    def test_selectors_and_ports_connect(self):
        docs = render(values={"monitoring": {"enabled": True}})
        services = {d["metadata"]["name"]: d for d in docs if d["kind"] == "Service"}
        for service in services.values():
            name = service["metadata"]["labels"]["app.kubernetes.io/component"]
            deployment = component(docs, "Deployment", name)
            labels = deployment["spec"]["template"]["metadata"]["labels"]
            self.assertEqual(service["spec"]["selector"], deployment["spec"]["selector"]["matchLabels"])
            self.assertTrue(all(labels[k] == v for k, v in service["spec"]["selector"].items()))
            port = service["spec"]["ports"][0]
            self.assertIn(port["targetPort"], [p["name"] for p in container(deployment)["ports"]])
        for monitor in (d for d in docs if d["kind"] == "ServiceMonitor"):
            name = monitor["metadata"]["labels"]["app.kubernetes.io/component"]
            service = component(docs, "Service", name)
            selector = monitor["spec"]["selector"]["matchLabels"]
            self.assertTrue(all(service["metadata"]["labels"][k] == v for k, v in selector.items()))
            self.assertIn(monitor["spec"]["endpoints"][0]["port"], [p["name"] for p in service["spec"]["ports"]])

    def test_ingress_routes_and_health_checks(self):
        docs = render()
        ingress = next(d for d in docs if d["kind"] == "Ingress")
        paths = ingress["spec"]["rules"][0]["http"]["paths"]
        self.assertEqual({p["path"]: p["backend"]["service"]["name"] for p in paths}, {
            "/api": "razzia-socket", "/ws": "razzia-socket", "/": "razzia-web",
        })
        self.assertNotIn("/metrics", [p["path"] for p in paths])
        for name, path in (("web", "/"), ("socket", "/health/ready")):
            service = component(docs, "Service", name)
            self.assertEqual(service["metadata"]["annotations"]["alb.ingress.kubernetes.io/healthcheck-path"], path)

    def test_secret_access_and_probe_contract(self):
        docs = render(values={"secretName": "quiz-env"})
        expected = {
            "web": set(), "socket": {"DATABASE_URL", "REDIS_URL", "JWT_SECRET", "MANAGER_PASSWORD"},
            "publisher": {"DATABASE_URL", "KAFKA_BROKERS"},
            "score": {"DATABASE_URL", "REDIS_URL", "KAFKA_BROKERS"},
            "stats": {"DATABASE_URL", "REDIS_URL", "KAFKA_BROKERS"},
        }
        for name, keys in expected.items():
            app = container(component(docs, "Deployment", name))
            env = app.get("env", [])
            self.assertEqual(len(env), len({e["name"] for e in env}))
            refs = [e["valueFrom"]["secretKeyRef"] for e in env if "valueFrom" in e]
            self.assertEqual({r["key"] for r in refs}, keys)
            self.assertTrue(all(r["name"] == "quiz-env" for r in refs))
            if name in ("publisher", "score", "stats"):
                self.assertNotIn("livenessProbe", app)
                self.assertIn("tcpSocket", app["readinessProbe"])
        socket = container(component(docs, "Deployment", "socket"))
        self.assertEqual(socket["livenessProbe"]["httpGet"]["path"], "/health/live")
        self.assertEqual(socket["readinessProbe"]["httpGet"]["path"], "/health/ready")

    def test_migration_hook_has_no_chart_resource_dependency(self):
        job = component(render(), "Job", "migrate")
        annotations = job["metadata"]["annotations"]
        self.assertEqual(annotations["helm.sh/hook"], "pre-install,pre-upgrade")
        self.assertNotIn("hook-failed", annotations["helm.sh/hook-delete-policy"])
        self.assertEqual(job["spec"]["backoffLimit"], 0)
        pod = job["spec"]["template"]["spec"]
        self.assertNotIn("serviceAccountName", pod)
        self.assertFalse(pod["automountServiceAccountToken"])
        self.assertTrue(all("emptyDir" in v for v in pod["volumes"]))
        self.assertEqual([e["name"] for e in pod["containers"][0]["env"]], ["DATABASE_URL"])

    def test_socket_writable_config_and_config_rollout(self):
        for revision in ("", "123"):
            docs = render(values={"configRevision": revision})
            for name in ("web", "socket", "publisher", "score", "stats"):
                deployment = component(docs, "Deployment", name)
                annotation = deployment["spec"]["template"]["metadata"].get("annotations", {})
                self.assertEqual(annotation.get("razzia/config-revision"), revision if revision and name != "web" else None)
            socket = component(docs, "Deployment", "socket")
            pod = socket["spec"]["template"]["spec"]
            mounts = {m["mountPath"] for m in container(socket)["volumeMounts"]}
            self.assertIn("/app/config", mounts)
            self.assertIn("/tmp", mounts)
            self.assertEqual(pod["securityContext"]["fsGroup"], 1000)

    def test_releases_are_isolated_and_names_fit(self):
        first = render(release="alpha")
        second = render(release="beta")
        self.assertFalse({d["metadata"]["name"] for d in first} & {d["metadata"]["name"] for d in second})
        for release in ("r" * 53, "r" * 52 + "s"):
            docs = render(release=release, namespace="another-ns")
            for doc in docs:
                self.assertLessEqual(len(doc["metadata"]["name"]), 63)
                self.assertEqual(doc["metadata"]["namespace"], "another-ns")
        self.assertNotEqual(render(release="r" * 53)[0]["metadata"]["name"], render(release="r" * 52 + "s")[0]["metadata"]["name"])

    def test_invalid_configuration_is_rejected(self):
        cases = [
            {"image": {"registry": "", "tag": "abc"}},
            {"image": {"registry": "example.invalid/razzia", "tag": ""}},
            {"image": {"registry": "example.invalid/foo bar", "tag": "abc"}},
            {"apps": {"socket": {"hpa": {"enabled": True, "minReplicas": 8, "maxReplicas": 2}}}},
            {"apps": {"socket": {"hpa": {"enabled": True}, "resources": {"requests": {"cpu": None}}}}},
            {"apps": {"socket": {"replicas": 1}}},
            {"apps": {"socket": {"env": {"JWT_SECRET": "inline-password"}}}},
            {"apps": {"score": {"env": {"METRICS_PORT": "42"}}}},
            {"apps": {"web": {"terminationGracePeriodSeconds": 10}}},
            {"apps": {"web": {"port": 80}}},
            {"apps": {"socket": {"secretKeys": []}}},
            {"unknownSetting": True},
        ]
        for values in cases:
            with self.subTest(values=values):
                self.assertNotEqual(invoke(values=values).returncode, 0)
        self.assertNotEqual(invoke(configured=False).returncode, 0)


if __name__ == "__main__":
    unittest.main()
