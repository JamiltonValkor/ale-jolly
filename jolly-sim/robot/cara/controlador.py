"""Une catálogo + selector + capas + burbujas: recibe momentos/emociones/gestos (del director o de una demo) y da la
cara de cada cuadro.

v2 (sesión real 27-oct, feedback "más expresiva"): intensidad global ×1,35 sobre la cara neutra, gestos breves al
empezar cada frase mientras habla, y burbujas arriba que muestran qué está haciendo Ale.
"""
import random

from boton_sueno import BotonSueno, a_logico
from burbujas import Burbujas, icono_para
from capas import Animador
from carga import Carga, POSE
from conteo import PantallaConteo
from emparejamiento import PantallaEmparejamiento
from parametros import NEUTRA, claves
from selector import Selector
from sueno import DORMIDA, DUR, FPS_DORMIDA, RESPIRA_DORMIDA, RESPIRA_DESPIERTA, Sueno

PARPADEO_POR_MOMENTO = {"escucha": "escucha", "hablando": "hablando", "pensando": "pensando",
                        "pensando_largo": "pensando", "trabajando": "pensando"}
INTENSIDAD = 1.35
PENSANDO = ("pensando", "pensando_largo", "trabajando")
PARPADOS = (".sup", ".inf", ".sup_curva", ".inf_curva")
SONRISA_MIN = 0.18
ANTICIPA = 0.15                       # cara/reaccion sale antes de verse: el servo tarda en arrancar
REACCIONES_RESPUESTA = {              # al pasar a hablar; None = sin reacción
    "busqueda": (("ya_se", 2), ("listo", 2), ("sorpresa_suave", 1), (None, 1)),
    "corta": (("sorpresa_suave", 1), (None, 3)),
}
INTENCIONES = {"ofrece": "ofrecer", "muestra": "señalar"}


def intensificar(expr: dict, k: float = INTENSIDAD) -> dict:
    """Aleja cada parámetro de la cara neutra k veces (más expresiva sin reescribir el catálogo)."""
    out = {}
    for clave, v in expr.items():
        neutra = NEUTRA[next(iter(claves({clave: v})))]
        kp = min(k, INTENSIDAD) if clave.endswith(PARPADOS) else k    # más párpado parte el ojo en vez de expresar
        out[clave] = neutra + (v - neutra) * kp
        if clave.endswith("boca.sonrisa"):            # D5: nunca sonrisa al revés ni párpado triste, ni boca recta
            out[clave] = max(SONRISA_MIN, out[clave]) if v > 0 else out[clave]
        elif clave.endswith("sup_ang"):
            out[clave] = max(-20.0, out[clave])
    return out


def factor_intensidad(intensidad: float | None) -> float:
    return INTENSIDAD if intensidad is None else 1.1 + 0.6 * intensidad


