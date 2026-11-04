"""Sistema de alineamiento de Meta — mini web local para alinear los brazos de Mini-Muse (y probar sus gestos).

.venv/bin/python alineamiento.py              → abre http://localhost:8790
.venv/bin/python alineamiento.py --simulado   → sin Arduino (para ver la web)

Referente: el Servo Lab de animatronic_head (HESed): un archivo de verdad (brazos.yaml, la web es la única que lo
escribe, con respaldo .bak), pasos de 5 µs, guardar reposo/máximo/mínimo, marcar calibrado. Diferencia acordada con el
owner (A3): sin confirmaciones — el slider mueve el servo EN VIVO; el botón "Soltar" está siempre a mano.
Mientras esta web está abierta es la dueña del puerto del Arduino (cierra ./ale.sh o brazos.py antes).
"""
import argparse, json, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import calibracion

PUERTO_WEB = 8790
US_POR_GRADO = 2000 / 180          # SG90: ~500–2500 µs para ~180°


class Simulado:
    """Arduino de mentira para ver la web sin hardware."""
    version, puerto, sin_limites = "simulado", "—", []

    def __init__(self, *a, **k): self.calib = calibracion.cargar()
    def cargar_limites(self, *a): self.calib = calibracion.cargar()
    def pulso(self, brazo, us): pass
    def mover(self, *a, **k): pass
    def soltar(self): pass
    def cerrar(self, reposo=True): pass


class Estado:
    def __init__(self, simulado: bool):
        self.simulado = simulado
        self.lock = threading.Lock()
        self.b = None
        self.error = ""
        self.us = {"derecho": None, "izquierdo": None}      # último pulso enviado (None = suelto)
        self.reproductor = None

    def conectar(self):
        with self.lock:
            if self.b:
                return
            try:
                if self.simulado:
                    self.b = Simulado()
                else:
                    import arduino
                    self.b = arduino.Brazos()
                self.error = ""
            except Exception as e:                           # puerto ocupado / sin Arduino: se muestra en la web
                self.b, self.error = None, str(e)

    def reconectar(self):
        with self.lock:
            viejo, self.b = self.b, None
            if self.reproductor:
                self.reproductor.detener()
            self.reproductor = None
            try:
                if viejo is not None and hasattr(viejo, "s"):
                    viejo.vivo = False; viejo.s.close()
            except Exception:
                pass
        self.us = {"derecho": None, "izquierdo": None}
        time.sleep(0.3)
        self.conectar()
        if not self.b:
            raise RuntimeError(self.error or "no encuentro el Arduino")

    def json(self) -> dict:
        if self.b is not None and getattr(self.b, "vivo", True) is False:
            self.b, self.error = None, "el Arduino se desconectó: vuelve a conectarlo (se reconecta solo)"
        calib = calibracion.cargar()
        return {"conectado": self.b is not None, "error": self.error,
                "version": getattr(self.b, "version", ""), "puerto": getattr(self.b, "puerto", ""),
                "simulado": self.simulado, "brazos": calib["brazos"], "us": self.us,
                "us_por_grado": US_POR_GRADO, "sin_limites": getattr(self.b, "sin_limites", []),
                "diag": getattr(self, "diag", "")}


E: Estado = None  # type: ignore


def _desconectado(e: Exception) -> bool:
    import serial
    return isinstance(e, (serial.SerialException, OSError)) or "desconect" in str(e) or "no está conectado" in str(e)


