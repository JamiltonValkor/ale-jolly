#!/usr/bin/env python3
"""Puente de BANCO entre Stock y Telegram para el paso 7 del E2E (IVB-024). No es el adaptador de producto.

Decisión del owner (2-nov-2026): ni secreto ni configuración en dev. El canal del servidor sigue en `banco`, y este
puente corre en el Mac junto a `banco.py`:

- Saliente: lee de la base (solo lectura, `devlab.Sql`, la misma consulta del simulador) los mensajes que Stock le mandó
  al proveedor en la corrida y los envía con `sendMessage`, solo al chat fijo.
- Entrante: `getUpdates` con offset persistido. Solo mensajes privados del chat fijo, con texto, de una persona y sin
  comando. Cada uno entra con `bench_supplier_reply`: el servidor lo marca no confiable como a cualquier proveedor.
- R30 doble: el destino está fijo aquí (y el .env debe coincidir), y el tope y el mandato siguen en el servidor.
- Idempotencia: el estado vive en `<corrida>/p07/puente.json`. Un saliente se anota como `enviando` ANTES de enviarlo:
  si el puente muere a mitad, al volver no lo reenvía (como mucho una vez) y la evidencia lo marca para revisar a mano.
- Primer arranque: lo que ya estaba en el bot (el `/start` y el «hola» viejos del owner) se descarta sin inyectarlo.

El adaptador de producto es `src/stock/supplier-telegram.ts` (`1b9defe`), probado solo en unidad.

Token: `~/.config/inventario-vivo/telegram-proveedor.env` (modo 600). Nunca se imprime ni se escribe.
Uso: python puente_telegram.py --corrida DIR [--una-vez] [--intervalo 5]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

AQUI = Path(__file__).resolve().parent
DESTINO = "8032357348"           # R30: el único chat al que este puente escribe y del que escucha
ENV_TOKEN = Path.home() / ".config/inventario-vivo/telegram-proveedor.env"
os.environ.setdefault("SIM_BANCO_ENV", str(Path.home() / ".config/inventario-vivo/banco-pi.env"))
sys.path.insert(0, str(AQUI.parents[1] / "stock-sim"))

SALIENTES_SQL = ("SELECT m.id, m.body, m.sent_at, m.blocked_reason FROM assistant.stock_supplier_messages m "
                 "JOIN assistant.stock_orders o ON o.id = m.order_id "
                 "WHERE o.run_id = $1 AND m.direction = 'saliente' ORDER BY m.recorded_at")


def ahora() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def huella(valor: str) -> str:
    return hashlib.sha256(valor.encode()).hexdigest()[:12]


def leer_token(ruta: Path = ENV_TOKEN) -> str:
    if stat.S_IMODE(ruta.stat().st_mode) & 0o077:
        raise SystemExit(f"{ruta} debe ser modo 600")
    env = {}
    for linea in ruta.read_text().splitlines():
        if "=" in linea and not linea.lstrip().startswith("#"):
            k, v = linea.split("=", 1)
            env[k.strip()] = v.strip().strip('"')
    if env.get("STOCK_SUPPLIER_DESTINATION") != DESTINO:
        raise SystemExit("STOCK_SUPPLIER_DESTINATION no es el destino fijo del puente")
    token = env.get("STOCK_SUPPLIER_TELEGRAM_TOKEN", "")
    if ":" not in token:
        raise SystemExit("falta STOCK_SUPPLIER_TELEGRAM_TOKEN")
    return token


class Telegram:
    """Bot API por HTTPS. Los errores nunca llevan el token."""

    def __init__(self, token: str):
        self._token = token

    def call(self, metodo: str, cuerpo: dict[str, Any]) -> Any:
        req = urllib.request.Request(f"https://api.telegram.org/bot{self._token}/{metodo}", data=json.dumps(cuerpo).encode(),
                                     method="POST", headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                resp = json.loads(r.read())
        except urllib.error.HTTPError as e:
            try:
                resp = json.loads(e.read() or b"{}")
            except ValueError:
                raise RuntimeError(f"telegram {metodo}: HTTP {e.code}") from None
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise RuntimeError(f"telegram {metodo}: red ({type(e).__name__})") from None
        if not resp.get("ok"):
            raise RuntimeError(f"telegram {metodo}: {resp.get('error_code')} {str(resp.get('description', ''))[:120].replace(self._token, '[R]')}")
        return resp["result"]


def es_del_proveedor(msg: dict[str, Any] | None) -> str | None:
    """El texto, si es un mensaje privado del destino fijo, de una persona y sin comando. Si no, None."""
    if not msg or msg.get("chat", {}).get("type") != "private":
        return None
    if str(msg["chat"].get("id")) != DESTINO or str(msg.get("from", {}).get("id")) != DESTINO or msg.get("from", {}).get("is_bot"):
        return None
    texto = msg.get("text")
    if not isinstance(texto, str) or not texto.strip() or texto.lstrip().startswith("/"):
        return None
    return texto


class Puente:
    def __init__(self, carpeta: Path, run_id: str, telegram: Any, salientes: Callable[[], list[dict[str, Any]]],
                 inyectar: Callable[[str], int]):
        self.dir = carpeta / "p07"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.ruta = self.dir / "puente.json"
        self.run_id, self.tg, self.salientes, self.inyectar = run_id, telegram, salientes, inyectar
        self.estado: dict[str, Any] = json.loads(self.ruta.read_text()) if self.ruta.exists() else {
            "run_id": run_id, "offset": None, "salientes": {}, "nota": "puente de banco, no el adaptador de producto"}
        if self.estado["run_id"] != run_id:
            raise SystemExit("el estado del puente es de otra corrida")

    def guardar(self) -> None:
        tmp = self.ruta.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.estado, ensure_ascii=False, indent=1) + "\n")
        tmp.replace(self.ruta)

    def evidencia(self, fila: dict[str, Any]) -> None:
        with open(self.dir / "puente.jsonl", "a") as f:
            f.write(json.dumps({"t": ahora(), "puente": "banco", "destino_huella": huella(DESTINO), **fila}, ensure_ascii=False) + "\n")

    def arrancar(self) -> None:
        """Primer arranque: confirma a Telegram todo lo pendiente sin inyectarlo (el /start y el «hola» viejos)."""
        if self.estado["offset"] is not None:
            return
        viejos = self.tg.call("getUpdates", {"timeout": 0, "limit": 100, "allowed_updates": ["message"]})
        ultimo = max((u["update_id"] for u in viejos), default=None)
        self.estado["offset"] = 0 if ultimo is None else ultimo + 1
        if ultimo is not None:
            self.tg.call("getUpdates", {"offset": ultimo + 1, "timeout": 0, "limit": 1})
        self.guardar()
        self.evidencia({"dir": "arranque", "descartados_sin_inyectar": len(viejos)})

    def enviar_salientes(self) -> int:
        n = 0
        for m in self.salientes():
            mid = str(m["id"])
            if mid in self.estado["salientes"]:
                continue                                   # ya enviado, ya visto o a medio enviar: nunca otra vez
            if m.get("blocked_reason") or not m.get("sent_at"):
                self.estado["salientes"][mid] = {"estado": "no_enviado", "motivo": m.get("blocked_reason") or "sin sent_at"}
                self.guardar()
                self.evidencia({"dir": "saliente", "stock_mensaje": mid, "estado": "no_enviado", "motivo": m.get("blocked_reason") or "sin sent_at"})
                continue
            self.estado["salientes"][mid] = {"estado": "enviando", "desde": ahora()}
            self.guardar()                                 # antes de enviar: un reinicio no lo repite
            r = self.tg.call("sendMessage", {"chat_id": DESTINO, "text": m["body"], "link_preview_options": {"is_disabled": True}})
            if str(r.get("chat", {}).get("id")) != DESTINO:
                raise SystemExit("Telegram respondió con otro chat: el puente se detiene")
            self.estado["salientes"][mid] = {"estado": "enviado", "telegram_id": r["message_id"], "en": ahora()}
            self.guardar()
            self.evidencia({"dir": "saliente", "stock_mensaje": mid, "estado": "enviado", "telegram_id": r["message_id"], "texto": m["body"]})
            n += 1
        return n

    def recibir(self) -> int:
        n = 0
        updates = self.tg.call("getUpdates", {"offset": self.estado["offset"], "timeout": 0, "limit": 100, "allowed_updates": ["message"]})
        for u in sorted(updates, key=lambda x: x["update_id"]):
            texto = es_del_proveedor(u.get("message"))
            if texto is None:
                self.evidencia({"dir": "entrante", "update_id": u["update_id"], "estado": "ignorado"})   # ni quién ni qué
            else:
                status = self.inyectar(texto)
                if status != 200:   # sin avanzar el offset: el próximo arranque lo reintenta
                    self.evidencia({"dir": "entrante", "update_id": u["update_id"], "estado": f"bench_supplier_reply {status}"})
                    raise SystemExit(f"bench_supplier_reply respondió {status}")
                self.evidencia({"dir": "entrante", "update_id": u["update_id"], "estado": "inyectado", "texto": texto})
                n += 1
            self.estado["offset"] = u["update_id"] + 1
            self.guardar()
        return n

    def vuelta(self) -> tuple[int, int]:
        self.arrancar()
        return self.enviar_salientes(), self.recibir()


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description="Puente de banco Stock ↔ Telegram (paso 7, IVB-024)")
    ap.add_argument("--corrida", required=True)
    ap.add_argument("--una-vez", action="store_true")
    ap.add_argument("--intervalo", type=float, default=5)
    a = ap.parse_args(argv)
    carpeta = Path(a.corrida)
    run_id = json.loads((carpeta / "estado.json").read_text())["run_id"]
    import devlab
    token = leer_token()
    devlab._SECRETS.append(token)
    banco, sql = devlab.Banco(), devlab.Sql()
    puente = Puente(carpeta, run_id, Telegram(token),
                    salientes=lambda: devlab.retry(lambda: sql.query(SALIENTES_SQL, [run_id])),
                    inyectar=lambda texto: banco.op({"op": "bench_supplier_reply", "texto": texto, "run_id": run_id})[0])
    print(f"puente de banco en marcha: corrida {run_id}, destino {huella(DESTINO)}")
    while True:
        try:
            enviados, recibidos = puente.vuelta()
        except RuntimeError as e:
            print(devlab.redact(str(e)), flush=True)
            enviados = recibidos = 0
        if enviados or recibidos:
            print(f"{ahora()} enviados {enviados}, recibidos {recibidos}", flush=True)
        if a.una_vez:
            return
        time.sleep(a.intervalo)


if __name__ == "__main__":
    main()
