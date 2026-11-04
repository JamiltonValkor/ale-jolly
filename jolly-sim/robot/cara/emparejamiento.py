"""Pantalla de emparejamiento del robot (CR-007 de canal-robot-v1): cuando el robot aún no tiene credencial, muestra un
código grande + QR para que el dueño lo vincule en SaleADS; al vincularse, celebra y vuelve a la cara.

Tema del bus: robot/emparejamiento {estado: mostrando|vinculado|vencido, codigo, url, expira (monotonic)}.
Diseño: look and feel de la pantalla `/companion` del rediseño de Meta Assistant (negro, cara crema redondeada, barra
de estado, QR crema con logo), adaptado a 480×320. Sin URL de reclamo el QR no se dibuja y el código ocupa ese espacio.
"""
import pygame

W, H = 480, 320
NEGRO = (0, 0, 0)
BLANCO = (237, 237, 237)
TEXTO = (168, 168, 168)
TENUE = (118, 118, 118)
PILDORA = (24, 24, 24)
VERDE = (61, 220, 132)
AMBAR = (240, 192, 90)
CREMA = (246, 235, 212)
CREMA_BORDE = (226, 212, 184)
RUBOR = (240, 170, 176)
TINTA = (14, 12, 12)
SS = 3                                 # supermuestreo de las piezas fijas (bordes limpios)
QR_LADO = 140                          # px objetivo; cada módulo queda en un entero de px para que escanee


def _fuente(px: int, mono: bool = False, bold: bool = False) -> pygame.font.Font:
    """Variante bold real de la familia (no la negrita sintética), a la escala del lienzo."""
    familia = "menlo,dejavusansmono,couriernew,monaco" if mono else "helveticaneue,helvetica,dejavusans,arial"
    return pygame.font.SysFont(familia, int(px * SS), bold=bold)


def _partir(texto: str, fuente: pygame.font.Font, ancho: int) -> list[str]:
    lineas, actual = [], ""
    for palabra in texto.split():
        prueba = f"{actual} {palabra}".strip()
        if fuente.size(prueba)[0] > ancho and actual:
            lineas.append(actual)
            actual = palabra
        else:
            actual = prueba
    return lineas + [actual] if actual else lineas


