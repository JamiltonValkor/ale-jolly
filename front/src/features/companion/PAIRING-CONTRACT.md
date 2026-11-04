# Contrato: sincronizar el compañero físico con Saleads

Para Jamilton. El front ya está hecho y habla con estos endpoints a través de
`createHttpTransport` (`lib/http-transport.ts`); todo lo que llega se valida con
los esquemas de `types/pairing.schemas.ts`. Si cambias un campo, cambia el
esquema: los tests del front lo van a notar.

Solo en desarrollo, `?demo=1` usa `createDemoTransport`, que simula
estos mismos estados y tiempos (ver «Modo demo» al final).

## Quién es quién

| Actor | Dónde corre                                                      | Sesión                                                                     |
| ----- | ---------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Robot | Navegador de la pantallita: `/{locale}/companion`                | **Ninguna.** Se identifica con `poll_token` (y opcionalmente `device_id`). |
| Dueño | Saleads (Meta Assistant): modal «Compañero físico · Sincronizar» | La sesión normal del dashboard (cookie same-origin al BFF).                |

## Endpoints

Todos son same-origin, JSON, sin caché. Los errores 4xx traen `{ "code": "<CÓDIGO>" }`.

### Robot

#### `POST /api/companion/pairing` — pedir un código

Cuerpo (opcional): `{ "device_id": "rb_123" }` (el front lo manda si la URL trae `?device=`).

`201`:

```json
{
  "pairing_id": "pr_7f3a…",
  "code": "K7P4QXAB",
  "qr_url": "https://app.saleads.ai/es/dashboard/meta-assistant?pair=K7P4QXAB",
  "expires_at": "2026-10-30T15:10:00Z",
  "poll_token": "pt_9c1e…"
}
```

