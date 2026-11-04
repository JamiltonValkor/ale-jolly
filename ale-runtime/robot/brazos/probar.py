"""Probar gestos de brazos desde la terminal (sin web). Lo normal es la web: alineamiento.py.
.venv/bin/python probar.py          → lista de gestos; escribe el nombre (o el número) y Enter · x soltar · q salir"""
import arduino
import gestos as G


def main():
    cat = G.cargar()
    nombres = list(cat["gestos"])
    b = arduino.Brazos()
    rep = G.Reproductor(b)
    print(f"🦾 {b.version}\n" + "  ".join(f"{i + 1}:{n}" for i, n in enumerate(nombres)))
    if b.sin_limites:
        print(f"⚠️ sin calibrar: {', '.join(b.sin_limites)} — alinéalos en la web primero")
    try:
        while (o := input("gesto> ").strip()) != "q":
            if o == "x":
                rep.detener(); b.soltar(); continue
            n = nombres[int(o) - 1] if o.isdigit() and 0 < int(o) <= len(nombres) else o
            if n in cat["gestos"]:
                rep.reproducir(cat["gestos"][n], nombre=n)
            else:
                print("   ? no existe")
    except (KeyboardInterrupt, EOFError):
        pass
    finally:
        rep.detener(); b.cerrar(); print("👋 brazos abajo")


if __name__ == "__main__":
    main()
