import asyncio

import pytest

from saleads_brain.web import Blocked, Response, Web, canonical_url, check_url, extract_text

PUBLIC = {"example.com": ["93.184.216.34"], "news.google.com": ["142.250.78.14"], "www.bing.com": ["13.107.21.200"],
          "evil.com": ["93.184.216.35"], "rebind.com": ["10.0.0.5"], "v6.com": ["fd00::1"], "mapped.com": ["::ffff:169.254.169.254"]}


def resolve(host: str) -> list[str]:
    if host not in PUBLIC:
        raise OSError("nxdomain")
    return PUBLIC[host]


def rss(*items: tuple[str, str, str]) -> bytes:
    body = "".join(f"<item><title>{t}</title><link>{u}</link><pubDate>{d}</pubDate><description>x</description></item>"
                   for t, u, d in items)
    return f"<?xml version='1.0'?><rss><channel>{body}</channel></rss>".encode()


class FakeHttp:
    def __init__(self, routes: dict[str, Response]) -> None:
        self.routes = routes
        self.calls: list[str] = []

    async def __call__(self, url: str) -> Response:
        self.calls.append(url)
        for prefix, response in self.routes.items():
            if url.startswith(prefix):
                return response
        return Response(404, {}, b"")


HTML = "<html><head><title>Kits capilares</title><script>var x=1</script></head><body><nav>menu</nav>" + \
       "<article><p>" + "Texto real del artículo sobre kits capilares. " * 10 + "</p></article></body></html>"


@pytest.mark.parametrize("url", [
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://169.254.169.254/latest",
    "http://saleads-brain:8765/run/x",
    "http://hermes:8642/",
    "http://localhost/",
    "http://127.0.0.1/",
    "http://[::1]/",
    "http://rebind.com/",
    "http://v6.com/",
    "http://mapped.com/",
    "http://example.com:8080/",
    "file:///etc/passwd",
    "http://user:pw@example.com/",
])
def test_check_url_blocks_internal_targets(url) -> None:
    with pytest.raises(Blocked):
        check_url(url, resolve)


def test_leer_blocks_internal_and_redirects_to_internal() -> None:
    http = FakeHttp({"https://evil.com/robots.txt": Response(404, {}, b""),
                     "https://evil.com/": Response(302, {"location": "http://169.254.169.254/latest"}, b"")})
    web = Web(fetch=http, resolve=resolve)
    for url in ["http://metadata.google.internal/x", "http://169.254.169.254/x", "http://saleads-brain:8765/run/x", "http://hermes:8642/"]:
        out = asyncio.run(web.leer(url))
        assert out["estado"] == "error" and out["motivo"] in {"host_interno", "ip_no_publica", "puerto_o_credenciales_no_permitidos"}
    assert http.calls == []
    out = asyncio.run(web.leer("https://evil.com/page"))
    assert out == {**out, "estado": "error", "motivo": "ip_no_publica"}
    assert not any("169.254" in call for call in http.calls)


def test_leer_extracts_main_text_and_caches() -> None:
    http = FakeHttp({"https://example.com/robots.txt": Response(200, {}, b"User-agent: *\nDisallow: /privado\n"),
                     "https://example.com/": Response(200, {"content-type": "text/html; charset=utf-8"}, HTML.encode())})
    web = Web(fetch=http, resolve=resolve)
    out = asyncio.run(web.leer("https://example.com/kits"))
    assert out["estado"] == "ok" and out["titulo"] == "Kits capilares" and "Texto real" in out["texto"]
    assert "menu" not in out["texto"] and "var x" not in out["texto"] and out["truncado"] is False
    calls = len(http.calls)
    assert asyncio.run(web.leer("https://example.com/kits"))["cache"] is True and len(http.calls) == calls
    assert asyncio.run(web.leer("https://example.com/privado/x"))["motivo"] == "robots_no_permite"


