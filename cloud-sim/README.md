# cloud-sim · Google Cloud simulado (pieza P1)

> **Simulado.** Nada de esto habla con Google. `cloud-sim` imita, con el mismo
> protocolo, las APIs de Google Cloud que usa `ale-runtime`, para que el producto
> corra en el portátil del evaluador **sin cambiar su código**: solo cambian las
> variables `*_API_BASE`.

## Qué imita

| API real | Ruta en cloud-sim | Quién la usa | Qué hace aquí |
|---|---|---|---|
| Compute Engine v1 (`compute.googleapis.com/compute/v1`) | `/compute/v1/…` | ale-runtime (`src/compute`, `src/renewal`, `src/lifecycle`) | Plantilla, `insert`, operaciones, `get`, `setMetadata`, `stop`, `start`, `delete`, `getGuestAttributes` |
| Token del metadata server (Workload Identity) | `/token` y `/computeMetadata/v1/instance/service-accounts/default/token` | ale-runtime | Token falso con `Metadata-Flavor: Google` |
| IAM Credentials `signBlob` | `…/projects/-/serviceAccounts/<email>:signBlob` | ale-runtime (URLs firmadas) | Firma de 256 bytes, determinista y **sin llave** |
| Cloud Storage JSON API | `/storage/v1/b/<b>/o…`, `/upload/storage/v1/b/<b>/o` | ale-runtime | Existe (`fields=name,size`), sube (`uploadType=media`), baja (`alt=media`) y lista (`prefix`, `pageToken`) |
| URLs firmadas V4 (`https://storage.googleapis.com/<b>/<o>?X-Goog-…`) | `/<b>/<o>` con Host `storage.googleapis.com` | el watcher de la VM (archivo, restauración, fotos) | PUT y GET. Respeta el vencimiento; **no valida la firma** |
| Metadata server de cada VM (`metadata.google.internal`) | `/vm/<instancia>/computeMetadata/v1/…` | `vm/startup-script.sh watch` | Atributos, long poll `wait_for_change` con ETag y guest attributes por PUT |
| Una VM de Compute (COS) | un contenedor `vm-<instancia>` (`docker:dind`) | — | Ver abajo |

### Semántica de Compute que se respeta

- `insert` con `requestId`: repetir el mismo devuelve la misma operación; otro
  `requestId` sobre un nombre existente responde **409 `alreadyExists`**.
- La instancia nace con la metadata enviada, que **reemplaza** la de la plantilla
  (como GCE; por eso ale-runtime fusiona la plantilla antes).
- La plantilla trae el `startup-script` **byte a byte** de
  `ale-runtime/vm/startup-script.sh`, más `enable-guest-attributes`.
- `id` numérico estable mientras la instancia exista; uno nuevo si se recrea.
- Estados: `PROVISIONING → STAGING → RUNNING`, `STOPPING → TERMINATED`,
  `TERMINATED → STAGING → RUNNING`; tras `delete`, 404.
- `networkInterfaces[0].networkIP` es la IPv4 real del contenedor en la red `ale`.
- `setMetadata` exige el `fingerprint` vigente (si no, **412 `conditionNotMet`**),
  cambia el fingerprint y despierta el long poll de la VM. Funciona con la VM apagada.
- Las operaciones son asíncronas (`RUNNING → DONE`); un fallo de la VM queda en
  `error.errors[0].code`. Los errores HTTP usan el cuerpo de Google
  (`error.errors[0].reason`).
- `getGuestAttributes` en sus dos formas: `variableKey=ns/key` →
  `variableValue`, y `queryPath=ns/` → `queryValue.items[]`; 404 si no hay.
  Se borran solo con la instancia.

## La «VM» (decisión D6)

Cada instancia es un contenedor privilegiado `docker:dind` (`cloud-sim/vm`) con
IPv4 propia en la red `ale` y dos volúmenes que hacen de disco persistente
(`/var/lib/docker` y `/var/lib/hermes`): sobreviven a stop/start y se borran con
`delete`. Al arrancar hace lo que en GCE hacen COS, el startup-script y systemd:

