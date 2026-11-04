"""Prueba rápida de variantes de la cara (sin regenerar cuerpo/cabeza): python imprimir/prueba_cara.py k rr nombre"""
import sys, re
k, rr, nombre = float(sys.argv[1]), float(sys.argv[2]), sys.argv[3]
src = open("imprimir/generar_final.py").read()
pre = src[:src.index("exterior = mc(sdf_pelo, org)")]           # constantes, funciones y sdf
func = src[src.index("from scipy.ndimage import map_coordinates"):src.index("cara = cara_domo(); cara.export")]
func = func if True else func.replace("hx, hz, rr = PANT[\"w\"] / 2 + t + 0.0004, PANT[\"h\"] / 2 + t + 0.0004, 0.004",
                    f"rr = {rr}; hx, hz = PANT[\"w\"] / 2 + t + 0.0004 + rr * 0.6, PANT[\"h\"] / 2 + t + 0.0004 + rr * 0.6")
exec(pre); exec(func)
m = cara_domo(k=k); m.export(f"imprimir/_fuente/stl_final/variante_cara_{nombre}.stl"); print("OK", nombre, len(m.faces))