@pytest.mark.parametrize(("response", "estado"), [
    (Response(429, {}, b""), "limitado"),
    (Response(200, {"content-type": "text/html"}, b"<html>Please solve this CAPTCHA</html>"), "captcha"),
    (Response(200, {"content-type": "text/html"}, b"<html><body></body></html>"), "vacio"),
    (Response(200, {"content-type": "application/pdf"}, b"%PDF"), "error"),
    (Response(500, {}, b""), "error"),
])
def test_leer_reports_state_and_reason(response, estado) -> None:
    web = Web(fetch=FakeHttp({"https://example.com/robots.txt": Response(404, {}, b""), "https://example.com/": response}),
              resolve=resolve)
    out = asyncio.run(web.leer("https://example.com/a"))
    assert out["estado"] == estado and out["motivo"]


def test_buscar_dedupes_across_sources_and_keeps_provenance() -> None:
    google = rss(("Kits capilares crecen en Colombia - El Tiempo", "https://example.com/a?utm_source=x", "Sat, 31 Oct 2026 10:00:00 GMT"),
                 ("Otra nota", "https://example.com/b", "Sun, 01 Nov 2026 10:00:00 GMT"))
    bing = rss(("Kits capilares crecen en Colombia", "https://example.com/a/", "Sat, 31 Oct 2026 10:00:00 GMT"),
               ("Nota vieja", "https://example.com/c", "Wed, 28 Oct 2026 10:00:00 GMT"))
    http = FakeHttp({"https://news.google.com/": Response(200, {}, google), "https://www.bing.com/": Response(200, {}, bing)})
    out = asyncio.run(Web(fetch=http, resolve=resolve).buscar("kits capilares", desde="2026-10-30"))
    assert out["estado"] == "ok" and out["fuentes"]["google_news"]["estado"] == "ok"
    titles = [r["titulo"] for r in out["resultados"]]
    assert titles == ["Kits capilares crecen en Colombia - El Tiempo", "Otra nota"]
    first = out["resultados"][0]
    assert first["publicado"] == "2026-10-31T10:00:00+00:00" and first["consultado"] and first["fuente_rss"] == "google_news"


def test_buscar_reports_captcha_rate_limit_and_empty() -> None:
    http = FakeHttp({"https://news.google.com/": Response(429, {}, b""),
                     "https://www.bing.com/": Response(200, {}, b"<html>captcha</html>")})
    out = asyncio.run(Web(fetch=http, resolve=resolve).buscar("x"))
    assert out["estado"] == "error" and out["resultados"] == []
    assert out["fuentes"] == {"google_news": {"estado": "limitado", "motivo": "http_429"}, "bing": {"estado": "captcha", "motivo": "http_200"}}
    empty = FakeHttp({"https://": Response(200, {}, rss())})
    assert asyncio.run(Web(fetch=empty, resolve=resolve).buscar("x"))["estado"] == "vacio"
    limited = Web(fetch=empty, resolve=resolve, per_minute=0)
    assert asyncio.run(limited.buscar("y"))["fuentes"]["bing"]["motivo"] == "limite_por_minuto"


def test_xml_bombs_are_refused() -> None:
    bomb = b'<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]><rss><channel><item><title>&b;</title></item></channel></rss>'
    http = FakeHttp({"https://": Response(200, {}, bomb)})
    out = asyncio.run(Web(fetch=http, resolve=resolve).buscar("x"))
    assert out["fuentes"]["google_news"]["estado"] == "error"


def test_helpers() -> None:
    assert canonical_url("HTTPS://Example.com/a/?utm_source=x&id=2#top") == "https://example.com/a?id=2"
    assert extract_text("<title>T</title><p>Hola mundo</p><style>x{}</style>") == ("T", "Hola mundo")


def test_user_agent_is_ascii_and_honest() -> None:
    from saleads_brain.web import USER_AGENT

    assert USER_AGENT.isascii() and "SaleADS" in USER_AGENT and "saleads.ai" in USER_AGENT