1. confía en la CA local (D1), que le sirve cloud-sim en `/vm/ca.crt`;
2. reenvía DNS (dnsmasq) para que Hermes resuelva los nombres de la red `ale`;
3. arranca `dockerd` (con el espejo `cloud-sim-registry` de Docker Hub);
4. baja **su** `startup-script` de la metadata, como GCE en cada arranque;
5. toma la imagen de Hermes fijada por digest en ese script y le agrega la CA
   local en una capa encima (la oficial no la conoce). Sin CA, usa la oficial tal cual;
6. corre `startup-script.sh watch` (sin systemd ni iptables: el modo `startup`
   no se usa) con `HERMES_MD_URL` apuntando a cloud-sim y `HERMES_DOCKER_CRED=true`,
   y lo reinicia si sale (como `Restart=always`).

El watcher no cambia: lee la metadata, escribe `/opt/data`, arranca Hermes en el
puerto 8642 (que ale-runtime alcanza en la IP de la VM), archiva, restaura y
publica el ack en los guest attributes.

## Variables

cloud-sim:

| Variable | Defecto | Para qué |
|---|---|---|
| `CLOUD_SIM_PORT` | `8070` | Puerto HTTP |
| `GCP_PROJECT` / `GCP_ZONE` | `ale-local` / `local-sim1-a` | Proyecto y zona que acepta |
| `CLOUD_SIM_STARTUP_SCRIPT` | `/template/startup-script.sh` | El script de la plantilla |
| `CLOUD_SIM_CA_FILE` | `/ca/ca.crt` | Raíz de la CA local que se entrega a las VMs |
| `CLOUD_SIM_NETWORK` | `ale` | Red Docker de las VMs |
| `CLOUD_SIM_URL` | `http://cloud-sim:8070` | Cómo la alcanzan las VMs |
| `CLOUD_SIM_VM_IMAGE` | `ale-jolly/cloud-sim-vm:local` | Imagen de las VMs |
| `CLOUD_SIM_REGISTRY_MIRROR` | — | `host:puerto` del espejo de Docker Hub |
| `CLOUD_SIM_DATA` | `/data` | Estado de Compute y objetos de GCS |
| `CLOUD_SIM_OP_DELAY_SEC` | `1` | Pausa entre estados, para que se vean |
| `CLOUD_SIM_DRIVER` | `docker` | `fake` = VMs en memoria, sin Docker |

ale-runtime: ver el encabezado de `local/compose.cloud.yml`.

## Pruebas

```bash
cd cloud-sim/tests && python3 -m unittest -q
```

Contrato Compute, metadata, IAM y GCS con el driver falso (sin Docker): rutas,
cuerpos, códigos y reasons tal como los lee ale-runtime.

```bash
python3 cloud-sim/tests/vm_smoke.py --startup-script <ale-runtime>/vm/startup-script.sh
```

Prueba de humo con Docker real: Caddy con CA interna, una VM que arranca Hermes
oficial y publica el ack, archivo por URL firmada, stop/start, delete y una VM
nueva que restaura las memorias.

## Limpieza

Las VMs las crea cloud-sim por el socket de Docker, así que `docker compose down`
no las borra. Llevan la etiqueta `ale-jolly.cloud-sim`:

```bash
docker rm -f $(docker ps -aq --filter label=ale-jolly.cloud-sim)
```

```bash
docker volume rm $(docker volume ls -q --filter label=ale-jolly.cloud-sim)
```

Y luego el volumen `cloud-sim-data` para olvidar las instancias.

## Lo que no imita

Firmas (no se validan), IAM y permisos (cualquier `Bearer` sirve), cuotas,
regiones, discos, redes y firewalls de GCP, y Artifact Registry (el cerebro
queda apagado en fase 1: `BRAIN_IMAGE=''`, D3).
