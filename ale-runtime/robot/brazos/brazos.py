"""Brazos: siguen a la cara, también en reposo (decisiones S1/S2 del owner, tabla aprobada 2026-10-30).
Escuchan el mismo bus que la cara (cuerpo/*, robot/emparejamiento en :5560) y sus gestos de reposo (cara/micro en
:5561; contrato en voz-hermes/cuerpo/CONTRATO.md). Cada gesto sale a su hora `t`, sobre los límites de brazos.yaml.

.venv/bin/python brazos.py        (lo lanzan ale_mac.sh y arrancar.sh)
ALE_BRAZOS_REGISTRO=ruta.jsonl    registra órdenes, gestos y respuestas del Arduino (medir sincronía)

Prioridades: 5 emparejamiento · 4 problema · 3 nombre · 2 momentos y emociones · 1 frase · 0 reposo. Un gesto solo
corta a uno de nivel igual o menor. Eventos sin nivel se descartan (tarde se ve peor); un momento es un estado y nunca
se pierde: queda pendiente hasta que termine el gesto en curso. La pose final se sostiene hasta el siguiente gesto.
Sin latido del director 3 s → reposo.
"""
import json, math, os, random, signal, sys, time

import gestos as G

BUS = os.environ.get("ALE_BUS", "tcp://127.0.0.1:5560")
BUS_CARA = os.environ.get("ALE_BUS_CARA", "tcp://127.0.0.1:5561")
TEMAS = (b"cuerpo/", b"robot/emparejamiento", b"cara/micro")
SIN_LATIDO = 3.0
MICRO_VIEJO = 0.5                        # un gesto de reposo que llega tarde no se hace
GRANDES = {"celebrar_arriba", "celebrar_pechito", "celebrar_olas", "celebrar_vinculo", "vinculo_saludo", "estirarse",
           "saludo_corto", "saludo_doble", "saludo_alto"}
SEPARACION_GRANDES = 3.0
ENFRIAMIENTO = {"saludo_si": 1.5, "si_dos": 1.5, "hola_mano": 1.5}
ENFRIAMIENTO_GRUPO = {"orgullosa": 15.0, "feliz": 2.5}   # emociones seguidas de una misma respuesta no repiten festejo
RECIENTES = 2                            # un gesto no vuelve a salir hasta que pasen 2 de su grupo
NIVEL_EMPAREJAMIENTO, NIVEL_PROBLEMA, NIVEL_NOMBRE, NIVEL_ALE, NIVEL_FRASE, NIVEL_REPOSO = 5, 4, 3, 2, 1, 0
EMOCIONES = {"orgullosa": ("orgullosa", NIVEL_ALE), "feliz": ("feliz", NIVEL_ALE), "preocupada": ("preocupada", NIVEL_ALE),
             "confundida": ("problema", NIVEL_PROBLEMA)}


