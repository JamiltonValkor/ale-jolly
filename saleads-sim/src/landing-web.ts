import type {IncomingMessage, ServerResponse} from 'node:http';
import type {SimConfig} from './config';
import {escapeHtml, readJson, redirect, sendJson, sendText} from './http-util';
import type {Landing} from './store';
import type {Store} from './store';
import {publishedUrl} from './tools/landings';

/**
 * Lo que en SaleADS hacen el publicador de landings y la vista web de
 * revisión, en versión mínima:
 *
 * - `GET /l/{id}/v/{n}/` y `/l/{id}/v/{n}/styles.css`: cualquier versión.
 * - `GET /l/{id}/` (y su CSS): la versión publicada.
 * - `GET /{locale}/dashboard/agent-landings/{id}`: vista de revisión del dueño.
 * - `POST /sim/landings/{id}/publish` `{n?}`: el dueño publica (simulado).
 * - `POST /sim/landings/{id}/unpublish` y `/feedback` `{text}`.
 *
 * Todo lleva la marca «simulado». Las páginas se sirven con una CSP que solo
 * permite recursos propios, imágenes y fuentes https.
 */

const LANDING_CSP = "default-src 'self'; img-src 'self' data: https:; font-src 'self' data: https:; style-src 'self' 'unsafe-inline' https:; script-src 'self' 'unsafe-inline'; frame-ancestors *";

