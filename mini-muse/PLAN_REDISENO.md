# Mini-Muse — rediseño de TJBot con forma de Muse (Meta)

Uso personal / fan-made: no vender ni usar las marcas Meta / IBM / TJBot. Crédito: TJBot © IBM (Apache-2.0).

## Punto de partida
- `tjbot_3d_oficial/` — 14 STL oficiales v3.0.0 (copiados de ~/Downloads/tjbot-3dparts-3.0.0). Lámina: `analisis/tjbot_piezas_oficiales.png`.
- `referencia/muse_frente.webp` — foto de referencia (es un recorte plano tipo standee: solo vista frontal).

## Diagnóstico
TJBot es una caja (mandíbula 104×104, cabeza 104×104×77, patas-pilar 142 mm). Muse es una pera de una sola pieza
(cabeza+cuerpo sin cuello), capucha con cara ovalada, bracitos cortos colgando de los lados y dos patitas.
Las mallas de TJBot NO se pueden "deformar" a Muse. Se reutiliza su lógica interna, no su exterior:

| TJBot | Mini-Muse |
|---|---|
| Patas-pilar + retenedores apilados | Esqueleto interno: 2 pilares + bandejas (base, electrónica, pantalla) |
| Mandíbula con la Raspberry | Bandeja base con ESP32-S3, batería, parlante (peso abajo = estable) |
| Cabeza caja con ojos/LED | Ventana ovalada con pantalla (emociones) |
| Brazo en servo lateral (eje lateral) | Bracito en servo de hombro con eje hacia adelante → sube de lado y saluda |
| Pies encastrados | Patitas impresas + suela con peso |

## Proporciones medidas a ojo sobre la foto (H = altura total)
- Ancho cabeza a la altura de la cara ≈ 0.38 H; ancho máximo (panza) ≈ 0.54 H
- Cara (óvalo claro) ≈ 0.30 H de ancho × 0.19 H de alto, centro a ≈ 0.23 H desde arriba
- Hombros ≈ 0.45 H desde arriba; bracito ≈ 0.30 H de largo
- Patitas ≈ 0.12 H de alto, ancho de cada una ≈ 0.10 H, separación ≈ 0.04 H
- Vista lateral: NO existe en la foto → hay que definirla y aprobarla (etapa 1)

## Etapas (cada una con OK antes de seguir)
1. Concepto 3D fiel (forma suave, sin piel aún) superpuesto a la foto frente + propuesta de perfil lateral.
2. Esqueleto interno estilo TJBot + ubicación de pantalla, servo, ESP32, batería, parlante, micrófono.
3. Partición para impresión (Bambu P1S 256³): concha frente/espalda, bisel de cara, bracitos, patitas; insertos M3.
4. Validación: interferencias, recorrido del bracito, torque del servo, estabilidad al saludar, piezas caben en cama.
5. Emociones en pantalla (cara pastel + ojos + rubor + boca, parpadeo, alegría, sorpresa, sueño...).
6. Acabado peluche (fuzzy skin / flocado / funda de peluche).

## CAMBIO 2026-10-26: referente = Reachy Mini (Pollen / Hugging Face), no TJBot
- Repo clonado en `reachy_ref/repo` (Apache-2.0). Mallas LFS bajadas; el MJCF carga en MuJoCo (9 actuadores:
  yaw_body, stewart_1..6, right/left_antenna). Render: `analisis/reachy_poses.png`.
- Piezas impresas medidas: body_top 155×155×120, body_down 155×155×52, head_front 150×26×94, head_back 150×70×88,
  stewart_main_plate 145×126×39, body_foot 126×114×22.
- Mapeo: cuerpo pera → panza Muse; cabeza en plataforma Stewart → capucha con cara/pantalla;
  2 motores de antena → 2 bracitos (pasarlos de la cabeza a los hombros); giro de cuerpo → Muse gira sobre las patitas.
- Proporción: la cabeza de Muse ≈ 70 % del ancho de la panza; la de Reachy ≈ 97 % → panza más ancha (~200 mm), robot ~28–30 cm.

## Concepto v0 con SG90 (2026-10-26) — `concepto/`
- Forma: `forma_sdf.py` (uniones suaves, H = 0.32 m con las proporciones medidas en la foto) → cuerpo/cabeza/brazos .ply.
- Render: `render_concepto.py -- pelo|interior|rapido` (Blender 5.2, Cycles CPU; Metal se colgaba). Rótulos: `rotular.py`.
- Imágenes: `concepto_pelo.png` (pelo), `concepto_interior_rotulado.png` (corte).
- Movimiento simplificado de Reachy: 5 servos = giro cabeza + asentir + ladear (cuello en serie, en vez de
  Stewart de 6) + 2 bracitos. Opcional: 6.º servo de giro del cuerpo sobre la base.
- Recomendado MG90S (mismo tamaño, piñones metálicos) para el cuello; el de giro va con rodamiento tipo "lazy susan".
- Electrónica: Pi 5 + PCA9685 + pantalla DSI de 4″ en la cara + cámara Pi v3 en la frente + micrófonos arriba + parlante en la panza + 2×18650.
- Pendiente: unión cabeza-cuerpo (faldón de pelo), cables por el cuello, validación de torque/estabilidad en MuJoCo.
