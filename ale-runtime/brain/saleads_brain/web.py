"""Búsqueda gratuita del investigador (MLB-006, D38/D42): RSS y lectura de URL.

Inspirada en el radar de ORQA personal. `buscar` consulta Google News RSS y
Bing RSS y deduplica; `leer` extrae el texto principal de una página. Todo
resultado trae su procedencia y su fecha, y todo fallo un `estado` con su
`motivo`: nunca se presenta un hueco como si fuera un dato.

`leer` abre URLs que elige el agente, así que se protege contra SSRF: solo
http/https por 80/443, el nombre se resuelve y se rechazan IPs privadas,
loopback, link-local (la metadata de GCE), ULA y los nombres de la red docker;
se revalida en cada redirección. Nunca registra las URLs ni el contenido.
"""

from __future__ import annotations

import asyncio
import ipaddress
import re
import socket
import time
import unicodedata
import urllib.parse
import urllib.robotparser
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from typing import Any
from xml.etree.ElementTree import ParseError

import defusedxml.ElementTree as SafeET
import httpx2 as httpx

USER_AGENT = "SaleADS-research-bot/1.0 (+https://saleads.ai; market research for a small business owner)"
MAX_BYTES = 2_000_000
TIMEOUT_S = 10.0
MAX_REDIRECTS = 3
CACHE_TTL_S = 20 * 60
PER_MINUTE = 30
MAX_TEXT = 20_000
MAX_RESULTS = 20
BLOCKED_HOSTS = {"hermes", "falkordb", "saleads-brain", "metadata", "metadata.google.internal", "localhost"}
TRACKING = re.compile(r"^(utm_|fbclid$|gclid$|mc_|ref$|ocid$)")


@dataclass
class Response:
    status: int
    headers: dict[str, str]
    body: bytes


Fetch = Callable[[str], Awaitable[Response]]
Resolve = Callable[[str], list[str]]


class Blocked(Exception):
    """La URL apunta a algo que no es internet público."""


def _resolve(host: str) -> list[str]:
    return sorted({str(info[4][0]) for info in socket.getaddrinfo(host, None)})


async def _fetch(url: str) -> Response:
    async with (
        httpx.AsyncClient(timeout=httpx.Timeout(TIMEOUT_S), follow_redirects=False) as client,
        client.stream("GET", url, headers={"User-Agent": USER_AGENT, "Accept-Language": "es,en;q=0.8"}) as response,
    ):
        body = b""
        async for chunk in response.aiter_bytes():
            body += chunk
            if len(body) > MAX_BYTES:
                body = body[:MAX_BYTES]
                break
        return Response(response.status_code, {k.lower(): v for k, v in response.headers.items()}, body)


def check_url(url: str, resolve: Resolve) -> str:
    """Devuelve la URL si apunta a internet público; si no, `Blocked` con el motivo."""
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise Blocked("esquema_no_permitido")
    if parts.port not in (None, 80, 443) or parts.username or parts.password:
        raise Blocked("puerto_o_credenciales_no_permitidos")
    host = (parts.hostname or "").rstrip(".").lower()
    if not host or host in BLOCKED_HOSTS or host.endswith((".internal", ".local", ".localhost")) or "." not in host:
        raise Blocked("host_interno")
    try:
        addresses = [ipaddress.ip_address(host)]
    except ValueError:
        try:
            addresses = [ipaddress.ip_address(a.split("%")[0]) for a in resolve(host)]
        except OSError as error:
            raise Blocked("dns_no_resuelve") from error
    if not addresses:
        raise Blocked("dns_no_resuelve")
    for address in addresses:
        if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
            address = address.ipv4_mapped
        if not address.is_global or address.is_multicast:
            raise Blocked("ip_no_publica")
    return url


def _normal_title(title: str) -> str:
    text = unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode().casefold()
    text = re.sub(r"\s+-\s+[^-]{1,60}$", "", text)  # Google News agrega « - Fuente»
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def canonical_url(url: str) -> str:
    parts = urllib.parse.urlsplit(url.strip())
    query = urllib.parse.urlencode(
        [(k, v) for k, v in urllib.parse.parse_qsl(parts.query) if not TRACKING.match(k.lower())]
    )
    path = parts.path.rstrip("/") or "/"
    return urllib.parse.urlunsplit((parts.scheme.lower(), (parts.hostname or "").lower(), path, query, ""))


def _date(raw: str | None) -> str | None:
    if not raw:
        return None
    try:
        parsed = parsedate_to_datetime(raw)
    except (TypeError, ValueError):
        return None
    return (parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)).astimezone(UTC).isoformat()


