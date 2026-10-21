// Kyara Duel v2 — module d'effets (chantier D, voir docs/DUEL-V2.md §4).
// Sons synthétisés (WebAudio), particules (canvas) et carte d'ultime plein écran.
// Script simple, sans dépendance ni fichier binaire : expose window.KYARA_DUEL_FX.
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constantes
  // ---------------------------------------------------------------------------

  // Couleurs des types (DUEL-V2 §1.6) : permet aussi de passer un nom de type comme couleur.
  const TYPE_COLORS = {
    duelliste: '#ff5a4e',
    mystique: '#a66bff',
    soutien: '#3fd68a',
    gardien: '#4aa3ff',
    gardienne: '#4aa3ff',
    'stratège': '#ffc24a',
    stratege: '#ffc24a'
  };
  const DEFAULT_COLOR = '#e8ecff';

  // Statuts du moteur (STATUS_KEYS) → libellé français, couleur, forme des particules.
  const STATUS = {
    poison: { label: 'Poison', color: '#c061ff', shape: 'bubble', dir: -1, good: false },
    curse: { label: 'Malédiction', color: '#ff3d7f', shape: 'smoke', dir: 1, good: false },
    weakness: { label: 'Faiblesse', color: '#93a4c3', shape: 'chev', dir: 1, good: false },
    rage: { label: 'Rage', color: '#ff7a2b', shape: 'flame', dir: -1, good: true },
    regen: { label: 'Régénération', color: '#3fd68a', shape: 'plus', dir: -1, good: true },
    haste: { label: 'Hâte', color: '#ffe14a', shape: 'dash', dir: 0, good: true },
    dispel: { label: 'Dissipation', color: '#dff3ff', shape: 'star', dir: -1, good: true }
  };
  // Alias français acceptés pour `status`.
  const STATUS_ALIAS = {
    'malédiction': 'curse', malediction: 'curse', faiblesse: 'weakness',
    'régénération': 'regen', regeneration: 'regen', 'hâte': 'haste', hate: 'haste',
    dissipation: 'dispel'
  };

  const MAX_PARTICLES = 1400;
  const HEAL_COLOR = '#3fd68a';
  const GUARD_COLOR = '#4aa3ff';

  // ---------------------------------------------------------------------------
  // Utilitaires
  // ---------------------------------------------------------------------------

  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const easeOut = (k) => 1 - (1 - k) * (1 - k) * (1 - k);
  const easeIn = (k) => k * k;

  function parseColor(c) {
    if (Array.isArray(c) && c.length >= 3) return [c[0] | 0, c[1] | 0, c[2] | 0];
    let s = String(c == null ? '' : c).trim();
    const named = TYPE_COLORS[s.toLowerCase()];
    if (named) s = named;
    let m = /^#([0-9a-f]{3})$/i.exec(s);
    if (m) {
      const h = m[1];
      return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
    }
    m = /^#([0-9a-f]{6})/i.exec(s);
    if (m) {
      const n = parseInt(m[1], 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
    if (m) return [+m[1] | 0, +m[2] | 0, +m[3] | 0];
    return parseColor(DEFAULT_COLOR);
  }
  const css = (rgb) => 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')';
  const hex = (rgb) => '#' + rgb.map((v) => ('0' + clamp(v, 0, 255).toString(16)).slice(-2)).join('');
  // Mélange vers le blanc (k > 0) ou vers le gris terne (désaturation, k < 0).
  function tint(rgb, k) {
    if (k >= 0) return rgb.map((v) => Math.round(v + (255 - v) * k));
    const g = (rgb[0] + rgb[1] + rgb[2]) / 3;
    return rgb.map((v) => Math.round(v + (g - v) * -k));
  }

  function reducedMotionQuery() {
    try {
      return root.matchMedia ? root.matchMedia('(prefers-reduced-motion: reduce)') : null;
    } catch (_) {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Feuille de style (injectée dans rootEl, fonctionne aussi dans un Shadow DOM)
  // ---------------------------------------------------------------------------

  const FONT_IMPACT = "'Impact','Haettenschweiler','Arial Narrow Bold','Arial Black','Segoe UI Black',sans-serif";
  const FONT_UI = "'Segoe UI','Trebuchet MS',system-ui,sans-serif";
  const STYLE = `
.kdfx-layer{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;overflow:hidden;z-index:60;contain:strict}
.kdfx-canvas{position:absolute;left:0;top:0;width:100%;height:100%;display:block}
.kdfx-float{position:absolute;left:0;top:0;white-space:nowrap;text-align:center;pointer-events:none;will-change:transform,opacity;font-family:${FONT_IMPACT};line-height:1}
.kdfx-num{display:block;font-size:clamp(24px,calc(var(--kdfx-u,8px)*6.2),58px);font-style:italic;letter-spacing:.02em;color:#fff;
  text-shadow:0 3px 0 #000,2px 2px 0 #000,-2px 2px 0 #000,2px -2px 0 #000,-2px -2px 0 #000,0 0 14px var(--kdfx-glow,#000)}
.kdfx-lab{display:block;margin-bottom:.18em;font-size:clamp(13px,calc(var(--kdfx-u,8px)*2.5),24px);font-style:italic;letter-spacing:.04em;color:#fff;
  text-shadow:0 2px 0 #000,1px 1px 0 #000,-1px 1px 0 #000,1px -1px 0 #000,-1px -1px 0 #000,0 0 10px var(--kdfx-glow,#000)}
.kdfx-big .kdfx-num{font-size:clamp(32px,calc(var(--kdfx-u,8px)*8.6),84px);color:#ffe45c}
.kdfx-big .kdfx-lab{color:#ffe45c}
.kdfx-dull .kdfx-num{font-size:clamp(20px,calc(var(--kdfx-u,8px)*4.8),44px);color:#b9bdc8;text-shadow:0 2px 0 #000,1px 1px 0 #000,-1px 1px 0 #000,1px -1px 0 #000,-1px -1px 0 #000}
.kdfx-dull .kdfx-lab{color:#c9ccd4;text-shadow:0 2px 0 #000,1px 1px 0 #000,-1px 1px 0 #000,1px -1px 0 #000,-1px -1px 0 #000}
.kdfx-heal .kdfx-num{color:#7dffbc}
.kdfx-guard .kdfx-num{color:#9fd2ff}
.kdfx-pill{display:inline-block;padding:.32em .8em .36em;border-radius:999px;font-family:${FONT_UI};font-weight:800;font-size:clamp(12px,calc(var(--kdfx-u,8px)*2.2),20px);
  letter-spacing:.03em;color:#10121a;background:var(--kdfx-pill,#fff);box-shadow:0 0 0 2px rgba(0,0,0,.55),0 0 18px var(--kdfx-pill,#fff)}
.kdfx-ult{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:auto;cursor:pointer;overflow:hidden;z-index:5;
  -webkit-tap-highlight-color:transparent;user-select:none;font-family:${FONT_IMPACT}}
.kdfx-ult>*{position:absolute;pointer-events:none}
.kdfx-ult-bg{left:0;top:0;width:100%;height:100%}
.kdfx-ult-rays{border-radius:50%;opacity:.85;
  background:repeating-conic-gradient(from 0deg,rgba(var(--kdfx-cr),.55) 0deg 2.2deg,rgba(var(--kdfx-cr),0) 2.2deg 7deg,rgba(255,255,255,.18) 7deg 7.8deg,rgba(var(--kdfx-cr),0) 7.8deg 13deg);
  -webkit-mask-image:radial-gradient(circle,transparent 6%,#000 22%,#000 48%,transparent 70%);mask-image:radial-gradient(circle,transparent 6%,#000 22%,#000 48%,transparent 70%)}
.kdfx-ult-lines{left:0;top:0;width:100%;height:100%}
.kdfx-ult-bar{left:0;width:100%;height:9%;background:#000}
.kdfx-ult-band{left:-10%;width:120%;overflow:hidden;white-space:nowrap;transform:skewY(-7deg);
  background:linear-gradient(90deg,rgba(var(--kdfx-cr),0),rgba(var(--kdfx-cr),.9) 18%,rgba(var(--kdfx-cr),.75) 70%,rgba(var(--kdfx-cr),0));
  box-shadow:0 0 40px rgba(var(--kdfx-cr),.6)}
.kdfx-ult-band span{display:inline-block;padding-left:.4em;color:transparent;-webkit-text-stroke:1.5px rgba(255,255,255,.35);letter-spacing:.12em;font-style:italic}
.kdfx-ult-card{box-sizing:border-box;border-radius:16px;
  background:linear-gradient(135deg,#fff,var(--kdfx-c) 22%,#fff 46%,var(--kdfx-c) 70%,#fff);background-size:300% 300%;
  box-shadow:0 0 0 2px rgba(0,0,0,.6),0 0 26px 4px rgba(var(--kdfx-cr),.9),0 0 90px 14px rgba(var(--kdfx-cr),.55);
  animation:kdfx-sheen 1.1s linear infinite,kdfx-blink .16s steps(2,jump-none) infinite alternate}
.kdfx-reduced .kdfx-ult-card{animation:none}
.kdfx-ult-card-in{position:absolute;inset:var(--kdfx-pad,8px);border-radius:10px;overflow:hidden;background:#0d0f18}
.kdfx-ult-card-in img{position:absolute;left:0;top:0;width:100%;height:100%;object-fit:cover;object-position:50% 18%}
.kdfx-ult-card-in::after{content:'';position:absolute;inset:0;
  background:linear-gradient(180deg,rgba(0,0,0,0) 55%,rgba(var(--kdfx-cr),.55)),linear-gradient(115deg,transparent 38%,rgba(255,255,255,.6) 48%,transparent 58%) no-repeat;
  background-size:100% 100%,300% 100%;background-position:0 0,140% 0;animation:kdfx-shine .7s .25s ease-out both}
.kdfx-reduced .kdfx-ult-card-in::after{animation:none;background-position:0 0,-200% 0}
.kdfx-ult-ph{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:var(--kdfx-ph,120px);color:rgba(255,255,255,.92);
  background:radial-gradient(circle at 50% 35%,rgba(var(--kdfx-cr),.9),#10121c 75%);text-shadow:0 4px 0 #000}
.kdfx-ult-text{display:flex;flex-direction:column;justify-content:center}
.kdfx-ult-tall .kdfx-ult-text{align-items:center;text-align:center;justify-content:flex-start}
.kdfx-ult-wide .kdfx-ult-text{align-items:flex-start;text-align:left}
.kdfx-ult-tag{display:inline-block;align-self:inherit;padding:.12em .7em .16em;margin-bottom:.35em;font-family:${FONT_UI};font-weight:900;letter-spacing:.32em;
  color:#0b0c12;background:var(--kdfx-c);transform:skewX(-14deg);box-shadow:0 0 22px rgba(var(--kdfx-cr),.8)}
.kdfx-ult-name{display:block;max-width:100%;font-style:italic;line-height:.98;letter-spacing:.01em;padding:0 .12em .06em;overflow-wrap:break-word;
  color:#fff;background:linear-gradient(180deg,#fff 0%,#fff 46%,var(--kdfx-cl) 74%,var(--kdfx-c) 100%);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;
  filter:drop-shadow(0 3px 0 rgba(0,0,0,.85)) drop-shadow(0 0 1px #000) drop-shadow(0 0 16px rgba(var(--kdfx-cr),.85))}
.kdfx-ult-champ{display:flex;align-items:center;gap:.6em;margin-top:.45em;font-family:${FONT_UI};font-weight:800;text-transform:uppercase;letter-spacing:.24em;
  color:var(--kdfx-cl);text-shadow:0 2px 0 #000,0 0 12px rgba(var(--kdfx-cr),.9)}
.kdfx-ult-champ::before,.kdfx-ult-champ::after{content:'';width:2.4em;height:2px;background:linear-gradient(90deg,transparent,var(--kdfx-c))}
.kdfx-ult-champ::after{transform:scaleX(-1)}
.kdfx-ult-wide .kdfx-ult-champ::after{display:none}
.kdfx-ult-flash{left:0;top:0;width:100%;height:100%;background:#fff}
.kdfx-ult-skip{right:14px;bottom:10px;font-family:${FONT_UI};font-size:12px;font-weight:600;letter-spacing:.06em;color:rgba(255,255,255,.7);text-shadow:0 1px 2px #000}
@keyframes kdfx-sheen{to{background-position:300% 300%}}
@keyframes kdfx-blink{from{filter:brightness(1)}to{filter:brightness(1.45) saturate(1.2)}}
@keyframes kdfx-shine{to{background-position:0 0,-200% 0}}
`;

  // ---------------------------------------------------------------------------
  // Sons synthétisés (WebAudio)
  // ---------------------------------------------------------------------------

  const SOUND_NAMES = ['hit', 'crit', 'heal', 'guard', 'status', 'ko', 'switch', 'ultimate', 'chakra', 'select', 'victory', 'defeat'];

  function createAudio(doc, opts) {
    let ctx = null;
    let master = null;
    let noiseBuf = null;
    let muted = !!opts.muted;
    let volume = clamp(opts.volume == null ? 0.7 : +opts.volume || 0, 0, 1);
    let dead = false;
    const last = Object.create(null);

    function applyGain() {
      if (!ctx || !master) return;
      const v = muted ? 0 : volume * volume * 0.9; // courbe perceptive
      try {
        master.gain.cancelScheduledValues(ctx.currentTime);
        master.gain.setTargetAtTime(v, ctx.currentTime, 0.015);
      } catch (_) {
        master.gain.value = v;
      }
    }

    function ensure() {
      if (dead) return null;
      if (ctx) return ctx;
      const AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) return null;
      try {
        ctx = new AC();
      } catch (_) {
        return null;
      }
      master = ctx.createGain();
      master.gain.value = 0;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -16;
      comp.knee.value = 12;
      comp.ratio.value = 5;
      comp.attack.value = 0.003;
      comp.release.value = 0.18;
      master.connect(comp);
      comp.connect(ctx.destination);
      // Bruit blanc partagé (1,5 s), lu à un décalage aléatoire.
      const len = Math.floor(ctx.sampleRate * 1.5);
      noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      applyGain();
      return ctx;
    }

    // Déverrouillage au premier geste de l'utilisateur (politique d'autoplay).
    function unlock() {
      if (dead) return;
      const c = ensure();
      if (c && c.state === 'suspended') c.resume().catch(() => {});
      if (c && c.state === 'running') removeUnlock();
    }
    const unlockEvents = ['pointerdown', 'keydown', 'touchstart'];
    function removeUnlock() {
      for (const e of unlockEvents) doc.removeEventListener(e, unlock, true);
    }
    for (const e of unlockEvents) doc.addEventListener(e, unlock, true);

    // --- briques de synthèse -------------------------------------------------
    function env(g, t, a, peak, d) {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(peak, t + a);
      g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
    }
    function osc(type, f0, f1, t, dur, peak, o) {
      o = o || {};
      const a = o.a == null ? 0.004 : o.a;
      const n = ctx.createOscillator();
      n.type = type;
      n.frequency.setValueAtTime(f0, t);
      if (f1 && f1 !== f0) n.frequency.exponentialRampToValueAtTime(f1, t + (o.glide || dur));
      if (o.detune) n.detune.value = o.detune;
      const g = ctx.createGain();
      env(g, t, a, peak, dur);
      let out = g;
      if (o.lp) {
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.setValueAtTime(o.lp, t);
        if (o.lp1) f.frequency.exponentialRampToValueAtTime(o.lp1, t + a + dur);
        f.Q.value = o.q || 0.8;
        g.connect(f);
        out = f;
      }
      n.connect(g);
      out.connect(o.dest || master);
      n.start(t);
      n.stop(t + a + dur + 0.05);
      return n;
    }
    function noise(t, dur, peak, o) {
      o = o || {};
      const a = o.a == null ? 0.002 : o.a;
      const src = ctx.createBufferSource();
      src.buffer = noiseBuf;
      const f = ctx.createBiquadFilter();
      f.type = o.type || 'lowpass';
      f.frequency.setValueAtTime(o.f0 || 2000, t);
      if (o.f1) f.frequency.exponentialRampToValueAtTime(o.f1, t + a + dur);
      f.Q.value = o.q == null ? 0.8 : o.q;
      const g = ctx.createGain();
      env(g, t, a, peak, dur);
      src.connect(f);
      f.connect(g);
      g.connect(o.dest || master);
      src.start(t, Math.random() * 0.8);
      src.stop(t + a + dur + 0.05);
    }
    function sub(level) {
      const g = ctx.createGain();
      g.gain.value = level;
      g.connect(master);
      return g;
    }

    // --- banque de sons --------------------------------------------------------
    const BANK = {
      hit(t, L) {
        const d = sub(L);
        noise(t, 0.13, 0.75, { f0: 3400, f1: 300, dest: d });
        osc('sine', 170, 46, t, 0.17, 0.95, { dest: d });
        osc('square', 95, 60, t, 0.05, 0.12, { dest: d, lp: 900 });
      },
      crit(t, L) {
        const d = sub(L);
        noise(t, 0.07, 0.55, { type: 'bandpass', f0: 2600, q: 0.7, dest: d });
        noise(t + 0.01, 0.24, 0.85, { f0: 4800, f1: 220, dest: d });
        osc('sine', 210, 38, t, 0.28, 1, { dest: d });
        osc('triangle', 1568, 1318, t + 0.01, 0.26, 0.2, { dest: d });
        osc('square', 2093, 1760, t + 0.015, 0.1, 0.05, { dest: d, lp: 5000 });
      },
      heal(t, L) {
        const d = sub(L);
        [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
          osc('triangle', f, f, t + i * 0.065, 0.3, 0.2, { a: 0.012, dest: d });
          osc('sine', f * 2, f * 2, t + i * 0.065, 0.2, 0.05, { a: 0.012, dest: d });
        });
        noise(t + 0.05, 0.4, 0.05, { type: 'highpass', f0: 6500, a: 0.08, dest: d });
      },
      guard(t, L) {
        const d = sub(L);
        osc('sine', 130, 70, t, 0.12, 0.45, { dest: d });
        osc('triangle', 660, 645, t, 0.38, 0.26, { dest: d });
        osc('triangle', 992, 985, t + 0.004, 0.32, 0.16, { dest: d });
        osc('sine', 1320, 1310, t + 0.008, 0.24, 0.08, { dest: d });
        noise(t, 0.16, 0.22, { type: 'bandpass', f0: 3600, q: 3.5, dest: d });
      },
      status(t, L) {
        const d = sub(L);
        const n = osc('sawtooth', 430, 210, t, 0.42, 0.13, { a: 0.02, lp: 1500, lp1: 500, dest: d });
        const lfo = ctx.createOscillator();
        const lg = ctx.createGain();
        lfo.frequency.value = 13;
        lg.gain.value = 28;
        lfo.connect(lg);
        lg.connect(n.frequency);
        lfo.start(t);
        lfo.stop(t + 0.5);
        osc('square', 322, 160, t + 0.03, 0.36, 0.035, { a: 0.02, lp: 1200, dest: d });
      },
      buff(t, L) {
        const d = sub(L);
        [392, 523.25, 659.25].forEach((f, i) => osc('square', f, f * 1.02, t + i * 0.05, 0.12, 0.05, { lp: 2400, dest: d }));
        osc('triangle', 784, 1175, t + 0.1, 0.22, 0.14, { dest: d });
      },
      ko(t, L) {
        const d = sub(L);
        osc('sawtooth', 380, 52, t, 0.72, 0.26, { lp: 1400, lp1: 160, dest: d });
        osc('sine', 115, 30, t + 0.02, 0.62, 0.85, { dest: d });
        noise(t, 0.55, 0.5, { f0: 2200, f1: 110, dest: d });
        noise(t + 0.24, 0.3, 0.3, { type: 'bandpass', f0: 1800, f1: 500, q: 1.2, dest: d });
      },
      switch(t, L) {
        const d = sub(L);
        noise(t, 0.22, 0.32, { type: 'bandpass', f0: 500, f1: 4200, q: 1.3, a: 0.04, dest: d });
        osc('sine', 520, 1040, t + 0.06, 0.1, 0.17, { dest: d });
        osc('sine', 780, 1560, t + 0.13, 0.12, 0.12, { dest: d });
      },
      recall(t, L) {
        const d = sub(L);
        noise(t, 0.2, 0.22, { type: 'bandpass', f0: 3600, f1: 500, q: 1.3, a: 0.02, dest: d });
        osc('sine', 1000, 420, t, 0.16, 0.09, { dest: d });
      },
      whoosh(t, L) {
        const d = sub(L);
        noise(t, 0.16, 0.3, { type: 'bandpass', f0: 800, f1: 2800, q: 1.4, a: 0.03, dest: d });
      },
      charge(t, L) {
        const d = sub(L);
        osc('sawtooth', 160, 720, t, 0.34, 0.07, { a: 0.18, glide: 0.4, lp: 900, lp1: 3200, dest: d });
        noise(t, 0.34, 0.12, { type: 'highpass', f0: 600, f1: 4000, a: 0.25, dest: d });
      },
      ultimate(t, L) {
        const d = sub(L);
        // Montée
        noise(t, 0.3, 0.32, { type: 'highpass', f0: 500, f1: 3200, a: 0.26, dest: d });
        osc('sawtooth', 180, 900, t, 0.3, 0.06, { a: 0.24, lp: 1200, lp1: 4000, dest: d });
        // Impact
        const T = t + 0.3;
        osc('sine', 98, 30, T, 0.75, 1, { dest: d });
        noise(T, 0.55, 0.75, { f0: 6000, f1: 160, dest: d });
        [110, 164.81, 220, 329.63].forEach((f) => {
          osc('sawtooth', f, f, T, 0.95, 0.075, { a: 0.01, lp: 3200, lp1: 380, dest: d, detune: rand(-8, 8) });
        });
        osc('triangle', 1760, 1760, T + 0.02, 0.85, 0.07, { dest: d });
        osc('triangle', 2637, 2637, T + 0.08, 0.7, 0.04, { dest: d });
      },
      chakra(t, L) {
        const d = sub(L);
        osc('sine', 1318.5, 1318.5, t, 0.22, 0.18, { dest: d });
        osc('sine', 1975.5, 1975.5, t + 0.06, 0.34, 0.16, { dest: d });
        osc('triangle', 2637, 2637, t + 0.06, 0.14, 0.04, { dest: d });
      },
      select(t, L) {
        const d = sub(L);
        osc('square', 880, 920, t, 0.035, 0.05, { lp: 3000, dest: d });
        osc('sine', 1760, 1760, t, 0.05, 0.07, { dest: d });
      },
      victory(t, L) {
        const d = sub(L);
        const notes = [523.25, 659.25, 783.99];
        notes.forEach((f, i) => {
          osc('square', f, f, t + i * 0.12, 0.14, 0.05, { lp: 3000, dest: d });
          osc('triangle', f, f, t + i * 0.12, 0.16, 0.2, { dest: d });
        });
        const T = t + 0.38;
        osc('square', 1046.5, 1046.5, T, 0.8, 0.05, { a: 0.01, lp: 3000, dest: d });
        osc('triangle', 1046.5, 1046.5, T, 0.9, 0.22, { a: 0.01, dest: d });
        [523.25, 659.25, 783.99].forEach((f) => osc('triangle', f, f, T, 0.9, 0.08, { a: 0.01, dest: d }));
        noise(T, 0.6, 0.05, { type: 'highpass', f0: 7000, a: 0.05, dest: d });
      },
      defeat(t, L) {
        const d = sub(L);
        [392, 311.13, 261.63].forEach((f, i) => {
          osc('triangle', f, f * 0.99, t + i * 0.26, 0.32, 0.2, { a: 0.01, dest: d });
          osc('sine', f / 2, f / 2, t + i * 0.26, 0.32, 0.12, { a: 0.01, dest: d });
        });
        osc('sawtooth', 196, 180, t + 0.8, 0.9, 0.07, { a: 0.02, lp: 900, lp1: 300, dest: d });
        osc('triangle', 196, 185, t + 0.8, 0.9, 0.2, { a: 0.02, dest: d });
      }
    };

    function playNow(name, level) {
      try {
        BANK[name](ctx.currentTime + 0.005, level);
      } catch (_) {
        /* un son raté ne doit jamais casser le duel */
      }
    }

    function play(name, level) {
      if (dead || muted || !BANK[name]) return;
      const now = performance.now();
      if (last[name] && now - last[name] < 40) return; // évite l'empilement
      last[name] = now;
      // Pas de contexte avant un geste (sauf si le navigateur signale déjà une activation).
      const ua = root.navigator && root.navigator.userActivation;
      if (!ctx && ua && !ua.hasBeenActive) return;
      const c = ensure();
      if (!c) return;
      const lv = level == null ? 1 : level;
      if (c.state === 'running') return playNow(name, lv);
      const t0 = performance.now();
      c.resume()
        .then(() => {
          if (!dead && performance.now() - t0 < 250) playNow(name, lv);
        })
        .catch(() => {});
    }

    return {
      play,
      setMuted(b) {
        muted = !!b;
        applyGain();
      },
      setVolume(v) {
        volume = clamp(+v || 0, 0, 1);
        applyGain();
      },
      get muted() {
        return muted;
      },
      destroy() {
        dead = true;
        removeUnlock();
        if (ctx) ctx.close().catch(() => {});
        ctx = null;
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Instance
  // ---------------------------------------------------------------------------

  function create(rootEl, opts) {
    opts = opts || {};
    if (!rootEl || !rootEl.ownerDocument) throw new Error('KYARA_DUEL_FX.create : élément racine requis');
    const doc = rootEl.ownerDocument;
    const win = doc.defaultView || root;
    let destroyed = false;

    // --- mouvement réduit ---
    const mq = reducedMotionQuery();
    let reduced = opts.reducedMotion != null ? !!opts.reducedMotion : !!(mq && mq.matches);
    const onMq = () => {
      if (opts.reducedMotion == null) reduced = !!(mq && mq.matches);
      layer.classList.toggle('kdfx-reduced', reduced);
    };
    if (mq && opts.reducedMotion == null) {
      if (mq.addEventListener) mq.addEventListener('change', onMq);
      else if (mq.addListener) mq.addListener(onMq);
    }
    const density = () => (reduced ? 0.35 : 1);
    const N = (n) => Math.max(1, Math.round(n * density()));

    // --- DOM ---
    let restorePosition = null;
    if (win.getComputedStyle(rootEl).position === 'static') {
      restorePosition = rootEl.style.position;
      rootEl.style.position = 'relative';
    }
    const styleEl = doc.createElement('style');
    styleEl.textContent = STYLE;
    const layer = doc.createElement('div');
    layer.className = 'kdfx-layer' + (reduced ? ' kdfx-reduced' : '');
    layer.setAttribute('aria-hidden', 'true');
    const canvas = doc.createElement('canvas');
    canvas.className = 'kdfx-canvas';
    layer.appendChild(canvas);
    rootEl.appendChild(styleEl);
    rootEl.appendChild(layer);
    const g = canvas.getContext('2d');

    let W = 1;
    let H = 1;
    let dpr = 1;
    function resize() {
      if (destroyed) return;
      W = Math.max(1, rootEl.clientWidth);
      H = Math.max(1, rootEl.clientHeight);
      dpr = Math.min(2, win.devicePixelRatio || 1);
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      layer.style.width = W + 'px';
      layer.style.height = H + 'px';
      layer.style.setProperty('--kdfx-u', (Math.min(W, H) / 100).toFixed(2) + 'px');
      if (ult) ult.layout();
      if (!running) g.clearRect(0, 0, canvas.width, canvas.height);
    }
    function onScroll() {
      layer.style.left = rootEl.scrollLeft + 'px';
      layer.style.top = rootEl.scrollTop + 'px';
    }
    rootEl.addEventListener('scroll', onScroll, { passive: true });
    let ro = null;
    if (win.ResizeObserver) {
      ro = new win.ResizeObserver(resize);
      ro.observe(rootEl);
    }
    win.addEventListener('resize', resize);

    // --- minuteries suivies (nettoyées par destroy) ---
    const timers = new Set();
    function later(fn, ms) {
      const id = win.setTimeout(() => {
        timers.delete(id);
        if (!destroyed) fn();
      }, ms);
      timers.add(id);
      return id;
    }

    // --- animations d'éléments (WAAPI) ---
    const anims = new Set();
    const persisted = new Map(); // el → [Animation] conservées (K.O., retrait)
    function animate(el, kf, o, keep) {
      if (destroyed || !el || typeof el.animate !== 'function') return null;
      let a;
      try {
        a = el.animate(kf, Object.assign({ fill: keep ? 'forwards' : 'none' }, o));
      } catch (_) {
        return null;
      }
      anims.add(a);
      if (keep) {
        const list = persisted.get(el) || [];
        list.push(a);
        persisted.set(el, list);
      } else {
        const done = () => anims.delete(a);
        a.finished.then(done, done);
      }
      return a;
    }
    function releaseEl(el) {
      const list = persisted.get(el);
      if (!list) return;
      for (const a of list) {
        anims.delete(a);
        try {
          a.cancel();
        } catch (_) {
          /* ignoré */
        }
      }
      persisted.delete(el);
    }
    function shake(el, mag, dur) {
      if (reduced || !el || mag <= 0) return;
      const kf = [];
      const steps = 9;
      for (let i = 0; i < steps; i++) {
        const m = mag * (1 - i / steps);
        kf.push({ translate: (rand(-1, 1) * m).toFixed(1) + 'px ' + (rand(-0.6, 0.6) * m).toFixed(1) + 'px' });
      }
      kf.push({ translate: '0px 0px' });
      animate(el, kf, { duration: dur, easing: 'linear', composite: 'add' });
    }

    // --- géométrie ---
    function rectOf(el) {
      const L = layer.getBoundingClientRect();
      if (el && el.getBoundingClientRect) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 || r.height > 0) {
          return { x: r.left - L.left + r.width / 2, y: r.top - L.top + r.height / 2, w: r.width, h: r.height, l: r.left - L.left, t: r.top - L.top };
        }
      }
      return { x: W / 2, y: H / 2, w: 120, h: 160, l: W / 2 - 60, t: H / 2 - 80 };
    }

    // -------------------------------------------------------------------------
    // Système de particules (réserve d'objets, boucle à la demande)
    // -------------------------------------------------------------------------
    const pool = [];
    const live = [];
    const tasks = [];
    let running = false;
    let raf = 0;
    let lastT = 0;
    let flashA = 0;
    let flashCol = '#fff';

    const sprites = new Map();
    function glowSprite(rgb) {
      const key = rgb.join(',');
      let s = sprites.get(key);
      if (s) return s;
      s = doc.createElement('canvas');
      s.width = s.height = 64;
      const c = s.getContext('2d');
      const gr = c.createRadialGradient(32, 32, 0, 32, 32, 32);
      gr.addColorStop(0, 'rgba(255,255,255,1)');
      gr.addColorStop(0.18, 'rgba(' + key + ',1)');
      gr.addColorStop(0.45, 'rgba(' + key + ',.35)');
      gr.addColorStop(1, 'rgba(' + key + ',0)');
      c.fillStyle = gr;
      c.fillRect(0, 0, 64, 64);
      sprites.set(key, s);
      return s;
    }
    const smokeSprite = (() => {
      let s = null;
      return () => {
        if (s) return s;
        s = doc.createElement('canvas');
        s.width = s.height = 64;
        const c = s.getContext('2d');
        const gr = c.createRadialGradient(32, 32, 0, 32, 32, 32);
        gr.addColorStop(0, 'rgba(30,6,24,.85)');
        gr.addColorStop(0.5, 'rgba(40,8,30,.4)');
        gr.addColorStop(1, 'rgba(40,8,30,0)');
        c.fillStyle = gr;
        c.fillRect(0, 0, 64, 64);
        return s;
      };
    })();

    function spawn(o) {
      if (destroyed || live.length >= MAX_PARTICLES) return null;
      const p = pool.pop() || {};
      p.x = o.x;
      p.y = o.y;
      p.vx = o.vx || 0;
      p.vy = o.vy || 0;
      p.ax = o.ax || 0;
      p.ay = o.ay || 0;
      p.drag = o.drag || 0;
      p.t = -(o.delay || 0);
      p.ttl = o.ttl || 0.6;
      p.s0 = o.s0 == null ? 4 : o.s0;
      p.s1 = o.s1 == null ? p.s0 : o.s1;
      p.rgb = o.rgb || [255, 255, 255];
      p.css = css(p.rgb);
      p.shape = o.shape || 'glow';
      p.rot = o.rot || 0;
      p.vr = o.vr || 0;
      p.a0 = o.a == null ? 1 : o.a;
      p.add = o.add !== false;
      p.len = o.len || 0.04;
      p.lw = o.lw || 3;
      p.pts = o.pts || null;
      p.fadeIn = o.fadeIn || 0;
      live.push(p);
      wake();
      return p;
    }

    function addTask(t) {
      if (destroyed) return;
      t.age = 0;
      tasks.push(t);
      wake();
    }

    function wake() {
      if (running || destroyed) return;
      running = true;
      lastT = 0;
      raf = win.requestAnimationFrame(frame);
    }

    function frame(now) {
      if (destroyed) return;
      const dt = lastT ? Math.min(0.05, (now - lastT) / 1000) : 1 / 60;
      lastT = now;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, canvas.width, canvas.height);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Tâches (projectiles, boucliers…) : mise à jour.
      for (let i = tasks.length - 1; i >= 0; i--) {
        const t = tasks[i];
        t.age += dt;
        let alive = true;
        try {
          alive = t.update(dt, t.age) !== false;
        } catch (_) {
          alive = false;
        }
        if (!alive) {
          tasks.splice(i, 1);
          if (t.end) t.end();
        }
      }

      // Particules.
      for (let i = live.length - 1; i >= 0; i--) {
        const p = live[i];
        p.t += dt;
        if (p.t < 0) continue;
        if (p.t >= p.ttl) {
          live[i] = live[live.length - 1];
          live.pop();
          pool.push(p);
          continue;
        }
        const k = p.t / p.ttl;
        const dr = p.drag ? Math.max(0, 1 - p.drag * dt) : 1;
        p.vx = (p.vx + p.ax * dt) * dr;
        p.vy = (p.vy + p.ay * dt) * dr;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.rot += p.vr * dt;
        let a = p.a0 * (1 - k);
        if (p.fadeIn && k < p.fadeIn) a = p.a0 * (k / p.fadeIn);
        drawParticle(p, k, a);
      }

      // Dessins des tâches par-dessus les particules.
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 1;
      for (const t of tasks) if (t.draw) t.draw(g);

      if (flashA > 0.004) {
        g.globalCompositeOperation = 'source-over';
        g.globalAlpha = flashA;
        g.fillStyle = flashCol;
        g.fillRect(0, 0, W, H);
        flashA *= Math.pow(0.0025, dt); // décroissance rapide (~0,3 s)
      } else flashA = 0;
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';

      if (live.length || tasks.length || flashA > 0) {
        raf = win.requestAnimationFrame(frame);
      } else {
        running = false;
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.clearRect(0, 0, canvas.width, canvas.height);
      }
    }

    function drawParticle(p, k, a) {
      if (a <= 0.003) return;
      const s = p.s0 + (p.s1 - p.s0) * k;
      g.globalAlpha = a > 1 ? 1 : a;
      g.globalCompositeOperation = p.add ? 'lighter' : 'source-over';
      switch (p.shape) {
        case 'glow': {
          const sp = glowSprite(p.rgb);
          g.drawImage(sp, p.x - s, p.y - s, s * 2, s * 2);
          break;
        }
        case 'smoke': {
          g.drawImage(smokeSprite(), p.x - s, p.y - s, s * 2, s * 2);
          break;
        }
        case 'streak': {
          const tx = p.x - p.vx * p.len;
          const ty = p.y - p.vy * p.len;
          g.lineCap = 'round';
          g.strokeStyle = p.css;
          g.lineWidth = s;
          g.beginPath();
          g.moveTo(tx, ty);
          g.lineTo(p.x, p.y);
          g.stroke();
          g.strokeStyle = '#fff';
          g.lineWidth = Math.max(0.6, s * 0.4);
          g.stroke();
          break;
        }
        case 'ring': {
          const e = easeOut(k);
          const r = p.s0 + (p.s1 - p.s0) * e;
          g.strokeStyle = p.css;
          g.lineWidth = Math.max(0.5, p.lw * (1 - k));
          g.beginPath();
          g.arc(p.x, p.y, Math.max(0.1, r), 0, Math.PI * 2);
          g.stroke();
          break;
        }
        case 'shard': {
          const pts = p.pts;
          const c = Math.cos(p.rot);
          const si = Math.sin(p.rot);
          g.beginPath();
          for (let i = 0; i < pts.length; i += 2) {
            const x = p.x + pts[i] * c - pts[i + 1] * si;
            const y = p.y + pts[i] * si + pts[i + 1] * c;
            if (i) g.lineTo(x, y);
            else g.moveTo(x, y);
          }
          g.closePath();
          g.fillStyle = p.css;
          g.fill();
          g.strokeStyle = 'rgba(255,255,255,.75)';
          g.lineWidth = 1;
          g.stroke();
          break;
        }
        case 'plus': {
          const w = s * 0.36;
          g.fillStyle = p.css;
          g.fillRect(p.x - s, p.y - w / 2, s * 2, w);
          g.fillRect(p.x - w / 2, p.y - s, w, s * 2);
          break;
        }
        case 'chev': {
          // Chevron orienté par p.rot (0 = vers le bas).
          const c = Math.cos(p.rot);
          const si = Math.sin(p.rot);
          const pt = (x, y) => [p.x + x * c - y * si, p.y + x * si + y * c];
          g.strokeStyle = p.css;
          g.lineWidth = Math.max(1.5, s * 0.38);
          g.lineCap = 'round';
          g.lineJoin = 'round';
          g.beginPath();
          let q = pt(-s, -s * 0.45);
          g.moveTo(q[0], q[1]);
          q = pt(0, s * 0.45);
          g.lineTo(q[0], q[1]);
          q = pt(s, -s * 0.45);
          g.lineTo(q[0], q[1]);
          g.stroke();
          break;
        }
        case 'bubble': {
          g.strokeStyle = p.css;
          g.lineWidth = Math.max(1, s * 0.22);
          g.beginPath();
          g.arc(p.x, p.y, s, 0, Math.PI * 2);
          g.stroke();
          g.fillStyle = 'rgba(255,255,255,.8)';
          g.beginPath();
          g.arc(p.x - s * 0.35, p.y - s * 0.35, s * 0.22, 0, Math.PI * 2);
          g.fill();
          break;
        }
        case 'star': {
          g.fillStyle = p.css;
          g.beginPath();
          const r2 = s * 0.22;
          for (let i = 0; i < 8; i++) {
            const ang = p.rot + (i * Math.PI) / 4;
            const r = i % 2 ? r2 : s;
            const x = p.x + Math.cos(ang) * r;
            const y = p.y + Math.sin(ang) * r;
            if (i) g.lineTo(x, y);
            else g.moveTo(x, y);
          }
          g.closePath();
          g.fill();
          break;
        }
        default:
          break;
      }
    }

    // Gerbe radiale générique.
    function burst(x, y, o) {
      const n = N(o.n || 12);
      for (let i = 0; i < n; i++) {
        const ang = o.ang != null ? o.ang + rand(-(o.spread || Math.PI), o.spread || Math.PI) : rand(0, Math.PI * 2);
        const sp = rand(o.sp[0], o.sp[1]);
        const sz = rand(o.size[0], o.size[1]);
        spawn({
          x: x + (o.jitter ? rand(-o.jitter, o.jitter) : 0),
          y: y + (o.jitter ? rand(-o.jitter, o.jitter) : 0),
          vx: Math.cos(ang) * sp,
          vy: Math.sin(ang) * sp,
          ay: o.grav || 0,
          drag: o.drag || 0,
          ttl: rand(o.ttl[0], o.ttl[1]),
          s0: sz,
          s1: o.shrink ? sz * o.shrink : sz,
          rgb: Array.isArray(o.rgb[0]) ? o.rgb[(Math.random() * o.rgb.length) | 0] : o.rgb,
          shape: o.shape || 'glow',
          len: o.len,
          rot: o.rot != null ? o.rot : rand(0, 6.28),
          vr: o.vr ? rand(-o.vr, o.vr) : 0,
          a: o.a,
          delay: o.delay ? rand(0, o.delay) : 0,
          add: o.add
        });
      }
    }
    function ring(x, y, rgb, r0, r1, ttl, lw, delay) {
      spawn({ x, y, s0: r0, s1: r1, ttl, rgb, shape: 'ring', lw: lw || 3, delay: delay || 0 });
    }
    function flash(a, color) {
      if (reduced) a *= 0.4;
      flashA = Math.max(flashA, a);
      flashCol = color || '#fff';
      wake();
    }

    // Promesse résolue à la fin d'une tâche, avec filet de sécurité (onglet caché, etc.).
    function settle(ms, fn) {
      return new Promise((resolve) => {
        let done = false;
        const fin = () => {
          if (done) return;
          done = true;
          resolve();
        };
        later(fin, ms + 400);
        fn(fin);
      });
    }
    const resolved = () => Promise.resolve();

    // -------------------------------------------------------------------------
    // Textes flottants (chiffres, libellés)
    // -------------------------------------------------------------------------
    const stacks = new WeakMap();
    function floatText(el, r, main, label, cls, glow, dur) {
      const div = doc.createElement('div');
      div.className = 'kdfx-float ' + (cls || '');
      if (glow) div.style.setProperty('--kdfx-glow', glow);
      if (label) {
        const l = doc.createElement('span');
        l.className = 'kdfx-lab';
        l.textContent = label;
        div.appendChild(l);
      }
      if (main != null && main !== '') {
        const n = doc.createElement('span');
        n.className = 'kdfx-num';
        n.textContent = main;
        div.appendChild(n);
      }
      // Empilement si plusieurs textes arrivent vite sur le même élément.
      const now = performance.now();
      let st = el ? stacks.get(el) : null;
      if (!st || now - st.t > 650) st = { t: now, k: 0 };
      else st.k += 1;
      st.t = now;
      if (el) stacks.set(el, st);
      const x = clamp(r.x, 40, W - 40);
      const y = clamp(r.t + r.h * 0.32 - st.k * 30, 40, H - 20);
      div.style.left = x.toFixed(1) + 'px';
      div.style.top = y.toFixed(1) + 'px';
      layer.appendChild(div);
      dur = dur || 1100;
      const tr = (dy, s) => 'translate(-50%,' + dy + '%) scale(' + s + ')';
      const kf = reduced
        ? [
            { opacity: 0, transform: tr(-50, 1) },
            { opacity: 1, transform: tr(-50, 1), offset: 0.12 },
            { opacity: 1, transform: tr(-70, 1), offset: 0.75 },
            { opacity: 0, transform: tr(-80, 1) }
          ]
        : [
            { opacity: 0, transform: tr(-20, 0.3) },
            { opacity: 1, transform: tr(-55, 1.3), offset: 0.1 },
            { opacity: 1, transform: tr(-62, 1), offset: 0.22 },
            { opacity: 1, transform: tr(-90, 1), offset: 0.72 },
            { opacity: 0, transform: tr(-150, 0.94) }
          ];
      const a = animate(div, kf, { duration: dur, easing: 'cubic-bezier(.2,.7,.3,1)' });
      const rm = () => div.remove();
      if (a) a.finished.then(rm, rm);
      later(rm, dur + 300);
    }
    function statusPill(r, label, color) {
      const wrap = doc.createElement('div');
      wrap.className = 'kdfx-float';
      const pill = doc.createElement('span');
      pill.className = 'kdfx-pill';
      pill.style.setProperty('--kdfx-pill', color);
      pill.textContent = label;
      wrap.appendChild(pill);
      wrap.style.left = clamp(r.x, 60, W - 60).toFixed(1) + 'px';
      wrap.style.top = clamp(r.t + r.h * 0.18, 30, H - 20).toFixed(1) + 'px';
      layer.appendChild(wrap);
      const tr = (dy, s) => 'translate(-50%,' + dy + '%) scale(' + s + ')';
      const kf = reduced
        ? [{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }]
        : [
            { opacity: 0, transform: tr(0, 0.6) },
            { opacity: 1, transform: tr(-60, 1.12), offset: 0.14 },
            { opacity: 1, transform: tr(-70, 1), offset: 0.25 },
            { opacity: 1, transform: tr(-110, 1), offset: 0.8 },
            { opacity: 0, transform: tr(-150, 1) }
          ];
      const a = animate(wrap, kf, { duration: 1250, easing: 'ease-out', fill: 'both' });
      if (!a) wrap.style.transform = tr(-50, 1);
      const rm = () => wrap.remove();
      if (a) a.finished.then(rm, rm);
      later(rm, 1600);
    }

    // -------------------------------------------------------------------------
    // Effets de combat
    // -------------------------------------------------------------------------
    const audio = createAudio(doc, opts);
    const sfx = (name, level, o) => {
      if (!(o && o.silent)) audio.play(name, level);
    };

    // Point sur une courbe de Bézier quadratique.
    function bez(a, c, b, k) {
      const u = 1 - k;
      return [u * u * a.x + 2 * u * k * c.x + k * k * b.x, u * u * a.y + 2 * u * k * c.y + k * k * b.y];
    }
    function arcCtrl(A, B, h) {
      const dx = B.x - A.x;
      const dy = B.y - A.y;
      const d = Math.hypot(dx, dy) || 1;
      // Perpendiculaire orientée vers le haut de l'écran.
      let nx = -dy / d;
      let ny = dx / d;
      if (ny > 0) {
        nx = -nx;
        ny = -ny;
      }
      return { x: (A.x + B.x) / 2 + nx * d * h, y: (A.y + B.y) / 2 + ny * d * h };
    }

    // Projectile générique : tête lumineuse + traînée, appelle onHit à l'arrivée.
    function projectile(A, B, rgb, o, onHit) {
      const C = arcCtrl(A, B, o.arc);
      const trail = [];
      const lite = tint(rgb, 0.55);
      let hx = A.x;
      let hy = A.y;
      addTask({
        update(dt, age) {
          const k = clamp(age / o.dur, 0, 1);
          const e = o.ease ? o.ease(k) : k;
          const prev = [hx, hy];
          [hx, hy] = bez(A, C, B, e);
          const vx = (hx - prev[0]) / Math.max(dt, 1e-3);
          const vy = (hy - prev[1]) / Math.max(dt, 1e-3);
          trail.unshift(hx, hy);
          if (trail.length > o.trailLen * 2) trail.length = o.trailLen * 2;
          // Émission continue.
          const n = Math.max(1, Math.round(o.rate * dt * density()));
          for (let i = 0; i < n; i++) {
            const f = Math.random();
            const x = prev[0] + (hx - prev[0]) * f;
            const y = prev[1] + (hy - prev[1]) * f;
            if (o.streaks) {
              spawn({ x, y, vx: -vx * 0.12 + rand(-60, 60), vy: -vy * 0.12 + rand(-60, 60), ttl: rand(0.16, 0.3), s0: rand(1.5, 3), s1: 0.5, rgb: Math.random() < 0.3 ? lite : rgb, shape: 'streak', len: 0.05 });
            }
            spawn({ x: x + rand(-3, 3), y: y + rand(-3, 3), vx: rand(-40, 40), vy: rand(-40, 40), drag: 3, ttl: rand(0.2, 0.42), s0: rand(o.glow * 0.4, o.glow * 0.8), s1: 0, rgb, a: 0.8 });
            if (o.spiral) {
              const ang = age * 26 + i;
              const rr = o.glow * 0.9;
              spawn({ x: x + Math.cos(ang) * rr, y: y + Math.sin(ang) * rr, vx: rand(-30, 30), vy: rand(-30, 30), ttl: rand(0.3, 0.5), s0: rand(2, 4), s1: 0, rgb: lite, shape: 'star', rot: ang, vr: 8 });
            }
          }
          if (k >= 1) {
            onHit(hx, hy, vx, vy);
            return false;
          }
          return true;
        },
        draw(c) {
          // Traînée effilée.
          c.globalCompositeOperation = 'lighter';
          c.lineCap = 'round';
          c.lineJoin = 'round';
          const n = trail.length / 2;
          for (let i = 1; i < n; i++) {
            const f = 1 - i / n;
            c.globalAlpha = 0.85 * f;
            c.strokeStyle = css(rgb);
            c.lineWidth = o.glow * 0.9 * f + 1;
            c.beginPath();
            c.moveTo(trail[(i - 1) * 2], trail[(i - 1) * 2 + 1]);
            c.lineTo(trail[i * 2], trail[i * 2 + 1]);
            c.stroke();
            c.strokeStyle = '#fff';
            c.lineWidth = o.glow * 0.3 * f + 0.5;
            c.stroke();
          }
          c.globalAlpha = 1;
          const s = o.glow * 2.2;
          c.drawImage(glowSprite(rgb), hx - s, hy - s, s * 2, s * 2);
          const s2 = o.glow * 0.9;
          c.drawImage(glowSprite([255, 255, 255]), hx - s2, hy - s2, s2 * 2, s2 * 2);
          c.globalCompositeOperation = 'source-over';
        }
      });
    }

    function attack(o) {
      if (destroyed) return resolved();
      o = o || {};
      const rgb = parseColor(o.color);
      const kind = o.kind === 'support' || o.kind === 'ultimate' ? o.kind : 'attack';
      const A = rectOf(o.fromEl);
      const B = o.toEl ? rectOf(o.toEl) : A;
      if (kind === 'support') return supportFx(o, A, B, rgb);
      if (kind === 'ultimate') return ultimateShot(o, A, B, rgb);

      // Attaque : traînée nette et rapide + élan du lanceur.
      const dx = B.x - A.x;
      const dy = B.y - A.y;
      const d = Math.hypot(dx, dy) || 1;
      if (!reduced && o.fromEl) {
        animate(
          o.fromEl,
          [
            { translate: '0px 0px' },
            { translate: ((-dx / d) * 6).toFixed(1) + 'px ' + ((-dy / d) * 6).toFixed(1) + 'px', offset: 0.25 },
            { translate: ((dx / d) * 18).toFixed(1) + 'px ' + ((dy / d) * 18).toFixed(1) + 'px', offset: 0.55 },
            { translate: '0px 0px' }
          ],
          { duration: 360, easing: 'ease-out', composite: 'add' }
        );
      }
      sfx('whoosh', 0.9, o);
      burst(A.x, A.y, { n: 8, rgb: [rgb, tint(rgb, 0.6)], sp: [60, 200], ttl: [0.15, 0.3], size: [4, 9], shrink: 0.2, ang: Math.atan2(dy, dx), spread: 0.7 });
      const dur = reduced ? 0.22 : 0.3;
      return settle(dur * 1000, (fin) => {
        projectile(A, B, rgb, { dur, arc: 0.1, ease: easeIn, trailLen: 9, rate: 260, glow: 7, streaks: true }, (x, y, vx, vy) => {
          const ang = Math.atan2(vy, vx);
          burst(x, y, { n: 10, rgb: [rgb, [255, 255, 255]], sp: [120, 380], ttl: [0.12, 0.26], size: [1.5, 3], shape: 'streak', len: 0.04, ang, spread: 1.1 });
          ring(x, y, tint(rgb, 0.3), 4, 34, 0.25, 3);
          fin();
        });
      });
    }

    function supportFx(o, A, B, rgb) {
      const lite = tint(rgb, 0.5);
      const onEl = (el, r, delay) => {
        const size = Math.max(r.w, r.h) / 2;
        ring(r.x, r.y, rgb, size * 0.3, size * 1.05, 0.7, 4, delay);
        ring(r.x, r.y, lite, size * 0.15, size * 0.8, 0.6, 2, delay + 0.14);
        const n = N(26);
        for (let i = 0; i < n; i++) {
          spawn({ x: r.l + rand(0.05, 0.95) * r.w, y: r.t + r.h * rand(0.55, 1), vx: rand(-12, 12), vy: rand(-140, -50), drag: 0.6, ttl: rand(0.6, 1), s0: rand(3, 8), s1: 0.5, rgb: Math.random() < 0.4 ? lite : rgb, delay: delay + rand(0, 0.3), a: 0.85 });
        }
        burst(r.x, r.y, { n: 8, rgb: [lite, [255, 255, 255]], sp: [20, 90], ttl: [0.5, 0.8], size: [3, 6], shape: 'star', vr: 4, jitter: size * 0.6, delay: delay + 0.3 });
        if (el) {
          const glow = 'rgba(' + rgb.join(',') + ',.95)';
          animate(el, [{ filter: 'drop-shadow(0 0 0 ' + glow + ')' }, { filter: 'drop-shadow(0 0 16px ' + glow + ') brightness(1.18)', offset: 0.35 }, { filter: 'drop-shadow(0 0 0 rgba(0,0,0,0)) brightness(1)' }], { duration: 750, easing: 'ease-out' });
        }
      };
      sfx('buff', 0.7, o);
      onEl(o.fromEl, A, 0);
      const toOther = o.toEl && o.toEl !== o.fromEl;
      if (!toOther) return settle(650, (fin) => later(fin, 650));
      return settle(950, (fin) => {
        later(() => {
          projectile(A, B, rgb, { dur: 0.42, arc: 0.25, ease: easeOut, trailLen: 6, rate: 120, glow: 6, streaks: false }, () => {
            onEl(o.toEl, B, 0);
            later(fin, 300);
          });
        }, 220);
      });
    }

    function ultimateShot(o, A, B, rgb) {
      const lite = tint(rgb, 0.55);
      const charge = reduced ? 0.15 : 0.38;
      sfx('charge', 0.9, o);
      // Concentration d'énergie sur le lanceur.
      const n = N(34);
      for (let i = 0; i < n; i++) {
        const ang = rand(0, Math.PI * 2);
        const r0 = rand(60, 120);
        const ttl = rand(0.22, charge);
        spawn({ x: A.x + Math.cos(ang) * r0, y: A.y + Math.sin(ang) * r0, vx: (-Math.cos(ang) * r0) / ttl, vy: (-Math.sin(ang) * r0) / ttl, ttl, s0: rand(2, 5), s1: 1, rgb: Math.random() < 0.5 ? lite : rgb, shape: 'streak', len: 0.03, fadeIn: 0.3 });
      }
      ring(A.x, A.y, rgb, 110, 10, charge, 3);
      addTask({
        update: (dt, age) => age < charge,
        draw(c) {
          const k = clamp(this.age / charge, 0, 1);
          const s = 10 + 26 * k;
          c.globalCompositeOperation = 'lighter';
          c.globalAlpha = 0.5 + 0.5 * k;
          c.drawImage(glowSprite(rgb), A.x - s, A.y - s, s * 2, s * 2);
          c.globalCompositeOperation = 'source-over';
          c.globalAlpha = 1;
        }
      });
      if (o.fromEl && !reduced) shake(o.fromEl, 3, charge * 1000);
      const dur = reduced ? 0.3 : 0.46;
      return settle((charge + dur) * 1000, (fin) => {
        later(() => {
          sfx('whoosh', 1, o);
          projectile(A, B, rgb, { dur, arc: 0.16, ease: (k) => k * k * (3 - 2 * k), trailLen: 14, rate: 420, glow: 14, streaks: true, spiral: true }, (x, y) => {
            ring(x, y, [255, 255, 255], 8, 120, 0.4, 6);
            ring(x, y, rgb, 6, 170, 0.55, 5, 0.05);
            burst(x, y, { n: 50, rgb: [rgb, lite, [255, 255, 255]], sp: [250, 760], ttl: [0.3, 0.6], size: [2, 4.5], shape: 'streak', len: 0.045, drag: 2.2, grav: 280 });
            burst(x, y, { n: 26, rgb: [rgb, lite], sp: [40, 260], ttl: [0.4, 0.8], size: [8, 20], shrink: 0.1, drag: 3, a: 0.8 });
            flash(0.32, '#fff');
            shake(rootEl, 9, 420);
            fin();
          });
        }, charge * 1000);
      });
    }

    function hit(o) {
      if (destroyed) return resolved();
      o = o || {};
      const rgb = parseColor(o.color);
      const r = rectOf(o.el);
      const eff = o.effectiveness == null ? 1 : +o.effectiveness;
      const strong = !!o.crit || eff > 1;
      const weak = !strong && eff < 1;
      const x = r.x + rand(-r.w * 0.1, r.w * 0.1);
      const y = r.y + rand(-r.h * 0.12, r.h * 0.05);
      const col = weak ? tint(rgb, -0.7) : rgb;
      const lite = tint(col, 0.6);

      burst(x, y, { n: strong ? 38 : weak ? 10 : 22, rgb: [col, lite, [255, 255, 255]], sp: strong ? [260, 720] : weak ? [120, 280] : [200, 520], ttl: [0.22, 0.5], size: strong ? [2, 4] : [1.5, 3], shape: 'streak', len: 0.04, drag: 2.5, grav: 700 });
      burst(x, y, { n: strong ? 14 : 7, rgb: [col, lite], sp: [20, 140], ttl: [0.25, 0.45], size: strong ? [10, 22] : [7, 14], shrink: 0.15, drag: 3, a: weak ? 0.45 : 0.85 });
      ring(x, y, weak ? col : lite, 6, Math.max(r.w, r.h) * (strong ? 0.75 : 0.45), strong ? 0.38 : 0.28, strong ? 5 : 3);
      if (strong) {
        ring(x, y, [255, 255, 255], 4, Math.max(r.w, r.h) * 0.5, 0.3, 3, 0.06);
        burst(x, y, { n: 10, rgb: [[255, 240, 160], [255, 255, 255]], sp: [60, 220], ttl: [0.4, 0.7], size: [5, 9], shape: 'star', vr: 6, drag: 2 });
        flash(o.crit ? 0.28 : 0.18, '#fff');
      }
      if (o.el) {
        animate(o.el, [{ filter: 'brightness(' + (weak ? 1.4 : 2.4) + ') saturate(.6)' }, { filter: 'brightness(1) saturate(1)' }], { duration: weak ? 180 : 260, easing: 'ease-out' });
        shake(o.el, strong ? 11 : weak ? 3 : 7, strong ? 420 : 320);
      }
      if (strong) shake(rootEl, o.crit ? 7 : 5, 300);

      // Chiffre + libellés.
      const labels = [];
      if (o.crit) labels.push('Critique !');
      if (eff > 1) labels.push('Super efficace !');
      else if (eff < 1) labels.push('Peu efficace…');
      const main = o.amount == null || o.amount === '' ? '' : (+o.amount > 0 ? '-' : '') + Math.abs(+o.amount || 0);
      floatText(o.el, r, main, labels.join(' '), strong ? 'kdfx-big' : weak ? 'kdfx-dull' : '', strong ? '#ff8a00' : css(rgb), strong ? 1350 : 1100);

      sfx(strong ? 'crit' : 'hit', weak ? 0.55 : 1, o);
      return settle(strong ? 420 : 320, (fin) => later(fin, strong ? 420 : 320));
    }

    function heal(o) {
      if (destroyed) return resolved();
      o = o || {};
      const rgb = parseColor(o.color || HEAL_COLOR);
      const lite = tint(rgb, 0.55);
      const r = rectOf(o.el);
      const n = N(30);
      for (let i = 0; i < n; i++) {
        spawn({ x: r.l + rand(0.08, 0.92) * r.w, y: r.t + r.h * rand(0.45, 1.02), vx: rand(-10, 10), vy: rand(-150, -60), drag: 0.4, ttl: rand(0.7, 1.15), s0: rand(3, 7), s1: 1, rgb: Math.random() < 0.5 ? lite : rgb, delay: rand(0, 0.35), fadeIn: 0.15 });
      }
      const m = N(9);
      for (let i = 0; i < m; i++) {
        spawn({ x: r.l + rand(0.15, 0.85) * r.w, y: r.t + r.h * rand(0.5, 0.95), vy: rand(-110, -60), ttl: rand(0.7, 1), s0: rand(4, 7), s1: 2, rgb: lite, shape: 'plus', delay: rand(0, 0.4), fadeIn: 0.2 });
      }
      ring(r.x, r.t + r.h * 0.85, rgb, r.w * 0.1, r.w * 0.6, 0.6, 3);
      if (o.el) {
        const glow = 'rgba(' + rgb.join(',') + ',.9)';
        animate(o.el, [{ filter: 'drop-shadow(0 0 0 ' + glow + ')' }, { filter: 'drop-shadow(0 0 14px ' + glow + ') brightness(1.15)', offset: 0.35 }, { filter: 'drop-shadow(0 0 0 rgba(0,0,0,0)) brightness(1)' }], { duration: 800, easing: 'ease-out' });
      }
      if (o.amount != null && o.amount !== '') floatText(o.el, r, '+' + Math.abs(+o.amount || 0), '', 'kdfx-heal', css(rgb), 1150);
      sfx('heal', 0.9, o);
      return settle(700, (fin) => later(fin, 700));
    }

    function guard(o) {
      if (destroyed) return resolved();
      o = o || {};
      const rgb = parseColor(o.color || GUARD_COLOR);
      const lite = tint(rgb, 0.6);
      const r = rectOf(o.el);
      const rx = r.w * 0.62;
      const ry = r.h * 0.56;
      const dur = 0.85;
      const hexPath = (c, sx, sy) => {
        c.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = Math.PI / 6 + (i * Math.PI) / 3;
          const x = Math.cos(a) * sx;
          const y = Math.sin(a) * sy;
          if (i) c.lineTo(x, y);
          else c.moveTo(x, y);
        }
        c.closePath();
      };
      addTask({
        update: (dt, age) => age < dur,
        draw(c) {
          const k = clamp(this.age / dur, 0, 1);
          const a = k < 0.15 ? k / 0.15 : k > 0.6 ? (1 - k) / 0.4 : 1;
          const sc = reduced ? 1 : 0.82 + 0.18 * easeOut(Math.min(1, k / 0.3));
          c.save();
          c.translate(r.x, r.y);
          c.scale(sc, sc);
          c.globalCompositeOperation = 'lighter';
          hexPath(c, rx, ry);
          const gr = c.createRadialGradient(0, 0, Math.min(rx, ry) * 0.2, 0, 0, Math.max(rx, ry));
          gr.addColorStop(0, 'rgba(' + rgb.join(',') + ',0.03)');
          gr.addColorStop(1, 'rgba(' + rgb.join(',') + ',0.32)');
          c.globalAlpha = a;
          c.fillStyle = gr;
          c.fill();
          c.lineWidth = 3.5;
          c.strokeStyle = css(rgb);
          c.stroke();
          c.lineWidth = 1.2;
          c.strokeStyle = 'rgba(255,255,255,.9)';
          c.stroke();
          // Alvéoles + reflet balayant, à l'intérieur du bouclier.
          c.clip();
          c.globalAlpha = a * 0.22;
          c.strokeStyle = css(lite);
          c.lineWidth = 1;
          const cs = 16;
          for (let yy = -ry; yy < ry + cs; yy += cs * 1.5) {
            for (let xx = -rx; xx < rx + cs; xx += cs * 1.732) {
              const ox = Math.round((yy + ry) / (cs * 1.5)) % 2 ? cs * 0.866 : 0;
              c.save();
              c.translate(xx + ox, yy);
              hexPath(c, cs * 0.55, cs * 0.55);
              c.stroke();
              c.restore();
            }
          }
          const sx = -rx * 1.6 + rx * 3.2 * clamp(k * 1.5, 0, 1);
          const lg = c.createLinearGradient(sx - 40, -ry, sx + 40, ry);
          lg.addColorStop(0, 'rgba(255,255,255,0)');
          lg.addColorStop(0.5, 'rgba(255,255,255,.7)');
          lg.addColorStop(1, 'rgba(255,255,255,0)');
          c.globalAlpha = a * 0.8;
          c.fillStyle = lg;
          c.fillRect(-rx, -ry, rx * 2, ry * 2);
          c.restore();
        }
      });
      burst(r.x, r.y, { n: 12, rgb: [lite, [255, 255, 255]], sp: [10, 50], ttl: [0.4, 0.8], size: [3, 6], shape: 'star', vr: 5, jitter: Math.min(rx, ry), delay: 0.25 });
      if (o.amount != null && o.amount !== '') floatText(o.el, r, '+' + Math.abs(+o.amount || 0), 'Garde', 'kdfx-guard', css(rgb), 1100);
      sfx('guard', 0.9, o);
      return settle(dur * 1000, (fin) => later(fin, dur * 1000));
    }

    function status(o) {
      if (destroyed) return resolved();
      o = o || {};
      let key = String(o.status || '').toLowerCase();
      key = STATUS_ALIAS[key] || key;
      const def = STATUS[key] || { label: String(o.status || 'Statut'), color: '#ffffff', shape: 'star', dir: -1, good: false };
      const rgb = parseColor(o.color || def.color);
      const lite = tint(rgb, 0.5);
      const r = rectOf(o.el);
      const cx = r.x;
      const cy = r.t + r.h * 0.4;
      const n = N(20);
      for (let i = 0; i < n; i++) {
        const x = cx + rand(-r.w * 0.4, r.w * 0.4);
        const y = cy + rand(-r.h * 0.25, r.h * 0.3);
        const base = { x, y, ttl: rand(0.6, 1), rgb: Math.random() < 0.5 ? lite : rgb, delay: rand(0, 0.25), fadeIn: 0.15 };
        switch (def.shape) {
          case 'bubble':
            spawn(Object.assign(base, { vx: rand(-15, 15), vy: rand(-90, -30), s0: rand(3, 7), s1: rand(5, 9), shape: 'bubble' }));
            break;
          case 'smoke':
            spawn(Object.assign(base, { vx: rand(-25, 25), vy: rand(10, 50), s0: rand(10, 18), s1: rand(22, 34), shape: 'smoke', add: false, a: 0.85 }));
            if (i % 2) spawn({ x, y, vx: rand(-20, 20), vy: rand(20, 70), ttl: rand(0.5, 0.9), s0: rand(3, 6), s1: 0, rgb, delay: base.delay });
            break;
          case 'chev':
            spawn(Object.assign(base, { vx: 0, vy: rand(40, 90), s0: rand(5, 9), s1: 4, shape: 'chev', rot: 0 }));
            break;
          case 'flame':
            spawn(Object.assign(base, { vx: rand(-15, 15), vy: rand(-140, -60), s0: rand(6, 12), s1: 1, rgb: Math.random() < 0.4 ? [255, 220, 120] : rgb }));
            if (i % 3 === 0) spawn({ x, y, vy: rand(-80, -40), ttl: 0.7, s0: 6, s1: 4, rgb: lite, shape: 'chev', rot: Math.PI, delay: base.delay });
            break;
          case 'plus':
            spawn(Object.assign(base, { vx: rand(-10, 10), vy: rand(-90, -40), s0: rand(4, 7), s1: 2, shape: 'plus' }));
            break;
          case 'dash': {
            const dir = r.x < W / 2 ? 1 : -1;
            spawn(Object.assign(base, { vx: dir * rand(160, 320), vy: rand(-10, 10), s0: rand(1.5, 3), s1: 1, shape: 'streak', len: 0.08 }));
            if (i % 3 === 0) spawn({ x, y, vx: dir * 120, ttl: 0.6, s0: 6, s1: 4, rgb: lite, shape: 'chev', rot: -dir * Math.PI / 2, delay: base.delay });
            break;
          }
          default:
            spawn(Object.assign(base, { vx: rand(-40, 40), vy: rand(-80, -20), s0: rand(3, 6), s1: 1, shape: 'star', vr: 5 }));
        }
      }
      burst(cx, cy, { n: 10, rgb: [rgb, lite], sp: [30, 120], ttl: [0.3, 0.55], size: [8, 16], shrink: 0.2, drag: 3, a: 0.6 });
      ring(cx, cy, rgb, 6, Math.max(r.w, r.h) * 0.5, 0.45, 3);
      if (o.el) {
        const glow = 'rgba(' + rgb.join(',') + ',.9)';
        animate(o.el, [{ filter: 'drop-shadow(0 0 0 ' + glow + ')' }, { filter: 'drop-shadow(0 0 12px ' + glow + ')', offset: 0.3 }, { filter: 'drop-shadow(0 0 0 rgba(0,0,0,0))' }], { duration: 700, easing: 'ease-out' });
      }
      statusPill(r, def.label, hex(rgb));
      sfx(def.good ? 'buff' : 'status', 0.85, o);
      return settle(650, (fin) => later(fin, 650));
    }

    function ko(o) {
      if (destroyed) return resolved();
      o = o || {};
      const el = o.el;
      const r = rectOf(el);
      const pre = reduced ? 120 : 300;
      if (el) {
        animate(el, [{ filter: 'grayscale(0) brightness(1)' }, { filter: 'grayscale(1) brightness(2)', offset: 0.25 }, { filter: 'grayscale(1) brightness(.75)' }], { duration: pre, easing: 'ease-out' });
        shake(el, 6, pre);
      }
      sfx('ko', 1, o);
      return settle(pre + 600, (fin) => {
        later(() => {
          if (el) {
            animate(el, [{ opacity: 1, filter: 'grayscale(1) brightness(.75)', translate: '0px 0px' }, { opacity: 0.28, filter: 'grayscale(1) brightness(.6)', translate: '0px ' + (reduced ? 0 : 14) + 'px' }], { duration: 420, easing: 'ease-out' }, true);
          }
          // Éclats : grille déformée de triangles couvrant la carte.
          const cols = reduced ? 3 : 5;
          const rows = reduced ? 4 : 7;
          const cw = r.w / cols;
          const chh = r.h / rows;
          const jit = [];
          for (let j = 0; j <= rows; j++) {
            for (let i = 0; i <= cols; i++) {
              const edge = i === 0 || j === 0 || i === cols || j === rows;
              jit.push(r.l + i * cw + (edge ? 0 : rand(-0.3, 0.3) * cw), r.t + j * chh + (edge ? 0 : rand(-0.3, 0.3) * chh));
            }
          }
          const P = (i, j) => [jit[(j * (cols + 1) + i) * 2], jit[(j * (cols + 1) + i) * 2 + 1]];
          const greys = [[206, 210, 220], [150, 156, 170], [112, 118, 132], [235, 236, 242]];
          for (let j = 0; j < rows; j++) {
            for (let i = 0; i < cols; i++) {
              const a = P(i, j);
              const b = P(i + 1, j);
              const c2 = P(i + 1, j + 1);
              const d = P(i, j + 1);
              const tris = Math.random() < 0.5 ? [[a, b, c2], [a, c2, d]] : [[a, b, d], [b, c2, d]];
              for (const tr of tris) {
                const gx = (tr[0][0] + tr[1][0] + tr[2][0]) / 3;
                const gy = (tr[0][1] + tr[1][1] + tr[2][1]) / 3;
                const pts = [tr[0][0] - gx, tr[0][1] - gy, tr[1][0] - gx, tr[1][1] - gy, tr[2][0] - gx, tr[2][1] - gy];
                const ox = gx - r.x;
                const oy = gy - r.y;
                const dd = Math.hypot(ox, oy) || 1;
                const sp = rand(120, 380);
                spawn({ x: gx, y: gy, vx: (ox / dd) * sp + rand(-40, 40), vy: (oy / dd) * sp * 0.6 - rand(80, 220), ay: 1100, ttl: rand(0.6, 0.95), s0: 1, rgb: greys[(Math.random() * greys.length) | 0], shape: 'shard', pts, rot: 0, vr: rand(-9, 9), add: false });
              }
            }
          }
          burst(r.x, r.y, { n: 24, rgb: [[255, 255, 255], [180, 186, 200]], sp: [40, 220], ttl: [0.4, 0.8], size: [6, 16], shrink: 0.2, drag: 2.5, a: 0.55, jitter: r.w * 0.3 });
          ring(r.x, r.y, [230, 232, 240], 10, Math.max(r.w, r.h) * 0.8, 0.5, 4);
          flash(0.15, '#fff');
          shake(rootEl, 6, 360);
          later(fin, 600);
        }, pre);
      });
    }

    function switchOut(o) {
      if (destroyed) return resolved();
      o = o || {};
      const el = o.el;
      const r = rectOf(el);
      const rgb = parseColor(o.color || '#ffffff');
      const dur = reduced ? 220 : 380;
      if (el) {
        releaseEl(el);
        const kf = reduced
          ? [{ opacity: 1 }, { opacity: 0 }]
          : [
              { opacity: 1, scale: '1', filter: 'brightness(1) saturate(1)' },
              { opacity: 1, scale: '.94', filter: 'brightness(2.6) saturate(0)', offset: 0.35 },
              { opacity: 0, scale: '.25', filter: 'brightness(3) saturate(0)' }
            ];
        animate(el, kf, { duration: dur, easing: 'ease-in' }, true);
      }
      // Particules aspirées vers le centre.
      const n = N(26);
      for (let i = 0; i < n; i++) {
        const ang = rand(0, Math.PI * 2);
        const rr = Math.max(r.w, r.h) * rand(0.45, 0.7);
        const ttl = rand(0.22, dur / 1000);
        spawn({ x: r.x + Math.cos(ang) * rr, y: r.y + Math.sin(ang) * rr, vx: (-Math.cos(ang) * rr) / ttl, vy: (-Math.sin(ang) * rr) / ttl, ttl, s0: rand(2, 4), s1: 1, rgb: Math.random() < 0.5 ? rgb : [255, 255, 255], shape: 'streak', len: 0.03, fadeIn: 0.3 });
      }
      later(() => {
        burst(r.x, r.y, { n: 10, rgb: [[255, 255, 255], rgb], sp: [20, 90], ttl: [0.2, 0.4], size: [6, 12], shrink: 0.1 });
      }, dur * 0.8);
      sfx('recall', 0.9, o);
      return settle(dur, (fin) => later(fin, dur));
    }

    function switchIn(o) {
      if (destroyed) return resolved();
      o = o || {};
      const el = o.el;
      if (el) releaseEl(el);
      const r = rectOf(el);
      const rgb = parseColor(o.color);
      const lite = tint(rgb, 0.55);
      const dir = r.x < W / 2 ? -1 : 1;
      const dur = reduced ? 260 : 460;
      if (el) {
        const kf = reduced
          ? [{ opacity: 0 }, { opacity: 1 }]
          : [
              { opacity: 0, translate: dir * 90 + 'px 0px', scale: '.8', filter: 'brightness(3) saturate(0)' },
              { opacity: 1, translate: (-dir * 6) + 'px 0px', scale: '1.04', filter: 'brightness(1.6) saturate(.6)', offset: 0.6 },
              { opacity: 1, translate: '0px 0px', scale: '1', filter: 'brightness(1) saturate(1)' }
            ];
        animate(el, kf, { duration: dur, easing: 'cubic-bezier(.2,.8,.25,1)' });
      }
      later(() => {
        const size = Math.max(r.w, r.h);
        ring(r.x, r.y, [255, 255, 255], 8, size * 0.6, 0.35, 5);
        ring(r.x, r.y, rgb, 8, size * 0.85, 0.5, 4, 0.05);
        burst(r.x, r.y, { n: 36, rgb: [rgb, lite, [255, 255, 255]], sp: [160, 460], ttl: [0.3, 0.6], size: [1.5, 3.5], shape: 'streak', len: 0.04, drag: 2.5 });
        burst(r.x, r.y, { n: 16, rgb: [rgb, lite], sp: [30, 160], ttl: [0.4, 0.7], size: [8, 16], shrink: 0.1, drag: 3, a: 0.75 });
        burst(r.x, r.y, { n: 8, rgb: [lite, [255, 255, 255]], sp: [30, 110], ttl: [0.5, 0.8], size: [4, 8], shape: 'star', vr: 5, drag: 1.5 });
      }, dur * 0.45);
      sfx('switch', 1, o);
      return settle(dur, (fin) => later(fin, dur));
    }

    // -------------------------------------------------------------------------
    // Carte d'ultime plein écran
    // -------------------------------------------------------------------------
    let ult = null;

    function ultimate(o) {
      if (destroyed) return resolved();
      o = o || {};
      if (ult) ult.finish(true);
      const rgb = parseColor(o.color);
      const lite = tint(rgb, 0.45);
      const total = reduced ? 1000 : 1600;

      const el = doc.createElement('div');
      el.className = 'kdfx-ult' + (reduced ? ' kdfx-reduced' : '');
      el.style.setProperty('--kdfx-c', hex(rgb));
      el.style.setProperty('--kdfx-cl', hex(lite));
      el.style.setProperty('--kdfx-cr', rgb.join(','));
      el.setAttribute('role', 'button');
      el.setAttribute('aria-label', 'Ultime : ' + String(o.name || '') + ' — ' + String(o.champion || '') + '. Toucher pour passer.');

      const mk = (cls, parent, tag) => {
        const e = doc.createElement(tag || 'div');
        e.className = cls;
        (parent || el).appendChild(e);
        return e;
      };
      const bg = mk('kdfx-ult-bg');
      const rays = mk('kdfx-ult-rays');
      const lines = mk('kdfx-ult-lines', null, 'canvas');
      const band = mk('kdfx-ult-band');
      const bandTxt = mk('', band, 'span');
      bandTxt.textContent = 'ULTIME · ULTIME · ULTIME · ULTIME · ULTIME · ULTIME · ULTIME · ULTIME';
      const barT = mk('kdfx-ult-bar');
      const barB = mk('kdfx-ult-bar');
      barT.style.top = '0';
      barB.style.bottom = '0';
      const card = mk('kdfx-ult-card');
      const cardIn = mk('kdfx-ult-card-in', card);
      const champName = String(o.champion || '');
      const showPlaceholder = () => {
        if (cardIn.querySelector('.kdfx-ult-ph')) return;
        const ph = mk('kdfx-ult-ph', cardIn);
        ph.textContent = (champName.trim()[0] || '?').toUpperCase();
      };
      if (o.image) {
        const img = doc.createElement('img');
        img.alt = '';
        img.decoding = 'async';
        img.referrerPolicy = 'no-referrer';
        img.draggable = false;
        img.addEventListener('error', () => {
          img.remove();
          showPlaceholder();
        });
        img.src = String(o.image);
        cardIn.appendChild(img);
      } else showPlaceholder();
      const text = mk('kdfx-ult-text');
      const tag = mk('kdfx-ult-tag', text);
      tag.textContent = 'ULTIME';
      const nameEl = mk('kdfx-ult-name', text);
      nameEl.textContent = String(o.name || 'Ultime');
      const champEl = mk('kdfx-ult-champ', text);
      champEl.textContent = champName;
      if (!champName) champEl.style.display = 'none';
      const flashEl = mk('kdfx-ult-flash');
      const skip = mk('kdfx-ult-skip');
      skip.textContent = 'Toucher pour passer';

      layer.appendChild(el);

      // Mise en page selon le format (large ou haut), recalculée au redimensionnement.
      let focus = { x: W / 2, y: H / 2 };
      const lc = lines.getContext('2d');
      function layout() {
        const wide = W / H >= 1.05;
        el.classList.toggle('kdfx-ult-wide', wide);
        el.classList.toggle('kdfx-ult-tall', !wide);
        let cardH;
        let cardW;
        let cx;
        let cy;
        let nameFs;
        if (wide) {
          cardH = Math.min(H * 0.74, W * 0.36 * 1.42);
          cardW = cardH / 1.42;
          cx = Math.max(W * 0.04, W * 0.27 - cardW / 2);
          cy = (H - cardH) / 2;
          const tl = cx + cardW + W * 0.05;
          Object.assign(text.style, { left: tl + 'px', top: H * 0.12 + 'px', width: W - tl - W * 0.05 + 'px', height: H * 0.76 + 'px' });
          nameFs = Math.min(W * 0.072, H * 0.12);
          Object.assign(band.style, { top: H * 0.5 - H * 0.11 + 'px', height: H * 0.22 + 'px', fontSize: H * 0.17 + 'px', lineHeight: H * 0.22 + 'px' });
        } else {
          cardH = Math.min(H * 0.5, W * 0.56 * 1.42);
          cardW = cardH / 1.42;
          cx = (W - cardW) / 2;
          cy = H * 0.1;
          const tt = cy + cardH + H * 0.035;
          Object.assign(text.style, { left: W * 0.05 + 'px', top: tt + 'px', width: W * 0.9 + 'px', height: Math.max(60, H * 0.92 - tt) + 'px' });
          nameFs = Math.min(W * 0.1, H * 0.085);
          Object.assign(band.style, { top: cy + cardH * 0.5 - H * 0.08 + 'px', height: H * 0.16 + 'px', fontSize: H * 0.12 + 'px', lineHeight: H * 0.16 + 'px' });
        }
        Object.assign(card.style, { left: cx + 'px', top: cy + 'px', width: cardW + 'px', height: cardH + 'px' });
        card.style.setProperty('--kdfx-pad', Math.max(4, cardW * 0.022).toFixed(1) + 'px');
        cardIn.style.setProperty('--kdfx-ph', (cardW * 0.55).toFixed(0) + 'px');
        focus = { x: cx + cardW / 2, y: cy + cardH / 2 };
        const D = Math.hypot(W, H) * 2.2;
        Object.assign(rays.style, { left: focus.x - D / 2 + 'px', top: focus.y - D / 2 + 'px', width: D + 'px', height: D + 'px' });
        bg.style.background =
          'radial-gradient(circle at ' + focus.x + 'px ' + focus.y + 'px, rgba(' + rgb.join(',') + ',.5), rgba(' + rgb.join(',') + ',.12) 38%, rgba(6,7,14,.95) 70%), #06070e';
        lines.width = Math.round(W * dpr);
        lines.height = Math.round(H * dpr);
        // Textes : taille de base puis réduction jusqu'à ce que le nom tienne (2 lignes max).
        tag.style.fontSize = Math.max(11, nameFs * 0.2) + 'px';
        champEl.style.fontSize = Math.max(13, nameFs * 0.3) + 'px';
        let fs = nameFs;
        nameEl.style.fontSize = fs + 'px';
        const maxH = Math.min(parseFloat(text.style.height) * 0.62, fs * 2.05);
        for (let i = 0; i < 14 && fs > 16; i++) {
          if (nameEl.scrollWidth <= nameEl.clientWidth + 1 && nameEl.offsetHeight <= maxH) break;
          fs *= 0.9;
          nameEl.style.fontSize = fs + 'px';
        }
      }
      layout();

      // Lignes de vitesse (dessinées dans le canvas de la carte par la boucle commune).
      const R = Math.hypot(W, H);
      const speedLines = [];
      const nLines = reduced ? 0 : 70;
      const newLine = (init) => ({
        ang: rand(0, Math.PI * 2),
        d: init ? rand(0.05, 1) * R : rand(0.05, 0.25) * R,
        v: rand(1.6, 3.4) * R,
        len: rand(0.06, 0.22) * R,
        w: rand(1, 3.5),
        c: Math.random() < 0.6 ? '#ffffff' : hex(lite)
      });
      for (let i = 0; i < nLines; i++) speedLines.push(newLine(true));
      const linesTask = {
        update(dt) {
          if (!ult || ult.el !== el) return false;
          for (const l of speedLines) {
            l.d += l.v * dt;
            if (l.d > R * 0.8) Object.assign(l, newLine(false));
          }
          lc.setTransform(1, 0, 0, 1, 0, 0);
          lc.clearRect(0, 0, lines.width, lines.height);
          lc.setTransform(dpr, 0, 0, dpr, 0, 0);
          lc.lineCap = 'round';
          for (const l of speedLines) {
            const c = Math.cos(l.ang);
            const s = Math.sin(l.ang);
            lc.globalAlpha = clamp((l.d / R) * 2.2, 0, 0.75);
            lc.strokeStyle = l.c;
            lc.lineWidth = l.w;
            lc.beginPath();
            lc.moveTo(focus.x + c * l.d, focus.y + s * l.d);
            lc.lineTo(focus.x + c * (l.d + l.len), focus.y + s * (l.d + l.len));
            lc.stroke();
          }
          return true;
        }
      };
      if (nLines) addTask(linesTask);

      // Chronologie.
      const fly = (e, kf, o2) => animate(e, kf, Object.assign({ fill: 'both' }, o2));
      fly(flashEl, [{ opacity: reduced ? 0.45 : 1 }, { opacity: 0 }], { duration: reduced ? 220 : 340, easing: 'ease-out' });
      fly(bg, [{ opacity: 0 }, { opacity: 1 }], { duration: 140 });
      if (!reduced) {
        fly(rays, [{ transform: 'rotate(0deg) scale(.6)', opacity: 0 }, { transform: 'rotate(10deg) scale(1)', opacity: 0.85, offset: 0.15 }, { transform: 'rotate(38deg) scale(1.05)', opacity: 0.85 }], { duration: total, easing: 'linear' });
        fly(barT, [{ transform: 'translateY(-100%)' }, { transform: 'translateY(0)' }], { duration: 260, easing: 'ease-out' });
        fly(barB, [{ transform: 'translateY(100%)' }, { transform: 'translateY(0)' }], { duration: 260, easing: 'ease-out' });
        fly(band, [{ transform: 'skewY(-7deg) translateX(-100%)', opacity: 0 }, { transform: 'skewY(-7deg) translateX(0)', opacity: 1 }], { duration: 280, delay: 60, easing: 'cubic-bezier(.2,.8,.2,1)' });
        fly(bandTxt, [{ transform: 'translateX(0)' }, { transform: 'translateX(-12%)' }], { duration: total, easing: 'linear' });
        fly(card, [
          { transform: 'translateX(-140%) rotate(-16deg) scale(1.2)', opacity: 0 },
          { transform: 'translateX(5%) rotate(-2deg) scale(1.03)', opacity: 1, offset: 0.7 },
          { transform: 'translateX(0) rotate(-4deg) scale(1)', opacity: 1 }
        ], { duration: 400, delay: 40, easing: 'cubic-bezier(.2,.8,.2,1)' });
        fly(cardIn, [{ transform: 'scale(1.12)' }, { transform: 'scale(1)' }], { duration: total, easing: 'ease-out' });
        fly(tag, [{ transform: 'skewX(-14deg) translateX(80px)', opacity: 0 }, { transform: 'skewX(-14deg) translateX(0)', opacity: 1 }], { duration: 260, delay: 140, easing: 'ease-out' });
        fly(nameEl, [{ transform: 'translateX(28%) skewX(-10deg) scale(1.3)', opacity: 0 }, { transform: 'translateX(-2%) skewX(-10deg) scale(.98)', opacity: 1, offset: 0.7 }, { transform: 'translateX(0) skewX(-10deg) scale(1)', opacity: 1 }], { duration: 380, delay: 200, easing: 'cubic-bezier(.2,.8,.2,1)' });
        fly(champEl, [{ transform: 'translateY(60%)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }], { duration: 300, delay: 360, easing: 'ease-out' });
      } else {
        rays.style.opacity = '.5';
        nameEl.style.transform = 'skewX(-10deg)';
        tag.style.transform = 'skewX(-14deg)';
        fly(text, [{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 80 });
        fly(card, [{ opacity: 0 }, { opacity: 1 }], { duration: 200 });
      }
      fly(skip, [{ opacity: 0 }, { opacity: 1 }], { duration: 300, delay: 450 });

      // Petite gerbe à l'impact du flash (dans le canvas principal, sous la carte).
      flash(0, '#fff');
      sfx('ultimate', 1, o);

      let resolveP;
      const promise = new Promise((res) => (resolveP = res));
      let ending = false;
      const state = {
        el,
        layout,
        finish(now) {
          if (state.done) return;
          if (now) {
            state.done = true;
            cleanup();
            return;
          }
          if (ending) return;
          ending = true;
          const d = reduced ? 160 : 240;
          const a = animate(el, [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: reduced ? 'scale(1)' : 'scale(1.06)' }], { duration: d, easing: 'ease-in', fill: 'forwards' });
          const go = () => {
            if (!state.done) {
              state.done = true;
              cleanup();
            }
          };
          if (a) a.finished.then(go, go);
          later(go, d + 80);
        }
      };
      function cleanup() {
        el.removeEventListener('pointerdown', onSkip);
        win.removeEventListener('keydown', onKey, true);
        el.remove();
        if (ult === state) ult = null;
        resolveP();
      }
      const onSkip = (e) => {
        e.preventDefault();
        e.stopPropagation();
        state.finish(false);
      };
      const onKey = (e) => {
        if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          state.finish(false);
        }
      };
      el.addEventListener('pointerdown', onSkip);
      win.addEventListener('keydown', onKey, true);
      ult = state;
      later(() => state.finish(false), total - (reduced ? 160 : 240));
      return promise;
    }

    // -------------------------------------------------------------------------
    // API publique
    // -------------------------------------------------------------------------
    resize();

    const api = {
      attack,
      hit,
      heal,
      guard,
      status,
      ko,
      switchOut,
      switchIn,
      ultimate,
      sound(name) {
        if (destroyed) return;
        audio.play(String(name || ''), 1);
      },
      setMuted(b) {
        audio.setMuted(b);
      },
      setVolume(v) {
        audio.setVolume(v);
      },
      destroy() {
        if (destroyed) return;
        if (ult) ult.finish(true);
        destroyed = true;
        if (raf) win.cancelAnimationFrame(raf);
        running = false;
        for (const id of timers) win.clearTimeout(id);
        timers.clear();
        for (const a of anims) {
          try {
            a.cancel();
          } catch (_) {
            /* ignoré */
          }
        }
        anims.clear();
        persisted.clear();
        live.length = 0;
        pool.length = 0;
        tasks.length = 0;
        sprites.clear();
        if (ro) ro.disconnect();
        win.removeEventListener('resize', resize);
        rootEl.removeEventListener('scroll', onScroll);
        if (mq) {
          if (mq.removeEventListener) mq.removeEventListener('change', onMq);
          else if (mq.removeListener) mq.removeListener(onMq);
        }
        audio.destroy();
        layer.remove();
        styleEl.remove();
        if (restorePosition != null) rootEl.style.position = restorePosition;
      }
    };
    return api;
  }

  root.KYARA_DUEL_FX = { create, SOUNDS: SOUND_NAMES.slice(), STATUS_LABELS: Object.keys(STATUS).reduce((m, k) => ((m[k] = STATUS[k].label), m), {}) };
})(typeof window !== 'undefined' ? window : this);
