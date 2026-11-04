"""Ale de mentira para medir sin el backend real (token vencido, port-forward caído, pruebas repetibles).

Imita el mismo camino que AleHermes: POST /assistants/me/sessions → {session_id};
POST /assistants/me/sessions/{id}/stream → SSE con token/commentary/tool_start/tool_end/message_end.

  .venv/bin/python pruebas/ale_falso.py [puerto=18099] [--sin-modo-voz] [--falla 500]
  .venv/bin/python voz_hermes.py --archivo pruebas/t1.wav --hermes http://localhost:18099 --cronometro

--sin-modo-voz: responde 400 si el cuerpo trae "voice" (prueba el reintento de modo_voz).
--falla N: el stream responde HTTP N (prueba ale/evento error de red/http).
--foto concepto:etiqueta: entrega esa orden por op:events, y atiende photo_url, photo_done y el PUT.
--aviso "texto": entrega ese aviso `decir` por op:events en cuanto empieza el primer turno, para provocar la colisión.
Tiempos: primer token a los PRIMER_TOKEN_S (como Ale real, ~1,5 s), luego ~25 tokens/s.
"""
import json, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PRIMER_TOKEN_S = 1.5
RESPUESTA = ("Te ayudo a vender más con anuncios en Meta. Reviso tus campañas cada día y te aviso qué mejorar. "
             "Así tu negocio crece sin que pierdas tiempo.")

args = sys.argv[1:]
PUERTO = int(next((a for a in args if a.isdigit()), 18099))
SIN_MODO_VOZ = "--sin-modo-voz" in args
FALLA = int(args[args.index("--falla") + 1]) if "--falla" in args else None


FOTOS: list[dict] = []        # órdenes de foto por entregar; ver --foto
AVISOS: list[dict] = []       # avisos por entregar; ver --aviso
OPS: list[dict] = []          # cada operación recibida, para revisar a mano o desde una prueba
HECHO = {"x": False}


class Manejador(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _json(self, codigo, obj):
        b = json.dumps(obj).encode()
        self.send_response(codigo)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_POST(self):
        largo = int(self.headers.get("Content-Length") or 0)
        cuerpo = json.loads(self.rfile.read(largo) or b"{}")
        if "op" in cuerpo:
            return self._op(cuerpo)
        if self.path.endswith("/sessions"):
            return self._json(200, {"session_id": "falsa-1"})
        if SIN_MODO_VOZ and "voice" in cuerpo:
            return self._json(400, {"error": "unknown field voice"})
        if FALLA:
            return self._json(FALLA, {"error": "falla simulada"})
        HECHO["turno"] = True
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()

        def ev(tipo, **d):
            self.wfile.write(f"event: {tipo}\ndata: {json.dumps({'type': tipo, **d})}\n\n".encode())
            self.wfile.flush()

        time.sleep(0.4)
        ev("tool_start", name="saleads_get_account_overview")
        time.sleep(0.3)
        ev("tool_end", name="saleads_get_account_overview", ok=True)
        time.sleep(PRIMER_TOKEN_S - 0.7)
        for i in range(0, len(RESPUESTA), 6):
            ev("token", text=RESPUESTA[i:i + 6])
            time.sleep(0.04)
        ev("message_end")
        self.close_connection = True


    def do_PUT(self):
        """Subida firmada falsa: el mismo proceso hace de bucket."""
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        OPS.append({"op": "put", "ruta": self.path, "content_type": self.headers.get("Content-Type")})
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _op(self, cuerpo):
        """Lado servidor de `op:*` (cuerpo/CONTRATO.md). `--foto concepto:etiqueta` entrega una orden al conectar."""
        OPS.append(cuerpo)
        if cuerpo["op"] == "photo_url":
            ruta = f"/subida/{cuerpo['role']}"
            return self._json(200, {"url": f"http://127.0.0.1:{PUERTO}{ruta}", "object": ruta, "expires_in": 300, "content_type": cuerpo["content_type"]})
        if cuerpo["op"] != "events":
            HECHO["x"] = HECHO["x"] or cuerpo["op"] in ("photo_done", "photo_failed")
            return self._json(200, {"ok": True})
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        for i, orden in enumerate(FOTOS, 1):
            if i > cuerpo["after"]:
                d = {"id": i, "kind": "foto", "payload": orden}
                self.wfile.write(f"event: stock\nid: {i}\ndata: {json.dumps(d)}\n\n".encode())
        while not HECHO["x"]:
            if AVISOS and HECHO.get("turno"):
                d = AVISOS.pop(0)
                self.wfile.write(f"event: stock\nid: {d['id']}\ndata: {json.dumps(d)}\n\n".encode())
            self.wfile.write(b": keepalive\n\n")
            self.wfile.flush()
            time.sleep(0.2)
        self.close_connection = True


if __name__ == "__main__":
    if "--foto" in args:
        concepto, etiqueta = args[args.index("--foto") + 1].split(":")
        FOTOS.append({"solicitud_id": "00000000-0000-4000-8000-000000000001", "concepto": concepto, "etiqueta": etiqueta, "foto_id": None})
    if "--aviso" in args:
        AVISOS.append({"id": 100, "kind": "decir", "payload": {"texto": args[args.index("--aviso") + 1], "pregunta": True, "prioridad": "normal", "proposal_id": None, "vence_s": 3600}})
    print(f"Ale falso en http://localhost:{PUERTO}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PUERTO), Manejador).serve_forever()
