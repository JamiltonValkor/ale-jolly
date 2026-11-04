"""Avisos: Jolly habla por iniciativa propia sin pisar a nadie. Contrato: cuerpo/CONTRATO.md.

Con ALE_AVISOS=1, `canal_robot.HiloEventos` reparte aquí los eventos `decir`, y un hilo los dice cuando hay hueco:

  candado libre, y 1,5 s desde que se soltó (recibir() no drena eventos mientras dura entregar)
  y el locutor callado, y el dueño callado, y sin parcial en los últimos 1,5 s, y despierto.

Los topes, el horario y el vencimiento los decide el servidor; aquí solo se respeta `vence_s`. Un aviso se marca dicho en
disco antes de sonar: si el proceso cae a mitad, el reinicio lo confirma sin repetirlo.
"""
import json, threading, time
from pathlib import Path

from cuerpo import bus

GRACIA_S = 1.5            # tras soltar el candado
SIN_PARCIAL_S = 1.5
DUENO_VENCE_S = 10.0      # un speechEnd perdido no traba los avisos
VENTANA_S = 20.0
VENCE_POR_DEFECTO_S = 6 * 3600
MAX_DICHOS = 200
PERDON = "Perdona, no te escuché. "


class CandadoTurno:
    """Un solo turno de voz a la vez, sea de `entregar` o de un aviso. Se suelta con la hora, para la gracia."""

    def __init__(self, reloj=time.monotonic):
        self.reloj, self._lock, self.liberado = reloj, threading.Lock(), float("-inf")

    def tomar(self, bloquear: bool = True) -> bool:
        return self._lock.acquire(blocking=bloquear)

    def soltar(self, hablo: bool = True):
        if hablo:
            self.liberado = self.reloj()
        self._lock.release()

    def libre(self) -> bool:
        return not self._lock.locked()


class Conversacion:
    """Lo que debe sobrevivir a una reconexión de Muse. Sin ALE_AVISOS, voz_hermes crea uno por sesión, como antes."""

    def __init__(self, reloj=time.monotonic):
        self.reloj = reloj
        self.abierta_hasta = 0.0
        self.dueno_hablando = False
        self.dueno_visto = float("-inf")
        self.ultimo_parcial = float("-inf")
        self.eco_exento_hasta = 0.0

    def sesion_nueva(self):
        """Sesión nueva de Muse: el speechEnd de la anterior ya no va a llegar."""
        self.dueno_hablando = False

    def habla_inicio(self):
        self.dueno_hablando, self.dueno_visto = True, self.reloj()

    def parcial(self):
        self.ultimo_parcial = self.dueno_visto = self.reloj()

    def habla_fin(self):
        self.dueno_hablando, self.ultimo_parcial = False, self.reloj()

    def dueno_activo(self) -> bool:
        ahora = self.reloj()
        return (self.dueno_hablando and ahora - self.dueno_visto < DUENO_VENCE_S) or ahora - self.ultimo_parcial < SIN_PARCIAL_S

    def exentar_eco(self, hasta: float):
        self.eco_exento_hasta = hasta

    def tomar_exencion_eco(self) -> bool:
        """Solo la primera frase tras una pregunta se salva de es_eco: «llegaron 22» repite lo que Jolly preguntó."""
        exenta, self.eco_exento_hasta = self.reloj() < self.eco_exento_hasta, 0.0
        return exenta


