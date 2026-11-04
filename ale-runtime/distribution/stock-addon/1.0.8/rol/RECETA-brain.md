# Imagen de Brain con el rol stock

La construye la sesión de pasos a dev. Esta rama solo deja los archivos. Parte de la imagen que ya corre en dev, así que el código de Brain no cambia: solo se reemplazan cuatro esquemas, y `verificar_brain.py` hace fallar la construcción si falta un rol de siempre.

## Construir

1. Toma el digest vigente de `BRAIN_IMAGE` en el overlay de Meta de `sa-argocd-config`.
2. Desde la raíz del repo, en `feat/inventario-vivo`:

```bash
BASE='us-central1-docker.pkg.dev/saleads-dev/saleads-brain/saleads-brain@sha256:<digest-vigente>'
cd distribution/stock-addon/1.0.8/rol
docker buildx build --platform linux/amd64 --provenance=false -f Dockerfile.brain \
  --build-arg BASE_BRAIN_IMAGE="$BASE" \
  -t us-central1-docker.pkg.dev/saleads-dev/saleads-brain/saleads-brain:stock-1.0.0-<commit> --push .
```

3. Anota commit y digest en `evidencia/despliegue/digest-commit.md`.

## Desplegar

1. Pon `STOCK_BRAIN_IMAGE=<repositorio>@sha256:<digest-nuevo>` en la configuración de ale-runtime **antes** de la imagen que trae IVB-008, si `STOCK_ENABLED=true` y `STOCK_USER_IDS` no está vacío. Sin esa llave el servicio no arranca.
2. No cambies `BRAIN_IMAGE`. Solo los usuarios de `STOCK_USER_IDS` reciben la imagen nueva.
3. El watcher exige digest fijo y el repositorio privado de siempre.

## Comprobar en dev (IVB-021)

1. En la VM de transportador, `hermes/applied-version` igual a lo esperado y `hermes-brain-image` con el digest nuevo.
2. Tarjeta real a `stock`: recibe ContextPack y `saleads_memory_recall` responde dentro de su negocio.
3. Tarjeta real a `disenador_landings` en esa misma VM: el rol de siempre sigue atendido.

## Volver atrás

Quita al usuario de `STOCK_USER_IDS`. `OrqaSync` le devuelve `BRAIN_IMAGE` y el catálogo original en el siguiente `onReady`. Lo que Brain guardó con rol `stock` queda en su base y la imagen vieja no lo consulta: no hay migración. Para borrar el perfil y el trabajo del disco, usa `scripts/stock-retirar-vm.sh`.
