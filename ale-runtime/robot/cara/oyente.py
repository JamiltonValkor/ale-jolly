"""La cara obedece al director por el bus (CV-013). Implementa el contrato de voz-hermes/cuerpo/CONTRATO.md con su
propio SUB (no importa código de voz-hermes).

- Vacía el bus en cada cuadro del hilo principal (macOS exige la ventana en el hilo principal) y agenda cada orden a
  su hora `t`.
- Republicaciones de cuerpo/momento (cada 1 s) no re-sortean la variante: solo se aplica si cambió momento/pista.
- Sin cuerpo/latido por 3 s → reposo (el director murió o se cerró la voz).
- Publica cara/estado a 10 Hz en tcp://127.0.0.1:5561 y escribe un registro de cuadros (para las pruebas CV-011).
"""
import json, os, time

import zmq

from boca import Boca

BUS = os.environ.get("ALE_BUS", "tcp://127.0.0.1:5560")
BUS_CARA = os.environ.get("ALE_BUS_CARA", "tcp://127.0.0.1:5561")
BUS_OJO = os.environ.get("ALE_BUS_OJO", "tcp://127.0.0.1:5562")
SIN_LATIDO = 3.0


class Oyente:
    def __init__(self, ctl, registro: str | None = None):
        self.ctl = ctl
        ctx = zmq.Context.instance()
        self.sub = ctx.socket(zmq.SUB)
        self.sub.setsockopt(zmq.LINGER, 0)
        for tema in ("cuerpo/", "voz/volumen", "robot/emparejamiento", "ojo/conteo"):
            self.sub.setsockopt(zmq.SUBSCRIBE, tema.encode())
        self.sub.connect(BUS)
        self.sub.connect(BUS_OJO)             # sin `ojo` corriendo no llega nada y la cara sigue igual
        self.pub = ctx.socket(zmq.PUB)
        self.pub.setsockopt(zmq.LINGER, 0)
        try:
            self.pub.bind(BUS_CARA)
        except zmq.ZMQError:
            print(f"   ⚠️ cara: no pude abrir {BUS_CARA}; los brazos no recibirán los gestos de reposo", flush=True)
            self.pub = None
        ctl.al_micro = self._micro
        ctl.al_sueno = self._sueno
        ctl.al_reaccion = self._reaccion
        self.agenda: list[tuple[float, str, dict]] = []
        self.boca = Boca()
        self.ultimo_latido = None
        self.aplicado = (None, None, None)    # (momento, pista, herramienta) vigente
        self.t_estado = 0.0
        self.seq = 0
        self.registro = open(registro, "a", encoding="utf-8") if registro else None

    def atender(self, t: float):
        while True:
            try:
                tema, cuerpo = self.sub.recv_multipart(flags=zmq.NOBLOCK)
            except zmq.Again:
                break
            try:
                m = json.loads(cuerpo)
            except ValueError:
                continue
            tema = tema.decode()
            if tema == "voz/volumen":
                self.boca.agregar(m["t0"], m["dt"], m["niveles"])
            elif tema == "robot/emparejamiento":
                self.ctl.emparejamiento(m, t)
            elif tema == "ojo/conteo":
                self.ctl.conteo.actualizar(m)
            elif tema == "cuerpo/latido":
                self.ultimo_latido = t
                self.ctl.voz_lista(t)
            elif tema == "cuerpo/sueno":
                self.ctl.orden_sueno(m.get("orden"), t)
            elif tema in ("cuerpo/momento", "cuerpo/emocion", "cuerpo/gesto"):
                self.ultimo_latido = t
                self.agenda.append((m.get("t", t), tema, m))
        self.agenda.sort(key=lambda x: x[0])
        while self.agenda and self.agenda[0][0] <= t:
            tm, tema, m = self.agenda.pop(0)
            if tema == "cuerpo/momento":
                clave = (m.get("momento"), m.get("pista"), m.get("herramienta"))
                if clave != self.aplicado:
                    self.ctl.momento(m.get("momento", "reposo"), t, pista=m.get("pista"), herramienta=m.get("herramienta"))
                    self.aplicado = clave
            elif tema == "cuerpo/gesto":
                self.ctl.gesto_habla(t, pregunta=m.get("pregunta", False), intencion=m.get("intencion"))
            else:
                self.ctl.emocion(m.get("emocion", "neutral"), t, m.get("intensidad"))
        if self.ultimo_latido is not None and t - self.ultimo_latido > SIN_LATIDO and self.aplicado[0] != "reposo":
            self.ctl.momento("reposo", t)
            self.aplicado = ("reposo", None, None)
        self.ctl.anim.boca_extra, self.ctl.anim.boca_redondez = self.boca.actualizar(t)

    def _publicar(self, tema: str, t: float, **datos):
        if self.pub is None:
            return
        self.seq += 1
        msg = {"tema": tema, "t": t, "t_pub": time.monotonic(), "seq": self.seq, **datos}
        try:
            self.pub.send_multipart([tema.encode(), json.dumps(msg).encode()], flags=zmq.NOBLOCK)
        except zmq.ZMQError:
            pass

    def _micro(self, nombre: str, t: float):
        """Aviso de que la cara empieza un gesto de reposo (cara/micro): los brazos lo acompañan."""
        self._publicar("cara/micro", t, nombre=nombre)

    def _reaccion(self, nombre: str, emocion: str | None, intensidad: float | None, dur: float, protagonista: str, t: float):
        """cara/reaccion: evento único; `t` es la hora en que se VE, unos 150 ms en el futuro."""
        self._publicar("cara/reaccion", t, nombre=nombre, emocion=emocion, intensidad=intensidad, dur=dur,
                       protagonista=protagonista)

    def _sueno(self, estado: str, dur: float, t: float):
        """cara/sueno: empezó o terminó una animación del modo dormir; `dur` es lo que tarda en terminar."""
        self._publicar("cara/sueno", t, estado=estado, dur=dur)

    def toque(self, accion: str, origen: str, t: float):
        """cara/toque: el dueño pidió dormir o despertar. La voz decide y responde con cuerpo/sueno."""
        self._publicar("cara/toque", t, accion=accion, origen=origen)

    def publicar_estado(self, t: float, cara: dict):
        est = {**self.ctl.estado(), "boca": round(cara["boca.apertura"], 3), "t_cuadro": t}
        if self.registro:
            self.registro.write(json.dumps(est) + "\n")
        if self.pub is not None and t - self.t_estado >= 0.1:
            self.t_estado, self.seq = t, self.seq + 1
            msg = {"tema": "cara/estado", "t": t, "t_pub": time.monotonic(), "seq": self.seq, **est}
            try:
                self.pub.send_multipart([b"cara/estado", json.dumps(msg).encode()], flags=zmq.NOBLOCK)
            except zmq.ZMQError:
                pass
