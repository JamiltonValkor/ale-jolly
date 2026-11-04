"""Pantalla de conteo: la imagen numerada que deja `ojo`, con su «Conté N», sobre la cara. La cara sigue calculando debajo,
así que boca, latido y reposo no se detienen. La imagen llega por ruta en `ojo/conteo`, nunca por el bus.

La carga es lo único caro: pasa una vez por `solicitud_id`, y cada cuadro hace solo un blit. `ojo` republica cada 1,5 s
para una cara que reinicia, y esas repeticiones no leen disco. `expira` es `time.monotonic()` de la misma máquina, como
`robot/emparejamiento`: la pantalla vuelve sola aunque `ojo` esté muerto.
"""
import pygame

FONDO = (250, 246, 240)


class PantallaConteo:
    def __init__(self, cargar=pygame.image.load):
        self.cargar = cargar
        self.solicitud = None
        self.expira = 0.0
        self.original: pygame.Surface | None = None
        self.lista: pygame.Surface | None = None
        self.tam = None
        self.nuevo = False                    # hay cuadro por guardar (bandera --cuadro-conteo de main.py)

    def actualizar(self, m: dict):
        if m.get("solicitud_id") != self.solicitud:
            self.solicitud, self.original, self.lista, self.tam = m.get("solicitud_id"), None, None, None
            try:
                self.original = self.cargar(m.get("ruta_pantalla"))
                self.nuevo = True
            except (OSError, TypeError, pygame.error) as e:
                print(f"⚠️ cara: no pude abrir el conteo ({type(e).__name__})", flush=True)
        self.expira = m.get("expira") or 0.0

    def activa(self, t: float) -> bool:
        return self.original is not None and t < self.expira

    def _ajustar(self, tam: tuple[int, int]):
        """Una vez por tamaño: cabe entero, centrado, sin deformar."""
        ow, oh = self.original.get_size()
        k = min(tam[0] / ow, tam[1] / oh)
        escalada = pygame.transform.smoothscale(self.original, (round(ow * k), round(oh * k)))
        self.lista = pygame.Surface(tam)
        self.lista.fill(FONDO)
        self.lista.blit(escalada, ((tam[0] - escalada.get_width()) // 2, (tam[1] - escalada.get_height()) // 2))
        self.tam = tam

    def dibujar(self, sup: pygame.Surface):
        if self.tam != sup.get_size():
            self._ajustar(sup.get_size())
        sup.blit(self.lista, (0, 0))