class Avisos(threading.Thread):
    def __init__(self, locutor, candado: CandadoTurno, conv: Conversacion, ruta_dichos: Path, sueno=None, ack=None,
                 ventana: float = VENTANA_S, reloj=time.monotonic):
        super().__init__(daemon=True, name="avisos")
        self.loc, self.candado, self.conv, self.ruta_dichos, self.sueno = locutor, candado, conv, ruta_dichos, sueno
        self.ack, self.ventana, self.reloj = ack or (lambda _id, _estado: None), ventana, reloj
        self.cola: list[dict] = []
        self.lock = threading.Lock()
        self.dichos = self._leer_dichos()
        self.ultima: dict | None = None
        self.ultima_hasta = 0.0        # hasta cuándo se espera respuesta a la última pregunta
        self.parar = threading.Event()

    # ---- persistencia --------------------------------------------------------------------------------------------
    def _leer_dichos(self) -> list[int]:
        try:
            return [int(i) for i in json.loads(self.ruta_dichos.read_text())]
        except (OSError, ValueError, TypeError):
            return []

    def _marcar_dicho(self, ident: int):
        self.dichos = (self.dichos + [ident])[-MAX_DICHOS:]
        tmp = self.ruta_dichos.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.dichos))
        tmp.replace(self.ruta_dichos)

    # ---- entrada -------------------------------------------------------------------------------------------------
    def recibir(self, evento: dict):
        """Del hilo de eventos. Devuelve el estado para confirmar ya, o None si la confirmación viene después."""
        ident, p = evento["id"], evento["payload"]
        if ident in self.dichos:
            return "hecho"
        with self.lock:
            if not any(a["id"] == ident for a in self.cola):
                self.cola.append({"id": ident, "texto": p["texto"], "pregunta": bool(p.get("pregunta")), "alta": p.get("prioridad") == "alta",
                                  "vence": self.reloj() + float(p.get("vence_s", VENCE_POR_DEFECTO_S)), "reiterado": False})
        return None

    def frase_ignorada(self):
        """El dueño respondió encima de la pregunta y `ocupado` la tiró: se registra `ignorada` y se reitera una vez."""
        with self.lock:
            u = self.ultima
            if u and u["pregunta"] and not u["reiterado"] and self.reloj() < self.ultima_hasta:
                u["reiterado"] = True
                self.cola.insert(0, {**u, "texto": PERDON + u["texto"], "reiteracion": True})

    # ---- decisión ------------------------------------------------------------------------------------------------
    def puede_hablar(self) -> bool:
        return self.candado.libre() and self.reloj() - self.candado.liberado >= GRACIA_S and self.silencio()

    def silencio(self) -> bool:
        return not self.loc.ocupado() and not self.conv.dueno_activo() and not (self.sueno and self.sueno.dormido)

    def _siguiente(self) -> dict | None:
        with self.lock:
            esperando = self.reloj() < self.ultima_hasta
            lista = [a for a in self.cola if a.get("reiteracion") or not esperando]   # no se pisa la pregunta anterior
            if not lista:
                return None
            a = next((x for x in lista if x.get("reiteracion")), None) or min(lista, key=lambda x: (not x["alta"], x["id"]))
            self.cola.remove(a)
            return a

    def _purgar_vencidos(self):
        ahora = self.reloj()
        with self.lock:
            vencidos = [a for a in self.cola if ahora >= a["vence"]]
            self.cola = [a for a in self.cola if a not in vencidos]
        for a in vencidos:
            if not a.get("reiteracion"):
                self.ack(a["id"], "vencido")

    def paso(self) -> bool:
        """Una vuelta del hilo. Devuelve True si habló."""
        self._purgar_vencidos()
        if not self.cola or not self.puede_hablar() or not self.candado.tomar(False):
            return False
        a, hablo = None, False
        try:
            if self.silencio():                        # entre mirar y tomar el candado el dueño pudo empezar a hablar
                a = self._siguiente()
            if a:
                hablo = True
                self._hablar(a)
        except Exception as e:
            print(f"   ⚠️ aviso sin decir: {type(e).__name__}", flush=True)
            hablo = False
            if a and not a.get("reiteracion"):
                self.ack(a["id"], "vencido")
            a = None
        finally:
            self.candado.soltar(hablo=hablo)
        if a and not a.get("reiteracion"):
            self.ack(a["id"], "hecho")
        return hablo

    def _hablar(self, a: dict):
        from voz_salida import Fragmentador
        turno = f"aviso-{a['id']}"
        if not a.get("reiteracion"):
            self._marcar_dicho(a["id"])
        with self.lock:
            self.ultima, self.ultima_hasta = (a if not a.get("reiteracion") else self.ultima), float("inf")
        bus.publicar("ale/evento", tipo="aviso", id=a["id"], texto=a["texto"], pregunta=a["pregunta"], turno=turno)
        self.loc.turno = turno
        self.loc.t_primer_audio = None
        frag = Fragmentador(self.loc)
        frag.token(a["texto"])
        frag.cerrar()
        if hasattr(self.loc, "fin_turno"):
            self.loc.fin_turno()
        self.loc.esperar()
        hasta = self.reloj() + self.ventana
        self.ultima_hasta = hasta if a["pregunta"] else 0.0
        if a["pregunta"]:
            self.conv.exentar_eco(hasta)
        if self.ventana > 0:
            self.conv.abierta_hasta = hasta
            bus.publicar("oido/evento", tipo="ventana", abierta_hasta=hasta, turno=turno)

    def run(self):
        while not self.parar.is_set():
            try:
                self.paso()
            except Exception as e:                     # un aviso nunca tumba la voz
                print(f"   ⚠️ avisos: {type(e).__name__}", flush=True)
            self.parar.wait(0.1)
