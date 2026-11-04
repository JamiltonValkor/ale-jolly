# Arranque de la Pi: lo que no instala `instalar_pi.sh`

Cambian el arranque, así que se aplican a mano y requieren reiniciar.

`/boot/firmware/config.txt`, táctil XPT2046 por SPI:

```
dtoverlay=ads7846,cs=1,penirq=25
```

`/boot/firmware/cmdline.txt`, en la misma línea única:

- Agregar `fbcon=rotate:2`: la consola queda al derecho con la pantalla montada al revés.
- No agregar `video=`: forzar 480×320 deja la pantalla negra. El modo es el nativo, 1280×720.

Sacar copia antes de editar. Pendiente contrastar contra los archivos de la Pi: ver «Procedencia» en `../../PI.md`.
