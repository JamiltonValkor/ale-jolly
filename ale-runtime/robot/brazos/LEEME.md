# Brazos de Ale — Sistema de alineamiento de Meta (prototipo con Arduino UNO)

Plan y decisiones: `mini-muse/docs/tasks/alineamiento-brazos-v1/`. Hardware final: se decide después (owner).

## Conexión (2 SG90 directo al UNO)
| Cable | Brazo derecho | Brazo izquierdo |
|---|---|---|
| Naranja (señal) | **A0** | **A1** |
| Rojo (+5 V) | 5V | ICSP pin 2 |
| Café (GND) | GND | GND |

## Uso
```bash
.venv/bin/python alineamiento.py      # web http://localhost:8790: alinear (slider en vivo) + laboratorio de gestos
.venv/bin/python brazos.py            # los brazos acompañan a la cara por el bus (lo lanza ../../../ale.sh)
.venv/bin/python probar.py            # gestos por terminal
.venv/bin/python -m pytest pruebas_brazos.py pruebas_calibracion.py pruebas_firmware.py -q
```
Solo un programa puede usar el Arduino a la vez (web, brazos.py o probar.py).

## Archivos
- `brazos.yaml` — límites reales (µs) por brazo: reposo (abajo), máximo (arriba), mínimo (tope). Única verdad; la escribe la web (con `.bak`).
- `gestos.yaml` — gestos en % de elevación (0 reposo · 100 máximo · −100 mínimo) + qué gesto complementa cada momento de la cara.
- `firmware_brazos/` — v2: µs, límites del host, % de elevación, suave, arranca suelto. Compilar/subir:
  `arduino-cli compile --fqbn arduino:avr:uno firmware_brazos && arduino-cli upload -p /dev/cu.usbmodem31101 --fqbn arduino:avr:uno firmware_brazos`
