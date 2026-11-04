"""Voz de salida en tiempo real: convierte el streaming de texto de Ale en audio frase por frase.

- Fragmentador: junta los tokens que llegan y suelta una frase en cuanto se completa (. ! ? … : o salto
  de línea), o en una coma si ya va larga. Así empieza a hablar con la PRIMERA frase, sin esperar
  la respuesta completa.
- Locutor: una cola + un hilo que habla las frases en orden. Motor "say" (macOS, voz Paulina) para
  probar en el Mac; en la Raspberry se cambia por Piper (mismo contrato: decir(texto)).
- Limpia lo que no se debe leer en voz alta: markdown, enlaces, emojis.
"""
import queue, re, subprocess, sys, threading, time

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


class LocutorEspeak(Locutor):
    """Respaldo para Linux sin Cartesia: el mismo contrato que Locutor, hablado con espeak-ng, espeak o spd-say."""

    MOTORES = ("espeak-ng", "espeak", "spd-say")

    def __init__(self, voz: str | None = None, velocidad: int = 165):
        import shutil
        self.motor = next((m for m in self.MOTORES if shutil.which(m)), None)
        if self.motor is None:
            print("⚠️ No encuentro espeak-ng, espeak ni spd-say: Jolly no hablará en voz alta", flush=True)
        super().__init__(voz or ("es" if self.motor == "spd-say" else "es-419"), velocidad)

    def _orden(self, texto: str) -> list[str]:
        if self.motor == "spd-say":
            return ["spd-say", "-w", "-l", self.voz, texto]       # -w: espera a que termine, como say
        return [self.motor, "-v", self.voz, "-s", str(self.velocidad), texto]

    def _bucle(self):
        while True:
            texto = self.cola.get()
            if self.t_primer_audio is None:
                self.t_primer_audio = time.monotonic()
            if self.cron:
                self.cron(f"🔊 empieza a sonar: {texto[:50]!r}")
            if self.motor:
                subprocess.run(self._orden(texto), check=False)
            if self.cron:
                self.cron("🔇 terminó esa frase")
            if self.cola.empty():
                self.ultimo_fin = time.monotonic()
                self.hablando.clear()


# Un solo PowerShell vivo: lee una frase por línea, la habla con la voz de Windows (System.Speech) y responde «fin».
# Prefiere una voz en español (es-MX primero, como Sabina); sin ninguna, usa la que traiga Windows.
_PS_VOZ = r"""
$ErrorActionPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voces = $s.GetInstalledVoices() | Where-Object Enabled | ForEach-Object VoiceInfo
$v = $voces | Where-Object { $_.Name -like '*__VOZ__*' } | Select-Object -First 1
if (-not $v) { $v = $voces | Where-Object { $_.Culture.Name -like 'es-*' } | Sort-Object { if ($_.Culture.Name -eq 'es-MX') { 0 } else { 1 } } | Select-Object -First 1 }
if ($v) { $s.SelectVoice($v.Name) }
$s.Rate = __VELOCIDAD__
[Console]::Out.WriteLine('listo ' + $s.Voice.Name + ' ' + $s.Voice.Culture.Name); [Console]::Out.Flush()
while ($null -ne ($l = [Console]::In.ReadLine())) { if ($l) { $s.Speak($l) }; [Console]::Out.WriteLine('fin'); [Console]::Out.Flush() }
"""


class LocutorWindows(Locutor):
    """Respaldo para Windows sin Cartesia: el mismo contrato que Locutor, hablado con la voz del sistema."""

    def __init__(self, voz: str | None = None, velocidad: int = 1):
        import base64, shutil
        self.proc, self.motor = None, shutil.which("powershell") or shutil.which("pwsh")
        if self.motor:
            script = _PS_VOZ.replace("__VOZ__", re.sub(r"[^\w -]", "", voz or "Sabina")).replace("__VELOCIDAD__", str(int(velocidad)))
            try:
                self.proc = subprocess.Popen(
                    [self.motor, "-NoProfile", "-NonInteractive", "-EncodedCommand", base64.b64encode(script.encode("utf-16-le")).decode()],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, encoding="utf-8")
                listo = self.proc.stdout.readline().strip()
                if not listo.startswith("listo"):
                    raise OSError(listo or "sin respuesta")
                print(f"🔊 voz de Windows: {listo[6:] or 'la del sistema'}", flush=True)
            except OSError as error:
                print(f"⚠️ La voz de Windows no arrancó ({error}): Jolly no hablará en voz alta", flush=True)
                self.proc = self.motor = None
        else:
            print("⚠️ No encuentro PowerShell: Jolly no hablará en voz alta", flush=True)
        super().__init__(voz or "Sabina", velocidad)

    def _bucle(self):
        while True:
            texto = self.cola.get()
            if self.t_primer_audio is None:
                self.t_primer_audio = time.monotonic()
            if self.cron:
                self.cron(f"🔊 empieza a sonar: {texto[:50]!r}")
            if self.proc and self.proc.poll() is None:
                try:
                    self.proc.stdin.write(texto.replace("\n", " ") + "\n")
                    self.proc.stdin.flush()
                    self.proc.stdout.readline()                          # «fin»: terminó de sonar, como say
                except OSError:
                    self.proc = None
            if self.cron:
                self.cron("🔇 terminó esa frase")
            if self.cola.empty():
                self.ultimo_fin = time.monotonic()
                self.hablando.clear()


def locutor_del_sistema(voz: str | None = None) -> Locutor:
    """Sin Cartesia: say en macOS, la voz de Windows o espeak en Linux. Sin motor, Jolly sigue (mudo) con subtítulos."""
    if sys.platform == "darwin":
        return Locutor(voz or "Paulina")
    if sys.platform == "win32":
        return LocutorWindows(voz)
    return LocutorEspeak(voz)
