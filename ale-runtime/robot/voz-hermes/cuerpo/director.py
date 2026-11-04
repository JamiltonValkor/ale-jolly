"""Director del cuerpo de Ale (CV-009/010): convierte los eventos crudos (oído, Ale, voz) en momentos y emociones con
hora, según las reglas de negocio de la etapa 1. Vive en el proceso de voz y recibe los eventos por memoria.

Reglas (cada una tiene su prueba en pruebas_director.py):
- nombre_detectado → escucha (brillo_nombre) al instante; nombre_cancelado → vuelve al momento anterior.
- habla_inicio con la conversación abierta → escucha.
- pregunta → pensando; sin respuesta a los 3,5 s (o relleno de espera) → pensando_largo.
- herramienta_inicio → trabajando (leyendo/tecleando según la herramienta); al cerrar todas → pensando.
- comentario mientras trabaja → hablando un momento y vuelve a trabajando si sigue la herramienta.
- voz/turno_inicio → hablando a la hora en que suena; voz/frase → emoción de esa frase a su hora.
- voz/turno_fin → escucha si la ventana sigue abierta, si no reposo; al vencer la ventana → reposo.
- error → problema (confundida, nunca triste) 2,5 s y luego escucha/reposo.
- eventos de Ale de otro turno se ignoran; cada 1 s: cuerpo/latido + republicar el momento (slow-joiner).
"""
import json
import os
import queue, threading, time

from cuerpo import bus
from cuerpo.emociones import Emociones, intencion

PENSANDO_LARGO_S = 3.5
PROBLEMA_S = 2.5
COMENTARIO_S = 2.5
VENTANA_GRACIA_S = 1.2
REPITE_EMOCION_S = 4.0


def variante_herramienta(nombre: str) -> str:
    n = (nombre or "").lower()
    return "tecleando" if any(k in n for k in ("update", "create", "set_", "submit", "approve", "pause", "request")) else "leyendo"


