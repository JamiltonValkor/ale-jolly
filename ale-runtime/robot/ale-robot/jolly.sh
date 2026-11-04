#!/usr/bin/env bash
# Duerme o despierta a Jolly sin tocar la pantalla:  ~/ale/ale-robot/jolly.sh dormir|despertar
case "${1:-}" in
  dormir) s=USR1 ;;
  despertar) s=USR2 ;;
  *) echo "uso: $0 dormir|despertar" >&2; exit 2 ;;
esac
pkill "-$s" -f "[Pp]ython[0-9.]* voz_hermes\.py" || { echo "Jolly no está corriendo" >&2; exit 1; }
