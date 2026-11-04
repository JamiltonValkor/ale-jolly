#!/usr/bin/env bash
# Jolly en este computador (macOS, Linux o Windows con Git Bash): cara (ventana), voz por el canal robot y ojo (fotos + SAM). Sin brazos.
#   ./start.sh                       Jolly en vivo contra ale-runtime (ALE_RUNTIME_URL, por defecto http://localhost:8060)
#   ./start.sh --replay              repetición de una traza real del robot, sin backend, sin llave y sin micrófono
#   ./start.sh meta-check            una llamada a cada modelo de Meta con tu llave (Spark, búsqueda, Transcribe, Image, SAM)
#   ./start.sh doctor                revisa Python, PortAudio, micrófono, ffmpeg, cámara, llave, voz y backend
#   ./start.sh --camara avfoundation:0 | v4l2:/dev/video0 | carpeta:/ruta/manifiesto.json
#   ./start.sh --desvincular         borra la credencial del robot: vuelve a mostrar un código
#   ./start.sh --sembrar             vincula a Jolly en la terminal si hace falta y siembra el inventario demo de Stock
#   ./start.sh --grabar              además graba el bus en jolly-sim/grabaciones/
# Llaves: META_API_KEY (obligatoria en vivo) y CARTESIA_API_KEY (opcional; sin ella, la voz del sistema: say en macOS, la de Windows o espeak en Linux).
# Se leen del entorno, o de local/.env o .env en la raíz del repo. Ctrl+C cierra todo.
set -u
AQUI="$(cd "$(dirname "$0")" && pwd)"
ROBOT="$AQUI/robot"
VENV="$AQUI/.venv"
PY="$VENV/bin/python"
[ -x "$VENV/Scripts/python.exe" ] && PY="$VENV/Scripts/python.exe"   # Windows
ENV_ROBOT="$ROBOT/voz-hermes/.env"

# Git Bash en Windows: `pwd -W` da C:/… (el Python de Windows no entiende /c/…); en macOS y Linux no existe y queda $AQUI.
AQUI_NATIVO="$(cd "$AQUI" && pwd -W 2>/dev/null || echo "$AQUI")"
MODO=vivo; CAMARA="${ALE_CAMARA:-carpeta:$AQUI_NATIVO/fotos-ejemplo/manifiesto.json}"; GRABAR=0; DESVINCULAR=0
while [ $# -gt 0 ]; do
  case "$1" in
    doctor) MODO=doctor ;;
    meta-check) MODO=meta ;;
    --replay) MODO=replay ;;
    --camara) CAMARA="$2"; shift ;;
    --grabar) GRABAR=1 ;;
    --desvincular) DESVINCULAR=1 ;;
    --sembrar) MODO=sembrar ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "❌ Opción desconocida: $1 (./start.sh --help)"; exit 2 ;;
  esac
  shift
done

# --- Python 3.12 y requisitos fijados, en un solo entorno ---------------------------------------------------------
python312() {   # imprime la orden que da Python 3.12, o nada
  local c
  for c in python3.12 "py -3.12" python3 python; do
    $c -c 'import sys; sys.exit(sys.version_info[:2] != (3, 12))' >/dev/null 2>&1 && { echo "$c"; return; }
  done
}

preparar_python() {
  if [ ! -x "$PY" ]; then
    local base
    if command -v uv >/dev/null 2>&1; then
      uv venv --quiet --python 3.12 "$VENV" || exit 1
    elif base="$(python312)" && [ -n "$base" ]; then
      $base -m venv "$VENV" || exit 1
    else
      echo "❌ Falta Python 3.12. Instala uv (https://docs.astral.sh/uv/: curl -LsSf https://astral.sh/uv/install.sh | sh)"
      echo "   o Python 3.12 (macOS: brew install python@3.12 · Ubuntu: sudo apt install python3.12-venv · Windows: python.org, con el lanzador py)."
      exit 1
    fi
    [ -x "$VENV/Scripts/python.exe" ] && PY="$VENV/Scripts/python.exe"
  fi
  local sello="$VENV/.requisitos.ok"
  if [ ! -f "$sello" ] || ! cmp -s "$AQUI/requisitos.txt" "$sello"; then
    echo "📦 Instalando requisitos (una sola vez)…"
    if command -v uv >/dev/null 2>&1; then
      uv pip install --quiet --python "$PY" -r "$AQUI/requisitos.txt" || exit 1
    else
      "$PY" -m pip install --quiet --upgrade pip && "$PY" -m pip install --quiet -r "$AQUI/requisitos.txt" || exit 1
    fi
    cp "$AQUI/requisitos.txt" "$sello"
  fi
}

# --- Llaves: entorno, luego local/.env o .env de la raíz del repo ------------------------------------------------
leer_llave() {   # leer_llave NOMBRE → valor, sin imprimirlo nunca en pantalla
  local nombre="$1" valor="${!1:-}" f
  if [ -z "$valor" ]; then
    for f in "$AQUI/../local/.env" "$AQUI/../.env"; do
      [ -f "$f" ] || continue
      valor="$(sed -n "s/^${nombre}=//p" "$f" | tail -1 | tr -d '\r' | sed 's/^["'\'']//; s/["'\'']$//')"
      [ -n "$valor" ] && break
    done
  fi
  printf '%s' "$valor"
}

