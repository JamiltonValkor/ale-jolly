"""Dueña sintética de Masquebella (Daniela), para Meta Assistant con inventario.

Procedencia: `docs/tasks/saleads-agente-marketing-loop-v1/pruebas/e2e/sim/owner.py` (sale -ads, sha en README). Se
conservan la ficha YAML que se vive y no se cita, el historial en disco, la lectura en JSON antes de escribir, la
decisión de aprobación con «entiendo» (qué cree que aprueba) y la prohibición de OpenRouter. Cambia:

- Modelo: Muse (`muse-spark-1.3-contributor`, API de Meta), no `gpt-6-luna`: en una VM con Muse el puente de Hermes con
  `openai-codex` no existe (tarea 023, O-8). Sigue prohibido OpenRouter.
- `SYSTEM` reescrito: el original no conoce Stock. Daniela habla con Jolly por voz, confirma conteos de viva voz, da la
  causa de una diferencia solo con lo que sabe, y aprueba lo que implica plata en la pantalla de Stock (R4).
- Sin panel de límites ni campañas: aquí el panel es la pantalla de Stock.

La dueña no ve el mundo secreto: solo los `hechos` que el reloj le da (lo que ella sabe de su día).
"""

from __future__ import annotations

import json
import os
import urllib.request
from pathlib import Path
from typing import Any

import yaml

MODEL = os.environ.get("SIM_OWNER_MODEL") or "muse-spark-1.3-contributor"
URL = os.environ.get("SIM_LLM_URL") or "https://api.meta.ai/v1/responses"
if "openrouter" in URL.lower() or "openrouter" in MODEL.lower() or "deepseek" in MODEL.lower():
    raise SystemExit("el simulador no usa OpenRouter ni deepseek: SIM_LLM_URL debe ser la API de Meta")
# Precio de lista de Muse Contributor (progress.md, IVB-021): US$ por millón de tokens.
PRICE_IN, PRICE_OUT = 0.10, 0.20

SYSTEM = """Eres {nombre}, {edad} años, dueña de {negocio} en {ciudad}. Hablas SIEMPRE como esta persona, en {idioma}.
Tu ficha (no la cites, vívela):
{ficha}

Cómo funciona tu día:
- Le hablas por voz a Jolly, el robot de tu mostrador. Jolly lleva el inventario con su equipo (Stock) y te habla por
  iniciativa propia cuando ve algo. Lo que te dice, lo oyes; lo que le contestas, se lo dices en voz alta.
- Tu inventario lo confirmas tú: si Jolly te dice un conteo y te pide confirmarlo, solo dices que sí si te cuadra con lo
  que sabes. Si te pregunta por qué falta o sobra algo, das la causa solo si la sabes (está en tus hechos del día); si
  no la sabes, dices que no sabes.
- Lo que implica plata (compras a proveedores, facturas, kits, pauta) lo apruebas o rechazas tú en la pantalla de Stock
  de SaleADS, nunca de palabra. Si Jolly te dice que hay algo por aprobar, dices que lo vas a revisar en la pantalla.
- Las facturas te llegan en papel o por WhatsApp. Solo tienes conectado lo que dice tu ficha.
- Hablas corto, natural, como en el mostrador: 1 a 3 frases, texto plano, sin listas ni emojis.
- No sabes nada técnico (IDs, herramientas, SAM, Hermes). Si te piden algo técnico, te confundes y lo dices.
- No inventas cantidades, causas, precios ni proveedores. Lo que no está en tu ficha o en tus hechos del día, no lo sabes.
- Nunca dices que eres una IA ni que esto es una prueba."""

READ = """Esto te dijo Jolly, el robot de tu tienda:
---
{jolly}
---
Responde SOLO un JSON:
{{"pregunta": <true si te hace una pregunta o te pide algo que espera respuesta>,
"pide_confirmar_conteo": <true si te pide confirmar una cantidad contada>,
"cantidad": <el número que te pide confirmar, o null>,
"pide_causa": <true si te pregunta por qué hay diferencia (venta, fiado, movimiento u otra)>,
"pide_variante": <true si te pregunta de qué variante, color o tipo son unos productos>,
"pide_factura": <true si te pide mandar una factura o documento>,
"dice_conectar_canal": <true si te dice que conectes WhatsApp o Telegram en SaleADS>,
"pide_aprobar_en_pantalla": <true si te dice que hay algo para aprobar en la pantalla o en SaleADS>}}"""

WRITE = """Jolly te dijo:
---
{jolly}
---
Tus hechos de hoy (lo único que sabes del día, además de tu ficha):
{hechos}
Contéstale como {nombre}, de viva voz, corto. Contesta lo que te preguntó con tus hechos; si no lo sabes, dilo.
Responde solo con lo que dices."""

