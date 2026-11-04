"""Canal robot: Jolly en el robot se empareja con SaleADS y habla con su propia credencial.

Primer arranque (sin ALE_DEVICE_TOKEN):
  1. POST /devices/pairing → código "XXXX-XXXX" (y URL para el QR).
  2. Se muestra en la terminal y se publica en el bus (`robot/emparejamiento`) para la cara.
  3. El dueño lo reclama en SaleADS ("Vincular mi compañero"); aquí se sondea cada 2 s.
  4. Llega la credencial (una sola vez) → se guarda en .env (modo 600) y no se vuelve a pedir.
Después: cada turno va a POST /devices/me/stream con `Authorization: Bearer ale_dev_…` (mismos eventos SSE que
el chat web). Si el dueño desvincula el robot (401), se borra la credencial y se vuelve a emparejar.

Con ALE_EVENTOS=1 corre además un hilo de eventos de Stock: una conexión larga por la misma ruta (`op:events`) que reparte
las órdenes al bus, y con ALE_AVISOS=1 pasa los avisos a avisos.py. Sin esas variables el robot se comporta exactamente
igual que antes. Contrato: cuerpo/CONTRATO.md.
"""
import json, os, socket, threading, time, urllib.error, urllib.request
from pathlib import Path

from cuerpo import bus
from voz_hermes import AleHermes

UA = "Mozilla/5.0 (X11; Linux) ale-robot/1.0"        # Cloudflare bloquea "Python-urllib"
SONDEO_S = 1.5                                       # también es el ritmo de republicado para la cara
RUTA_STREAM = "/devices/me/stream"
LECTURA_S = 45                                       # sin keepalive (15 s) en este tiempo, la conexión está muerta
RECONEXION_S = (1, 2, 5, 10, 30)
ESPERA_OJO_S = 3.0                                   # sin ojo/estado en este tiempo no se confirma: el servidor reentrega


def guardar_env(ruta: Path, valores: dict[str, str | None]):
    """Actualiza (o borra, con None) variables de .env sin tocar las demás; deja el archivo en modo 600."""
    lineas = ruta.read_text().splitlines() if ruta.exists() else []
    lineas = [l for l in lineas if l.split("=", 1)[0] not in valores]
    lineas += [f"{k}={v}" for k, v in valores.items() if v is not None]
    ruta.write_text("\n".join(lineas) + "\n")
    ruta.chmod(0o600)


class AleRobot(AleHermes):
    """Mismo cliente que AleHermes (parser SSE, eventos del bus, reintentos), con la credencial del robot."""

    def __init__(self, base: str, env: Path, nombre: str | None = None, avisos=None, sueno=None):
        super().__init__(base, os.getenv("ALE_DEVICE_TOKEN", ""), None)
        self.env, self.avisos, self.sueno = env, avisos, sueno
        self.nombre = nombre or os.getenv("ALE_ROBOT_NAME") or f"Jolly de {socket.gethostname().split('.')[0]}"[:60]

    def _abrir_sesion(self):
        self.sesion = "robot"                          # la sesión robot-<id> la elige el servidor por la credencial

    def _ruta_stream(self) -> str:
        return "/devices/me/stream"

    def preparar(self):
        if not self.token:
            self.emparejar()
        self.sesion = "robot"
        print("🤝 Jolly listo por el canal robot", flush=True)
        if os.getenv("ALE_EVENTOS") == "1" or self.avisos:
            hilo = HiloEventos(self, self.env.with_name(".eventos-cursor"), avisos=self.avisos)
            if self.sueno:                             # dormir o despertar lo sabe el servidor, sin frenar el hilo del sueño
                hilo.dormido = self.sueno.dormido
                self.sueno.al_cambiar = lambda d: threading.Thread(target=hilo.avisar_estado, args=(d,), daemon=True).start()
            hilo.start()

    def renovar(self) -> bool:
        """401: el dueño desvinculó el robot (o la credencial no sirve). Se borra y se vuelve a emparejar."""
        print("\n🔌 Este robot ya no está vinculado: hay que emparejarlo otra vez", flush=True)
        self.token = ""
        guardar_env(self.env, {"ALE_DEVICE_TOKEN": None, "ALE_DEVICE_ID": None})
        self.emparejar()
        return True

    def _post(self, ruta: str, cuerpo: dict) -> dict:
        req = urllib.request.Request(self.base + ruta, data=json.dumps(cuerpo).encode(), method="POST",
                                     headers={"Content-Type": "application/json", "User-Agent": UA})
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read() or b"{}")

    def emparejar(self):
        """Bloquea hasta que el dueño reclame el código. Si vence, pide otro."""
        while True:
            try:
                p = self._post("/devices/pairing", {"name": self.nombre})
            except Exception as e:
                print(f"⚠️ No pude pedir el código de emparejamiento ({e}); reintento en 5 s", flush=True)
                time.sleep(5)
                continue
            vence = time.monotonic() + max(0, _segundos_hasta(p["expires_at"]))
            print("\n" + "═" * 46, flush=True)
            print(f"  📱 Vincula a tu compañero en SaleADS con el código:\n\n        {p['code']}\n", flush=True)
            if p.get("claim_url"):
                print(f"  o abre: {p['claim_url']}", flush=True)
            print("═" * 46 + "\n", flush=True)
            while time.monotonic() < vence:
                # se republica en cada vuelta: un SUB que conecta tarde (slow-joiner) igual ve el código
                bus.publicar("robot/emparejamiento", estado="mostrando", codigo=p["code"], url=p.get("claim_url"),
                             expira=vence)                       # monotonic de ESTA máquina (la de la cara)
                time.sleep(SONDEO_S)
                try:
                    r = self._post(f"/devices/pairing/{p['pairing_id']}/poll", {"poll_secret": p["poll_secret"]})
                except urllib.error.HTTPError as e:
                    if e.code == 404:
                        break                          # venció o ya se entregó: pedir otro código
                    continue
                except Exception:
                    continue                           # red caída: seguir intentando hasta que venza
                if r.get("status") == "paired":
                    self.token = r["device_token"]
                    guardar_env(self.env, {"ALE_DEVICE_TOKEN": r["device_token"], "ALE_DEVICE_ID": r["device_id"]})
                    bus.publicar("robot/emparejamiento", estado="vinculado", codigo=None, url=None, expira=None)
                    print("✅ ¡Vinculado! Jolly ya es tu compañero.", flush=True)
                    return
            bus.publicar("robot/emparejamiento", estado="vencido", codigo=None, url=None, expira=None)
            print("⌛ El código venció; pido uno nuevo…", flush=True)


