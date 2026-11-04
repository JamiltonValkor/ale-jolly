"""Voz de salida en tiempo real: convierte el streaming de texto de Ale en audio frase por frase.

- Fragmentador: junta los tokens que llegan y suelta una frase en cuanto se completa (. ! ? … : o salto
  de línea), o en una coma si ya va larga. Así empieza a hablar con la PRIMERA frase, sin esperar
  la respuesta completa.
- Locutor: una cola + un hilo que habla las frases en orden. Motor "say" (macOS, voz Paulina) para
  probar en el Mac; en la Raspberry se cambia por Piper (mismo contrato: decir(texto)).
- Limpia lo que no se debe leer en voz alta: markdown, enlaces, emojis.
"""
import queue, re, subprocess, threading, time

FIN_FRASE = re.compile(r"([.!?…:;]\s|\n)")


def limpiar_para_voz(t: str) -> str:
    t = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", t)          # [texto](enlace) → texto
    t = re.sub(r"https?://\S+", "", t)                       # enlaces sueltos
    t = re.sub(r"[*_`#>|]+", "", t)                          # markdown
    t = re.sub(r"[\U0001F000-\U0001FAFF☀-➿]", "", t)  # emojis
    return re.sub(r"\s+", " ", t).strip()


class Locutor:
    def __init__(self, voz: str = "Paulina", velocidad: int = 195):
        self.voz, self.velocidad = voz, velocidad
        self.cola: queue.Queue = queue.Queue()
        self.hablando = threading.Event()
        self.ultimo_fin = 0.0
        self.t_primer_audio = None
        self.cron = None                      # función para registrar tiempos (cronómetro)
        threading.Thread(target=self._bucle, daemon=True).start()

    def decir(self, texto: str):
        texto = limpiar_para_voz(texto)
        if texto:
            if self.cron:
                self.cron(f"✂️  frase lista para voz ({len(texto)} letras)")
            self.hablando.set()
            self.cola.put(texto)

    def _bucle(self):
        while True:
            texto = self.cola.get()
            if self.t_primer_audio is None:
                self.t_primer_audio = time.monotonic()
            if self.cron:
                self.cron(f"🔊 empieza a sonar: {texto[:50]!r}")
            subprocess.run(["say", "-v", self.voz, "-r", str(self.velocidad), texto], check=False)
            if self.cron:
                self.cron("🔇 terminó esa frase")
            if self.cola.empty():
                self.ultimo_fin = time.monotonic()
                self.hablando.clear()

    def ocupado(self, cola_s: float = 0.6) -> bool:
        """Verdadero mientras habla y un momento después (para no escucharse a sí mismo)."""
        return self.hablando.is_set() or (time.monotonic() - self.ultimo_fin) < cola_s

    def esperar(self):
        while self.hablando.is_set():
            time.sleep(0.05)


class Fragmentador:
    """Recibe tokens y entrega frases completas al locutor."""

    def __init__(self, locutor: Locutor, largo_coma: int = 90):
        self.locutor, self.buf, self.largo_coma = locutor, "", largo_coma

    def token(self, t: str):
        self.buf += t
        while True:
            m = FIN_FRASE.search(self.buf)
            if m:
                frase, self.buf = self.buf[:m.end()], self.buf[m.end():]
                self.locutor.decir(frase)
                continue
            if len(self.buf) > self.largo_coma and ", " in self.buf:
                i = self.buf.rfind(", ") + 1
                frase, self.buf = self.buf[:i], self.buf[i:]
                self.locutor.decir(frase)
                continue
            break

    def cerrar(self):
        if self.buf.strip():
            self.locutor.decir(self.buf)
        self.buf = ""
