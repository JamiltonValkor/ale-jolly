/* <metal-ring> — real-time WebGL2 liquid-metal ring around a slotted button/icon.
   Attributes: strength (0–1), theme (dark|light), chroma (0–1), width (ring px), pad (halo px), paused.
   Falls back to a 2D conic ring without WebGL2. */
(function () {
  if (customElements.get('metal-ring')) return;
  const VS = `#version 300 es
  void main(){ int id=gl_VertexID; vec2 v=vec2(float((id<<1)&2),float(id&2)); gl_Position=vec4(v*2.0-1.0,0.0,1.0); }`;
  const FS = `#version 300 es
  precision highp float;
  uniform vec2 uRes; uniform float uDpr; uniform float uTime; uniform vec2 uMouse; uniform float uMouseOn;
  uniform float uR; uniform float uW; uniform float uStrength; uniform float uChroma; uniform float uTheme; uniform float uPad;
  out vec4 outColor;
  const float PI=3.14159265;
  float hash(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
  float noise(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f);
    float a=hash(i),b=hash(i+vec2(1,0)),c=hash(i+vec2(0,1)),d=hash(i+vec2(1,1));
    return mix(mix(a,b,f.x),mix(c,d,f.x),f.y); }
  float wrapA(float x){ return abs(mod(x+PI,2.0*PI)-PI); }
  void main(){
    vec2 p=(gl_FragCoord.xy-uRes*0.5)/uDpr;
    float r=length(p), a=atan(p.y,p.x), t=uTime;
    float bend=0.0, mouseGlow=0.0;
    if(uMouseOn>0.0){
      float md=length(uMouse), am=atan(uMouse.y,uMouse.x), da=wrapA(a-am);
      float prox=smoothstep(uR+90.0,uR+4.0,md)*uMouseOn;
      bend=-5.0*prox*exp(-da*da*5.0);
      mouseGlow=prox*exp(-da*da*3.0);
    }
    float R=uR+bend;
    float ring=1.0-smoothstep(uW*0.5-0.6,uW*0.5+0.7,abs(r-R));
    float env=0.5+0.5*sin(a-0.3*sin(t*0.3)+PI*0.5); env=0.25+0.75*env;
    float n1=noise(vec2(a*1.2+t*0.25,t*0.13));
    float b1=pow(max(0.0,sin(a*2.0+t*0.6+n1*3.0)),10.0);
    float b2=pow(max(0.0,sin(a*4.0-t*0.45+1.7)),30.0);
    float b3=pow(max(0.0,cos(a+t*0.35)),6.0);
    float flow=noise(vec2(a*3.0+t*0.4,(r-R)*0.8));
    float lum=env*0.55+0.25*flow+0.7*b1+0.9*b2+0.3*b3;
    vec3 rainbow=0.5+0.5*cos(2.0*PI*(a/PI+t*0.07+vec3(0.0,0.33,0.67)));
    vec3 base=mix(vec3(0.86,0.88,0.92),rainbow,uChroma*0.5)*lum;
    base*=1.0-smoothstep(0.0,uW*0.5,R-r)*0.25;
    base=mix(base,base*0.55+vec3(0.05),uTheme*0.5);
    float ha=t*0.4+1.2*sin(t*0.23)+0.6*sin(t*0.11+1.0);
    float dha=wrapA(a-ha);
    float outside=smoothstep(R-uW*0.5,R+uW*0.5,r);
    float fade=1.0-smoothstep(R+uPad*0.35,R+uPad*0.85,r);
    float halo=exp(-dha*dha*2.4)*exp(-max(0.0,r-R)/7.0)*outside*fade;
    halo+=mouseGlow*exp(-max(0.0,r-R)/6.0)*outside*fade*0.5;
    vec3 haloCol=mix(vec3(1.0,0.97,0.92),rainbow,uChroma*0.35);
    base+=vec3(1.0)*(exp(-dha*dha*1.6)*0.55+mouseGlow*0.4);
    vec3 col=base*ring; float alpha=ring;
    float hA=clamp(halo*0.45,0.0,1.0)*(1.0-ring);
    col+=haloCol*hA; alpha=max(alpha,hA);
    outColor=vec4(clamp(col,0.0,1.0),alpha)*uStrength;
  }`;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let pointer = null;
  addEventListener('pointermove', e => { pointer = { x: e.clientX, y: e.clientY }; }, { passive: true });
  addEventListener('pointerleave', () => { pointer = null; });

  class MetalRing extends HTMLElement {
    static get observedAttributes() { return ['strength', 'theme', 'chroma', 'width', 'pad', 'paused']; }
    constructor() {
      super();
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = '<style>:host{display:inline-flex;position:relative;flex:none;isolation:isolate}canvas{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);pointer-events:none;z-index:2}::slotted(*){position:relative;z-index:1}</style><canvas aria-hidden="true"></canvas><slot></slot>';
      this.canvas = root.querySelector('canvas');
      this.t0 = performance.now() - Math.random() * 4000;
      this.visible = true;
      this.frame = this.frame.bind(this);
      this.onLost = e => { e.preventDefault(); this.fallback(); this.start(); };
      this.onVisibility = () => { if (!document.hidden) this.start(); };
      this.canvas.addEventListener('webglcontextlost', this.onLost);
    }
    get num() { return (k, d) => { const v = parseFloat(this.getAttribute(k)); return isNaN(v) ? d : v; }; }
    connectedCallback() {
      document.addEventListener('visibilitychange', this.onVisibility);
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(this);
      this.io = new IntersectionObserver(es => { this.visible = es.some(e => e.isIntersecting); if (this.visible) this.start(); });
      this.io.observe(this);
      this.resize();
      this.start();
    }
    disconnectedCallback() {
      this.ro && this.ro.disconnect(); this.io && this.io.disconnect();
      document.removeEventListener('visibilitychange', this.onVisibility);
      this.raf && cancelAnimationFrame(this.raf); this.raf = 0;
      this.replaceCanvas();
      this.gl = undefined;
    }
    replaceCanvas() {
      const previous = this.canvas;
      previous.removeEventListener('webglcontextlost', this.onLost);
      const gl = this.gl;
      this.gl = null; this.u = undefined;
      const canvas = document.createElement('canvas');
      canvas.setAttribute('aria-hidden', 'true');
      previous.replaceWith(canvas);
      this.canvas = canvas;
      canvas.addEventListener('webglcontextlost', this.onLost);
      // Release only after detaching the listener: intentional loss is not a failure.
      try { if (gl && !gl.isContextLost()) gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* GPU already unavailable. */ }
      this.resize();
    }
    fallback() {
      // A WebGL canvas cannot acquire a 2D context, even after context loss.
      this.replaceCanvas();
      this.gl = null;
    }
    attributeChangedCallback() { this.start(); }
    start() { if (!this.raf && this.isConnected && !this.canvas.hidden) this.raf = requestAnimationFrame(this.frame); }
    resize() {
      const w = this.clientWidth, h = this.clientHeight; if (!w || !h) return;
      const pad = this.num('pad', 20), dpr = Math.min(2, devicePixelRatio || 1);
      this.box = { w: w + pad * 2, h: h + pad * 2, r: Math.min(w, h) / 2 - 0.5, pad, dpr };
      this.canvas.style.width = this.box.w + 'px'; this.canvas.style.height = this.box.h + 'px';
      this.canvas.width = Math.round(this.box.w * dpr); this.canvas.height = Math.round(this.box.h * dpr);
      if (this.gl) this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }
    initGL() {
      if (this.gl !== undefined) return this.gl;
      const gl = this.canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: true });
      if (!gl) { this.gl = null; return null; }
      this.gl = gl;
      const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.warn('[metal-ring]', gl.getShaderInfoLog(s)); return null; } return s; };
      const vs = sh(gl.VERTEX_SHADER, VS), fs = sh(gl.FRAGMENT_SHADER, FS);
      if (!vs || !fs) { this.fallback(); return null; }
      const prog = gl.createProgram(); gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { console.warn('[metal-ring]', gl.getProgramInfoLog(prog)); this.fallback(); return null; }
      gl.useProgram(prog);
      gl.deleteShader(vs); gl.deleteShader(fs);
      this.u = {}; ['uRes', 'uDpr', 'uTime', 'uMouse', 'uMouseOn', 'uR', 'uW', 'uStrength', 'uChroma', 'uTheme', 'uPad'].forEach(k => { this.u[k] = gl.getUniformLocation(prog, k); });
      gl.clearColor(0, 0, 0, 0);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      this.gl = gl; return gl;
    }
    mouse() {
      if (!pointer) return { x: 0, y: 0, on: 0 };
      const rc = this.canvas.getBoundingClientRect();
      const x = pointer.x - (rc.left + rc.width / 2), y = -(pointer.y - (rc.top + rc.height / 2));
      const d = Math.hypot(x, y); const on = d < 160 ? 1 - Math.max(0, (d - 90) / 70) : 0;
      return { x, y, on: Math.max(0, Math.min(1, on)) };
    }
    frame(now) {
      this.raf = 0;
      if (!this.isConnected || this.canvas.hidden) return;
      const paused = this.hasAttribute('paused') || document.hidden || !this.visible;
      if (!this.box) this.resize();
      if (this.box) {
        const t = ((now - this.t0) / 1000) * (reduced.matches ? 0.25 : 1);
        const target = Math.max(0, Math.min(1, this.num('strength', 1)));
        if (this._s == null) this._s = target;
        const dtS = Math.min(0.05, Math.max(0, (now - (this._last || now)) / 1000)); this._last = now;
        this._s += (target - this._s) * Math.min(1, dtS * 9);
        if (Math.abs(target - this._s) < 0.002) this._s = target;
        const strength = this._s, chroma = Math.max(0, Math.min(1, this.num('chroma', 0.6)));
        const theme = this.getAttribute('theme') === 'light' ? 1 : 0, w = this.num('width', 2.2), m = this.mouse();
        try {
          let gl = this.initGL();
          if (gl && gl.isContextLost()) { this.fallback(); gl = null; }
          if (gl) {
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.uniform2f(this.u.uRes, this.canvas.width, this.canvas.height); gl.uniform1f(this.u.uDpr, this.box.dpr); gl.uniform1f(this.u.uTime, t);
            gl.uniform2f(this.u.uMouse, m.x, m.y); gl.uniform1f(this.u.uMouseOn, m.on);
            gl.uniform1f(this.u.uR, this.box.r); gl.uniform1f(this.u.uW, w); gl.uniform1f(this.u.uStrength, strength); gl.uniform1f(this.u.uChroma, chroma); gl.uniform1f(this.u.uTheme, theme); gl.uniform1f(this.u.uPad, this.box.pad);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
          } else this.draw2d(t, strength, theme, w);
        } catch {
          // Decoration must never break the slotted control or its event handlers.
          this.fallback();
          try { this.draw2d(t, strength, theme, w); } catch { this.canvas.hidden = true; }
        }
      }
      if (this.canvas.hidden) return;
      if (!paused || (this._s != null && this._s !== Math.max(0, Math.min(1, this.num('strength', 1))))) this.raf = requestAnimationFrame(this.frame);
    }
    draw2d(t, strength, theme, w) {
      const c = this.canvas.getContext('2d'); if (!c) { this.canvas.hidden = true; return; }
      const { w: W, h: H, r, dpr } = this.box, cx = W / 2, cy = H / 2;
      c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W, H); c.globalAlpha = strength;
      const ha = t * 0.4 + 1.2 * Math.sin(t * 0.23);
      const glow = c.createRadialGradient(cx + Math.cos(ha) * r, cy - Math.sin(ha) * r, 0, cx + Math.cos(ha) * r, cy - Math.sin(ha) * r, 14);
      glow.addColorStop(0, 'rgba(255,248,236,.4)'); glow.addColorStop(1, 'rgba(255,248,236,0)');
      c.fillStyle = glow; c.fillRect(0, 0, W, H);
      let g; if (c.createConicGradient) { g = c.createConicGradient(-t * 0.5, cx, cy); const s = theme ? ['#3a3a40', '#d8d8dc', '#6a6a72', '#f4f4f6', '#4a4a52', '#c0c0c6', '#3a3a40'] : ['#7c7c84', '#ffffff', '#9a9aa4', '#f2f2f5', '#66666e', '#e2e2e8', '#7c7c84']; s.forEach((col, i) => g.addColorStop(i / (s.length - 1), col)); } else g = theme ? '#8a8a90' : '#d4d4da';
      c.lineWidth = w; c.strokeStyle = g; c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.stroke();
    }
  }
  customElements.define('metal-ring', MetalRing);
})();
