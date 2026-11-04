# Contrato del bus del cuerpo de Ale (v1)

Transporte: ZeroMQ PUB/SUB, `tcp://127.0.0.1:5560` (env `ALE_BUS`). Cada mensaje = 2 partes: `[tema, JSON utf-8]`.
Un solo PUB por proceso (`cuerpo/bus.py` en voz-hermes; la cara publica `cara/estado` en `tcp://127.0.0.1:5561`; `ojo` publica `ojo/*` en `tcp://127.0.0.1:5562`).
Nombres de temas al estilo ROS para poder puentearlos a ROS 2.

## Campos comunes (todos los mensajes)
| Campo | Tipo | Significado |
|---|---|---|
| `tema` | str | igual a la primera parte |
| `t` | float | `time.monotonic()` en que el hecho OCURRE o DEBE OCURRIR (puede ser futuro). Misma máquina. |
| `t_pub` | float | hora de envío |
| `seq` | int | contador por emisor |
| `turno` | str | id del turno de conversación (en oido/ale/voz/cuerpo cuando aplica) |

## oido/evento  (voz_hermes)
`tipo`:
- `habla_inicio` — Muse detectó voz
- `parcial {texto}`
- `nombre_detectado {texto}` — el parcial empieza con la palabra de activación (una vez por frase)
- `nombre_cancelado {motivo: eco|ocupado|sin_nombre}` — la frase que disparó `nombre_detectado` no se aceptó
- `habla_fin`
- `aceptada {instruccion, en_conversacion}` — la frase va para Ale
- `ignorada {motivo: sin_nombre|ocupado|eco}` — con `ocupado` tras una pregunta de un aviso, el aviso se reitera una vez
- `ventana {abierta_hasta}` — conversación abierta sin repetir el nombre hasta esa hora (monotónica)

## ale/evento  (voz_hermes)
`tipo`:
- `pregunta {texto}` — una sola vez por turno (también si hay reintento)
- `relleno {clase: inicio|espera, frase}`
- `primer_token`
- `herramienta_inicio {nombre}` / `herramienta_fin {nombre, ok}`
- `comentario {texto}`
- `fin` — siempre, también tras error
- `error {origen: sse|http|red, motivo}`
- `aviso {id, texto, pregunta}` — con `turno="aviso-<id>"`. Jolly habla por iniciativa propia (`avisos.py`). Solo evidencia: el director no reacciona

## voz/*  (voz_cartesia)
- `voz/turno_inicio` — `t` = hora en que SUENA la primera muestra de la respuesta
- `voz/turno_fin` — `t` = hora en que suena la última muestra
- `voz/frase {texto, es_relleno, idioma}` — `t` = hora en que suena su primera palabra
- `voz/volumen {t0, dt, niveles[]}` — RMS 0–1 cada `dt` (0,01 s) a partir de la hora de salida `t0`; se publica por adelantado

## cuerpo/*  (director)
- `cuerpo/momento {momento, pista, herramienta}` — `momento` ∈ MOMENTOS; `pista` opcional (p. ej. `leyendo`/`tecleando` en trabajando); `herramienta` = nombre de la tool en trabajando (la cara muestra su ícono)
- `cuerpo/gesto {pregunta, intencion}` — al empezar cada frase de la respuesta (gesto breve; `pregunta` si la frase termina en "?"; `intencion` ofrece|muestra|null)
- `cuerpo/emocion {emocion, intensidad 0–1, texto}` — `emocion` ∈ EMOCIONES; se repite cada ≥ 4 s si la frase sigue con la misma emoción no neutral
- `cuerpo/latido {momento, emocion}` — cada 1 s; además se republica el último `cuerpo/momento`

MOMENTOS = reposo, escucha, pensando, pensando_largo, trabajando, hablando, problema
EMOCIONES = neutral, feliz, orgullosa, curiosa, pensativa, preocupada, confundida
(Prohibidas por la regla de optimismo D5: triste, asustada.)

## robot/emparejamiento  (canal_robot.py — CR-007 de canal-robot-v1)
`{estado: mostrando|vinculado|vencido, codigo: "K7QM-3XPA"|null, url: str|null, expira: monotonic|null}`
- `mostrando`: el robot no tiene credencial → la cara muestra código grande + QR de `url` y cuenta regresiva hasta `expira`.
- `vencido`: aviso "código vencido, pidiendo uno nuevo".
- `vinculado`: vuelve a la cara y celebra (ojitos felices + destellos + saltito, 3 s) si venía de mostrando/vencido.
La cara también lo escucha en 5560 (lo publica el proceso de voz con cuerpo/bus.py).

## cara/micro  (cara, en tcp://127.0.0.1:5561)
`{nombre}` — la cara empieza un gesto de reposo (parpadeo_doble, mirar_alrededor, giro_jolly, bostecito); `t` = hora del cuadro.
Es un evento: no se republica ni cuenta como latido, y un SUB que llega tarde lo pierde. No se emite con la pantalla de vinculación.

## cara/reaccion  (cara, en tcp://127.0.0.1:5561)
`{nombre, emocion, intensidad, dur, protagonista, t, t_pub, seq}` — evento único, no se republica. `t` es la hora en que la
reacción se VE, unos 150 ms después de publicarse. `nombre` ∈ ya_se, listo, sorpresa_suave, celebra, alivio, ofrecer,
señalar, cambio_al_hablar; nombres desconocidos se ignoran. `protagonista` cara|brazos: ese lleva el momento y el otro
acompaña pequeño; `ambos`: los dos a tope. En celebra y alivio `emocion` e `intensidad` son las de `cuerpo/emocion`.