class Controlador:
    def __init__(self, semilla: int | None = None):
        self.anim = Animador(semilla)
        self.sel = Selector(semilla=semilla)
        self.burb = Burbujas()
        self.rnd = random.Random(semilla)
        self.nombre_momento, self.variante, self.nombre_emocion = "reposo", "tranquila", "neutral"
        self.expr_momento: dict = {}
        self.expr_emocion: dict = {}
        self.t_actividad = 0.0
        self.prox_micro = 8.0
        self.empareja = PantallaEmparejamiento()
        self.conteo = PantallaConteo()
        self.t_fin_celebracion = None
        self.al_micro = None                  # aviso al cuerpo: la cara empezó un gesto de reposo (oyente.py)
        self.prox_reposo = self.rnd.uniform(18, 40)
        self.al_reaccion = None               # aviso a los brazos: la cara va a hacer una reacción (oyente.py)
        self.reaccion_usada: dict[str, float] = {}
        self.ultima_reaccion = None
        self.diferidas: list[tuple[float, object]] = []
        self.frases_sin_cambio, self.prox_cambio = 0, self.rnd.randint(2, 3)
        self.sueno, self.boton = Sueno(), BotonSueno()
        self.al_sueno = None                  # aviso al cuerpo: cambió el modo dormir (oyente.py)
        self.momento_guardado = ("reposo", None, None)   # lo que llegó dormida: se aplica al despertar
        self.carga = Carga()
        self.red = None                  # main.py la pone con --bus
        self.sueno_mudo = False               # despertar del arranque: los brazos pueden no estar listos

    def momento(self, nombre: str, t: float, pista: str | None = None, herramienta: str | None = None, forzar: bool = False):
        if self.sueno.activo and not forzar:
            self.momento_guardado = (nombre, pista, herramienta)
            return
        if nombre not in self.sel.cat["momentos"]:
            nombre = "reposo"
        previo = self.nombre_momento
        nombres = [v["nombre"] for v in self.sel.cat["momentos"][nombre]]
        v = self.sel.momento(nombre, t, forzar=pista if pista in nombres else None)
        self.nombre_momento, self.variante = nombre, v["nombre"]
        self.expr_momento = intensificar(v["expr"])
        if nombre != "hablando":
            self.nombre_emocion, self.expr_emocion = "neutral", {}
        self.anim.ir_a(self.expr_momento, t, v.get("dur", 0.3))
        if v.get("gesto"):
            self.anim.gesto(v["gesto"], t + v.get("dur", 0.3))
        self.anim.modo_parpadeo(PARPADEO_POR_MOMENTO.get(nombre, "reposo"), t)
        self.anim.mirada_fija(nombre in ("escucha", "hablando"))
        if nombre != "reposo":
            self.t_actividad = t
        self.prox_micro = t + self.rnd.uniform(6, 15)
        self.prox_reposo = t + self.rnd.uniform(18, 40)
        if nombre == "hablando" and previo != "hablando":
            self.frases_sin_cambio = 0
        if nombre == "escucha" and pista == "brillo_nombre":
            self.anim.parpadear(t + 0.05)                     # parpadeo de "¿sí?" al oír su nombre
        self._burbujas_momento(nombre, previo, t, herramienta)

    def _burbujas_momento(self, nombre, previo, t, herramienta):
        b = self.burb
        if nombre in ("pensando", "pensando_largo"):
            b.mostrar("nube", t, contenido="puntos", rapido=nombre == "pensando_largo")
        elif nombre == "trabajando":
            b.mostrar("nube", t, contenido=icono_para(herramienta))
        else:
            b.ocultar("nube", t)
        if nombre == "hablando" and previo in PENSANDO:
            self._reaccion_respuesta("corta" if previo == "pensando" else "busqueda", t)
        if nombre == "escucha" and previo != "escucha":
            b.mostrar("ondas", t, dur=1.8)
        elif nombre != "escucha":
            b.ocultar("ondas", t)
        if nombre == "problema":
            b.mostrar("pregunta", t)
        else:
            b.ocultar("pregunta", t)

    def _reaccion_respuesta(self, tipo: str, t: float):
        libres = [(n, p) for n, p in REACCIONES_RESPUESTA[tipo] if n is None or self._reaccion_libre(n, t)]
        nombre = self.rnd.choices([n for n, _ in libres], weights=[p for _, p in libres])[0]
        if nombre:
            self.reaccionar(nombre, t)

    def _reaccion_libre(self, nombre: str, t: float) -> bool:
        enfriamiento = self.sel.cat["reacciones"][nombre].get("enfriamiento", 0)
        return t - self.reaccion_usada.get(nombre, -1e9) >= enfriamiento

    def reaccionar(self, nombre: str, t: float, al_verse=None, emocion: str | None = None,
                   intensidad: float | None = None) -> bool:
        """Avisa a los brazos ahora y la cara la hace ANTICIPA después, para que los dos coincidan."""
        if self.sueno.activo or not self._reaccion_libre(nombre, t):
            return False
        self.reaccion_usada[nombre] = t
        r, ve = self.sel.cat["reacciones"][nombre], t + ANTICIPA
        dur = sum(p[0] for p in r.get("gesto", []))

        def aplicar(tv: float):
            if al_verse:
                al_verse(tv)
            if r.get("burbuja"):
                self.burb.mostrar(r["burbuja"], tv, dur=r["burbuja_dur"])
            if r.get("gesto"):
                self.anim.gesto(r["gesto"], tv)
        self.diferidas.append((ve, aplicar))
        self.ultima_reaccion = nombre
        if self.al_reaccion:
            self.al_reaccion(nombre, emocion, intensidad, dur, r["protagonista"], ve)
        return True

    def emocion(self, nombre: str, t: float, intensidad: float | None = None):
        if self.sueno.activo:
            return
        fuerte = nombre == "orgullosa"                        # celebrar: cara y brazos a tope juntos
        v = self.sel.emocion(nombre, t)
        self.nombre_emocion = nombre
        self.expr_emocion = intensificar(v["expr"], factor_intensidad(1.0 if fuerte else intensidad))
        self.t_actividad = t

        def aplicar(tv: float):
            self.anim.ir_a({**self.expr_momento, **self.expr_emocion}, tv, v.get("dur", 0.3))
            if v.get("gesto"):
                self.anim.gesto(v["gesto"], tv + v.get("dur", 0.3))
            if nombre in ("feliz", "orgullosa"):
                self.burb.mostrar("destellos", tv, dur=1.5)
            elif nombre == "confundida":
                self.burb.mostrar("pregunta", tv, dur=2.0)
        reaccion = "celebra" if fuerte else "alivio" if nombre == "preocupada" and (intensidad or 1.0) <= 0.5 else None
        if not (reaccion and self.reaccionar(reaccion, t, aplicar, nombre, intensidad)):
            aplicar(t)

    def gesto_habla(self, t: float, pregunta: bool = False, intencion: str | None = None):
        """Al empezar cada frase: un gesto breve (asentir, ladear, mirar y volver) para que no hable 'congelada'.
        Cada 2 o 3 frases cambia también la cara de fondo."""
        if self.nombre_momento != "hablando" or self.sueno.activo:
            return
        self.frases_sin_cambio += 1
        if self.frases_sin_cambio >= self.prox_cambio:
            self._cambiar_al_hablar(t)
        if intencion in INTENCIONES:
            self.reaccionar(INTENCIONES[intencion], t)
        if self.anim.gesto_pasos:
            return
        lista = self.sel.cat.get("gestos_habla", [])
        if pregunta:
            lista = [g for g in lista if g.get("pregunta")] or lista
        if lista:
            g = self.sel.elegir(lista, "habla", t)
            self.anim.gesto(g["gesto"], t)

    def _cambiar_al_hablar(self, t: float):
        v = self.sel.momento("hablando", t)
        self.variante, self.expr_momento = v["nombre"], intensificar(v["expr"])
        self.frases_sin_cambio, self.prox_cambio = 0, self.rnd.randint(2, 3)
        self.anim.ir_a({**self.expr_momento, **self.expr_emocion}, t, 0.35)
        self.reaccionar("cambio_al_hablar", t)

    def pantalla_encima(self, sup, t: float):
        """Lo que tapa la cara. Vincular el robot manda sobre el conteo."""
        if self.empareja.activa:
            self.empareja.dibujar(sup, t)
        elif self.conteo.activa(t):
            self.conteo.dibujar(sup)

    def emparejamiento(self, m: dict, t: float):
        """robot/emparejamiento: muestra código+QR mientras espera; al vincularse, celebra y vuelve a la cara."""
        antes = self.empareja.estado
        self.empareja.actualizar(m)
        if self.carga.activa:
            self._salir_de_carga(t)
        if m.get("estado") == "vinculado" and antes in ("mostrando", "vencido"):
            self.momento("escucha", t, pista="brillo_nombre")
            self.emocion("feliz", t + 0.1)
            self.anim.gesto([[0.12, {"subir": 7}], [0.18, {"subir": 0}], [0.12, {"subir": 5}], [0.2, {"subir": 0}]], t + 0.2)
            self.burb.mostrar("destellos", t, dur=2.6)
            self.t_fin_celebracion = t + 3.0

    # ---------- pantalla de carga ----------
    def iniciar_carga(self, t: float, espera: float):
        self.sueno.estado = "dormida"
        self.anim.ir_a(POSE, t, 0.01)
        self.anim.respiracion = RESPIRA_DORMIDA
        self.carga.iniciar(t, espera)

    def voz_lista(self, t: float):
        """Primer cuerpo/latido, o nadie respondió a tiempo."""
        if self.carga.activa:
            self._salir_de_carga(t)

    def _salir_de_carga(self, t: float):
        self.carga.activa = False
        if self.empareja.activa:                 # directo a vinculación, sin animación debajo
            self.sueno.estado = "despierta"
            self.anim.respiracion = RESPIRA_DESPIERTA
            self.momento("reposo", t)
        else:
            self.sueno_mudo = True
            self.orden_sueno("despertar", t)

    # ---------- modo dormir ----------
    def orden_sueno(self, orden: str, t: float):
        """cuerpo/sueno, o el botón cuando la cara corre sin voz. Una orden en plena animación espera su fin."""
        if self.carga.activa:
            self.carga.activa = False
            if orden == "dormir":                # estaba dormida al apagarse: se queda así, sin animación
                self.anim.ir_a(DORMIDA, t, 0.3)
                if self.al_sueno:
                    self.al_sueno("dormida", 0.0, t)
                return
        if not self.sueno.orden(orden, t):
            return
        self.boton.recoger()
        if orden == "dormir":
            self.momento("reposo", t, forzar=True)
            self.momento_guardado = ("reposo", None, None)
        self.anim.amp_dardo = 0.0
        if self.al_sueno and not self.sueno_mudo:
            self.al_sueno(self.sueno.estado, DUR[self.sueno.estado], t)

    def _avanzar_sueno(self, t: float):
        for expr, dur in self.sueno.pasos(t):
            self.anim.ir_a(expr, t, dur)
        if self.sueno.termino(t):
            if self.al_sueno and not self.sueno_mudo:
                self.al_sueno(self.sueno.estado, 0.0, t)
            self.sueno_mudo = False
            dormida = self.sueno.estado == "dormida"
            self.anim.respiracion = RESPIRA_DORMIDA if dormida else RESPIRA_DESPIERTA
            if not dormida:
                self.t_actividad = t
                nombre, pista, herramienta = self.momento_guardado
                self.momento(nombre, t, pista, herramienta)
            pendiente, self.sueno.pendiente = self.sueno.pendiente, None
            if pendiente:
                self.orden_sueno(pendiente, t)

    def boton_visible(self) -> bool:
        if self.carga.activa or self.empareja.activa or self.t_fin_celebracion is not None:
            return False
        return self.sueno.estado in ("dormida", "despierta")

    def toque(self, x: float, y: float, tam: tuple[int, int], giro: int, t: float) -> str | None:
        """Toque o clic en píxeles de pantalla. Devuelve dormir/despertar si el botón ejecuta la acción."""
        if not self.boton_visible():
            return None
        return self.boton.toque(*a_logico(x, y, tam, giro), t, self.sueno.estado == "dormida")

    @property
    def sin_internet(self) -> bool:
        return bool(self.red and self.red.caida)

    def dibujar_encima(self, L, ss: int, t: float, subir: float):
        self.sueno.dibujar(L, ss, t, subir, zzz=not self.carga.activa)
        if self.carga.activa or (self.sin_internet and self.sueno.estado == "despierta"):
            self.carga.dibujar(L, ss, t, self.sin_internet)
        if self.boton_visible():
            self.boton.dibujar(L, ss, self.sueno.estado == "dormida")

    def fps_bajo(self) -> int | None:
        """Dormida y con el botón recogido basta con pocos cuadros: la cara no ocupa la CPU de la Pi."""
        return FPS_DORMIDA if self.sueno.estado == "dormida" and not self.boton.abierto else None

    def cuadro(self, t: float) -> dict:
        if self.carga.vencio(t) and not self.sin_internet:   # sin red, el aviso se queda hasta que vuelva
            self.voz_lista(t)
        self._avanzar_sueno(t)
        vencidas = [f for ve, f in self.diferidas if ve <= t]
        self.diferidas = [d for d in self.diferidas if d[0] > t]
        for f in vencidas:
            if not self.sueno.activo:
                f(t)
        self.boton.actualizar(t, self.boton_visible())
        if self.t_fin_celebracion is not None and t >= self.t_fin_celebracion:
            self.t_fin_celebracion = None
            self.momento("reposo", t)
        if self.nombre_momento == "reposo" and t >= self.prox_micro and not self.anim.gesto_pasos and not self.sueno.activo:
            g = self.sel.micro_gesto(t, t - self.t_actividad)
            if g.get("parpadeo_doble"):
                self.anim.parpadear(t, doble=True)
            elif g.get("gesto"):
                self.anim.gesto(g["gesto"], t)
            if g["nombre"] == "bostecito":
                self.burb.mostrar("zzz", t, dur=2.6)
            self.ultimo_micro = g["nombre"]
            if self.al_micro and not self.empareja.activa:
                self.al_micro(g["nombre"], t)
            self.prox_micro = t + self.rnd.uniform(6, 15)
        if self.nombre_momento == "reposo" and t >= self.prox_reposo and not self.anim.gesto_pasos and not self.sueno.activo:
            self.momento("reposo", t)                         # aun sin nadie cambia de expresión de vez en cuando
        return self.anim.cuadro(t)

    def estado(self) -> dict:
        return {"momento": self.nombre_momento, "variante": self.variante, "emocion": self.nombre_emocion,
                "sueno": self.sueno.estado, "carga": self.carga.activa, "sin_internet": self.sin_internet}
