"""Graba todo el bus (voz + cara + ojo) a un JSONL: .venv/bin/python -m cuerpo.grabar sesion.jsonl"""
import json, sys, time

from cuerpo.bus import DIRECCION, DIRECCION_CARA, DIRECCION_OJO, Suscriptor


def main():
    ruta = sys.argv[1] if len(sys.argv) > 1 else f"grabaciones/bus-{time.strftime('%Y%m%d-%H%M%S')}.jsonl"
    sub = Suscriptor(direccion=[DIRECCION, DIRECCION_CARA, DIRECCION_OJO])
    n = 0
    print(f"⏺️  grabando el bus en {ruta} (Ctrl+C para terminar)", flush=True)
    with open(ruta, "a", encoding="utf-8") as f:
        try:
            while True:
                for m in sub.recibir(espera_ms=200):
                    m["t_rec"] = time.monotonic()
                    f.write(json.dumps(m, ensure_ascii=False) + "\n"); n += 1
                f.flush()
        except KeyboardInterrupt:
            print(f"\n💾 {n} mensajes", flush=True)


if __name__ == "__main__":
    main()
