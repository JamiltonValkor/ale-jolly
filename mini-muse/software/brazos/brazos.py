"""Brazos v2: complementan a la cara (tabla aprobada por el owner 2026-10-28). Escuchan el mismo bus que la cara
(cuerpo/*, robot/emparejamiento; contrato en voz-hermes/cuerpo/CONTRATO.md) y ejecutan cada gesto a su hora `t`,
con los gestos de gestos.yaml sobre los límites reales de brazos.yaml.

.venv/bin/python brazos.py        (con ./ale.sh, o con la escena simulada: voz-hermes → python -m cuerpo.escena_demo)

Reglas: variantes por peso sin repetir · enfriamiento · "menos es más": nunca dos gestos grandes en < 3 s ·
sin latido del director 3 s → reposo. La mano en la barbilla (y otras poses finales) se sostiene hasta el siguiente gesto.
"""
import json, os, random, sys, time

import gestos as G

BUS = os.environ.get("ALE_BUS", "tcp://127.0.0.1:5560")
SIN_LATIDO = 3.0
GRANDES = {"celebrar_arriba", "celebrar_pechito", "celebrar_vinculo", "estirarse", "saludo_corto"}
SEPARACION_GRANDES = 3.0
ENFRIAMIENTO = {"asentir_mano": 2.5, "gesticular_abrir": 1.2, "gesticular_enfasis": 1.2, "gesticular_dos": 1.2,
                "saludo_si": 1.5, "balanceo": 20.0}
VIDA_REPOSO = (25.0, 50.0)               # cada cuánto un balanceo leve en reposo


class Cuerpo:
    """Decide QUÉ gesto de brazos acompaña a cada evento. `reproducir(nombre)` es inyectable (pruebas)."""

    def __init__(self, catalogo: dict, reproducir, semilla: int | None = None):
        self.cat = catalogo
        self.reproducir = reproducir
        self.rnd = random.Random(semilla)
        self.momento, self.pista = "reposo", None
        self.ultimo: dict[str, float] = {}
        self.ultimo_grande = -1e9
        self.previo_gesto = None
        self.prox_vida = 0.0
        self.lanzados: list[tuple[float, str]] = []         # registro (pruebas)

    def _elegir(self, clave: str) -> str | None:
        lista = self.cat["complementos"].get(clave, [])
        libres = [n for n in lista if n != self.previo_gesto] or lista
        return self.rnd.choice(libres) if libres else None

    def _lanzar(self, clave: str, t: float, forzar: bool = False) -> str | None:
        n = self._elegir(clave)
        if not n:
            return None
        if not forzar:
            if t - self.ultimo.get(n, -1e9) < ENFRIAMIENTO.get(n, 0):
                return None
            if n in GRANDES and t - self.ultimo_grande < SEPARACION_GRANDES:
                return None
        self.ultimo[n] = t
        if n in GRANDES:
            self.ultimo_grande = t
        self.previo_gesto = n
        self.lanzados.append((t, n))
        self.reproducir(n)
        return n

    # ---------- eventos del bus ----------
    def momento_nuevo(self, m: dict, t: float):
        nuevo, pista, previo = m.get("momento", "reposo"), m.get("pista"), self.momento
        if (nuevo, pista) == (self.momento, self.pista):
            return
        self.momento, self.pista = nuevo, pista
        if nuevo == "escucha" and pista == "brillo_nombre":
            self._lanzar("nombre_desde_reposo" if previo == "reposo" else "nombre_en_conversacion", t, forzar=True)
        elif nuevo == "escucha":
            self._lanzar("escucha", t, forzar=True)
        elif nuevo == "pensando":
            self._lanzar("pensando", t, forzar=True)
        elif nuevo == "pensando_largo":
            self._lanzar("pensando_largo", t, forzar=True)
        elif nuevo == "trabajando":
            self._lanzar("trabajando_tecleando" if pista == "tecleando" else "trabajando_leyendo", t, forzar=True)
        elif nuevo == "problema":
            self._lanzar("problema", t, forzar=True)
        elif nuevo == "reposo":
            self._lanzar("reposo", t, forzar=True)
            self.prox_vida = t + self.rnd.uniform(*VIDA_REPOSO)
        # hablando: los brazos esperan la primera frase (cuerpo/gesto) para no adelantarse a la voz

    def emocion(self, m: dict, t: float):
        e = m.get("emocion")
        if e in ("orgullosa", "feliz", "preocupada", "confundida"):
            self._lanzar({"confundida": "problema"}.get(e, e), t)

    def gesto_frase(self, m: dict, t: float):
        if self.momento == "hablando" or self.momento == "escucha":
            self._lanzar("frase_pregunta" if m.get("pregunta") else "frase", t)

    def emparejamiento(self, m: dict, t: float):
        """Celebra como la cara: solo al pasar a vinculado desde mostrando/vencido (CONTRATO robot/emparejamiento)."""
        estado, previo = m.get("estado"), getattr(self, "emparejo", None)
        self.emparejo = estado
        if estado == "vinculado" and previo in ("mostrando", "vencido"):
            self._lanzar("vinculado", t, forzar=True)

    def micro_gesto(self, nombre: str, t: float):
        if nombre == "bostecito":
            self._lanzar("bostecito", t)

    def tic(self, t: float):
        if self.momento == "reposo" and self.prox_vida and t >= self.prox_vida:
            self._lanzar("reposo_vida", t)
            self.prox_vida = t + self.rnd.uniform(*VIDA_REPOSO)