- `code`: 6 caracteres de `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (sin 0/O/1/I/L: se leen mal en una pantalla chica). El robot lo muestra como `K7P4-QXAB`.
- `qr_url`: lo que codifica el QR. **Solo lleva el código**, nunca el `poll_token`.
- `expires_at`: ISO 8601 con zona. El front muestra «Cambia en N min» y, al vencer, pide otro solo.
- Pedir un código nuevo **invalida el anterior del mismo dispositivo** (un código activo por robot).
- Si el robot ya está sincronizado, puedes responder con su sesión vigente (el front pasa directo a «en vivo» sin repetir el saludo); o un 409 y el robot muestra su estado.

#### `GET /api/companion/pairing/{pairing_id}` — consultar el estado

Header obligatorio: `x-poll-token: <poll_token>`. Sin él o con otro: `404` (no confirmes que el `pairing_id` existe).

`200`:

```json
{
  "status": "syncing",
  "owner_first_name": "Nicolás",
  "business_name": "Mi Negocio",
  "sync_step": "voice"
}
```

| `status`  | Qué muestra el robot                                                                                                       |
| --------- | -------------------------------------------------------------------------------------------------------------------------- |
| `waiting` | El código y el QR, esperando.                                                                                              |
| `claimed` | El dueño lo escribió; arranca la pantalla «Estoy conociendo {negocio}».                                                    |
| `syncing` | Pasos de la sincronización. `sync_step` (opcional): `knowledge` → `voice` → `ready`. Sin él, el front no inventa progreso. |
| `paired`  | «¡Hola, {nombre}! Ya conozco {negocio}.» y después la cara a pantalla completa.                                            |
| `expired` | «Ese código venció», y pide uno nuevo solo.                                                                                |
| `revoked` | _Agregado por el front._ El dueño lo desvinculó: el robot vuelve a encender y muestra un código nuevo.                     |

`owner_first_name` y `business_name` son opcionales; mándalos desde `claimed`.

**Recomendado:** en la primera respuesta `paired`, incluye una credencial de dispositivo (`device_token`) para que el software del robot hable con el agente. El front la ignora (no la necesita la pantalla), y como solo la recibe quien tiene el `poll_token`, no se filtra por el QR.

### Dueño (con sesión)

#### `POST /api/meta-assistant/companion/claim` — reclamar el código

```json
{ "code": "K7P4QXAB", "business_id": "b_42" }
```

`200`: `{ "status": "syncing" | "paired", "device_name": "Compañero de Nicolás" }`

Errores:

| HTTP | `code`           | Qué ve la persona                                                                                             |
| ---- | ---------------- | ------------------------------------------------------------------------------------------------------------- |
| 404  | `INVALID_CODE`   | Junto al campo: «Ese código no coincide con ningún compañero…»                                                |
| 410  | `EXPIRED`        | Junto al campo, con el campo vacío: «Ese código ya venció. Tu compañero ya muestra uno nuevo…»                |
| 409  | `ALREADY_PAIRED` | Panel: «Este compañero está sincronizado con otra cuenta» + qué hacer.                                        |
| 503  | `DEVICE_OFFLINE` | Panel: «Tu compañero no tiene internet» + reintentar con el mismo código.                                     |
| 429  | `RATE_LIMITED`   | Junto al campo: «Hiciste varios intentos seguidos. Espera un minuto…» (un 429 sin cuerpo también se lee así). |

Cualquier otro fallo (red, 5xx, respuesta que no pasa el esquema) se muestra como «No pudimos conectar con Saleads» con reintento.

Reglas:

- `business_id` debe ser de la cuenta de la sesión (403 si no).
- Si la cuenta ya tenía otro compañero, este **lo reemplaza** y el anterior pasa a `revoked`. El front lo avisa antes de enviar: «Reemplaza a {device}, que dejará de hablar contigo».
- El reclamo es de un solo uso: el código queda consumido aunque la sincronización falle después.

#### `GET /api/meta-assistant/companion` — estado del compañero de la cuenta

```json
{
  "paired": true,
  "device": {
    "name": "Compañero de Nicolás",
    "paired_at": "2026-10-29T10:00:00Z",
    "last_seen_at": "2026-10-30T14:59:20Z"
  },
  "sync_step": null
}
```

- Mientras sincroniza: `{ "paired": false, "device": null, "sync_step": "knowledge" }` (opcional, mismo significado que en el robot).
- El front lo consulta cada 1 s solo mientras muestra «sincronizando»; si no hay `paired: true` en 30 s, avisa «Está tardando más de lo normal» (sin cortar).
- «En línea» = `last_seen_at` hace menos de 2 minutos.

#### `DELETE /api/meta-assistant/companion` — desvincular

`204`. El robot debe ver `revoked` en su siguiente consulta. El front pide confirmación antes y explica cómo volver.

## Estados

```
                ROBOT                                        DUEÑO
  ┌──────────── POST /pairing ────────────┐
  │                                        ▼
  │   waiting ── 10 min ──▶ expired ──▶ (POST /pairing otra vez, solo)
  │      │
  │      │  POST /claim {code}  ◀──────────────────── escribe el código o abre ?pair=CODE
  │      ▼                                              y confirma «Sincronizar compañero»
  │   claimed ──▶ syncing (knowledge → voice → ready) ──▶ paired
  │                                                        │
  │                                         DELETE /companion
  │                                                        ▼
  └──────────────────────────────────────────────────── revoked
