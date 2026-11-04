# Exactitud de SAM con imágenes generadas (IVB-022)

Corrida del 2-nov-2026 en el Mac, con `robot/ojo` de `e467de7`: misma reducción (1600 px), cliente `sam.py` y filtro `numerar.filtrar`. Cada escena corrió 3 veces. El conteo a ojo quedó en `manifiesto.json` antes de la primera llamada a SAM.

## Resultado

- 25 de 31 escenas aciertan. Fallan 6: SU-1, SU-2, K-cerrada-1, O-solape, Q-reflejo y Q-pecho.
- Guion: 5 candidatas con error 0 en 3 corridas: S1-recibo, S2-a, S2-b, S5-a y S8-b. S8-a cae dentro de su rango, pero su conteo no es exacto: queda descartada, sin borrarla.
- Muy estable: 30 de 31 escenas dieron el mismo número las 3 veces. M-30 dio 43, 42, 42.
- Una escena fácil no predice una foto real: estas imágenes son limpias, sin polvo, con luz pareja. Las fotos reales (IVB-025) pueden dar peor.

## Qué falla

| Escena | Pasó | Causa | Qué debe hacer el flujo |
|---|---|---|---|
| SU-1 | 29 contra 6 botellas | Cuenta productos desenfocados del fondo y tubos | Stock mira la imagen numerada y pregunta. Un total alto en surtido no es confiable |
| SU-2 | 38 contra 3 | Igual, con mesa llena | Igual |
| K-cerrada-1 | 2 contra 1 caja | Cuenta una caja lejana del fondo | Stock revisa; con umbral 0,7 baja a 1 |
| O-solape | 19 contra 15 a 17 | Doble detección en canasta | Pedir reacomodar o preguntar |
| Q-pecho | 19 contra 18 | Frasco lejano del fondo | Con umbral 0,7 baja a 18 |
| Q-reflejo | 13 contra 14 a 16 | Reflejo y frascos tras vidrio | Sin cámara limpia, pregunta |

También quedan como límite conocido:

- **Filas de atrás:** S8-a, M-30, M-50, O-filas. SAM da números dentro del rango, pero nadie puede verificar el exacto: hay frascos asomados. Muse puso filas traseras sin pedirlas. Un conteo con filas ocultas no debe proponerse como exacto.
- **Etiquetas:** SAM no distingue texto. `bottle with REPARADOR label` da 10 y con HIDRATANTE da 0, sobre 5 y 5; `jar labeled RIZOS` da 0. Tamaños tampoco: `small bottle` y `large bottle` dan 12 ambas. Cumple R15 solo si Stock pregunta.
- **Color sí:** `green lid` da 12 y `red lid` da 8, exacto. La tarea decía que SAM solo no distingue variantes: es cierto para etiqueta y tamaño, no para color de tapa.
- **Frase larga:** R14 confirmado. 20 de 31 frases largas o de otro objeto dieron 0, y la palabra corta resolvió. Pero no siempre da 0: P-03, P-05, P-07 y otras contaron bien.
- **Un 0 no siempre es vacío:** `jar` sobre cajas cerradas da 0, igual que sobre estante vacío. Eso es R16: el cero solo no separa «no hay» de «está tapado».
- **Concepto amplio:** `product` en SU-1 da 44, y `hair care product` da 0.

## Umbral `ALE_OJO_MIN_CONF`

Simulado con las confianzas guardadas, sin llamadas nuevas. La propia API ya corta cerca de 0,5, así que el 0,5 actual no descarta nada: crudos = filtrados en todas.

| `ALE_OJO_MIN_CONF` simulado | Exactas que aciertan | Error medio |
|---|---|---|
| 0.5 | 21 de 25 | 2.40 |
| 0.6 | 22 de 25 | 1.40 |
| 0.7 | 23 de 25 | 0.76 |
| 0.8 | 23 de 25 | 0.32 |
| 0.9 | 22 de 25 | 1.76 |

**Propuesta: 0,7, sin aplicar.** Corrige K-cerrada-1, O-solape y Q-pecho, sin tocar las escenas limpias. Costo: filas de atrás bajan (S8-a de 62 a 54, M-50 de 85 a 74). 0,8 tiene mejor error, pero pierde frascos reales; 0,9 deja M-50 en 0. Sale de imágenes generadas: confirmar con foto real antes de fijarlo. Surtidos siguen mal con 0,7 (SU-1 13, SU-2 15).

## Por grupo

| Grupo | Imágenes | Aciertan | Error medio | Estables en 3 |
|---|---|---|---|---|
| guion | 6 | 6 | 0.0 | 6 |
| pocos | 3 | 3 | 0.0 | 3 |
| densidad | 3 | 3 | 0.0 | 2 |
| surtidos | 2 | 0 | 29.0 | 2 |
| variantes | 4 | 4 | 0.0 | 4 |
| concepto | 1 | 1 | 0.0 | 1 |
| cero | 2 | 2 | 0.0 | 2 |
| caja | 3 | 2 | 0.3 | 3 |
| oclusion | 2 | 1 | 1.0 | 2 |
| calidad | 5 | 3 | 0.4 | 5 |

Con filas ocultas se mide si cae dentro del rango; en ese caso el error es la distancia al rango.

## Por densidad

| Grupo | Imágenes | Aciertan | Error medio | Estables en 3 |
|---|---|---|---|---|
| 0 | 2 | 2 | 0.0 | 2 |
| 1 a 10 | 10 | 7 | 5.9 | 10 |
| 11 a 20 | 8 | 5 | 0.5 | 8 |
| 21 a 40 | 8 | 8 | 0.0 | 7 |
| más de 40 | 3 | 3 | 0.0 | 3 |

