#!/usr/bin/env bash
# Salida de voz por Bluetooth: ALE_BT_SALIDAS lista las direcciones en orden de preferencia. Si ninguna está, suena por HDMI.
set -u
read -r -a SALIDAS <<< "${ALE_BT_SALIDAS:-}"
[ "${#SALIDAS[@]}" -gt 0 ] || exit 0
conectada() { bluetoothctl info "$1" 2>/dev/null | grep -q "Connected: yes"; }
alguna() { for mac in "${SALIDAS[@]}"; do conectada "$mac" && return 0; done; return 1; }
while true; do
  # Con una salida conectada no se busca otra: buscar por radio corta el audio que está sonando.
  if ! alguna; then
    for mac in "${SALIDAS[@]}"; do
      timeout 10 bluetoothctl connect "$mac" >/dev/null 2>&1 && conectada "$mac" && break
    done
  fi
  sleep 30
done