class Director:
    def __init__(self, publicar=bus.publicar, reloj=time.monotonic):
        self.publicar, self.reloj = publicar, reloj
        self.momento, self.pista, self.emocion = "reposo", None, "neutral"
        self.t_emocion = -1e9
        self.t_momento = 0.0
        self.previo = ("reposo", None)
        self.turno = None
        self.ventana_hasta = 0.0
        self.herramientas: set[str] = set()
        self.herramienta: str | None = None             # la última abierta (la cara muestra su ícono)
        self.t_pregunta = None
        self.respondiendo = False
        self.hubo_texto = False                          # Ale ya mandó texto: la voz viene en camino
        self.t_volver: tuple[float, str] | None = None     # (hora, motivo) de un regreso programado
        self.emo = Emociones()

    # ---------- salida ----------
    def _ir(self, momento: str, t: float, pista: str | None = None):
        if (momento, pista) == (self.momento, self.pista):
            return
        if momento == "escucha" and pista == "brillo_nombre":
            self.previo = (self.momento, self.pista)
        self.momento, self.pista, self.t_momento = momento, pista, t
        if momento != "hablando":
            self.emocion = "neutral"
        self.publicar("cuerpo/momento", t=t, momento=momento, pista=pista, turno=self.turno,
                      herramienta=self.herramienta if momento == "trabajando" else None)

    def _reposo_o_escucha(self, t: float):
        self._ir("escucha" if self.ventana_hasta > t else "reposo", t)

    # ---------- entrada ----------
    def evento(self, m: dict):
        tema, tipo, t = m.get("tema"), m.get("tipo"), m.get("t", self.reloj())
        if tema == "oido/evento":
            if tipo == "nombre_detectado" and self.momento in ("reposo", "escucha"):
                self._ir("escucha", t, "brillo_nombre")
            elif tipo == "nombre_cancelado" and self.momento == "escucha" and self.pista == "brillo_nombre":
                self._ir(self.previo[0], t, self.previo[1])
            elif tipo == "habla_inicio" and self.momento == "reposo" and self.ventana_hasta > t:
                self._ir("escucha", t)
            elif tipo == "ventana":
                self.ventana_hasta = m.get("abierta_hasta", 0.0)
                if self.momento == "reposo" and self.ventana_hasta > t and not self.respondiendo:
                    self._ir("escucha", t)
            elif tipo == "aceptada":
                self.turno = m.get("turno") or self.turno
        elif tema == "ale/evento":
            if tipo == "pregunta":
                self.turno = m.get("turno") or self.turno
                self.herramientas.clear()
                self.t_pregunta, self.respondiendo, self.t_volver, self.hubo_texto = t, False, None, False
                self._ir("pensando", t)
                return
            if m.get("turno") and self.turno and m.get("turno") != self.turno:
                return                                             # evento viejo de otro turno
            if tipo == "relleno" and m.get("clase") == "espera" and self.momento == "pensando":
                self._ir("pensando_largo", t)
            elif tipo == "herramienta_inicio":
                self.herramientas.add(m.get("nombre", ""))
                self.herramienta = m.get("nombre", "")
                self._ir("trabajando", t, variante_herramienta(m.get("nombre", "")))
            elif tipo == "herramienta_fin":
                self.herramientas.discard(m.get("nombre", ""))
                if not self.herramientas and self.momento == "trabajando":
                    self._ir("pensando", t)
            elif tipo == "comentario" and self.momento == "trabajando":
                self._ir("hablando", t)
                self.t_volver = (t + COMENTARIO_S, "comentario")
            elif tipo == "primer_token":
                self.t_pregunta, self.hubo_texto = None, True
            elif tipo == "error":
                self.t_pregunta = None
                self._ir("problema", t)
                self.t_volver = (t + PROBLEMA_S, "problema")
            elif tipo == "fin" and not self.respondiendo and not self.hubo_texto \
                    and self.momento in ("pensando", "pensando_largo", "trabajando"):
                self.t_pregunta = None
                self._reposo_o_escucha(t)                          # terminó sin respuesta hablada
        elif tema == "voz/turno_inicio":
            self.respondiendo, self.t_pregunta, self.t_volver = True, None, None
            self._ir("hablando", t)
        elif tema == "voz/frase" and not m.get("es_relleno"):
            emo, inten = self.emo.frase(m.get("texto", ""))
            if self.momento != "hablando":
                self._ir("hablando", t)
            self.publicar("cuerpo/gesto", t=t, pregunta=m.get("texto", "").rstrip().endswith("?"), turno=self.turno,
                          intencion=intencion(m.get("texto", "")))
            if emo != self.emocion or (emo != "neutral" and t - self.t_emocion >= REPITE_EMOCION_S):
                self.emocion, self.t_emocion = emo, t
                self.publicar("cuerpo/emocion", t=t, emocion=emo, intensidad=inten, texto=m.get("texto", "")[:80],
                              turno=self.turno)
        elif tema == "voz/turno_fin":
            self.respondiendo = False
            self.emo = Emociones()
            # la ventana se publica justo después del fin del audio: escucha ya, y si no llega ventana → reposo
            self._ir("escucha", t)
            if self.ventana_hasta <= t:
                self.t_volver = (t + VENTANA_GRACIA_S, "sin_ventana")

    def tic(self, t: float):
        habla = os.path.exists("/tmp/jolly-cara") and os.path.exists("/tmp/jolly-hablando")   # rodaje: arranque exacto de la frase
        if habla and not getattr(self, "_rodaje_habla", False):
            self._rodaje_habla = True
            self.publicar("cuerpo/momento", t=t, momento="hablando", pista="furia", turno=self.turno, herramienta=None)
            try:
                n = json.load(open("/tmp/jolly-niveles.json"))
                self.publicar("voz/volumen", t=t, t0=t + float(n.get("retardo", 0.15)), dt=n["dt"], niveles=n["niveles"])
            except (OSError, ValueError, KeyError):
                pass
        elif not habla and getattr(self, "_rodaje_habla", False):
            self._rodaje_habla = False
        """Temporizadores: pensando largo, regresos programados y fin de la ventana."""
        if self.t_pregunta is not None and self.momento == "pensando" and t - self.t_pregunta >= PENSANDO_LARGO_S:
            self._ir("pensando_largo", t)
        if self.t_volver and t >= self.t_volver[0]:
            motivo, self.t_volver = self.t_volver[1], None
            if motivo == "comentario" and self.herramientas:
                self._ir("trabajando", t, self.pista if self.pista in ("leyendo", "tecleando") else "leyendo")
            elif motivo == "problema" and self.momento == "problema":
                self._reposo_o_escucha(t)
            elif motivo == "sin_ventana" and self.momento == "escucha" and self.ventana_hasta <= t:
                self._ir("reposo", t)
        if self.momento == "escucha" and self.pista != "brillo_nombre" and not self.respondiendo \
                and self.t_pregunta is None and 0 < self.ventana_hasta < t:
            self._ir("reposo", t)

    def latido(self, t: float):
        if os.path.exists("/tmp/jolly-cara"):   # rodaje: cara fija despierta con la emoción del archivo, aunque la voz duerma
            emo = open("/tmp/jolly-cara").read().strip() or "neutral"
            self.publicar("cuerpo/momento", t=t, momento="hablando" if os.path.exists("/tmp/jolly-hablando") else "reposo", pista="furia" if os.path.exists("/tmp/jolly-hablando") else None, turno=self.turno, herramienta=None)
            self.publicar("cuerpo/emocion", t=t, emocion=emo, intensidad=1.0, texto="")
            return
        if os.path.exists("/tmp/jolly-tecleando"):   # rodaje: con este archivo la cara queda trabajando/tecleando en bucle
            self.publicar("cuerpo/latido", t=t, momento="trabajando", emocion=self.emocion)
            self.publicar("cuerpo/momento", t=t, momento="trabajando", pista="tecleando", turno=self.turno, herramienta="saleads_create_landing")
            return
        self.publicar("cuerpo/latido", t=t, momento=self.momento, emocion=self.emocion)
        # nunca adelantar un cambio programado a futuro (p. ej. hablando a la hora en que suena)
        self.publicar("cuerpo/momento", t=max(t, self.t_momento), momento=self.momento, pista=self.pista, turno=self.turno,
                      herramienta=self.herramienta if self.momento == "trabajando" else None)


def arrancar(listo: threading.Event | None = None) -> Director:
    """Lanza el director en un hilo del proceso de voz (escucha la cola local del bus). Con `listo`, el latido espera:
    el primero saca a la cara de la pantalla de carga, y antes debe saber si toca vincular o sigue dormida."""
    d = Director()
    q = bus.escuchar_local()

    def bucle():
        prox_latido = 0.0
        while True:
            try:
                m = q.get(timeout=0.05)
                if not m["tema"].startswith(("cuerpo/", "_")):
                    d.evento(m)
            except queue.Empty:
                pass
            ahora = time.monotonic()
            d.tic(ahora)
            if (listo is None or listo.is_set()) and ahora >= prox_latido:
                d.latido(ahora); prox_latido = ahora + 1.0

    threading.Thread(target=bucle, daemon=True, name="director").start()
    return d