def confirmar_ojo(sub, solicitud_id: str, espera_s: float = ESPERA_OJO_S) -> bool:
    """Una orden solo cuenta como recibida cuando `ojo` responde: el bus pierde mensajes si `ojo` está reiniciando."""
    vence = time.monotonic() + espera_s
    while time.monotonic() < vence:
        if any(m.get("solicitud_id") == solicitud_id for m in sub.recibir(espera_ms=200)):
            return True
    return False


class HiloEventos(threading.Thread):
    """Recibe los eventos de Stock. Sigue vivo ante cualquier fallo, nunca toca el hilo de voz ni la credencial.

    - El cursor vive en disco y solo avanza con `event_ack`: un reinicio no pierde lo que no se confirmó.
    - Un evento reentregado conserva su `id`: lo confirmado no se reparte dos veces.
    - 401: no empareja. Eso es del hilo principal; aquí se espera a que aparezca una credencial distinta.
    - Quien recibe la foto es `ojo` (R11: la Pi nunca decide tomar una). Quien recibe `decir` es solo avisos.py, que
      confirma cuando lo dijo: el cursor no pasa de un aviso sin confirmar, o un reinicio lo perdería.
    """

    def __init__(self, robot: "AleRobot", cursor: Path, confirmar=None, sub=None, avisos=None):
        super().__init__(daemon=True, name="eventos-stock")
        self.robot, self.ruta_cursor = robot, cursor
        self.confirmar = confirmar or (lambda solicitud_id: confirmar_ojo(self.sub, solicitud_id))
        self.sub = sub
        self.cursor = self._leer_cursor()
        self.parar = threading.Event()
        self.dormido = False
        self.avisos = avisos
        self.sin_ack: set[int] = set()
        self.con_ack: set[int] = set()
        self.lock = threading.Lock()
        self.lock_estado = threading.Lock()
        if avisos:
            avisos.ack = self.confirmar_aviso

    def _leer_cursor(self) -> int:
        try:
            return max(0, int(self.ruta_cursor.read_text().strip()))
        except (OSError, ValueError):
            return 0

    def _guardar_cursor(self, valor: int):
        if valor <= self.cursor:
            return
        self.cursor = valor
        tmp = self.ruta_cursor.with_suffix(".tmp")
        tmp.write_text(str(valor))
        tmp.replace(self.ruta_cursor)

    def _op(self, cuerpo: dict) -> dict:
        with urllib.request.urlopen(self.robot._req(RUTA_STREAM, cuerpo), timeout=20) as r:
            return json.loads(r.read() or b"{}")

    def _confirmado(self, ident: int):
        """El cursor avanza hasta justo antes del aviso más viejo sin confirmar."""
        with self.lock:
            self.sin_ack.discard(ident)
            self.con_ack.add(ident)
            tope = min(self.sin_ack) - 1 if self.sin_ack else max(self.con_ack)
            listos = {i for i in self.con_ack if i <= tope}
            self.con_ack -= listos
            if listos:
                self._guardar_cursor(max(listos))

    def confirmar_aviso(self, ident: int, estado: str):
        """Desde avisos.py. Si falla, el aviso sigue sin confirmar: al reconectar vuelve, y como ya se dijo no se repite."""
        try:
            self._op({"op": "event_ack", "event_id": ident, "estado": estado})
            self._confirmado(ident)
        except Exception as e:
            print(f"   ⚠️ eventos: aviso sin confirmar ({type(e).__name__})", flush=True)

    def avisar_estado(self, dormido: bool):
        self.dormido = dormido
        try:
            with self.lock_estado:                     # siempre el último: dos cambios seguidos no llegan al revés
                self._op({"op": "state", "device_state": "dormido" if self.dormido else "activo"})
        except Exception as e:
            print(f"   ⚠️ eventos: no pude avisar el estado ({type(e).__name__})", flush=True)

    def _repartir(self, evento: dict):
        """Devuelve el estado para `event_ack`, o None si no se debe confirmar todavía."""
        if evento.get("kind") == "decir":
            if not self.avisos:                        # este robot no habla avisos: que lo lleve Ale por el canal
                return "vencido"
            estado = self.avisos.recibir(evento)
            if estado is None:
                with self.lock:
                    self.sin_ack.add(evento["id"])
            return estado
        if evento.get("kind") != "foto":
            return "descartado"
        p = evento["payload"]
        bus.publicar("ojo/orden", solicitud_id=p["solicitud_id"], concepto=p["concepto"], etiqueta=p["etiqueta"], foto_id=p.get("foto_id"))
        return "recibido" if self.confirmar(p["solicitud_id"]) else None

    def _evento(self, crudo: str):
        evento = json.loads(crudo)
        if evento["id"] <= self.cursor or evento["id"] in self.con_ack:
            return                                     # reentrega de algo ya confirmado
        estado = self._repartir(evento)
        if estado is None:
            return
        self._op({"op": "event_ack", "event_id": evento["id"], "estado": estado})
        self._confirmado(evento["id"])

    def _conexion(self):
        cuerpo = {"op": "events", "after": self.cursor, "device_state": "dormido" if self.dormido else "activo"}
        with urllib.request.urlopen(self.robot._req(RUTA_STREAM, cuerpo), timeout=LECTURA_S) as r:
            self.fallos = 0
            nombre, datos = None, None
            for linea in r:
                if self.parar.is_set():
                    return
                linea = linea.decode("utf-8").rstrip("\r\n")
                if linea.startswith("event:"):
                    nombre = linea[6:].strip()
                elif linea.startswith("data:"):
                    datos = linea[5:].strip()
                elif not linea:
                    if nombre == "stock" and datos:
                        self._evento(datos)
                    nombre, datos = None, None

    def _esperar_token_nuevo(self, viejo: str):
        while not self.parar.is_set() and (not self.robot.token or self.robot.token == viejo):
            self.parar.wait(1.0)

    def run(self):
        if self.sub is None and self.confirmar.__name__ == "<lambda>":
            self.sub = bus.Suscriptor(temas=("ojo/estado",), direccion=bus.DIRECCION_OJO)
        self.fallos = 0
        while not self.parar.is_set():
            token = self.robot.token
            try:
                self._conexion()
            except urllib.error.HTTPError as e:
                if e.code == 401:
                    self._esperar_token_nuevo(token)
                    continue
                print(f"   ⚠️ eventos: el servidor respondió {e.code}", flush=True)
            except Exception as e:                     # red caída o conexión cortada: se reconecta
                print(f"   ⚠️ eventos: conexión perdida ({type(e).__name__})", flush=True)
            self.parar.wait(RECONEXION_S[min(self.fallos, len(RECONEXION_S) - 1)])
            self.fallos += 1


def _segundos_hasta(iso: str) -> float:
    from datetime import datetime, timezone
    return (datetime.fromisoformat(iso.replace("Z", "+00:00")) - datetime.now(timezone.utc)).total_seconds()