## cara/estado  (cara, en tcp://127.0.0.1:5561)
`{momento, emocion, variante, sueno, boca, t_cuadro}` a 10 Hz — para registros y pruebas de negocio.

## cuerpo/sueno  (voz, 5560)
`{orden: dormir|despertar}` — la voz decide. Al dormir cierra la sesión con Muse y el micrófono.

## cara/toque  (cara, en tcp://127.0.0.1:5561)
`{accion: dormir|despertar, origen: boton|tecla}` — es un pedido; la voz responde con cuerpo/sueno. Por SSH: `ale-robot/jolly.sh`.

## cara/sueno  (cara, en tcp://127.0.0.1:5561)
`{estado: durmiendose|dormida|despertando|despierta, dur}` — dur: 3,8 s al dormirse, 3,0 s al despertar, 0 al terminar.

## ojo/*  (órdenes en 5560, respuestas en tcp://127.0.0.1:5562, env `ALE_BUS_OJO`)
- `ojo/orden {solicitud_id, concepto, etiqueta, foto_id}` — la publica la voz (5560) al llegar un evento `foto`. `foto_id` = reintento R14 sobre esa foto, sin capturar.
- `ojo/estado {solicitud_id, estado: recibida|capturando|contando|subida|error, tiempos?, motivo?}`
- `ojo/conteo {solicitud_id, estado, ruta_pantalla, total, expira}` — se republica cada 1,5 s hasta `expira` (monotónica, misma máquina) para que una cara reiniciada lo recupere.
Solo viajan rutas y números. Nunca bytes de imagen.

## Eventos de Stock (`canal_robot.py`, hilo `HiloEventos`, solo con `ALE_EVENTOS=1`)
No hay ruta nueva: todo va por `POST /devices/me/stream` con `Authorization: Bearer ale_dev_…`. Un cuerpo con `op` no abre turno.

| `op` | Cuerpo | Respuesta |
|---|---|---|
| `events` | `{after, device_state: activo\|dormido}` | SSE con keepalive cada 15 s |
| `event_ack` | `{event_id, estado: recibido\|hecho\|descartado\|vencido}` | `{ok}`. `vencido` deja el aviso `para_canal` |
| `state` | `{device_state}` | `{ok}`. No renueva la presencia. Al pasar a `activo` salen los avisos retenidos |
| `photo_url` | `{request_id, role: original\|numerada, content_type: image/jpeg\|image/png}` | `{url, object, expires_in, content_type}`. PUT ≤ 300 s, y el `content-type` va firmado |
| `photo_done` | `{request_id, sam, tiempos, fuente: camara\|simulada, imagen_sha256}` | `{ok}` |
| `photo_failed` | `{request_id, motivo: camara\|sam\|subida\|sin_original\|desconocido}` | `{ok}` |

Evento: `event: stock`, `id: 123`, `data: {"id":123,"kind":"foto","payload":{"solicitud_id":"…","concepto":"jar","etiqueta":"frascos","foto_id":null}}`.

- Una conexión por usuario: la nueva cierra la vieja. Sin keepalive escrito en 45 s, `take_photo` responde `robot_offline`.
- El cursor solo avanza con `event_ack`. Un evento `foto` sin ack en 60 s se reentrega una vez, con el mismo `id`.
- Un evento vence a los 30 min.
- El hilo confirma `recibido` solo cuando `ojo` responde en `ojo/estado`: si `ojo` está caído, la reentrega le da otra oportunidad.
- `request_id` en HTTP es el mismo valor que `solicitud_id` en evento y bus. `sam.objetos[].caja` va en coordenadas de la imagen enviada a SAM.
- Dormido no impide fotos: la cámara no usa micrófono.

## Avisos (`decir`, `avisos.py`, solo con `ALE_AVISOS=1`)
`{"id":9,"kind":"decir","payload":{"texto":"…","pregunta":true,"prioridad":"normal|alta","proposal_id":null,"vence_s":3600}}`. `vence_s` es lo que le queda antes de vencer o de cerrar el horario, lo que pase primero. Sin `ALE_AVISOS`, el hilo confirma `vencido` y Ale lo lleva por el canal.

- Solo `avisos.py` consume `decir`. El servidor retiene lo que está fuera de horario (07:00 a 21:00, zona del asistente) y lo de un robot dormido. `cuerpo/sueno.py` avisa con `HiloEventos.avisar_estado`.
- Habla si: candado libre, 1,5 s desde que se soltó, locutor callado, dueño callado, sin parcial en 1,5 s, despierto. `dueno_hablando` se reinicia al abrir sesión con Muse y vence a los 10 s sin señal.
- `voz_hermes` toma el candado desde que acepta la frase hasta que termina de sonar la respuesta: cubre el hueco en que Ale piensa.
- Al hablar: `locutor.turno=aviso-<id>`, `Fragmentador`, `cerrar`, `fin_turno`, `esperar`, ventana de 20 s. Tras una pregunta, otro aviso no entra hasta cerrar la ventana.
- La primera frase tras una pregunta, de aviso o de un turno, no pasa por `es_eco`. Solo esa.
- El id se guarda en `grabaciones/avisos-dichos.json` antes de sonar. El cursor no pasa de un aviso sin confirmar. Un reinicio no repite ni pierde.
- `ALE_VOZ_CARPETA=/ruta` reemplaza al micrófono por silencio y WAV nuevos, para provocar colisiones. Exige `ALE_AVISOS=1`; `ALE_ENTORNO=produccion` lo niega.

## Reglas
- Publicar nunca bloquea ni falla; sin oyentes los mensajes se pierden (es esperado).
- Un SUB que llega tarde (slow-joiner) recupera el estado por `cuerpo/latido` + republicado en ≤ 1 s.
- Nunca se publica desde el callback de audio.
