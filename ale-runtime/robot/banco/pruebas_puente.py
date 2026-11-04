"""Pruebas del puente de banco Stock ↔ Telegram (IVB-024, paso 7). Telegram y servidor simulados: nada sale a la red.
   uv run --no-project --with pytest python -m pytest robot/banco/pruebas_puente.py -q
Cada prueba cae si se quita la regla que nombra."""
import json
import os

import pytest

import puente_telegram as pt
from puente_telegram import DESTINO, Puente

RUN = "11111111-2222-4333-8444-555555555555"


class TelegramFalso:
    def __init__(self, updates=(), chat_respuesta=None):
        self.updates, self.enviados, self.llamadas = list(updates), [], []
        self.chat_respuesta = chat_respuesta
        self.n = 100

    def call(self, metodo, cuerpo):
        self.llamadas.append((metodo, cuerpo))
        if metodo == "sendMessage":
            self.n += 1
            self.enviados.append(cuerpo)
            return {"message_id": self.n, "chat": {"id": int(self.chat_respuesta or cuerpo["chat_id"])}}
        offset = cuerpo.get("offset")
        if offset is not None:
            self.updates = [u for u in self.updates if u["update_id"] >= offset]   # como Telegram: offset confirma lo anterior
        return list(self.updates)


def msg(uid, texto="a 24.000", chat=DESTINO, de=DESTINO, tipo="private", bot=False):
    m = {"message_id": uid, "chat": {"id": int(chat), "type": tipo}, "from": {"id": int(de), "is_bot": bot}}
    if texto is not None:
        m["text"] = texto
    return {"update_id": uid, "message": m}


class Servidor:
    def __init__(self, status=200):
        self.salientes, self.inyectados, self.status = [], [], status

    def leer(self):
        return list(self.salientes)

    def inyectar(self, texto):
        if self.status == 200:
            self.inyectados.append(texto)
        return self.status


def puente(tmp_path, tg, srv):
    return Puente(tmp_path, RUN, tg, srv.leer, srv.inyectar)


def saliente(i, body="Hola, soy el asistente virtual de Masquebella", sent=True, bloqueado=None):
    return {"id": f"m{i}", "body": body, "sent_at": "2026-10-27T10:00:00Z" if sent else None, "blocked_reason": bloqueado}


# ---- Primer arranque ---------------------------------------------------------------------------------------------

def test_primer_arranque_descarta_el_start_y_el_hola_viejos_sin_inyectarlos(tmp_path):
    tg, srv = TelegramFalso([msg(1, "/start"), msg(2, "hola")]), Servidor()
    puente(tmp_path, tg, srv).vuelta()
    assert srv.inyectados == []
    assert tg.updates == []                                          # confirmados a Telegram
    assert json.loads((tmp_path / "p07" / "puente.json").read_text())["offset"] == 3   # y el offset propio pasa encima
    tg.updates.append(msg(3, "le dejo a 24.000"))
    puente(tmp_path, tg, srv).vuelta()
    assert srv.inyectados == ["le dejo a 24.000"]


# ---- Entrante: solo el proveedor fijo, en privado, persona, texto, sin comando ------------------------------------

@pytest.mark.parametrize("ajeno", [
    msg(10, chat="-100200", tipo="supergroup"),   # grupo
    msg(10, chat="999", de="999"),                # otra cuenta
    msg(10, chat=DESTINO, de="999"),              # otro remitente en el chat
    msg(10, bot=True),                            # bot
    msg(10, "/start"),                            # comando
    msg(10, texto=None),                          # sin texto (foto, sticker)
    msg(10, chat=DESTINO, tipo="group"),          # tipo no privado aunque el id coincida
    msg(10, chat="999", de=DESTINO),              # el proveedor, pero desde otro chat
    msg(10, "   "),                               # texto vacío
])
def test_entrante_ajeno_no_entra(tmp_path, ajeno):
    tg, srv = TelegramFalso(), Servidor()
    p = puente(tmp_path, tg, srv)
    p.arrancar()
    tg.updates.append(ajeno)
    p.recibir()
    assert srv.inyectados == []
    assert p.estado["offset"] == 11                                  # se confirma igual: no vuelve a leerse


def test_entrante_del_proveedor_entra_una_sola_vez_aunque_se_reinicie(tmp_path):
    tg, srv = TelegramFalso(), Servidor()
    puente(tmp_path, tg, srv).arrancar()
    tg.updates.append(msg(20, "acépteme 24.000"))
    puente(tmp_path, tg, srv).vuelta()
    tg.updates.append(msg(20, "acépteme 24.000"))                    # Telegram lo vuelve a entregar sin offset
    puente(tmp_path, tg, srv).vuelta()
    assert srv.inyectados == ["acépteme 24.000"]
    assert json.loads((tmp_path / "p07" / "puente.json").read_text())["offset"] == 21


def test_si_el_servidor_no_lo_acepta_no_avanza_el_offset(tmp_path):
    tg, srv = TelegramFalso(), Servidor(status=503)
    p = puente(tmp_path, tg, srv)
    p.arrancar()
    tg.updates.append(msg(30, "19.000"))
    with pytest.raises(SystemExit):
        p.recibir()
    assert p.estado["offset"] == 0
    srv.status = 200
    puente(tmp_path, tg, srv).recibir()
    assert srv.inyectados == ["19.000"]