escribir_env_robot() {   # deja solo llaves y URL; conserva la credencial de la vinculación
  local token="" id=""
  if [ -f "$ENV_ROBOT" ] && [ "$DESVINCULAR" = 0 ]; then
    token="$(sed -n 's/^ALE_DEVICE_TOKEN=//p' "$ENV_ROBOT" | tail -1)"
    id="$(sed -n 's/^ALE_DEVICE_ID=//p' "$ENV_ROBOT" | tail -1)"
  fi
  umask 077
  {
    echo "# Lo escribe jolly-sim/start.sh en cada arranque. No lo subas a ningún repo."
    echo "META_API_KEY=$META_API_KEY"
    [ -n "$CARTESIA_API_KEY" ] && echo "CARTESIA_API_KEY=$CARTESIA_API_KEY"
    echo "ALE_RUNTIME_URL=$ALE_RUNTIME_URL"
    echo "ALE_ROBOT_NAME=$ALE_ROBOT_NAME"
    [ -n "$token" ] && echo "ALE_DEVICE_TOKEN=$token"
    [ -n "$id" ] && echo "ALE_DEVICE_ID=$id"
  } > "$ENV_ROBOT.tmp" && mv "$ENV_ROBOT.tmp" "$ENV_ROBOT"
  chmod 600 "$ENV_ROBOT"
}

PIDS=()
limpiar() {
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && wait "$p" 2>/dev/null; done
}
trap limpiar EXIT INT TERM

preparar_python
export PYTHONUTF8=1 PYTHONIOENCODING=utf-8   # la consola de Windows (cp1252) no imprime los emojis de los mensajes
export META_API_KEY="$(leer_llave META_API_KEY)"
export CARTESIA_API_KEY="$(leer_llave CARTESIA_API_KEY)"
export ALE_RUNTIME_URL="${ALE_RUNTIME_URL:-http://localhost:8060}"
export ALE_ROBOT_NAME="${ALE_ROBOT_NAME:-Jolly}"
export ALE_CAMARA="$CAMARA"

case "$MODO" in
  doctor)
    exec "$PY" "$AQUI/doctor.py" ;;

  meta)
    exec "$PY" "$AQUI/meta_check.py" ;;

  sembrar)
    exec "$PY" "$AQUI/sembrar.py" --vincular ;;

  replay)
    "$PY" "$AQUI/doctor.py" --rapido --replay || exit 1
    TRAZA="${JOLLY_TRAZA:-$AQUI/replay/traza-2026-11-02-p2.jsonl}"
    ETIQUETA="$("$PY" "$AQUI/replay/reproducir.py" "$TRAZA" --etiqueta)"
    # La cara vigila internet; en la repetición no hace falta, así que mira el puerto del bus local.
    ALE_RED_DESTINO=127.0.0.1:5560 "$PY" "$AQUI/replay/cara_replay.py" --etiqueta "$ETIQUETA" &
    PIDS+=($!)
    sleep 1.5
    "$PY" "$AQUI/replay/reproducir.py" "$TRAZA" --bucle ;;

  vivo)
    "$PY" "$AQUI/doctor.py" --rapido || { echo "   Más detalle: ./start.sh doctor · Sin backend ni llave: ./start.sh --replay"; exit 1; }
    escribir_env_robot
    # Contra el entorno local, Stock necesita el inventario demo: se siembra solo en cuanto Jolly queda vinculado.
    case "$ALE_RUNTIME_URL" in
      http://localhost*|http://127.0.0.1*)
        "$PY" "$AQUI/sembrar.py" --esperar 1800 &
        PIDS+=($!) ;;
    esac
    export ALE_AVISOS="${ALE_AVISOS:-1}"     # avisos por iniciativa propia; también enciende los eventos (fotos)
    export ALE_EVENTOS=1
    (cd "$ROBOT/cara" && exec "$PY" main.py --bus) &
    PIDS+=($!)
    # Contra la pila local, las fotos se suben a su Storage imitado (nube-local/sitecustomize.py); en la nube, tal cual.
    case "$ALE_RUNTIME_URL" in
      http://localhost*|http://127.0.0.1*)
        PYTHONPATH="$AQUI_NATIVO/nube-local" ALE_CA_CERT="$AQUI_NATIVO/../local/certs/ca.crt" \
          ALE_OJO_PYTHON="$PY" "$ROBOT/ale-robot/bucle_ojo.sh" & ;;
      *) ALE_OJO_PYTHON="$PY" "$ROBOT/ale-robot/bucle_ojo.sh" & ;;
    esac
    PIDS+=($!)
    if [ "$GRABAR" = 1 ]; then
      mkdir -p "$AQUI/grabaciones"
      (cd "$ROBOT/voz-hermes" && exec "$PY" -m cuerpo.grabar "$AQUI/grabaciones/bus-$(date +%Y%m%d-%H%M%S).jsonl" >/dev/null 2>&1) &
      PIDS+=($!)
    fi
    TTS=()
    [ -z "$CARTESIA_API_KEY" ] && TTS=(--tts say)       # sin Cartesia: la voz del sistema (macOS, Windows o espeak en Linux)
    cd "$ROBOT/voz-hermes" && "$PY" voz_hermes.py --robot --cuerpo ${TTS[@]+"${TTS[@]}"} ;;
esac