class Web(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _resp(self, codigo, cuerpo, tipo="application/json"):
        datos = cuerpo if isinstance(cuerpo, bytes) else json.dumps(cuerpo, ensure_ascii=False).encode()
        self.send_response(codigo)
        self.send_header("Content-Type", tipo + "; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(datos)

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            return self._resp(200, PAGINA.encode(), "text/html")
        if self.path == "/api/estado":
            return self._resp(200, E.json())
        if self.path == "/api/gestos":
            import gestos
            return self._resp(200, gestos.cargar())
        self._resp(404, {"error": "no existe"})

    def do_POST(self):
        largo = int(self.headers.get("Content-Length") or 0)
        try:
            d = json.loads(self.rfile.read(largo) or b"{}")
        except ValueError:
            return self._resp(400, {"error": "JSON inválido"})
        try:
            try:
                r = self._accion(self.path, d)
            except Exception as e:
                if not _desconectado(e):
                    raise
                E.reconectar()                               # se desenchufó y volvió: nueva conexión y reintento
                r = self._accion(self.path, d)
            self._resp(200, r if r is not None else E.json())
        except calibracion.CalibracionInvalida as e:
            self._resp(400, {"error": str(e)})
        except Exception as e:
            self._resp(500, {"error": f"{type(e).__name__}: {e}"})

    def _accion(self, ruta, d):
        if ruta == "/api/conectar":
            E.conectar(); return None
        if not E.b:
            raise RuntimeError(E.error or "el Arduino no está conectado")
        brazo = d.get("brazo")
        if ruta == "/api/pulso":                             # mover EN VIVO (alinear): pulso crudo 500–2500
            us = max(100, min(2900, int(d["us"])))
            with E.lock:
                E.b.pulso(brazo, us)
            E.us[brazo] = us
            return {"ok": True, "us": us}
        if ruta == "/api/diagnostico":                       # ¿servo de 180° (posición) o de 360° (rotación continua)?
            def secuencia():
                for us, seg in ((1500, 2.0), (1650, 3.0), (1500, 2.0), (1350, 3.0), (1500, 2.0)):
                    with E.lock:
                        E.b.pulso(brazo, us)
                    E.us[brazo], E.diag = us, f"{us} µs durante {seg:.0f} s"
                    time.sleep(seg)
                with E.lock:
                    E.b.soltar()
                E.us[brazo], E.diag = None, "terminado"
            threading.Thread(target=secuencia, daemon=True).start()
            return {"ok": True}
        if ruta == "/api/guardar":                           # guardar reposo/máximo/mínimo con el pulso actual
            calibracion.fijar(brazo, d["campo"], int(d["us"]))
            with E.lock:
                E.b.cargar_limites()
            return None
        if ruta == "/api/calibrado":
            calibracion.marcar_calibrado(brazo, bool(d.get("si", True)))
            return None
        if ruta == "/api/soltar":
            if E.reproductor:
                E.reproductor.detener()
            with E.lock:
                E.b.soltar()
            E.us = {"derecho": None, "izquierdo": None}
            return None
        if ruta == "/api/porcentaje":                        # mover por % de elevación (requiere límites)
            with E.lock:
                E.b.mover(d.get("der", 999), d.get("izq", 999), int(d.get("ms", 600)))
            return None
        if ruta in ("/api/gesto", "/api/gesto_guardar", "/api/gesto_parar"):
            import gestos
            if ruta == "/api/gesto_guardar":
                gestos.guardar_gesto(d["nombre"], d["gesto"]); return gestos.cargar()
            if E.reproductor is None:
                E.reproductor = gestos.Reproductor(E.b, E.lock)
            if ruta == "/api/gesto_parar":
                E.reproductor.detener(); return None
            g = d.get("gesto") or gestos.cargar()["gestos"][d["nombre"]]
            E.reproductor.reproducir(g, intensidad=float(d.get("intensidad", 1.0)), velocidad=float(d.get("velocidad", 1.0)))
            return None
        raise RuntimeError("acción desconocida")


PAGINA = r"""<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sistema de alineamiento de Meta</title>
<style>
:root{--crema:#efe3cf;--papel:#fff9f1;--cafe:#5a463c;--suave:#a88876;--rosa:#ee8a96;--rosa2:#f9d3d8;--amarillo:#f7c454;--verde:#5aa58a;--borde:#e3d2bb}
*{box-sizing:border-box}body{margin:0;background:var(--crema);color:var(--cafe);font:16px/1.45 -apple-system,system-ui,sans-serif}
main{max-width:1060px;margin:auto;padding:22px 16px 60px}header{display:flex;gap:14px;align-items:center;flex-wrap:wrap}
h1{margin:0;font-size:24px;font-weight:600}h1 small{display:block;font-size:14px;font-weight:400;color:var(--suave)}
.pill{padding:5px 11px;border-radius:99px;background:var(--papel);border:1px solid var(--borde);font-size:13px}.pill.ok{color:var(--verde)}.pill.mal{color:#c0392b}
#soltar{margin-left:auto;background:#d9534f;color:#fff;border:0;border-radius:12px;padding:12px 18px;font-weight:700;font-size:16px;cursor:pointer}
.grid{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:16px;margin-top:18px}@media(max-width:820px){.grid{grid-template-columns:1fr}}
.card{background:var(--papel);border:1px solid var(--borde);border-radius:16px;padding:18px}.card h2{margin:0 0 4px;font-size:18px;font-weight:600}.card p{margin:4px 0 12px;color:var(--suave);font-size:14px}
.tabs{display:flex;gap:8px;margin:10px 0}.tabs button{flex:1;padding:10px;border-radius:10px;border:1px solid var(--borde);background:#fff;color:var(--cafe);font-weight:600;cursor:pointer}.tabs button.on{background:var(--rosa);border-color:var(--rosa);color:#fff}
.valor{font-size:40px;font-weight:700;text-align:center;margin:6px 0}.valor small{font-size:16px;color:var(--suave);font-weight:400}
input[type=range]{width:100%;accent-color:var(--rosa);height:28px}.fila{display:flex;gap:8px;flex-wrap:wrap}.fila>*{flex:1}
button.b{padding:10px;border-radius:10px;border:1px solid var(--borde);background:#fff;color:var(--cafe);font-weight:600;cursor:pointer;min-width:52px}button.b:hover{background:var(--rosa2)}button.p{background:var(--cafe);color:#fff;border-color:var(--cafe)}
.puntos{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:14px}.punto{border:1px solid var(--borde);border-radius:12px;padding:10px;text-align:center;background:#fff}
.punto b{display:block;font-size:13px;color:var(--suave);font-weight:600}.punto span{display:block;font-size:20px;font-weight:700;margin:2px 0 6px}.punto .fila button{padding:7px 4px;font-size:13px}
.estado{margin-top:12px;font-size:14px;min-height:20px}.listo{color:var(--verde);font-weight:600}.falta{color:#b7791f}
.pasos{margin:10px 0 0;padding-left:20px;color:var(--suave);font-size:14px}svg{width:100%;height:auto}
.gestos{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;margin:10px 0}
label.s{display:block;font-size:14px;margin-top:8px}table{width:100%;border-collapse:collapse;font-size:14px;margin-top:8px}td,th{padding:4px;border-bottom:1px solid var(--borde);text-align:center}td input{width:70px;padding:4px;border:1px solid var(--borde);border-radius:6px}
</style></head><body><main>
<header><h1>Sistema de alineamiento de Meta<small>Brazos de Mini-Muse · SG90 · Arduino</small></h1><span id="con" class="pill">…</span><button id="soltar" title="Suelta los dos servos (sin pulso)">✋ Soltar servos</button></header>
<div class="grid">
<section class="card"><h2>1 · Alinear un brazo</h2><p>El slider mueve el servo <b>en vivo</b>. Baja de a 5 µs y guarda el último punto que no roce.</p>
<div class="tabs"><button data-b="derecho" class="on">Brazo derecho · A0</button><button data-b="izquierdo">Brazo izquierdo · A1</button></div>
<div class="valor"><span id="us">—</span> <small>µs</small></div>
<input id="slider" type="range" min="100" max="2900" step="5"><div style="position:relative;height:6px;margin:-6px 0 8px;border-radius:3px;background:linear-gradient(90deg,#e57373 0 14.3%,#cfe8d8 14.3% 85.7%,#e57373 85.7% 100%)" title="rojo: fuera de 500–2500 µs (el SG90 suele no responder y puede forzarse)"></div><p style="margin:0;font-size:13px">Verde = rango normal del SG90 (500–2500). <b>Rojo</b> = fuera de rango: si el brazo ya no se mueve o el servo zumba, ese es su límite → vuelve atrás.</p>
<div class="fila"><button class="b" data-d="-25">−25</button><button class="b" data-d="-5">−5</button><button class="b" data-d="5">+5</button><button class="b" data-d="25">+25</button></div>
<div class="puntos">
<div class="punto"><b>Reposo (abajo)</b><span id="v_reposo_us">—</span><div class="fila"><button class="b" data-ir="reposo_us">Ir</button><button class="b p" data-g="reposo_us">Guardar</button></div></div>
<div class="punto"><b>Máximo (arriba)</b><span id="v_maximo_us">—</span><div class="fila"><button class="b" data-ir="maximo_us">Ir</button><button class="b p" data-g="maximo_us">Guardar</button></div></div>
<div class="punto"><b>Mínimo (tope)</b><span id="v_minimo_us">—</span><div class="fila"><button class="b" data-ir="minimo_us">Ir</button><button class="b p" data-g="minimo_us">Guardar</button></div></div>
</div>
<ol class="pasos"><li>Lleva el brazo <b>abajo, pegado al cuerpo</b> → Guardar reposo.</li><li>Súbelo hasta <b>justo antes</b> de tocar la cabeza/pelo → Guardar máximo.</li><li>Llévalo al lado contrario hasta el tope (sin forzar) → Guardar mínimo.</li></ol>
<div class="fila" style="margin-top:12px"><button id="calibrado" class="b p">✓ Marcar este brazo como calibrado</button></div>
<div class="estado" id="msg"></div>
<div style="margin-top:14px;padding:12px;border:1px dashed var(--rosa);border-radius:12px"><b>Diagnóstico: ¿180° o 360°?</b>
<p>Mira el brazo. Hace: <b>1500</b> (2 s) → <b>1650</b> (3 s) → <b>1500</b> (2 s) → <b>1350</b> (3 s) → <b>1500</b> → suelta.<br>
<b>180°</b>: en 1650 gira un poquito (~15°) y <b>se queda quieto</b>; en 1350 va al otro lado y se queda.<br>
<b>360° continuo</b>: en 1650 <b>gira sin parar</b> durante los 3 s; en 1500 se detiene; en 1350 gira al revés sin parar.</p>
<button class="b p" id="diag">▶ Correr diagnóstico en este brazo</button> <span id="diagmsg"></span></div></section>
<section class="card"><h2>Mini-Muse</h2><p>La silueta se mueve igual que el servo real. Las zonas rosadas son los límites guardados.</p>
<svg viewBox="0 0 320 300" id="muse" aria-label="Silueta de Mini-Muse con sus brazos">
<path d="M160 18 C220 18 262 70 262 128 C262 200 232 262 160 268 C88 262 58 200 58 128 C58 70 100 18 160 18 Z" fill="#e8d6bc" stroke="#5a463c" stroke-width="3"/>
<ellipse cx="160" cy="118" rx="66" ry="52" fill="#f6ead7" stroke="#5a463c" stroke-width="2"/>
<circle cx="132" cy="112" r="9" fill="#120e10"/><circle cx="188" cy="112" r="9" fill="#120e10"/><circle cx="129" cy="109" r="3" fill="#fff"/><circle cx="185" cy="109" r="3" fill="#fff"/>
<path d="M148 136 Q160 146 172 136" fill="none" stroke="#1e1416" stroke-width="3" stroke-linecap="round"/>
<ellipse cx="118" cy="138" rx="12" ry="8" fill="#ee8a96" opacity=".45"/><ellipse cx="202" cy="138" rx="12" ry="8" fill="#ee8a96" opacity=".45"/>
<g id="zona_derecho"></g><g id="zona_izquierdo"></g>
<g id="brazo_derecho" transform="rotate(0 72 168)"><path d="M72 168 C58 176 46 196 44 214 C42 232 56 240 66 232 C74 224 80 204 82 186 Z" fill="#e8d6bc" stroke="#5a463c" stroke-width="3"/></g>
<g id="brazo_izquierdo" transform="rotate(0 248 168)"><path d="M248 168 C262 176 274 196 276 214 C278 232 264 240 254 232 C246 224 240 204 238 186 Z" fill="#e8d6bc" stroke="#5a463c" stroke-width="3"/></g>
<text x="58" y="292" font-size="12" fill="#a88876" text-anchor="middle">derecho</text><text x="262" y="292" font-size="12" fill="#a88876" text-anchor="middle">izquierdo</text>
</svg><div class="estado" id="resumen"></div></section>
</div>
<section class="card" style="margin-top:16px"><h2>2 · Laboratorio de gestos</h2><p>Gestos complementarios a la cara. Pruébalos sobre los límites reales; edita sus poses (% de elevación: 0 reposo · 100 máximo · −100 mínimo).</p>
<div class="gestos" id="lista"></div>
<div class="fila"><label class="s">Intensidad <b id="vi">100%</b><input id="intensidad" type="range" min="20" max="120" value="100" step="5"></label><label class="s">Velocidad <b id="vv">1.0×</b><input id="velocidad" type="range" min="0.4" max="2" value="1" step="0.1"></label></div>
<div id="editor" style="display:none"><h2 style="margin-top:14px" id="titulo_gesto"></h2><table><thead><tr><th>#</th><th>ms</th><th>der %</th><th>izq %</th><th></th></tr></thead><tbody id="poses"></tbody></table>
<div class="fila" style="margin-top:8px"><button class="b" id="agregar">+ Pose</button><button class="b" id="probar_ed">▶ Probar edición</button><button class="b p" id="guardar_ed">Guardar gesto</button><button class="b" id="parar">■ Parar</button></div></div>
<div class="estado" id="msg2"></div></section>
</main><script>
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];let S=null,brazo='derecho',env=null,ultimo=0,G=null,edit=null;
async function api(r,d){const o=d?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)}:{};const x=await fetch(r,o);const j=await x.json();if(!x.ok)throw new Error(j.error||x.status);return j}
function msg(t,c){$('#msg').innerHTML=t;$('#msg').className='estado '+(c||'')}
function us(){return Number($('#slider').value)}
function pinta(){if(!S)return;const b=S.brazos[brazo];$('#con').textContent=S.conectado?('● '+(S.simulado?'simulado':S.puerto)):'○ '+(S.error||'sin Arduino');$('#con').className='pill '+(S.conectado?'ok':'mal');
['reposo_us','maximo_us','minimo_us'].forEach(k=>$('#v_'+k).textContent=b[k]+' µs');
$('#resumen').innerHTML=['derecho','izquierdo'].map(n=>{const x=S.brazos[n];return `<div><b>${n}</b>: ${x.minimo_us} / ${x.reposo_us} / ${x.maximo_us} µs · ${x.calibrado?'<span class=listo>calibrado</span>':'<span class=falta>pendiente</span>'}</div>`}).join('');
['derecho','izquierdo'].forEach(silueta)}
function ang(n,u){const b=S.brazos[n];if(u==null)u=b.reposo_us;const sube=Math.sign(b.maximo_us-b.reposo_us)||1;return (u-b.reposo_us)*sube/S.us_por_grado}
function silueta(n){const lado=n==='derecho'?1:-1,px=n==='derecho'?72:248;const a=ang(n,S.us[n]);$('#brazo_'+n).setAttribute('transform',`rotate(${a*lado} ${px} 168)`);
const b=S.brazos[n],a1=ang(n,b.maximo_us),a0=ang(n,b.minimo_us);const r=58,p=(d)=>{const t=(90+d*lado)*Math.PI/180;return [px+r*Math.cos(t),168+r*Math.sin(t)]};const[x0,y0]=p(a0),[x1,y1]=p(a1);const grande=Math.abs(a1-a0)>180?1:0;
$('#zona_'+n).innerHTML=`<path d="M${px} 168 L${x0} ${y0} A${r} ${r} 0 ${grande} ${lado>0?1:0} ${x1} ${y1} Z" fill="#ee8a96" opacity=".18"/>`}
function enviar(){const now=Date.now();clearTimeout(env);const f=()=>{ultimo=Date.now();api('/api/pulso',{brazo,us:us()}).then(r=>{S.us[brazo]=r.us;silueta(brazo)}).catch(e=>msg(e.message,'falta'))};if(now-ultimo>60)f();else env=setTimeout(f,60)}
function fijar(v){v=Math.max(100,Math.min(2900,v));$('#slider').value=v;$('#us').textContent=v;S.us[brazo]=v;silueta(brazo);enviar()}
$('#slider').oninput=()=>{$('#us').textContent=us();$('#us').style.color=(us()<500||us()>2500)?'#c0392b':'';S.us[brazo]=us();silueta(brazo);enviar()};
$$('[data-d]').forEach(b=>b.onclick=()=>fijar(us()+Number(b.dataset.d)));
document.addEventListener('keydown',e=>{if(e.target.tagName==='INPUT'&&e.target.type!=='range')return;if(e.key==='ArrowRight'||e.key==='ArrowUp'){fijar(us()+5);e.preventDefault()}if(e.key==='ArrowLeft'||e.key==='ArrowDown'){fijar(us()-5);e.preventDefault()}});
$$('.tabs button').forEach(t=>t.onclick=()=>{brazo=t.dataset.b;$$('.tabs button').forEach(x=>x.classList.toggle('on',x===t));const v=S.us[brazo]??S.brazos[brazo].reposo_us;$('#slider').value=v;$('#us').textContent=S.us[brazo]==null?'suelto':v;pinta()});
$$('[data-ir]').forEach(b=>b.onclick=()=>fijar(S.brazos[brazo][b.dataset.ir]));
$$('[data-g]').forEach(b=>b.onclick=async()=>{try{S=await api('/api/guardar',{brazo,campo:b.dataset.g,us:us()});msg(`Guardado ${b.dataset.g.replace('_us','')} = ${us()} µs`,'listo');pinta()}catch(e){msg(e.message,'falta')}});
$('#diag').onclick=async()=>{try{await api('/api/diagnostico',{brazo});const t=setInterval(async()=>{const s=await api('/api/estado');$('#diagmsg').textContent=s.diag;if(s.diag==='terminado')clearInterval(t)},300)}catch(e){msg(e.message,'falta')}};
$('#calibrado').onclick=async()=>{try{S=await api('/api/calibrado',{brazo,si:true});msg('Brazo '+brazo+' calibrado ✓','listo');pinta()}catch(e){msg(e.message,'falta')}};
$('#soltar').onclick=async()=>{try{S=await api('/api/soltar',{});$('#us').textContent='suelto';msg('Servos sueltos','listo');pinta()}catch(e){msg(e.message,'falta')}};
async function cargar_gestos(){try{G=await api('/api/gestos')}catch(e){return}$('#lista').innerHTML=Object.keys(G.gestos).map(n=>`<button class="b" data-gesto="${n}" title="${G.gestos[n].nota||''}">${n.replaceAll('_',' ')}</button>`).join('');
$$('[data-gesto]').forEach(b=>b.onclick=()=>{probar(b.dataset.gesto);abrir(b.dataset.gesto)})}
function opts(){return{intensidad:$('#intensidad').value/100,velocidad:Number($('#velocidad').value)}}
async function probar(n,g){try{await api('/api/gesto',{nombre:n,gesto:g,...opts()});$('#msg2').textContent='▶ '+n}catch(e){$('#msg2').textContent=e.message}}
function abrir(n){edit={nombre:n,g:JSON.parse(JSON.stringify(G.gestos[n]))};$('#editor').style.display='';$('#titulo_gesto').textContent='Editar: '+n.replaceAll('_',' ');poses()}
function poses(){$('#poses').innerHTML=edit.g.poses.map((p,i)=>`<tr><td>${i+1}</td><td><input type=number value="${p[0]}" data-i="${i}" data-k="0"></td><td><input type=number value="${p[1]??''}" placeholder="—" data-i="${i}" data-k="1"></td><td><input type=number value="${p[2]??''}" placeholder="—" data-i="${i}" data-k="2"></td><td><button class="b" data-q="${i}">✕</button></td></tr>`).join('');
$$('#poses input').forEach(x=>x.onchange=()=>{const v=x.value===''?null:Number(x.value);edit.g.poses[x.dataset.i][x.dataset.k]=v});$$('[data-q]').forEach(b=>b.onclick=()=>{edit.g.poses.splice(b.dataset.q,1);poses()})}
$('#agregar').onclick=()=>{edit.g.poses.push([400,0,0]);poses()};$('#probar_ed').onclick=()=>probar(edit.nombre,edit.g);
$('#guardar_ed').onclick=async()=>{try{G=await api('/api/gesto_guardar',{nombre:edit.nombre,gesto:edit.g});$('#msg2').textContent='Guardado ✓ '+edit.nombre}catch(e){$('#msg2').textContent=e.message}};
$('#parar').onclick=()=>api('/api/gesto_parar',{});
$('#intensidad').oninput=()=>$('#vi').textContent=$('#intensidad').value+'%';$('#velocidad').oninput=()=>$('#vv').textContent=Number($('#velocidad').value).toFixed(1)+'×';
(async()=>{S=await api('/api/conectar',{}).catch(()=>api('/api/estado'));$('#slider').value=S.brazos[brazo].reposo_us;$('#us').textContent='suelto';pinta();cargar_gestos();
if(!S.conectado)msg('No hay Arduino: '+S.error,'falta');else msg('Conectado. El servo está suelto hasta que muevas el slider.','listo')})();
</script></body></html>"""


def main():
    global E
    ap = argparse.ArgumentParser()
    ap.add_argument("--simulado", action="store_true")
    ap.add_argument("--puerto-web", type=int, default=PUERTO_WEB)
    a = ap.parse_args()
    E = Estado(a.simulado)
    srv = ThreadingHTTPServer(("127.0.0.1", a.puerto_web), Web)
    print(f"🦾 Sistema de alineamiento de Meta → http://localhost:{a.puerto_web}  (Ctrl+C para salir)", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if E.b:
            E.b.soltar()
            if hasattr(E.b, "vivo"):
                E.b.vivo = False; E.b.s.close()
        print("👋 servos sueltos", flush=True)


if __name__ == "__main__":
    main()