DECIDE = """En la pantalla de Stock de SaleADS ves esta propuesta para aprobar:
---
{texto}
---
Tus reglas de plata (de tu ficha): {reglas}
Tus hechos de hoy: {hechos}
Responde SOLO un JSON con valores en {idioma}:
{{"entiendo": "<con tus palabras, qué crees que apruebas y cuánto te cuesta>", "decision": "aprobar" | "rechazar" | "esperar",
"motivo": "<una frase>"}}"""


def _text(out: dict[str, Any]) -> str:
    return "".join(c.get("text", "") for item in out.get("output", []) for c in (item.get("content") or []) if c.get("type") == "output_text").strip()


def _json(raw: str) -> dict[str, Any]:
    try:
        return json.loads(raw[raw.find("{"): raw.rfind("}") + 1])
    except ValueError:
        return {}


class Owner:
    def __init__(self, card_path: Path, api_key: str | None = None, chat=None):
        self.card = yaml.safe_load(card_path.read_text(encoding="utf-8"))
        self.api_key = api_key or os.environ.get("META_API_KEY", "")
        self.history: list[dict[str, str]] = []
        self.history_path: Path | None = None
        self.usage = {"input_tokens": 0, "output_tokens": 0, "llamadas": 0}
        self._chat_impl = chat  # pruebas: doble sin red

    def keep_history(self, path: Path) -> None:
        self.history_path = path
        if path.exists():
            self.history = json.loads(path.read_text(encoding="utf-8"))

    def _save(self) -> None:
        if self.history_path:
            self.history_path.write_text(json.dumps(self.history, ensure_ascii=False, indent=1), encoding="utf-8")

    def system(self) -> str:
        c = self.card
        ficha = {k: v for k, v in c.items() if k not in ("perfil",)}
        return SYSTEM.format(nombre=c["nombre"], edad=c["edad"], negocio=c["negocio"]["nombre"], ciudad=c["ciudad"], idioma=c["idioma"],
                             ficha=yaml.safe_dump(ficha, allow_unicode=True, sort_keys=False))

    def _chat(self, messages: list[dict[str, str]]) -> str:
        if self._chat_impl:
            return self._chat_impl(messages)
        body = {"model": MODEL, "store": False, "input": messages, "reasoning": {"effort": "low"}}
        req = urllib.request.Request(URL, data=json.dumps(body).encode(), headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as res:
            out = json.loads(res.read())
        u = out.get("usage") or {}
        self.usage["input_tokens"] += int(u.get("input_tokens", 0))
        self.usage["output_tokens"] += int(u.get("output_tokens", 0))
        self.usage["llamadas"] += 1
        return _text(out)

    def cost_usd(self) -> float:
        return self.usage["input_tokens"] / 1e6 * PRICE_IN + self.usage["output_tokens"] / 1e6 * PRICE_OUT

    def read(self, jolly: str) -> dict[str, Any]:
        return _json(self._chat([{"role": "user", "content": READ.format(jolly=jolly[-4000:])}]))

    def say(self, jolly: str, hechos: list[str]) -> str:
        """Contesta lo que dijo Jolly, de viva voz, con sus hechos del día."""
        prompt = WRITE.format(jolly=jolly[-4000:], hechos="\n".join(f"- {h}" for h in hechos) or "- Nada especial.", nombre=self.card["nombre"])
        msg = self._chat([{"role": "system", "content": self.system()}, *self.history[-12:], {"role": "user", "content": prompt}])
        self.history += [{"role": "user", "content": jolly[-1500:]}, {"role": "assistant", "content": msg}]
        self._save()
        return msg

    def opener(self, intencion: str, hechos: list[str]) -> str:
        """Lo que Daniela le dice a Jolly por iniciativa propia (guion del día), en su voz."""
        prompt = (f"Dile a Jolly, de viva voz y corto, esto que quieres: {intencion}\nTus hechos de hoy:\n" +
                  "\n".join(f"- {h}" for h in hechos) + "\nResponde solo con lo que dices.")
        msg = self._chat([{"role": "system", "content": self.system()}, *self.history[-8:], {"role": "user", "content": prompt}])
        self.history.append({"role": "assistant", "content": msg})
        self._save()
        return msg

    def decide(self, proposal_text: str, hechos: list[str]) -> dict[str, str]:
        """Decisión sobre una propuesta de la pantalla. Lo que no entiende o no le cuadra, lo deja esperando."""
        reglas = "; ".join(str(x) for x in self.card.get("reglas_de_plata", []))
        out = _json(self._chat([{"role": "system", "content": self.system()},
                                {"role": "user", "content": DECIDE.format(texto=proposal_text[-3000:], reglas=reglas, hechos="; ".join(hechos) or "nada",
                                                                          idioma=self.card["idioma"])}]))
        if out.get("decision") not in ("aprobar", "rechazar", "esperar"):
            out["decision"] = "esperar"
        return {"entiendo": str(out.get("entiendo", ""))[:400], "decision": out["decision"], "motivo": str(out.get("motivo", ""))[:300]}
