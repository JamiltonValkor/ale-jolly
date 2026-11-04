# stock-sim: usuarios sintéticos para Stock (IVB-023)

Corre un día (8 ticks) y una semana (56 ticks) de una tienda capilar con la forma de Masquebella, comprimidos con el reloj
del banco, contra la VM real de dev. Una dueña sintética (Daniela) le habla a Jolly por el canal robot, el mundo vende y
el proveedor sintético negocia. Un juez sin modelo da oportunidades y violaciones por regla de negocio.

## Real y simulado

| Pieza | En esta corrida | Cómo |
|---|---|---|
| VM, Hermes, Kanban, Ale y el perfil Stock | Real (dev) | VM del usuario de prueba, por `SIM_VM`. Nunca `sa-assistant-sim-*` (`devlab.guard_vm`) |
| MCP `saleads_stock_*` y reglas de `src/stock` | Real (dev) | Lo desplegado en `sa-meta-assistant-service` |
| Modelo del sujeto | Real | El de la VM (Muse Contributor en dev) |
| SAM 3.1 y `robot/ojo` | Real | `ojo.Ojo` del repo, cámara `carpeta:` con imágenes de IVB-022 (`fuente: simulada`) |
| Repisa | Simulada | Imagen elegida por el guion (`escena_actual`), con sha256 congelado |
| Dueña | Simulada | `owner.py` con Muse por la API de Meta, nunca OpenRouter |
| Voz de la dueña | Simulada con frase real | Turno por `POST /devices/me/stream`: la frase queda en `stock_owner_utterances` y `confirm_count` la cita |
| Aprobaciones de plata | Pantalla real | `--web manual`: la decisión de la dueña queda en `web/pendiente-*.json` y una persona o agente hace el clic en la pantalla de Stock |
| Ventas | Simuladas | `bench_seed` con método `semilla`, marcadas `simulated` |
| Proveedor | Simulado | `world.Supplier` responde por `bench_supplier_reply` (adaptador `banco`) |
| Campaña | Simulada | `bench_campaign` tras una apuesta aprobada |
| Reloj | Simulado | `bench_clock` por tick; `bench_close` lo devuelve a 0 al cerrar |

Esto difiere de `back/tasks/023`: la tarea pedía VM propia `sa-assistant-sim-stock-*`, MCP simulado y `src/stock` sobre
PGlite. La orden de la corrida (2-nov-2026) fue usar la VM de dev del usuario de prueba y no tocar las VMs `sa-assistant-sim-*`.
Por eso `server.py`, `meta_mirror.py`, `dev_fidelity.py`, `agent_api.py`, `bridge.ts`, `make-metadata.ts` y `llm_proxy.py`
no se copiaron: el MCP, el one-click y `src/stock` son los reales de dev.

## Procedencia

Origen: `sale -ads/docs/tasks/saleads-agente-marketing-loop-v1/pruebas/e2e/sim/` (sin git en esa carpeta; sha256 de 12).
Dueña de esa carpeta: sesión `local_b4c9d7af`.

| Archivo aquí | Origen | sha256 del origen | Qué se conserva |
|---|---|---|---|
| `owner.py` | `owner.py` | `b3937208a6dc` | Ficha que se vive, historial en disco, lectura JSON antes de escribir, decisión con «entiendo», prohibición de OpenRouter. `SYSTEM` reescrito para Stock, modelo Muse |
| `clock.py` | `clock.py` | `e41ff5e14535` | Reloj que comprime y conversa. Reescrito para modo stock: N ticks exactos por día, sin `MAX_TICKS` ni corte por silencio |
| `world.py` | `world.py` | `3983a54c1b60` | RNG sembrado por (semilla, producto, día). Contenido nuevo: inventario y proveedor |
| `judge.py` | `judge.py` | `542d6cdf2021` | Reglas puras sobre datos recogidos. Reglas nuevas, con antivacío |
| `meter.py` | `meter.py` | `6e630ac97a61` | Gasto por tramo. Precios de esta ola |
| `duenos/daniela.yaml` | `usuarios-simulados/duenos/kaba.yaml` | `899ed4ef9eac` | Forma de ficha. Persona nueva y anónima |
| `devlab.py`, `scenarios/masquebella.yaml`, `test_sim.py` | Nuevos | | |

## Uso

```sh
python -m pytest -q                         # sin red
export SIM_NEGOCIO=<negocio de prueba> SIM_VM=<vm del usuario de prueba> SIM_OFERTAS=<json fuera del repo> \
       SIM_IMAGENES=<carpeta con manifiesto.json de IVB-022> META_API_KEY=<llave Muse>
python clock.py scenarios/masquebella.yaml --dias 1 --ticks 1 --out <dir>   # humo
python clock.py scenarios/masquebella.yaml --dias 1 --out <dir>             # un día, 8 ticks
python clock.py scenarios/masquebella.yaml --dias 7 --out <dir>             # una semana, 56 ticks
```

`SIM_OFERTAS` mapea las claves del escenario (`mascarilla`, `shampoo`, …) a `{"type": "product", "id": …}` del negocio de
prueba. Queda fuera del repo, que se prepara para publicar. La credencial del dispositivo de banco se lee de
`~/.config/inventario-vivo/banco-dispositivo.env` y nunca se escribe en la salida (`devlab.redact`).

Antes de la corrida, cerrar la corrida activa del negocio con `{"op":"bench_close","run_id":…}` (ver `docs/stock-operacion.md`).
Al terminar, `bench_close` de la propia corrida devuelve el reloj del negocio a la hora real.

## Límites conocidos

- Los workers del perfil `stock` no aparecen en la API de sesiones de Hermes: su gasto se estima por tarjeta (`meter.py`).
- La lista de herramientas de cada turno (`tools`) no se lee: Hermes deja `tool_names` vacío en sesiones `kanban`. R36 y
  R20d se juzgan por las llamadas del MCP, no por la lista ofrecida.
- `margen` de kits y apuestas sale nulo: el costo por unidad solo lo escribe una factura confirmada.
