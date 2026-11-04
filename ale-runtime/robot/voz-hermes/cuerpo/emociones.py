"""Emoción de cada frase de Ale con un léxico bilingüe de negocio (CV-010, decisión T4: léxico ahora, etiquetas de
Ale después). Sin demora: reglas de palabras sobre la frase ya cortada. Regla de optimismo (D5): nunca triste ni
asustada — lo negativo es `preocupada` (con plan) y si la frase siguiente trae solución, se pasa a una positiva.
"""
import re
import unicodedata


def _n(t: str) -> str:
    t = unicodedata.normalize("NFD", t.lower())
    return "".join(c for c in t if unicodedata.category(c) != "Mn")


def _rx(*pal):
    return re.compile(r"\b(?:" + "|".join(pal) + r")", re.I)


REGLAS = [  # (emoción, patrón) en orden de prioridad
    ("confundida", _rx(r"no (?:te )?entendi", r"no estoy segura", r"podrias repetir", r"me lo repites",
                       r"didn'?t (?:get|understand)", r"not sure what you", r"could you repeat")),
    ("preocupada", _rx(r"baj(?:o|aron|a|ando)\b", r"cay(?:o|eron|endo)", r"disminuy", r"perdi(?:ste|mos|o)", r"pausad",
                       r"detenid", r"error", r"fall(?:o|a|aron|ando)", r"problema", r"no veo ventas", r"no hay anuncios", r"ninguna activa", r"\bcero\b", r"sin acceso", r"no tengo acceso",
                       r"no puedo", r"vencid", r"rechaz", r"alerta", r"cuidado", r"riesgo", r"sin presupuesto",
                       r"se acab", r"dropped", r"went down", r"decreas", r"paused", r"failed", r"issue", r"problem",
                       r"can'?t access", r"warning", r"risk")),
    ("orgullosa", _rx(r"(?<!si )vendiste", r"(?:ventas|ingresos|clientes|resultados) (?:subieron|crecieron|aumentaron|mejoraron)",
                      r"creci(?:o|ste|mos)", r"crece\b", r"esta creciendo", r"record", r"tu mejor", r"superaste", r"lo lograste", r"lo logramos",
                      r"felicitaciones", r"felicidades", r"ya quedo", r"ya esta (?:publicad|list)", r"vamos bien", r"dar lo mejor", r"excelente resultado", r"van muy bien", r"vas muy bien",
                      r"\+\d+ ?%", r"increased", r"grew", r"best (?:week|month)", r"great results", r"well done")),
    ("pensativa", _rx(r"dejame (?:revisar|pensar|ver|mirar)", r"voy a revisar", r"estoy revisando", r"te reviso", r"reviso\b", r"hay un matiz", r"analizando",
                      r"veamos", r"revisemos", r"let me (?:check|think|see)", r"checking")),
    ("feliz", _rx(r"hola", r"buenos dias", r"buenas (?:tardes|noches)", r"te escucho", r"todo bien", r"voy bien", r"amaneci bien",
                  r"soy ale", r"content[ao]", r"que detalle", r"jaja", r"buena pregunta", r"te ayudo", r"para ayudar",
                  r"juntos", r"contigo", r"muy bien", r"estoy bien", r"que bueno", r"me encanta", r"encantad", r"claro\b",
                  r"por supuesto", r"de una", r"ayudarte", r"apoyarte", r"cuenta conmigo", r"aqui estoy", r"listo", r"perfecto", r"genial", r"claro que si", r"con gusto", r"buenisim", r"me alegra",
                  r"bienvenid", r"gracias", r"que bien", r"excelente", r"super\b", r"hello", r"\bhi\b", r"great",
                  r"sure", r"done", r"happy", r"glad", r"awesome")),
]
INTENCIONES = [  # lo que hace la frase con el dueño; no es una emoción: da pie al gesto de los brazos
    ("muestra", _rx(r"este enlace", r"aqui esta", r"veo tus", r"tienes \d+", r"mira\b", r"look at", r"here (?:is|are)")),
    ("ofrece", _rx(r"si quieres", r"te propongo", r"te recomiendo", r"te detallo", r"te traigo", r"podemos", r"seguimos con",
                   r"avanzamos", r"lo revisamos", r"i suggest", r"i recommend", r"we can")),
]
NEGACION = re.compile(r"\b(?:no|sin|nunca|ningun|ninguna|not|no hay|without)\s+(?:\w+\s+){0,1}$")
SOLUCION = _rx(r"podemos", r"te propongo", r"propongo", r"la solucion", r"vamos a", r"te recomiendo", r"recomiendo",
               r"plan\b", r"lo arreglamos", r"se puede", r"we can", r"i suggest", r"let'?s", r"i recommend")


def clasificar(frase: str) -> tuple[str, float]:
    """(emoción, intensidad 0–1) de una frase. Neutral si no hay señal clara."""
    t = _n(frase)
    for emo, rx in REGLAS:
        hits = [m for m in rx.finditer(t) if not (emo == "preocupada" and NEGACION.search(t[:m.start()]))]
        if hits:
            if emo == "preocupada" and SOLUCION.search(t) and len(hits) == 1:
                return "preocupada", 0.5                       # mala noticia con plan en la misma frase: suave
            return emo, min(1.0, 0.55 + 0.2 * len(hits))
    if t.rstrip().endswith("?") or t.lstrip().startswith("¿"):
        return "curiosa", 0.6
    return "neutral", 0.3


def intencion(frase: str) -> str | None:
    t = _n(frase)
    return next((nombre for nombre, rx in INTENCIONES if rx.search(t)), None)


class Emociones:
    """Recuerda la frase anterior para la regla de optimismo."""

    def __init__(self):
        self.previa = "neutral"

    def frase(self, texto: str) -> tuple[str, float]:
        emo, inten = clasificar(texto)
        if self.previa == "preocupada" and emo in ("neutral", "pensativa") and SOLUCION.search(_n(texto)):
            emo, inten = "feliz", 0.6                         # D5: después del problema, la solución se ve optimista
        self.previa = emo
        return emo, inten