```

## Tiempos

| Qué                                                     | Valor                           | Dónde vive                           |
| ------------------------------------------------------- | ------------------------------- | ------------------------------------ |
| Vida del código                                         | 10 min (`expires_at`)           | back                                 |
| Consulta del robot esperando                            | cada 2 s                        | `PAIRING_TIMINGS.robotPollWaitingMs` |
| Consulta del robot sincronizando                        | cada 1 s                        | `robotPollSyncingMs`                 |
| Consulta del robot ya sincronizado (para ver `revoked`) | cada 15 s                       | `robotPollPairedMs`                  |
| Consulta del dueño sincronizando                        | cada 1 s                        | `ownerPollSyncingMs`                 |
| Aviso «tarda más de lo normal»                          | 30 s                            | `syncSlowAfterMs`                    |
| Reintento del robot sin conexión                        | cada 10 s (y al volver el wifi) | `offlineRetryMs`                     |
| Sincronización esperada                                 | menos de 15 s                   | back                                 |

El robot pasa a «sin conexión» tras **dos** fallas seguidas (una suelta no asusta) o si el navegador avisa `offline`.

## Seguridad

- **Códigos cortos y de vida corta:** 31⁶ ≈ 887 M combinaciones, 10 minutos, un solo uso, uno activo por dispositivo.
- **Límite de intentos:** por usuario (p. ej. 5 reclamos por minuto) y por IP; y bloquea un código tras ~10 intentos fallidos globales contra él. Responde `429 RATE_LIMITED`.
- **`poll_token`:** aleatorio de 128 bits o más, atado al `pairing_id`, nunca en el QR ni en logs. Sin el token correcto, `404`.
- **Sin sincronizar por enlace:** abrir `?pair=CODE` **no** reclama nada; la persona ve el código y el negocio que va a compartir y confirma con «Sincronizar compañero». Así un enlace malicioso no puede atar la cuenta al robot de otro.
- **El QR solo abre Saleads:** el reclamo exige la sesión del dueño; el robot nunca recibe datos del negocio hasta `claimed`.
- **Desvincular** revoca la credencial del dispositivo (`device_token`) en el acto.

## Integración en la pantalla del robot

- URL: `/{locale}/companion` (pública, sin sesión, sin cromo). `?kiosk=1` oculta el cursor; `?device=<id>` manda `device_id`.
- Cara en vivo desde el software del robot:

  ```js
  window.postMessage(
    { source: 'saleads-companion', face: 'speaking', amplitude: 0.6 },
    '*'
  )
  ```

  `face`: `sleeping | waking | idle | listening | thinking | speaking | happy | syncing | error`; `amplitude` (0–1, opcional) mueve la boca con el audio real.

- Frase con sincronía labial (la boca sigue los visemas del texto, ~11 caracteres por segundo):

  ```js
  window.postMessage(
    {
      source: 'saleads-companion',
      say: '¡Hola, Nicolás! Ya conozco Mi Negocio.',
    },
    '*'
  )
  ```

  Si mandas `amplitude` mientras habla, manda la amplitud (audio real) sobre los visemas.

## Modo demo (escenario de la hackatón)

- Robot (solo en desarrollo): `/{locale}/companion?demo=1` · Saleads: el modal con `mode="demo"` (o el laboratorio `/{locale}/dev/companion-pairing-lab?section=demo&open=1`).
- En el mismo navegador se coordinan por `localStorage` + `BroadcastChannel`: escribir en Saleads el código que muestra el robot completa las dos pantallas (sincronización simulada de ~7 s).
- Si no hay robot abierto, cualquier código válido funciona (escenario con un solo equipo). En el robot, Enter o doble toque se reclama solo (`?name=Nicolás&business=Mi%20Negocio` para el saludo). `?ttl=30` acorta la vida del código para ensayar el vencimiento.
- Códigos de ensayo para mostrar cada error: `EEEEEE` venció · `NNNNNN` no coincide · `FFFFFF` sin internet · `PPPPPP` de otra cuenta · `RRRRRR` muchos intentos · `WWWWWW` sin conexión con Saleads.
- «Probar: dile hola» hace que el robot de la demo escuche, diga «¡Hola, {nombre}! ¿En qué te ayudo hoy?» moviendo la boca y se alegre. En vivo, las teclas `i l t s h e z` fuerzan cada cara y `v` dice una frase de muestra; `?say=texto` la dice al quedar en vivo.