class PantallaEmparejamiento:
    def __init__(self):
        self.estado = None
        self.codigo = None
        self.url = None
        self.expira = None
        self.duracion = None                # segundos totales del código (para la barra)
        self._qr = None
        self._qr_url = None
        self._fondo = None
        self._caras = None
        self._lienzo = pygame.Surface((W * SS, H * SS))
        self.f_titulo = _fuente(23, bold=True)
        self.f_codigo = _fuente(30, mono=True, bold=True)
        self.f_codigo_grande = _fuente(44, mono=True, bold=True)
        self.f_texto = _fuente(12)
        self.f_marca = _fuente(12, bold=True)
        self.f_mini = _fuente(10)
        self.f_logo = _fuente(26, bold=True)

    def actualizar(self, m: dict):
        codigo = m.get("codigo")
        if codigo != self.codigo:
            self.duracion = None             # código nuevo: la barra vuelve a empezar
        self.estado, self.codigo, self.url, self.expira = m.get("estado"), codigo, m.get("url"), m.get("expira")

    @property
    def activa(self) -> bool:
        return self.estado in ("mostrando", "vencido")

    # ---------- piezas fijas ----------
    def _hacer_fondo(self) -> pygame.Surface:
        fondo = pygame.Surface((W * SS, H * SS))
        fondo.fill(NEGRO)
        halo = pygame.Surface((W, H), pygame.SRCALPHA)
        halo.fill((0, 0, 0, 0))
        pygame.draw.circle(halo, (30, 120, 120, 60), (30, 120), 90)
        pygame.draw.circle(halo, (130, 40, 90, 55), (120, 250), 90)
        halo = pygame.transform.gaussian_blur(halo, 40)
        fondo.blit(pygame.transform.smoothscale(halo, (W * SS, H * SS)), (0, 0))
        return fondo

    def _hacer_cara(self, cerrada: bool) -> pygame.Surface:
        lado = 112 * SS
        s = pygame.Surface((lado, lado), pygame.SRCALPHA)
        s.fill((0, 0, 0, 0))
        pygame.draw.rect(s, CREMA, (0, 0, lado, lado), border_radius=30 * SS)
        rubor = pygame.Surface((lado, lado), pygame.SRCALPHA)
        rubor.fill((*RUBOR, 0))                # transparente del mismo color: el desenfoque no deja halo gris
        for x in (20, 92):
            pygame.draw.ellipse(rubor, (*RUBOR, 190), ((x - 13) * SS, 62 * SS, 26 * SS, 13 * SS))
        rubor = pygame.transform.gaussian_blur(rubor, 3 * SS)
        s.blit(rubor, (0, 0))
        for x in (34, 78):
            if cerrada:
                pygame.draw.line(s, TINTA, ((x - 9) * SS, 50 * SS), ((x + 9) * SS, 50 * SS), 3 * SS)
            else:
                pygame.draw.circle(s, TINTA, (x * SS, 50 * SS), 10 * SS)
                pygame.draw.circle(s, (255, 255, 255), ((x - 3) * SS, 46 * SS), 3 * SS)
                pygame.draw.circle(s, (255, 255, 255), ((x + 3) * SS, 54 * SS), int(1.2 * SS))
        pygame.draw.arc(s, TINTA, (46 * SS, 54 * SS, 20 * SS, 16 * SS), 3.5, 5.9, int(1.6 * SS))
        return s

    def _superficie_qr(self, url: str, lado: int) -> pygame.Surface:
        """QR crema con logo. Corrección Q para tolerar el logo; módulos enteros y borde blanco suficiente."""
        if self._qr is None or self._qr_url != url or getattr(self, "_qr_lado", None) != lado:
            import segno
            filas = [list(f) for f in segno.make(url, error="q", boost_error=False).matrix_iter(scale=1, border=0)]
            n = len(filas)
            px = max(2, lado // n)
            margen = 2 * px
            sup = pygame.Surface((n * px + 2 * margen, n * px + 2 * margen), pygame.SRCALPHA)
            sup.fill((0, 0, 0, 0))
            pygame.draw.rect(sup, CREMA, sup.get_rect(), border_radius=max(10, px * 4))
            for y, fila in enumerate(filas):
                for x, v in enumerate(fila):
                    if v:
                        sup.fill(TINTA, (margen + x * px, margen + y * px, px, px))
            c = sup.get_rect().center
            radio = int(n * px * 0.105)          # ~9 % del área: dentro de lo que corrige el nivel Q
            pygame.draw.circle(sup, CREMA, c, radio + 2)
            logo = self.f_logo.render("$", True, TINTA)
            logo = pygame.transform.smoothscale_by(logo, (2 * radio - 4) / max(logo.get_height(), 1))
            sup.blit(logo, logo.get_rect(center=c))
            self._qr, self._qr_url, self._qr_lado = sup, url, lado
        return self._qr

    # ---------- pantalla ----------
    def _texto(self, L, texto, fuente, color, x, y):
        """Escribe en el lienzo con coordenadas de la pantalla de 480×320."""
        t = fuente.render(texto, True, color)
        L.blit(t, (x * SS, y * SS))
        return t.get_width() / SS

    def _barra_superior(self, L, vencido: bool):
        x = 16 + self._texto(L, "Meta Assistant", self.f_marca, BLANCO, 16, 13)
        self._texto(L, " · Saleads", self.f_texto, TENUE, x, 13)
        texto = "Pidiendo otro código" if vencido else "Esperando tu código"
        ancho = self.f_mini.size(texto)[0] / SS + 30
        cx = W - 14 - ancho
        pygame.draw.rect(L, PILDORA, (cx * SS, 9 * SS, ancho * SS, 22 * SS), border_radius=11 * SS)
        pygame.draw.circle(L, AMBAR if vencido else VERDE, ((cx + 12) * SS, 20 * SS), 3 * SS)
        self._texto(L, texto, self.f_mini, TEXTO, cx + 21, 14)

    def _barra_tiempo(self, L, x, y, ancho, t):
        quedan = max(0.0, self.expira - t)
        if self.duracion is None:
            self.duracion = max(quedan, 1.0)
        pygame.draw.rect(L, (44, 44, 44), (x * SS, y * SS, ancho * SS, 2 * SS), border_radius=SS)
        pygame.draw.rect(L, (205, 205, 205), (x * SS, y * SS, int(ancho * SS * min(1.0, quedan / self.duracion)), 2 * SS),
                         border_radius=SS)
        m, s = divmod(int(quedan), 60)
        self._texto(L, f"Cambia en {m}:{s:02d}", self.f_mini, TENUE, x, y + 8)

    def dibujar(self, sup: pygame.Surface, t: float):
        """Pinta a alta resolución y reduce a `sup` (480×320 en el robot, más en un monitor): texto siempre nítido."""
        if self._fondo is None:
            self._fondo = self._hacer_fondo()
            self._caras = (self._hacer_cara(False), self._hacer_cara(True))
        L = self._lienzo
        L.blit(self._fondo, (0, 0))
        vencido = self.estado == "vencido"
        self._barra_superior(L, vencido)
        L.blit(self._caras[1 if (t % 4.0) < 0.14 else 0], (12 * SS, 106 * SS))

        escala = sup.get_width() / W
        x = 136
        qr = None
        if vencido:
            self._texto(L, "Código", self.f_titulo, BLANCO, x, 112)
            self._texto(L, "vencido", self.f_titulo, BLANCO, x, 139)
            self._texto(L, "Estoy pidiendo uno nuevo…", self.f_texto, TEXTO, x, 174)
        else:
            con_qr = bool(self.url)
            qr = self._superficie_qr(self.url, int(QR_LADO * escala)) if con_qr else None
            lado_qr = qr.get_width() / escala if qr else 0
            ancho = (W - 14 - lado_qr - 12 - x) if con_qr else W - 16 - x
            y = 54 if con_qr else 62
            self._texto(L, "Sincronízame", self.f_titulo, BLANCO, x, y)
            self._texto(L, "con Saleads", self.f_titulo, BLANCO, x, y + 26)
            y += 58
            self._texto(L, "M I   C Ó D I G O", self.f_mini, TENUE, x, y)
            y += 15
            fuente = self.f_codigo if con_qr else self.f_codigo_grande
            cx = x
            for i, parte in enumerate((self.codigo or "····-····").split("-")[:2]):
                if i:
                    cx += self._texto(L, "·", fuente, (100, 100, 100), cx, y)
                cx += self._texto(L, parte, fuente, (250, 250, 250), cx, y)
            y += fuente.get_height() / SS + 6
            guia = "En Saleads, abre «Meta Assistant», toca «Compañero físico» y escribe este código."
            for linea in _partir(guia, self.f_texto, ancho * SS):
                self._texto(L, linea, self.f_texto, TEXTO, x, y)
                y += 15
            if self.expira:
                self._barra_tiempo(L, x, y + 8, min(ancho, 190), t)
            if con_qr:
                leyenda = "O escanéame con tu celular"
                self._texto(L, leyenda, self.f_mini, TENUE,
                            W - 14 - lado_qr / 2 - self.f_mini.size(leyenda)[0] / SS / 2, 58 + lado_qr + 8)

        pygame.transform.smoothscale(L, sup.get_size(), sup)
        if qr is not None:                       # el QR va a píxel exacto, sin reducir: es lo que lo hace escaneable
            sup.blit(qr, qr.get_rect(topright=(int((W - 14) * escala), int(58 * escala))))
