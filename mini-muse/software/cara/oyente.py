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
SIN_LATIDO = 3.0


class Oyente:
    def __init__(self, ctl, registro: str | None = None):
        self.ctl = ctl
        ctx = zmq.Context.instance()
        self.sub = ctx.socket(zmq.SUB)
        self.sub.setsockopt(zmq.LINGER, 0)
        for tema in ("cuerpo/", "voz/volumen", "robot/emparejamiento"):
            self.sub.setsockopt(zmq.SUBSCRIBE, tema.encode())
        self.sub.connect(BUS)
        self.pub = ctx.socket(zmq.PUB)
        self.pub.setsockopt(zmq.LINGER, 0)
        try:
            self.pub.bind(BUS_CARA)
        except zmq.ZMQError:
            self.pub = None
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
            elif tema == "cuerpo/latido":
                self.ultimo_latido = t
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
                self.ctl.gesto_habla(t, pregunta=m.get("pregunta", False))
            else:
                self.ctl.emocion(m.get("emocion", "neutral"), t)
        if self.ultimo_latido is not None and t - self.ultimo_latido > SIN_LATIDO and self.aplicado[0] != "reposo":
            self.ctl.momento("reposo", t)
            self.aplicado = ("reposo", None, None)
        self.ctl.anim.boca_extra, self.ctl.anim.boca_redondez = self.boca.actualizar(t)

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