function versionFile(res: ServerResponse, landing: Landing, n: number | null, file: string): void {
  const version = n === null ? undefined : landing.versions.find((v) => v.n === n);
  if (!version) return sendText(res, 404, 'Versión no encontrada (simulado).', 'text/plain; charset=utf-8');
  if (file === 'styles.css') return sendText(res, 200, version.files['styles.css'] ?? '', 'text/css; charset=utf-8', {'cache-control': 'no-cache'});
  const banner = '<div style="position:fixed;z-index:2147483647;bottom:8px;right:8px;background:#1F6F50;color:#fff;font:12px/1.2 system-ui,sans-serif;padding:6px 10px;border-radius:6px;opacity:.85">Landing simulada · saleads-sim</div>';
  const html = version.files['index.html'] ?? '';
  const marked = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${banner}</body>`) : `${html}${banner}`;
  sendText(res, 200, marked, 'text/html; charset=utf-8', {'cache-control': 'no-cache', 'content-security-policy': LANDING_CSP});
}

function reviewPage(config: SimConfig, landing: Landing, locale: string): string {
  const latest = landing.latestN;
  const versions = [...landing.versions].reverse().map((v) =>
    `<li><a href="/l/${landing.id}/v/${v.n}/" target="preview">Versión ${v.n}</a> · ${escapeHtml(v.createdAt)}${landing.publishedN === v.n ? ' · <b>publicada</b>' : ''}</li>`).join('');
  const url = landing.status === 'published' ? `${config.landingPublicBaseUrl}/l/${landing.id}/` : null;
  return `<!doctype html><html lang="${locale === 'en' ? 'en' : 'es'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Revisión de landing (simulado)</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#F4F1EA;color:#222}header{background:#1F6F50;color:#fff;padding:12px 16px}main{display:grid;grid-template-columns:320px 1fr;gap:16px;padding:16px}@media(max-width:800px){main{grid-template-columns:1fr}}
aside{background:#fff;border-radius:12px;padding:16px}iframe{width:100%;height:80vh;border:1px solid #ccc;border-radius:12px;background:#fff}button{background:#1F6F50;color:#fff;border:0;border-radius:8px;padding:10px 14px;font-size:15px;cursor:pointer}button.sec{background:#666}textarea{width:100%;box-sizing:border-box}.tag{display:inline-block;background:#F2C14E;color:#222;border-radius:6px;padding:2px 8px;font-size:12px}</style></head>
<body><header><b>SaleADS · Landings del agente</b> <span class="tag">simulado</span></header><main><aside>
<h2 style="margin-top:0">${escapeHtml(landing.name)}</h2>
<p>Estado: <b>${landing.status}</b>${landing.publishedN ? ` (versión ${landing.publishedN})` : ''}<br>Formato: ${escapeHtml(landing.format)}</p>
${url ? `<p>URL publicada: <a href="${escapeHtml(url)}" target="_blank">${escapeHtml(url)}</a></p>` : ''}
${latest ? `<p><button id="pub">Publicar versión ${latest}</button></p>` : '<p>El agente aún no envió versiones.</p>'}
${landing.status === 'published' ? '<p><button class="sec" id="unpub">Despublicar</button></p>' : ''}
<h3>Versiones</h3><ul>${versions || '<li>—</li>'}</ul>
<h3>Comentarios para Ale</h3><textarea id="fb" rows="3" placeholder="Qué cambiarías…"></textarea><p><button class="sec" id="send">Enviar comentario</button></p>
<ul>${landing.feedback.map((f) => `<li>${escapeHtml(f.text)}</li>`).join('')}</ul>
<p><small>Publicar aquí simula la acción del dueño en la web de SaleADS. No se crea nada en Meta.</small></p>
</aside><iframe name="preview" src="${latest ? `/l/${landing.id}/v/${latest}/` : 'about:blank'}" title="Vista de la landing"></iframe></main>
<script>
const post=(p,b)=>fetch(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b||{})}).then(()=>location.reload());
document.getElementById('pub')?.addEventListener('click',()=>post('/sim/landings/${landing.id}/publish',{n:${latest ?? 'null'}}));
document.getElementById('unpub')?.addEventListener('click',()=>post('/sim/landings/${landing.id}/unpublish'));
document.getElementById('send')?.addEventListener('click',()=>{const t=document.getElementById('fb').value.trim();if(t)post('/sim/landings/${landing.id}/feedback',{text:t});});
</script></body></html>`;
}

/** Publicar como el dueño: `status=published`, `publishedN` y `url`. */
export function publishLanding(config: SimConfig, store: Store, landing: Landing, n: number | null) {
  const target = n ?? landing.latestN;
  if (!target || !landing.versions.some((v) => v.n === target)) return null;
  landing.status = 'published';
  landing.publishedN = target;
  landing.updated_at = new Date().toISOString();
  store.save();
  return {id: landing.id, status: landing.status, publishedN: target, url: publishedUrl({config} as never, landing), simulated: true};
}

export async function handleLandingWeb(config: SimConfig, store: Store, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;
  let m = /^\/l\/([0-9a-f-]{36})(?:\/v\/(\d{1,6}))?(\/(?:index\.html|styles\.css)?)?$/.exec(path);
  if (m && req.method === 'GET') {
    const landing = store.state.landings[m[1]];
    if (!landing) {
      sendText(res, 404, 'Landing no encontrada (simulado).', 'text/plain; charset=utf-8');
      return true;
    }
    if (m[3] === undefined) {
      redirect(res, `${path}/`);
      return true;
    }
    const n = m[2] !== undefined ? Number(m[2]) : landing.status === 'published' ? landing.publishedN : null;
    versionFile(res, landing, n, m[3] === '/styles.css' ? 'styles.css' : 'index.html');
    return true;
  }
  m = /^\/(es|en)\/dashboard\/agent-landings\/([0-9a-f-]{36})\/?$/.exec(path);
  if (m && req.method === 'GET') {
    const landing = store.state.landings[m[2]];
    if (!landing) sendText(res, 404, 'Landing no encontrada (simulado).', 'text/plain; charset=utf-8');
    else sendText(res, 200, reviewPage(config, landing, m[1]), 'text/html; charset=utf-8', {'cache-control': 'no-store'});
    return true;
  }
  m = /^\/sim\/landings\/([0-9a-f-]{36})\/(publish|unpublish|feedback)$/.exec(path);
  if (m && req.method === 'POST') {
    const landing = store.state.landings[m[1]];
    if (!landing) {
      sendJson(res, 404, {ok: false, code: 'LANDING_NOT_FOUND'});
      return true;
    }
    const body = ((await readJson(req, 64 * 1024).catch(() => undefined)) ?? {}) as Record<string, unknown>;
    if (m[2] === 'publish') {
      const out = publishLanding(config, store, landing, typeof body.n === 'number' ? body.n : null);
      sendJson(res, out ? 200 : 409, out ? {ok: true, data: out} : {ok: false, code: 'LANDING_NO_VERSION'});
    } else if (m[2] === 'unpublish') {
      landing.status = 'unpublished';
      landing.updated_at = new Date().toISOString();
      store.save();
      sendJson(res, 200, {ok: true, data: {id: landing.id, status: landing.status}});
    } else {
      const text = typeof body.text === 'string' ? body.text.trim().slice(0, 2000) : '';
      if (text) landing.feedback.push({at: new Date().toISOString(), text});
      store.save();
      sendJson(res, 200, {ok: true, data: {feedback: landing.feedback}});
    }
    return true;
  }
  if (path === '/sim/landings' && req.method === 'GET') {
    sendJson(res, 200, {ok: true, data: Object.values(store.state.landings).map((l) => ({
      id: l.id, name: l.name, status: l.status, latestN: l.latestN, publishedN: l.publishedN,
      review_path: `/es/dashboard/agent-landings/${l.id}`, url: l.status === 'published' ? `${config.landingPublicBaseUrl}/l/${l.id}/` : null,
    }))});
    return true;
  }
  return false;
}
