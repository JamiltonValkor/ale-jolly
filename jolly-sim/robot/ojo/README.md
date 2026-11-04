# ojo

Proceso del robot que cuenta. Recibe `ojo/orden` por el bus, toma la foto, llama a SAM, numera, deja la pantalla y entrega
JSON e imagen a Stock. **Stock decide** cuándo contar, qué concepto usar y qué significa el resultado. Esto solo captura,
llama a SAM, filtra, numera, muestra y envía. Las máscaras no salen de `sam.py`.

Va aparte de la voz porque el audio pelea por el GIL, con su `.venv` (`config/requisitos-ojo.txt`) y su PUB en 5562
(`ALE_BUS_OJO`). No importa código de voz.

| Variable | Valor |
|---|---|
| `ALE_OJO=1` | Lo arrancan `arrancar.sh` y `ale_mac.sh`, y enciende `ALE_EVENTOS` en la voz. Sin ella, nada cambia |
| `ALE_CAMARA` | `v4l2:/dev/video0`, `avfoundation:0`, `carpeta:/ruta/manifiesto.json`, `muse:/ruta/escenas.json` |
| `ALE_ENTORNO=produccion` | Niega `carpeta` y `muse`, que salen marcadas `fuente: simulada` |
| `ALE_ESCENA` | Escena de `carpeta` o `muse`. También sirve el archivo `escena_actual` junto al manifiesto |
| `ALE_OJO_MIN_CONF` | Confianza mínima, 0,5. Se calibra en IVB-022 |
| `ALE_OJO_PANTALLA` | Tamaño de `pantalla.png`, 1280x720, el modo real de la Pi. La cara reescala a su ventana |
| `ALE_OJO_PANTALLA_S` | Vida de la pantalla, 15 s |
| `ALE_OJO_PLAZO_SUBIDA_S` | Plazo para subir y cerrar una foto, 150 s. La URL firmada vive 300 s |

Muse genera la escena y entra como lectura de cámara; todo lo demás es igual. Una escena se genera una vez y queda en
`datos/muse`. Muse no respeta la cantidad pedida: el conteo real se verifica mirando la imagen. Es solo fuente de prueba:
en la Pi real la comprensión de la escena sigue siendo de Stock.

Prueba sin servidor, con `cwd` aquí:

    ALE_CAMARA=carpeta:$PWD/pruebas/manifiesto-minimo.json python ojo.py --una-vez --concepto jar --etiqueta frascos

`datos/<solicitud_id>` guarda `enviada.jpg`, `meta.json`, `pantalla.png` y `numerada.jpg` durante 7 días. El reintento R14
lee `enviada.jpg` de la foto original. Las cajas de `photo_done` están en coordenadas de `enviada.jpg`; el recorte solo
afecta a las dos imágenes dibujadas.

**Subida.** La Pi sale por el hotspot del teléfono, el mismo del Mac, y despierta sube ~50 KB/s de audio a Muse sin
parar. En un bajón del enlace móvil la cola crece y el RTT pasa de 5 ms a más de 1 s. Por eso cada paso (`photo_url` y
PUT, `photo_done`, `photo_failed`) se reintenta con espera creciente (1, 2, 4, 8, 15 y 30 s) hasta el plazo. Cada
intento pide una firma nueva y su tiempo de espera crece con el tamaño (`tiempo_para`, piso de 16 KB/s). 400, 401, 404 y
413 no se reintentan. El log dice el paso y la causa, nunca la URL. Las dos imágenes van a 1600 px en JPEG q85, entre 90
y 210 KB.

Prueba real en la Pi, sin tocar Stock (firma hacia un sumidero público, bytes al azar del mismo tamaño y sin
`photo_done`): `prueba_subida_real.py --n 10 --sam real`, con Jolly despierto. Ver su docstring.

`stream:true` va por decisión de la auditoría, aunque la doc de `segmenting` dice que es opcional.
