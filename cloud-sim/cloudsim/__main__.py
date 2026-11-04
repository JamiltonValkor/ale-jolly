"""Arranque: `python -m cloudsim`. Toda la configuración va por variables (README.md)."""
import os

from .compute import Cloud
from .drivers import DockerDriver, FakeDriver
from .server import build_server, log
from .storage import Storage


def env(key, default):
    return os.environ.get(key) or default


def template_items():
    """Metadata de la plantilla: el `startup-script` byte a byte (vm/startup-script.sh de ale-runtime)."""
    path = env("CLOUD_SIM_STARTUP_SCRIPT", "/template/startup-script.sh")
    with open(path, encoding="utf-8") as fh:
        script = fh.read()
    return [
        {"key": "startup-script", "value": script},
        {"key": "enable-guest-attributes", "value": "TRUE"},
        {"key": "enable-oslogin", "value": "TRUE"},
    ]


def main():
    data = env("CLOUD_SIM_DATA", "/data")
    port = int(env("CLOUD_SIM_PORT", "8070"))
    os.makedirs(data, exist_ok=True)
    if env("CLOUD_SIM_DRIVER", "docker") == "fake":
        driver = FakeDriver()
    else:
        vm_env = {}
        for key in ("CLOUD_SIM_REGISTRY_MIRROR", "HERMES_WAIT_TIMEOUT_SEC", "SALEADS_MEMORY_RECONCILE_EVERY"):
            if os.environ.get(key):
                vm_env[key] = os.environ[key]
        driver = DockerDriver(
            image=env("CLOUD_SIM_VM_IMAGE", "ale-jolly/cloud-sim-vm:local"),
            network=env("CLOUD_SIM_NETWORK", "ale"),
            metadata_base=env("CLOUD_SIM_URL", f"http://cloud-sim:{port}"),
            env={"CLOUD_SIM_URL": env("CLOUD_SIM_URL", f"http://cloud-sim:{port}"), **vm_env},
        )
    cloud = Cloud(
        driver,
        project=env("GCP_PROJECT", "ale-local"),
        zone=env("GCP_ZONE", "local-sim1-a"),
        template_items=template_items(),
        state_file=os.path.join(data, "compute-state.json"),
        op_delay=float(env("CLOUD_SIM_OP_DELAY_SEC", "1")),
    )
    storage = Storage(os.path.join(data, "gcs"))
    server = build_server(cloud, storage, port, ca_file=env("CLOUD_SIM_CA_FILE", "/ca/ca.crt"))
    log(f"listening on :{port} project={cloud.project} zone={cloud.zone} instances={len(cloud.instances)}")
    server.serve_forever()


if __name__ == "__main__":
    main()