# ---- Saliente: solo lo enviado por Stock, solo al destino fijo, como mucho una vez --------------------------------

def test_saliente_va_solo_al_destino_fijo(tmp_path):
    tg, srv = TelegramFalso(), Servidor()
    srv.salientes = [saliente(1)]
    puente(tmp_path, tg, srv).vuelta()
    assert [e["chat_id"] for e in tg.enviados] == [DESTINO]


def test_saliente_bloqueado_o_sin_enviar_no_sale(tmp_path):
    tg, srv = TelegramFalso(), Servidor()
    srv.salientes = [saliente(1, bloqueado="sobre_tope"), saliente(2, sent=False), saliente(3, "ok")]
    puente(tmp_path, tg, srv).vuelta()
    assert [e["text"] for e in tg.enviados] == ["ok"]


def test_reiniciar_no_reenvia(tmp_path):
    tg, srv = TelegramFalso(), Servidor()
    srv.salientes = [saliente(1)]
    puente(tmp_path, tg, srv).vuelta()
    puente(tmp_path, tg, srv).vuelta()
    srv.salientes.append(saliente(2, "segundo"))
    puente(tmp_path, tg, srv).vuelta()
    assert [e["text"] for e in tg.enviados] == [saliente(1)["body"], "segundo"]


def test_muerto_a_mitad_de_envio_no_se_repite(tmp_path):
    class Cae(TelegramFalso):
        def call(self, metodo, cuerpo):
            if metodo == "sendMessage":
                raise RuntimeError("telegram sendMessage: red")
            return super().call(metodo, cuerpo)
    srv = Servidor()
    srv.salientes = [saliente(1)]
    with pytest.raises(RuntimeError):
        puente(tmp_path, Cae(), srv).vuelta()
    tg = TelegramFalso()
    puente(tmp_path, tg, srv).vuelta()
    assert tg.enviados == []                                         # como mucho una vez: queda «enviando» para revisar
    assert json.loads((tmp_path / "p07" / "puente.json").read_text())["salientes"]["m1"]["estado"] == "enviando"


def test_respuesta_de_otro_chat_detiene_el_puente(tmp_path):
    srv = Servidor()
    srv.salientes = [saliente(1)]
    with pytest.raises(SystemExit):
        puente(tmp_path, TelegramFalso(chat_respuesta="999"), srv).vuelta()


# ---- Credencial y evidencia --------------------------------------------------------------------------------------

def _env(tmp_path, destino=DESTINO, modo=0o600):
    ruta = tmp_path / "t.env"
    ruta.write_text(f"STOCK_SUPPLIER_TELEGRAM_TOKEN=123456:SECRETO-de-prueba\nSTOCK_SUPPLIER_DESTINATION={destino}\n")
    os.chmod(ruta, modo)
    return ruta


def test_el_env_debe_ser_600_y_con_el_destino_fijo(tmp_path):
    assert pt.leer_token(_env(tmp_path)) == "123456:SECRETO-de-prueba"
    with pytest.raises(SystemExit):
        pt.leer_token(_env(tmp_path, modo=0o644))
    with pytest.raises(SystemExit):
        pt.leer_token(_env(tmp_path, destino="999"))


def test_la_evidencia_no_lleva_token_ni_destino_en_claro_y_dice_que_es_de_banco(tmp_path):
    tg, srv = TelegramFalso([msg(1, "hola")]), Servidor()
    srv.salientes = [saliente(1)]
    p = puente(tmp_path, tg, srv)
    p.vuelta()
    tg.updates.append(msg(2, "a 21.500"))
    p.vuelta()
    texto = (tmp_path / "p07" / "puente.jsonl").read_text() + (tmp_path / "p07" / "puente.json").read_text()
    assert DESTINO not in texto and "SECRETO" not in texto
    filas = [json.loads(x) for x in (tmp_path / "p07" / "puente.jsonl").read_text().splitlines()]
    assert all(f["puente"] == "banco" for f in filas)
    assert [f["dir"] for f in filas] == ["arranque", "saliente", "entrante"]


def test_el_error_de_telegram_no_lleva_el_token():
    t = pt.Telegram("123456:SECRETO-de-prueba")
    t._token = "123456:SECRETO-de-prueba"
    import urllib.request

    def falla(*a, **k):
        raise pt.urllib.error.URLError("api.telegram.org/bot123456:SECRETO-de-prueba/sendMessage")
    orig, urllib.request.urlopen = urllib.request.urlopen, falla
    try:
        with pytest.raises(RuntimeError) as e:
            t.call("sendMessage", {"chat_id": DESTINO, "text": "x"})
    finally:
        urllib.request.urlopen = orig
    assert "SECRETO" not in str(e.value)


def test_el_estado_de_otra_corrida_no_se_mezcla(tmp_path):
    puente(tmp_path, TelegramFalso(), Servidor()).arrancar()
    with pytest.raises(SystemExit):
        Puente(tmp_path, "99999999-2222-4333-8444-555555555555", TelegramFalso(), Servidor().leer, Servidor().inyectar)