class Cuerpo:
    """Decide QUÉ gesto de brazos acompaña a cada evento. `reproducir` y `detener` son inyectables (pruebas)."""

    def __init__(self, catalogo: dict, reproducir, semilla: int | None = None, detener=lambda: None):
        self.cat = catalogo
        self.reproducir, self._detener = reproducir, detener
        self.rnd = random.Random(semilla)
        self.momento, self.pista = "reposo", None
        self.ultimo: dict[str, float] = {}
        self.ultimo_grande = -1e9
        self.recientes: dict[str, list[str]] = {}
        self.ultimo_grupo: dict[str, float] = {}
        self.intensidad = 1.0
        self.vivo = None                                    # {nombre, nivel, t_fin, bucle}
        self.pendiente = None                               # (clave, nivel) del momento que espera su turno
        self.emparejo = None
        self.agenda: list[tuple[float, str, dict]] = []
        self.latido = None
        self.lanzados: list[tuple[float, str]] = []         # registro (pruebas)

    def _duracion(self, nombre: str) -> float:
        g = self.cat["gestos"][nombre]
        return math.inf if g.get("bucle") else sum(p[0] for p in g["poses"]) / 1000

    def _libre(self, nivel: int, t: float) -> bool:
        if self.vivo and t >= self.vivo["t_fin"]:
            self.vivo = None
        return self.vivo is None or nivel >= self.vivo["nivel"]

    def _elegir(self, clave: str) -> str | None:
        lista = self.cat["complementos"].get(clave, [])
        vistos = self.recientes.get(clave, [])
        libres = [n for n in lista if n not in vistos[-RECIENTES:]] or [n for n in lista if n not in vistos[-1:]] or lista
        return self.rnd.choice(libres) if libres else None

    def _lanzar(self, clave: str, t: float, nivel: int, forzar: bool = False, espero: bool = False) -> str | None:
        n = self._elegir(clave)
        if not n or not self._libre(nivel, t):
            return None
        if not forzar:
            if t - self.ultimo.get(n, -1e9) < ENFRIAMIENTO.get(n, 0):
                return None
            if n in GRANDES and t - self.ultimo_grande < SEPARACION_GRANDES:
                return None
            if t - self.ultimo_grupo.get(clave, -1e9) < ENFRIAMIENTO_GRUPO.get(clave, 0):
                return None
        self.ultimo[n] = t
        if n in GRANDES:
            self.ultimo_grande = t
        self.recientes[clave] = (self.recientes.get(clave, []) + [n])[-RECIENTES:]
        self.ultimo_grupo[clave] = t
        dur = self._duracion(n)
        self.vivo = {"nombre": n, "nivel": nivel, "t_fin": t + dur, "bucle": dur == math.inf, "espero": espero,
                     "intensidad": self.intensidad}
        self.lanzados.append((t, n))
        self.reproducir(n)
        return n

    def _estado(self, clave: str, t: float, nivel: int):
        """Un momento nunca se pierde: si no puede cortar lo que corre, espera a que termine."""
        if self._lanzar(clave, t, nivel, forzar=True) is None and self._elegir(clave):
            self.pendiente = (clave, nivel)

    # ---------- eventos del bus ----------
    def momento_nuevo(self, m: dict, t: float):
        nuevo, pista, previo = m.get("momento", "reposo"), m.get("pista"), self.momento
        if (nuevo, pista) == (self.momento, self.pista):
            return
        self.momento, self.pista, self.pendiente = nuevo, pista, None
        if self.vivo and self.vivo["bucle"]:                # teclear/leer no siguen en otro momento
            self._detener()
            self.vivo = None
        if pista == "furia":                                 # rodaje: villano
            self._estado("furia", t, NIVEL_PROBLEMA)
        elif nuevo == "escucha" and pista == "brillo_nombre":
            self._estado("nombre_desde_reposo" if previo == "reposo" else "nombre_en_conversacion", t, NIVEL_NOMBRE)
        elif nuevo == "escucha":
            self._estado("escucha", t, NIVEL_ALE)
        elif nuevo in ("pensando", "pensando_largo"):
            self._estado(nuevo, t, NIVEL_ALE)
        elif nuevo == "trabajando":
            self._estado("trabajando_tecleando" if pista == "tecleando" else "trabajando_leyendo", t, NIVEL_ALE)
        elif nuevo == "problema":
            self._estado("problema", t, NIVEL_PROBLEMA)
        elif nuevo == "reposo":
            self._estado("reposo", t, NIVEL_REPOSO)
        # hablando: los brazos esperan la primera frase (cuerpo/gesto) para no adelantarse a la voz

    def emocion(self, m: dict, t: float):
        clave_nivel = EMOCIONES.get(m.get("emocion"))
        if clave_nivel:
            i = m.get("intensidad", 1.0)                    # emoción leve 75 % del rango, fuerte 100 %
            self.intensidad = min(1.0, max(0.75, 0.75 + (i - 0.55) / 0.45 * 0.25))
            self._lanzar(clave_nivel[0], t, clave_nivel[1])
            self.intensidad = 1.0

    def gesto_frase(self, m: dict, t: float):
        if self.momento in ("hablando", "escucha"):
            self._lanzar("frase_pregunta" if m.get("pregunta") else "frase", t, NIVEL_FRASE)

    def emparejamiento(self, m: dict, t: float):
        """Celebra como la cara: solo al pasar a vinculado desde mostrando/vencido (CONTRATO robot/emparejamiento)."""
        estado, previo = m.get("estado"), self.emparejo
        self.emparejo = estado
        if estado == "vinculado" and previo in ("mostrando", "vencido"):
            if self.vivo and self.vivo["bucle"]:
                self._detener()
            self._lanzar("vinculado", t, NIVEL_EMPAREJAMIENTO, forzar=True)

    def micro_gesto(self, nombre: str, t: float):
        """La cara empezó un gesto de reposo: los brazos lo acompañan (solo los que tienen complemento)."""
        if self.momento == "reposo" and self.emparejo not in ("mostrando", "vencido"):
            self._lanzar(nombre, t, NIVEL_REPOSO)

    # ---------- bus ----------
    def recibir(self, tema: str, m: dict, ahora: float):
        if tema == "cara/micro":                            # la cara viva no es latido del director
            if ahora - m.get("t", ahora) <= MICRO_VIEJO:
                self.agenda.append((m.get("t", ahora), tema, m))
            return
        self.latido = ahora
        if tema != "cuerpo/latido":
            self.agenda.append((m.get("t", ahora), tema, m))

    def tic(self, ahora: float):
        self.agenda.sort(key=lambda x: x[0])
        while self.agenda and self.agenda[0][0] <= ahora:
            _, tema, m = self.agenda.pop(0)
            if tema == "cuerpo/momento":
                self.momento_nuevo(m, ahora)
            elif tema == "cuerpo/emocion":
                self.emocion(m, ahora)
            elif tema == "cuerpo/gesto":
                self.gesto_frase(m, ahora)
            elif tema == "cara/micro":
                self.micro_gesto(m.get("nombre", ""), ahora)
            elif tema.startswith("robot/emparejamiento"):
                self.emparejamiento(m, ahora)
        if self.latido is not None and ahora - self.latido > SIN_LATIDO and self.momento != "reposo":
            self.momento_nuevo({"momento": "reposo"}, ahora)
            self.latido = None
        if self.pendiente and self._libre(self.pendiente[1], ahora):
            clave, nivel = self.pendiente
            self.pendiente = None
            self._lanzar(clave, ahora, nivel, forzar=True, espero=True)


