"""Une catálogo + selector + capas + burbujas: recibe momentos/emociones/gestos (del director o de una demo) y da la
cara de cada cuadro.

v2 (sesión real 27-oct, feedback "más expresiva"): intensidad global ×1,35 sobre la cara neutra, gestos breves al
empezar cada frase mientras habla, y burbujas arriba que muestran qué está haciendo Ale.
"""
import random

from burbujas import Burbujas, icono_para
from capas import Animador
from emparejamiento import PantallaEmparejamiento
from parametros import NEUTRA, claves
from selector import Selector

PARPADEO_POR_MOMENTO = {"escucha": "escucha", "hablando": "hablando", "pensando": "pensando",
                        "pensando_largo": "pensando", "trabajando": "pensando"}
INTENSIDAD = 1.35
PENSANDO = ("pensando", "pensando_largo", "trabajando")


def intensificar(expr: dict, k: float = INTENSIDAD) -> dict:
    """Aleja cada parámetro de la cara neutra k veces (más expresiva sin reescribir el catálogo)."""
    out = {}
    for clave, v in expr.items():
        neutra = NEUTRA[next(iter(claves({clave: v})))]
        out[clave] = neutra + (v - neutra) * k
    return out


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
        self.t_fin_celebracion = None

    def momento(self, nombre: str, t: float, pista: str | None = None, herramienta: str | None = None):
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
            b.mostrar("foco", t, dur=1.1)                     # "¡ya sé!"
        if nombre == "escucha" and previo != "escucha":
            b.mostrar("ondas", t, dur=1.8)
        elif nombre != "escucha":
            b.ocultar("ondas", t)
        if nombre == "problema":
            b.mostrar("pregunta", t)
        else:
            b.ocultar("pregunta", t)

    def emocion(self, nombre: str, t: float):
        v = self.sel.emocion(nombre, t)
        self.nombre_emocion = nombre
        self.expr_emocion = intensificar(v["expr"])
        self.anim.ir_a({**self.expr_momento, **self.expr_emocion}, t, v.get("dur", 0.3))
        if v.get("gesto"):
            self.anim.gesto(v["gesto"], t + v.get("dur", 0.3))
        if nombre in ("feliz", "orgullosa"):
            self.burb.mostrar("destellos", t, dur=1.5)
        elif nombre == "confundida":
            self.burb.mostrar("pregunta", t, dur=2.0)
        self.t_actividad = t

    def gesto_habla(self, t: float, pregunta: bool = False):
        """Al empezar cada frase: un gesto breve (asentir, ladear, mirar y volver) para que no hable 'congelada'."""
        if self.nombre_momento != "hablando" or self.anim.gesto_pasos:
            return
        lista = self.sel.cat.get("gestos_habla", [])
        if pregunta:
            lista = [g for g in lista if g.get("pregunta")] or lista
        if lista:
            g = self.sel.elegir(lista, "habla", t)
            self.anim.gesto(g["gesto"], t)

    def emparejamiento(self, m: dict, t: float):
        """robot/emparejamiento: muestra código+QR mientras espera; al vincularse, celebra y vuelve a la cara."""
        antes = self.empareja.estado
        self.empareja.actualizar(m)
        if m.get("estado") == "vinculado" and antes in ("mostrando", "vencido"):
            self.momento("escucha", t, pista="brillo_nombre")
            self.emocion("feliz", t + 0.1)
            self.anim.gesto([[0.12, {"subir": 7}], [0.18, {"subir": 0}], [0.12, {"subir": 5}], [0.2, {"subir": 0}]], t + 0.2)
            self.burb.mostrar("destellos", t, dur=2.6)
            self.t_fin_celebracion = t + 3.0

    def cuadro(self, t: float) -> dict:
        if self.t_fin_celebracion is not None and t >= self.t_fin_celebracion:
            self.t_fin_celebracion = None
            self.momento("reposo", t)
        if self.nombre_momento == "reposo" and t >= self.prox_micro and not self.anim.gesto_pasos:
            g = self.sel.micro_gesto(t, t - self.t_actividad)
            if g.get("parpadeo_doble"):
                self.anim.parpadear(t, doble=True)
            elif g.get("gesto"):
                self.anim.gesto(g["gesto"], t)
            if g["nombre"] == "bostecito":
                self.burb.mostrar("zzz", t, dur=2.6)
            self.ultimo_micro = g["nombre"]
            self.prox_micro = t + self.rnd.uniform(6, 15)
        return self.anim.cuadro(t)

    def estado(self) -> dict:
        return {"momento": self.nombre_momento, "variante": self.variante, "emocion": self.nombre_emocion}