La densidad no es el problema: 60 tapas desde arriba y 33 frascos en repisa salen exactos. El error de 1 a 10 viene de surtidos, con fondo lleno. El límite real es el fondo y lo oculto.

## Por imagen

| Imagen | Grupo | Concepto | Mirado | SAM ×3 | Largo | Resultado |
|---|---|---|---|---|---|---|
| S1-recibo | guion | jar | 12 | 12/12/12 | 0 | acierta |
| S2-a | guion | jar | 22 | 22/22/22 | 0 | acierta |
| S2-b | guion | jar | 22 | 22/22/22 | 0 | acierta |
| S5-a | guion | jar | 16 | 16/16/16 | 0 | acierta |
| S8-a | guion | jar | 60-80 | 62/62/62 | 0 | acierta |
| S8-b | guion | jar | 33 | 33/33/33 | 0 | acierta |
| P-03 | pocos | bottle | 3 | 3/3/3 | 3 | acierta |
| P-05 | pocos | tube | 5 | 5/5/5 | 5 | acierta |
| P-07 | pocos | bottle | 7 | 7/7/7 | 7 | acierta |
| M-30 | densidad | jar | 40-50 | 43/42/42 | 41 | acierta |
| M-50 | densidad | jar | 77-115 | 85/85/85 | 0 | acierta |
| D-apretados | densidad | lid | 60 | 60/60/60 | 60 | acierta |
| SU-1 | surtidos | bottle | 6 | 29/29/29 | 0 | **falla** |
| SU-2 | surtidos | bottle | 3 | 38/38/38 | 58 | **falla** |
| V-tapas | variantes | jar | 20 | 20/20/20 | 12 | acierta |
| V-etiquetas-1 | variantes | bottle | 10 | 10/10/10 | 10 | acierta |
| V-etiquetas-2 | variantes | jar | 12 | 12/12/12 | 0 | acierta |
| V-tamanos | variantes | bottle | 12 | 12/12/12 | 0 | acierta |
| C-frase | concepto | bottle | 9 | 9/9/9 | 0 | acierta |
| Z-vacio-1 | cero | jar | 0 | 0/0/0 | 0 | acierta |
| Z-vacio-2 | cero | jar | 0 | 0/0/0 | 0 | acierta |
| K-cerrada-1 | caja | box | 1 | 2/2/2 | 0 | **falla** |
| K-cerradas-4 | caja | box | 4 | 4/4/4 | 0 | acierta |
| K-mixta | caja | jar | 6 | 6/6/6 | 2 | acierta |
| O-filas | oclusion | jar | 27-30 | 27/27/27 | 18 | acierta |
| O-solape | oclusion | bottle | 15-17 | 19/19/19 | 16 | **falla** |
| Q-reflejo | calidad | jar | 14-16 | 13/13/13 | 0 | **falla** |
| Q-pecho | calidad | jar | 18 | 19/19/19 | 0 | **falla** |
| Q-oscura | calidad | jar | 22 | 22/22/22 | 0 | acierta |
| Q-borrosa | calidad | jar | 22 | 22/22/22 | 0 | acierta |
| Q-inclinada | calidad | jar | 22 | 22/22/22 | 0 | acierta |

## Sondas de variante

| Imagen | Frase | SAM |
|---|---|---|
| V-tapas | `green lid` | 12 |
| V-tapas | `red lid` | 8 |
| V-etiquetas-1 | `bottle with REPARADOR label` | 10 |
| V-etiquetas-1 | `bottle with HIDRATANTE label` | 0 |
| V-etiquetas-2 | `jar labeled RIZOS` | 0 |
| V-tamanos | `small bottle` | 12 |
| V-tamanos | `large bottle` | 12 |
| K-cerrada-1 | `jar` | 0 |
| K-cerradas-4 | `jar` | 0 |
| Z-vacio-2 | `box` | 1 |
| SU-1 | `product` | 44 |
| D-apretados | `jar` | 60 |
| M-50 | `lid` | 81 |
| M-30 | `lid` | 44 |
| S8-a | `lid` | 59 |
| Q-pecho | `lid` | 19 |

## Costo

| Concepto | Cantidad | Precio de lista | Total |
|---|---|---|---|
| `muse-image-1.0` | 28 | US$ 0,01 | US$ 0,28 |
| `sam-3.1` | 140 | US$ 0,0025 | US$ 0,35 |
| **Total** | | | **US$ 0,63** |

Precios de `back/tasks/022`, no de una factura. Tope pedido: muy por debajo de US$ 5. Las 3 degradadas no llamaron a Muse. SAM: 0,66 a 3,2 s por llamada, mediana 1,1 s.

## Sin cerrar en IVB-022

- **Firma O-6.** El conteo lo hice yo mirando, por instrucción de esta tarea. La tarea exige que firme una persona, y por eso `firma_o6` es nulo. Faltan los 6 conteos con rango, sobre todo.
- `contar_ciego.py`, `pruebas_banco.py`, `generar_imagenes.py` en `robot/banco/`, rechazo por byte en `ojo` con `carpeta:` y copia con `llevar_a_pi.sh`: no se hicieron. Aquí todo vive en `evidencia/imagenes/`, sin tocar ale-runtime, y `herramientas/medir_sam.py` sí rechaza un sha256 distinto.
- 31 imágenes, 12 MB, muy por debajo de 200 MB. Sin datos de clientes.
- S1-recibo trae una marca real (Kraft) en el fondo, puesta por Muse. Sirve para banco, no para material público.
- S8-b da 33 y Muse no dio 30. El guion debe usar 33 en IVB-024, o generar otra.