def main():
    import zmq
    import arduino
    try:
        b = arduino.Brazos(sys.argv[1] if len(sys.argv) > 1 else None)
    except arduino.PuertoOcupado as e:
        sys.exit(f"🦾 {e}")
    cat = G.cargar()
    rep = G.Reproductor(b)
    c = Cuerpo(cat, lambda n: (rep.reproducir(cat["gestos"][n], nombre=n), print(f"   🦾 {n}", flush=True)))
    print(f"🦾 {b.version} en {b.puerto} · escuchando el bus {BUS}", flush=True)
    if b.sin_limites:
        print(f"   ⚠️ brazos sin calibrar (no se moverán por gestos): {', '.join(b.sin_limites)}", flush=True)
    sub = zmq.Context.instance().socket(zmq.SUB)
    sub.setsockopt(zmq.LINGER, 0)
    for tema in (b"cuerpo/", b"robot/emparejamiento"):
        sub.setsockopt(zmq.SUBSCRIBE, tema)
    sub.connect(BUS)
    agenda, latido = [], None
    try:
        while True:
            if sub.poll(20):
                while True:
                    try:
                        tema, cuerpo = sub.recv_multipart(flags=zmq.NOBLOCK)
                    except zmq.Again:
                        break
                    m = json.loads(cuerpo); tema = tema.decode()
                    latido = time.monotonic()
                    if tema != "cuerpo/latido":
                        agenda.append((m.get("t", latido), tema, m))
            ahora = time.monotonic()
            agenda.sort(key=lambda x: x[0])
            while agenda and agenda[0][0] <= ahora:
                _, tema, m = agenda.pop(0)
                if tema == "cuerpo/momento":
                    c.momento_nuevo(m, ahora)
                elif tema == "cuerpo/emocion":
                    c.emocion(m, ahora)
                elif tema == "cuerpo/gesto":
                    c.gesto_frase(m, ahora)
                elif tema.startswith("robot/emparejamiento"):
                    c.emparejamiento(m, ahora)
            if latido and ahora - latido > SIN_LATIDO and c.momento != "reposo":
                c.momento_nuevo({"momento": "reposo"}, ahora); latido = None
            c.tic(ahora)
    except KeyboardInterrupt:
        pass
    finally:
        rep.detener(); b.cerrar(); print("👋 brazos abajo", flush=True)


if __name__ == "__main__":
    main()
