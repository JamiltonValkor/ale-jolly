/* <border-beam> — a smooth glow that rides around the border of its slotted child, plus a soft colour wash drifting inside
   (inspired by libraries.dev/beam, "pulse-inner"). Attributes: active (true|false), strength (0–1), theme (dark|light),
   size (md|sm|line), speed (seconds per lap), wash (false to disable the inner gradient). */
(function () {
  if (customElements.get('border-beam')) return;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const CSS = `
:host{display:block;position:relative;--a:0deg;--s:.75;--w:2px;--hw:4px}
.fx{position:absolute;inset:0;border-radius:inherit;pointer-events:none;opacity:0;transition:opacity .8s ease}
.wash{overflow:hidden;z-index:4;mix-blend-mode:screen}
:host([theme="light"]) .wash{mix-blend-mode:multiply}
.wash i{position:absolute;display:block;width:62%;padding-top:62%;border-radius:50%;filter:blur(42px);will-change:transform}
.wash .b1{left:-14%;top:-40%;background:radial-gradient(circle,#ABC4EE 0%,rgba(171,196,238,0) 68%);opacity:.3;animation:bb-d1 16s ease-in-out infinite alternate}
.wash .b2{right:-18%;bottom:-46%;background:radial-gradient(circle,#E2BFDB 0%,rgba(226,191,219,0) 68%);opacity:.26;animation:bb-d2 19s ease-in-out infinite alternate}
.wash .b3{left:30%;top:0;width:46%;padding-top:46%;background:radial-gradient(circle,#C3B9EE 0%,rgba(195,185,238,0) 68%);opacity:.22;animation:bb-d3 13s ease-in-out infinite alternate}
.wash .b4{right:16%;top:-42%;width:40%;padding-top:40%;background:radial-gradient(circle,#A3DCEB 0%,rgba(163,220,235,0) 68%);opacity:.16;animation:bb-d2 21s ease-in-out infinite alternate-reverse}
.wash .b5{left:8%;bottom:-40%;width:44%;padding-top:44%;background:radial-gradient(circle,#E4C9B6 0%,rgba(228,201,182,0) 68%);opacity:.14;animation:bb-d1 23s ease-in-out infinite alternate-reverse}
.ring{z-index:5;padding:var(--w);mix-blend-mode:screen;background:conic-gradient(from var(--a),transparent 0deg,transparent 214deg,rgba(195,185,238,0) 214deg,rgba(195,185,238,.95) 232deg,#ABC4EE 250deg,#F4F4F6 262deg,#A3DCEB 276deg,#A9DCD2 294deg,#E5E0B9 310deg,#F7F7F9 322deg,#E4C9B6 336deg,rgba(226,191,219,.95) 348deg,rgba(226,191,219,0) 359.5deg,transparent 360deg);-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);mask-composite:exclude}
.halo{z-index:4;inset:-2px;padding:var(--hw);filter:blur(7px)}
:host([theme="light"]) .ring{mix-blend-mode:multiply}
:host([active="true"]) .wash{opacity:calc(var(--s) * .8)}
:host([active="true"]) .ring{opacity:var(--s)}
:host([active="true"]) .halo{opacity:calc(var(--s) * .65)}
:host([size="sm"]){--w:1px;--hw:4px}
:host([size="line"]){--w:1px}
:host([size="line"]) .halo,:host([size="line"]) .wash,:host([wash="false"]) .wash{display:none}
/* 28 sep, noche: en claro el degradado de dentro no se veía (pastel al 24% en multiply sobre blanco oscurece menos de un 10%). En claro, los mismos cinco tonos, más saturados y más presentes. */
:host([theme="light"][active="true"]) .wash{opacity:var(--s)}
:host([theme="light"]) .wash .b1{background:radial-gradient(circle,#8FAEEA 0%,rgba(143,174,234,0) 68%);opacity:.62}
:host([theme="light"]) .wash .b2{background:radial-gradient(circle,#DDA6D2 0%,rgba(221,166,210,0) 68%);opacity:.55}
:host([theme="light"]) .wash .b3{background:radial-gradient(circle,#AE9FEA 0%,rgba(174,159,234,0) 68%);opacity:.5}
:host([theme="light"]) .wash .b4{background:radial-gradient(circle,#85CFE3 0%,rgba(133,207,227,0) 68%);opacity:.4}
:host([theme="light"]) .wash .b5{background:radial-gradient(circle,#E3B797 0%,rgba(227,183,151,0) 68%);opacity:.34}
@keyframes bb-d1{to{transform:translate(22%,26%) scale(1.15)}}
@keyframes bb-d2{to{transform:translate(-20%,-22%) scale(1.1)}}
@keyframes bb-d3{to{transform:translate(-26%,30%) scale(.92)}}
@media (prefers-reduced-motion:reduce){.wash i{animation:none}}`;
  class BorderBeam extends HTMLElement {
    static get observedAttributes() { return ['active', 'strength', 'speed']; }
    constructor() {
      super();
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = '<style>' + CSS + '</style><slot></slot><div class="fx wash"><i class="b1"></i><i class="b2"></i><i class="b3"></i><i class="b4"></i><i class="b5"></i></div><div class="fx ring halo"></div><div class="fx ring"></div>';
      this.a = 0; this.frame = this.frame.bind(this);
    }
    connectedCallback() { this.syncRadius(); this.syncStrength(); this.start(); this.ro = new ResizeObserver(() => this.syncRadius()); this.ro.observe(this); }
    disconnectedCallback() { this.ro && this.ro.disconnect(); this.raf && cancelAnimationFrame(this.raf); this.raf = 0; }
    attributeChangedCallback(k) { if (k === 'strength') this.syncStrength(); this.start(); }
    get on() { return this.getAttribute('active') === 'true'; }
    num(k, d) { const v = parseFloat(this.getAttribute(k)); return isNaN(v) ? d : v; }
    syncStrength() { this.style.setProperty('--s', String(Math.max(0, Math.min(1, this.num('strength', 0.75))))); }
    syncRadius() {
      // the fx layers use border-radius:inherit — make sure the host carries the child's radius
      let el = this.firstElementChild, r = '';
      while (el) { r = getComputedStyle(el).borderRadius; if (parseFloat(r) > 0 || !el.firstElementChild) break; el = el.firstElementChild; }
      if (parseFloat(r) > 0 && getComputedStyle(this).borderRadius !== r) this.style.borderRadius = r;
    }
    start() { if (!this.raf) { this._last = 0; this.raf = requestAnimationFrame(this.frame); } }
    frame(now) {
      this.raf = 0; if (!this.isConnected) return;
      const dt = this._last ? Math.min(0.05, (now - this._last) / 1000) : 0; this._last = now;
      if (this.on) { this._off = 0; if (!reduced.matches) { this.a = (this.a + dt * 360 / this.num('speed', 3.6)) % 360; this.style.setProperty('--a', this.a.toFixed(2) + 'deg'); } this.raf = requestAnimationFrame(this.frame); }
      else { this._off = (this._off || 0) + dt; if (this._off < 0.9) this.raf = requestAnimationFrame(this.frame); } // keep moving while it fades out
    }
  }
  customElements.define('border-beam', BorderBeam);
})();