class _TextExtractor(HTMLParser):
    SKIP = {"script", "style", "noscript", "svg", "nav", "footer", "header", "form", "aside", "template"}
    BLOCK = {"p", "div", "li", "h1", "h2", "h3", "h4", "br", "tr", "section", "article", "blockquote"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.skipping = 0
        self.title = ""
        self.in_title = False
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in self.SKIP:
            self.skipping += 1
        elif tag == "title":
            self.in_title = True
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in self.SKIP and self.skipping:
            self.skipping -= 1
        elif tag == "title":
            self.in_title = False

    def handle_data(self, data: str) -> None:
        if self.in_title:
            self.title += data
        elif not self.skipping:
            self.parts.append(data)

    def text(self) -> str:
        lines = (re.sub(r"[ \t\r\f\v]+", " ", line).strip() for line in "".join(self.parts).split("\n"))
        return "\n".join(line for line in lines if len(line) > 1)


def extract_text(html: str) -> tuple[str, str]:
    parser = _TextExtractor()
    parser.feed(html)
    parser.close()
    return parser.title.strip(), parser.text()


def _blocked_page(response: Response) -> str | None:
    """CAPTCHA o límite. Una página grande que solo menciona «captcha» en su código no es un bloqueo."""
    if response.status == 429:
        return "limitado"
    head = response.body[:20_000].lower()
    title = re.search(rb"<title[^>]*>(.*?)</title>", head, re.S)
    challenge = b"captcha" in (title.group(1) if title else b"") or b"unusual traffic" in head
    small = len(response.body) < 30_000 and b"captcha" in head
    if challenge or (small and (response.status in (403, 503) or b"<rss" not in head)):
        return "captcha"
    return None


@dataclass
class Web:
    fetch: Fetch = _fetch
    resolve: Resolve = _resolve
    clock: Callable[[], float] = time.monotonic
    per_minute: int = PER_MINUTE
    _cache: dict[tuple[Any, ...], tuple[float, dict[str, Any]]] = field(default_factory=dict)
    _calls: deque[float] = field(default_factory=deque)
    _robots: dict[str, urllib.robotparser.RobotFileParser | None] = field(default_factory=dict)

    def _cached(self, key: tuple[Any, ...]) -> dict[str, Any] | None:
        hit = self._cache.get(key)
        return hit[1] if hit and self.clock() - hit[0] < CACHE_TTL_S else None

    def _allow_call(self) -> bool:
        now = self.clock()
        while self._calls and now - self._calls[0] > 60:
            self._calls.popleft()
        if len(self._calls) >= self.per_minute:
            return False
        self._calls.append(now)
        return True

    async def _get(self, url: str) -> Response:
        """GET con redirecciones revalidadas (máximo 3). Lanza `Blocked` si alguna sale de internet público."""
        current = check_url(url, self.resolve)
        for _ in range(MAX_REDIRECTS + 1):
            response = await asyncio.wait_for(self.fetch(current), timeout=TIMEOUT_S + 2)
            location = response.headers.get("location")
            if response.status in (301, 302, 303, 307, 308) and location:
                current = check_url(urllib.parse.urljoin(current, location), self.resolve)
                continue
            return response
        raise Blocked("demasiadas_redirecciones")

    # ------------------------------------------------------------------ buscar

    async def buscar(
        self, query: str, idioma: str = "es", pais: str = "CO", desde: str | None = None
    ) -> dict[str, Any]:
        query = query.strip()[:300]
        idioma = idioma.strip().lower()[:2] or "es"
        pais = pais.strip().upper()[:2] or "CO"
        consulted = datetime.now(UTC).isoformat()
        if not query:
            return {"estado": "error", "motivo": "consulta_vacia", "fuentes": {}, "resultados": []}
        key = ("buscar", query.casefold(), idioma, pais, desde)
        if (hit := self._cached(key)) is not None:
            return {**hit, "cache": True}
        q = urllib.parse.quote(query)
        hl = f"{idioma}-419" if idioma == "es" else f"{idioma}-{pais}"
        sources = {
            "google_news": f"https://news.google.com/rss/search?q={q}&hl={hl}&gl={pais}&ceid={pais}:{hl}",
            # Sin setlang/cc: con ellos Bing devuelve vacío desde la salida de dev (compuerta MLB-006).
            "bing": f"https://www.bing.com/search?q={q}&format=rss",
        }
        since = _date_iso(desde)
        fuentes: dict[str, dict[str, str]] = {}
        seen_urls: set[str] = set()
        seen_titles: set[str] = set()
        results: list[dict[str, Any]] = []
        for name, url in sources.items():
            status, items = await self._rss(url)
            fuentes[name] = status
            for item in items:
                canon, title = canonical_url(item["url"]), _normal_title(item["titulo"])
                if not title or canon in seen_urls or title in seen_titles:
                    continue
                if since and item["publicado"] and item["publicado"] < since:
                    continue
                seen_urls.add(canon)
                seen_titles.add(title)
                results.append({**item, "fuente_rss": name, "consultado": consulted})
        estado = "ok" if results else ("vacio" if any(s["estado"] == "vacio" for s in fuentes.values()) else "error")
        out: dict[str, Any] = {
            "estado": estado,
            "motivo": "" if results else "; ".join(f"{k}: {v['motivo']}" for k, v in fuentes.items()),
            "fuentes": fuentes,
            "resultados": results[:MAX_RESULTS],
        }
        if results:
            self._cache[key] = (self.clock(), out)
        return out

    async def _rss(self, url: str) -> tuple[dict[str, str], list[dict[str, Any]]]:
        if not self._allow_call():
            return {"estado": "limitado", "motivo": "limite_por_minuto"}, []
        try:
            response = await self._get(url)
        except Blocked as error:
            return {"estado": "error", "motivo": str(error)}, []
        except (httpx.HTTPError, TimeoutError, OSError) as error:
            return {"estado": "error", "motivo": type(error).__name__}, []
        if (blocked := _blocked_page(response)) is not None:
            return {"estado": blocked, "motivo": f"http_{response.status}"}, []
        if response.status >= 400:
            return {"estado": "error", "motivo": f"http_{response.status}"}, []
        try:
            root = SafeET.fromstring(response.body)
        except (ParseError, ValueError):
            return {"estado": "error", "motivo": "xml_invalido"}, []
        items = []
        for node in root.iter("item"):
            link = (node.findtext("link") or "").strip()
            title = re.sub(r"\s+", " ", node.findtext("title") or "").strip()
            if not link.startswith(("http://", "https://")) or not title:
                continue
            source = node.find("source")
            snippet = re.sub(r"<[^>]+>", " ", node.findtext("description") or "")
            items.append({
                "titulo": title[:300],
                "url": link,
                "fuente": (source.text or "").strip()[:120] if source is not None
                else urllib.parse.urlsplit(link).hostname,
                "publicado": _date(node.findtext("pubDate")),
                "extracto": re.sub(r"\s+", " ", snippet).strip()[:400],
            })
        return ({"estado": "ok", "motivo": ""} if items else {"estado": "vacio", "motivo": "sin_resultados"}), items

    # ------------------------------------------------------------------- leer

    async def leer(self, url: str) -> dict[str, Any]:
        consulted = datetime.now(UTC).isoformat()
        base = {"url": url[:2000], "consultado": consulted}
        try:
            check_url(url, self.resolve)
        except Blocked as error:
            return {**base, "estado": "error", "motivo": str(error)}
        if (hit := self._cached(("leer", url))) is not None:
            return {**hit, "cache": True}
        if not self._allow_call():
            return {**base, "estado": "limitado", "motivo": "limite_por_minuto"}
        try:
            if not await self._robots_allow(url):
                return {**base, "estado": "error", "motivo": "robots_no_permite"}
            response = await self._get(url)
        except Blocked as error:
            return {**base, "estado": "error", "motivo": str(error)}
        except (httpx.HTTPError, TimeoutError, OSError) as error:
            return {**base, "estado": "error", "motivo": type(error).__name__}
        if (blocked := _blocked_page(response)) is not None:
            return {**base, "estado": blocked, "motivo": f"http_{response.status}"}
        if response.status >= 400:
            return {**base, "estado": "error", "motivo": f"http_{response.status}"}
        kind = response.headers.get("content-type", "").split(";")[0].strip().lower()
        if kind not in ("text/html", "application/xhtml+xml", "text/plain"):
            return {**base, "estado": "error", "motivo": f"tipo_no_soportado:{kind or 'desconocido'}"}
        html = response.body.decode(_charset(response.headers.get("content-type", "")), errors="replace")
        title, text = extract_text(html) if kind != "text/plain" else ("", html)
        if len(text) < 200:
            return {**base, "estado": "vacio", "motivo": "sin_texto_legible", "titulo": title[:300]}
        out = {
            **base, "estado": "ok", "motivo": "", "titulo": title[:300], "texto": text[:MAX_TEXT],
            "truncado": len(text) > MAX_TEXT or len(response.body) >= MAX_BYTES,
        }
        self._cache[("leer", url)] = (self.clock(), out)
        return out

    async def _robots_allow(self, url: str) -> bool:
        parts = urllib.parse.urlsplit(url)
        origin = f"{parts.scheme}://{parts.netloc}"
        if origin not in self._robots:
            parser: urllib.robotparser.RobotFileParser | None = None
            try:
                response = await self._get(origin + "/robots.txt")
                if response.status < 400 and response.body:
                    parser = urllib.robotparser.RobotFileParser()
                    parser.parse(response.body.decode("utf-8", errors="replace").splitlines())
            except (Blocked, httpx.HTTPError, TimeoutError, OSError):
                parser = None
            self._robots[origin] = parser
        parser = self._robots[origin]
        return parser is None or parser.can_fetch(USER_AGENT, url)


def _charset(content_type: str) -> str:
    match = re.search(r"charset=([\w-]+)", content_type, re.I)
    if match:
        try:
            "".encode(match.group(1))
            return match.group(1)
        except LookupError:
            pass
    return "utf-8"


def _date_iso(raw: str | None) -> str | None:
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError:
        return None
    return (parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)).astimezone(UTC).isoformat()
