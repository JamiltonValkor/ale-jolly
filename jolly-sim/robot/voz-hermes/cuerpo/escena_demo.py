"""Escena simulada para ver la cara obedeciendo al director sin micrófono ni red (solo el bus).

Terminal 1:  cd mini-muse/software/cara && .venv/bin/python main.py --bus
Terminal 2:  cd voz-hermes && .venv/bin/python -m cuerpo.escena_demo
Eventos con los mismos nombres y tiempos que produce una conversación real (contrato CONTRATO.md).
"""
import math, random, time

from cuerpo import bus
from cuerpo.director import arrancar


def volumen(t0: float, dur: float, semilla: int = 0):
    """Sílabas sintéticas (~4,5/s) como la envolvente de una voz real, en lotes de 0,2 s."""
    rnd = random.Random(semilla)
    niveles, dt = [], 0.01
    for i in range(int(dur / dt)):
        x = i * dt
        silaba = max(0.0, math.sin(2 * math.pi * 4.5 * x + rnd.uniform(-0.3, 0.3)))
        pausa = 0.0 if (x % 2.2) > 1.95 else 1.0
        niveles.append(round(min(1.0, (0.25 + 0.55 * silaba ** 1.5) * pausa * rnd.uniform(0.8, 1.1)), 3))
    for k in range(0, len(niveles), 20):
        bus.publicar("voz/volumen", t=t0 + k * dt, t0=t0 + k * dt, dt=dt, niveles=niveles[k:k + 20])


def decir(t: float, frases: list[tuple[float, str]], fin: float):
    """Una respuesta: turno_inicio, frases a su hora, volumen y turno_fin (todo publicado por adelantado, como Cartesia)."""
    bus.publicar("voz/turno_inicio", t=t)
    for dt, texto in frases:
        bus.publicar("voz/frase", t=t + dt, texto=texto, es_relleno=False, idioma="es")
    volumen(t, fin)
    bus.publicar("voz/turno_fin", t=t + fin)


def esperar_hasta(t):
    while time.monotonic() < t:
        time.sleep(0.005)


def main():
    arrancar()
    bus.publicar("_arranque"); time.sleep(1.5)                       # la cara alcanza a conectarse
    T = time.monotonic() + 2.0
    print("▶️  escena: '¿cómo va mi negocio?' (con herramienta) → seguimiento → error → reposo", flush=True)
    paso = lambda dt, tema, **k: (esperar_hasta(T + dt), bus.publicar(tema, **k))
    # 1) llamada con el nombre
    paso(0.0, "oido/evento", tipo="habla_inicio", turno="T1")
    paso(0.35, "oido/evento", tipo="nombre_detectado", texto="Ale", turno="T1")
    paso(2.0, "oido/evento", tipo="habla_fin", turno="T1")
    paso(2.02, "oido/evento", tipo="aceptada", instruccion="¿cómo va mi negocio?", en_conversacion=False, turno="T1")
    paso(2.05, "ale/evento", tipo="pregunta", texto="¿cómo va mi negocio?", turno="T1")
    paso(2.7, "ale/evento", tipo="herramienta_inicio", nombre="mcp__saleads__saleads_get_results", turno="T1")
    paso(5.0, "ale/evento", tipo="herramienta_fin", nombre="mcp__saleads__saleads_get_results", ok=True, turno="T1")
    paso(5.6, "ale/evento", tipo="primer_token", turno="T1")
    esperar_hasta(T + 5.65)
    decir(T + 5.85, [(0.0, "¡Muy bien!"), (1.2, "Vendiste 32 pedidos esta semana, tu mejor semana del mes."),
                     (5.2, "La campaña de Instagram está pausada por presupuesto."),
                     (8.4, "Podemos reactivarla hoy con veinte mil pesos diarios, ¿te parece?")], 11.6)
    paso(5.9, "ale/evento", tipo="fin", turno="T1")
    paso(17.6, "oido/evento", tipo="ventana", abierta_hasta=T + 17.6 + 20.0, turno="T1")
    # 2) seguimiento sin repetir el nombre → la respuesta falla (red)
    paso(20.5, "oido/evento", tipo="habla_inicio", turno="T2")
    paso(22.0, "oido/evento", tipo="habla_fin", turno="T2")
    paso(22.05, "ale/evento", tipo="pregunta", texto="sí, reactívala", turno="T2")
    paso(23.0, "ale/evento", tipo="herramienta_inicio", nombre="mcp__saleads__saleads_request_resume_campaign", turno="T2")
    paso(26.2, "ale/evento", tipo="error", origen="red", motivo="timeout", turno="T2")
    paso(26.25, "ale/evento", tipo="fin", turno="T2")
    paso(26.3, "oido/evento", tipo="ventana", abierta_hasta=T + 32.0, turno="T2")
    esperar_hasta(T + 44.0)
    print("⏹️  fin de la escena", flush=True)


if __name__ == "__main__":
    main()
