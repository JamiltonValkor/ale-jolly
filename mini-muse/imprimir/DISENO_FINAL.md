# Mini-Muse — diseño final para imprimir

Las piezas están en `imprimir/stl_final/`, generadas por `imprimir/generar_final.py`. El robot mide unos **34 cm de alto**.

**Verificado con `imprimir/verificar_final.py`:**
- **0 mm³ de choques** entre las piezas y con los componentes reales: Pi 5 con su modelo oficial, MPI3508, Gikfun de 40 mm, SG90, cámara USB de 38 mm y el lastre.
- **Los brazos giran de 0° a 150°** sin tocar el cuerpo ni la cabeza.
- **Silueta igual a la versión de manoplas que aprobaste:** 0,908 de frente, 0,919 de lado y 0,892 de espalda.

## Qué imprimir (Bambu P2S, boquilla 0,4)

| Código | Pieza | Medidas (mm) | Material y color | Ajustes |
|---|---|---|---|---|
| **P0** | Prueba de hombro, **vuelve a imprimirla** (cambió el agujero a Ø23,6 y la cuna) | ~20×60×65 | PLA | Pruébala con el brazo P4 nuevo |
| P2 | Cuerpo con patitas | 188×200×207 | **PETG beige** | De pie, soportes de árbol solo desde la cama, 3 paredes, 10% de relleno |
| P1 | Cabeza | 183×159×145 | PLA beige | Boca abajo, soportes de árbol |
| P3 | Cara: cojín con la ventana de la pantalla | 128×~40×98 | **PLA crema**, del mismo tono que el fondo de la pantalla | Con la ventana hacia arriba y soportes adentro, o de lado |
| P4 / P5 | Brazos con la forma del dibujo (banda arriba y mano en bola hacia adelante): **huecos** (pared de 1,2 mm) y con un **eje macizo Ø22 que los atraviesa** | 62×84×130 | PLA beige | **3 paredes y 100% de relleno**: como el brazo ya viene hueco, el relleno solo llena el eje y el tarugo. Pesan ~65 g. **De pie, con la mano abajo**, para que las capas corran a lo largo del tarugo. Soportes de árbol solo desde la cama |
| P6 ×2 | Tapón del agujerito del brazo | 9×9×5 | PLA beige | — |

**Para que se sienta peludito:** el pelo ya viene modelado en la superficie, con mechones de hasta 1,3 mm peinados hacia abajo. Encima activa en Bambu Studio:
- **Otros → Piel difusa (Fuzzy skin): "Paredes exteriores".**
- **Espesor 0,3 mm y distancia entre puntos 0,4 mm.**
- Solo en P1, P2, P4 y P5. **No** en la cara P3: tiene que quedar lisa como en el dibujo.

## Dónde va cada cosa (cambios frente a la guía anterior)
- **Pantalla MPI3508:** entra por detrás de la cara P3, con el conector HDMI **hacia abajo**. El vidrio queda a ras de la ventana. La sujetan 4 ganchos y 2 topes, y la cara se pega en la pestaña de la cabeza.
- **Parlante Gikfun:** va boca abajo sobre el aro, que está a 4,6 cm del suelo, por encima de la entrepierna. Suena por la rejilla de la entrepierna.
- **Cámara USB:** el porta-lente M12 entra en la toma cuadrada del pecho, que ahora tiene 12 mm de fondo. La placa de 38 mm queda adentro sin rozar.
- **Micrófono USB:** directo a la Pi; escucha por las ranuras de atrás.
- **Audio:** sale por el jack de 3,5 mm de la pantalla hacia tu amplificador y de ahí al parlante.

## La cara en la pantalla
`imprimir/cara/cara_neutra_480x320.png` sale de `imprimir/cara/generar_cara.py`. Ojos, sonrisa y rubor están medidos sobre el dibujo y escalados para caber en la ventana de 73×49 mm. El fondo crema (238, 222, 196) es el mismo color de la pieza P3.

## Medir cuando llegue la pantalla
Grosor del módulo, posición del área visible y lado del conector HDMI. Se ajustan en `PANT` dentro de `generar_final.py`.

## Unión brazo–servo (rediseñada el 2026-10-27 por el feedback del prototipo)
- **Antes:** el tarugo Ø20 solo entraba 2 mm al brazo, sobre un asiento más chico que él, y se reventaba fácil.
- **Ahora:**
  - Un eje macizo Ø22 atraviesa el brazo de pared a pared, fundido con filetes a las dos paredes.
  - El tarugo Ø22 que entra al cuerpo sale de ese mismo eje, también con filete.
  - El eje es hueco por dentro (Ø12) para meter el destornillador desde afuera; luego se tapa con P6.
- **Horn:** usa el horn simple del SG90 **recortado a 10,5 mm** desde el centro, para que quepa entero en el tarugo. Va con su tornillo a 8,5 mm, el tornillo central y una gota de epóxica.
- **Simulación:** el SG90 saluda al ~60–70% de su fuerza (era 83%).

## Forma de los brazos (feedback: "idénticos a la foto, no tan redondos")
- **Cómo se construyen:** rebanada por rebanada. El contorno de frente sale de la foto y el grueso de la malla aprobada, con sección redonda. Salen angostos en el hombro, con la mano como la parte más ancha y curvada hacia la panza.
- **Cuerpo:** bajo los brazos quedó 6 mm más delgado por lado, como el torso del dibujo, para darle espacio al brazo.
- **Silueta frente a la foto:** de frente pasó de 0,908 a **0,959**; de lado 0,917 y de espalda 0,937.

## Último ajuste de la mano (2026-10-27)
- **Mano:** termina en una bola redonda con la palma hacia adelante y hacia abajo, como en el dibujo, sin la pelotica que sobraba debajo.
- **Hombro:** el eje bajó a 16,4 cm del suelo, donde el brazo ya es ancho, y el brazo arranca afinándose suave. **Por eso P0 cambió: imprime la versión de `stl_final/`.**
- **Verificación:** 0 choques y giro de 0° a 150° libre. Silueta frente a la foto: 0,956 de frente, 0,917 de lado y 0,934 de espalda.

## Pendientes cerrados (2026-10-27)
- **Cámara USB:** agujero del lente de Ø10,6 mm, para el lente de 1 cm. La toma cuadrada de 15×15 mm para la placa con tornillitos se mantiene.
- **Pantalla MPI3508** (ficha de lcdwiki y Suconel):
  - La placa es de 85,5×56 mm y el área visible de 73,4×49 mm queda centrada.
  - USB, HDMI y jack de audio sobresalen 4,6 mm por el borde de **abajo**. El conector de 26 pines va atrás, por el borde de arriba.
  - Los 4 ganchos agarran el borde de la placa justo entre los conectores. Si la pantalla queda floja (el grosor se tomó como 6 mm), pon cinta espumosa detrás.
- **Amplificador:** bandeja universal de 48×52 mm entre el parlante y la Pi, con 2 pares de ranuras para zuncho. Le sirve a cualquier módulo de hasta 44×34 mm.
- **Verificación:** 0 mm³ de choques con todos los componentes, incluidos los conectores de la pantalla y el amplificador.