def _terminar(*_):
    raise KeyboardInterrupt                                 # SIGTERM de los lanzadores: mismo cierre que Ctrl+C


def main():
    import zmq
    import arduino
    signal.signal(signal.SIGTERM, _terminar)
    try:
        b = arduino.Brazos(sys.argv[1] if len(sys.argv) > 1 else None)
    except arduino.PuertoOcupado as e:
        sys.exit(f"🦾 {e}")
    registro = open(os.environ["ALE_BRAZOS_REGISTRO"], "a", buffering=1) if os.environ.get("ALE_BRAZOS_REGISTRO") else None

    def anotar(**d):
        if registro:
            registro.write(json.dumps({"t": time.monotonic(), **d}, ensure_ascii=False) + "\n")

    def del_arduino(linea: str):
        anotar(linea=linea)
        if linea.startswith(("ERR", "LISTO")):
            print(f"   ⚠️ Arduino: {linea}", flush=True)

    b.al_leer = del_arduino
    if registro:
        enviar = b.enviar

        def enviar_anotado(orden: str):
            anotar(orden=orden)
            enviar(orden)

        b.enviar = enviar_anotado
    cat = G.cargar()
    rep = G.Reproductor(b)
    rep.rnd = random.Random()

    def reproducir(n: str):
        anotar(gesto=n, nivel=c.vivo["nivel"], espero=c.vivo["espero"])
        rep.reproducir(cat["gestos"][n], intensidad=c.vivo["intensidad"], nombre=n)
        print(f"   🦾 {n}", flush=True)

    c = Cuerpo(cat, reproducir, detener=rep.detener)
    print(f"🦾 {b.version} en {b.puerto} · escuchando {BUS} y {BUS_CARA}", flush=True)
    if b.sin_limites:
        print(f"   ⚠️ brazos sin calibrar (no se moverán por gestos): {', '.join(b.sin_limites)}", flush=True)
    sub = zmq.Context.instance().socket(zmq.SUB)
    sub.setsockopt(zmq.LINGER, 0)
    for tema in TEMAS:
        sub.setsockopt(zmq.SUBSCRIBE, tema)
    sub.connect(BUS)
    sub.connect(BUS_CARA)
    try:
        while True:
            if sub.poll(20):
                while True:
                    try:
                        tema, cuerpo = sub.recv_multipart(flags=zmq.NOBLOCK)
                    except zmq.Again:
                        break
                    try:
                        c.recibir(tema.decode(), json.loads(cuerpo), time.monotonic())
                    except ValueError:
                        continue
            c.tic(time.monotonic())
    except KeyboardInterrupt:
        pass
    finally:
        rep.detener(); b.cerrar(); print("👋 brazos sueltos", flush=True)


if __name__ == "__main__":
    main()
