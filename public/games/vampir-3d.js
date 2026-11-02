// 🧛 Vampir Köylü — 3D köy meydanı (Aşama 1). Oyun ekranının üstünde küçük, sevimli bir sahne:
// ateşin çevresinde oyuncular, gece/gündüz geçişi, gece dokunarak seçim. Kurallar ve sunucu aynı.
//
// GİZLİLİK: Sahne sadece describe() çıktısından çizilir. describe() rol bilgisini (view.me.role, allies,
// allyPicks, seerResults, nightPick) SADECE kart açıkken okur; kart kapalıyken herkesin sahnesi birebir aynıdır
// (tek fark kamera açısı: herkes kendini önde görür). Yeni bir görsel eklerken bu kurala uy.
//
// Three.js public/vendor/three/ altında (r187, MIT); sadece 3D açıkken ve WebGL2 varken tembel yüklenir.

import { deathStyle, DAWN_REVEAL, VERDICT_REVEAL } from './vampir-flow.js';

const THREE_URL = '../vendor/three/three.module.min.js';
const LS_KEY = 'tss:vampir-3d';
const FPS = 30;
const TAU = Math.PI * 2;

// ---------- Ayar (localStorage) ----------

export function is3DEnabled() {
  try { return localStorage.getItem(LS_KEY) !== '0'; } catch { return true; }
}
function save3D(on) {
  try { localStorage.setItem(LS_KEY, on ? '1' : '0'); } catch { /* gizli sekme vb. */ }
}

function hasWebGL2() {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch { return false; }
}

// ---------- Saf kısım: görünümden sahne tarifi (testler de kullanır) ----------

// Oyuncuya göre sabit (oyundan oyuna değişmez) renk ve şapka. Sadece kimlikten türetilir.
export function hashId(id) {
  let h = 0x811c9dc5;
  const s = String(id);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
export const COLORS = ['#ff8fab', '#ffb86b', '#ffe066', '#9be15d', '#5ce1c6', '#6ec6ff',
  '#9d8cff', '#d98cff', '#ff9e9e', '#7bdcb5', '#f7a072', '#a0c4ff'];
export const HATS = ['kasket', 'fes', 'kovboy', 'tac', 'bere', 'silindir', 'kulah', 'cicek'];
export function lookOf(id) {
  const h = hashId(id);
  return { color: COLORS[h % COLORS.length], hat: HATS[(h >>> 8) % HATS.length], seed: ((h >>> 16) % 1000) / 1000 };
}

// ui.cardOpen: rol kartı açık mı. Kart kapalıyken rol türevli hiçbir alan doldurulmaz.
// narr: sunucunun herkese aynı anlatımı (view.narration) + ölüm animasyonu türü (oyun+gece tohumundan).
export function describe(view, ui = {}) {
  const phase = view.phase;
  const night = phase === 'night';
  const dark = night || phase === 'dusk'; // akşam anlatımında güneş batar, köy uyur
  const me = view.me;
  const open = !!(ui.cardOpen && me && me.alive && night);
  const chosen = open ? me.nightPick ?? null : null;
  const allyTargets = open ? Object.values(me.allyPicks ?? {}) : [];
  const nominee = phase === 'day' ? view.nomination?.targetId ?? null : null;
  const n = view.narration ?? null;
  const accused = phase === 'trial' || phase === 'trialVote' ? view.trial?.targetId ?? null
    : phase === 'verdict' ? n?.trial?.targetId ?? null : null;
  return {
    phase,
    sky: dark ? 'night' : 'day',
    spotlight: accused,
    narr: n && {
      kind: n.kind,
      deadId: n.deadId ?? null,
      trial: n.trial ?? null,
      startedAt: n.startedAt,
      endsAt: n.endsAt ?? null,
      style: n.kind === 'dawn' && n.deadId ? deathStyle(view.gameKey, n.night) : null,
    },
    chars: view.players.map((p) => ({
      id: p.id,
      name: p.name,
      alive: !!p.alive,
      sleeping: dark && !!p.alive,
      ring: chosen === p.id,
      allies: allyTargets.filter((t) => t === p.id).length,
      nominee: nominee === p.id,
      accused: accused === p.id,
      look: accused && p.alive && p.id !== accused ? 'accused' : 'fire',
    })),
  };
}

// ---------- Sahne bloğu ----------

// onTap(playerId): karaktere dokunuldu (gece seçimi / gündüz satıra kaydırma vampir.js'te).
export function createStage({ onTap } = {}) {
  const el = document.createElement('div');
  el.className = 'v3d';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'v3d-toggle';
  const note = document.createElement('span');
  note.className = 'v3d-note';
  el.append(note, toggle);

  let enabled = is3DEnabled();
  let world = null;
  let loading = false;
  let last = null;
  let disposed = false;
  let failed = false; // WebGL yok/koptu: bu oyunda bir daha deneme

  const setReady = (s) => { el.dataset.ready = s; };
  const paint = () => {
    el.classList.toggle('off', !enabled);
    toggle.textContent = enabled ? '3D açık ✕' : '🏡 3D köyü göster';
    toggle.setAttribute('aria-pressed', String(enabled));
    note.textContent = enabled && el.dataset.ready === 'loading' ? 'Köy kuruluyor…' : '';
  };
  const fail = () => {
    failed = true;
    world?.dispose();
    world = null;
    setReady('fallback');
    el.hidden = true; // sessizce gizle: oyun 2D olarak aynen sürer
  };
  const enable = () => {
    if (world || loading || disposed || failed) return;
    if (!hasWebGL2()) return fail();
    loading = true;
    setReady('loading');
    paint();
    import(THREE_URL).then((THREE) => {
      loading = false;
      if (disposed || !enabled) return;
      try {
        world = buildWorld(THREE, el, { onTap: (id) => onTap?.(id), onLost: fail, onDetached: () => api.dispose() });
        setReady('webgl');
        if (last) world.apply(last);
      } catch { fail(); }
      paint();
    }).catch(() => { loading = false; fail(); });
  };
  const disable = () => {
    world?.dispose();
    world = null;
    setReady('off');
    paint();
  };
  toggle.addEventListener('click', () => {
    enabled = !enabled;
    save3D(enabled);
    if (enabled) enable(); else disable();
    paint();
  });

  setReady(enabled ? 'loading' : 'off');
  paint();

  const api = {
    el,
    get disposed() { return disposed; },
    update(view, ctx, ui) {
      if (disposed) return;
      const desc = describe(view, ui);
      const meIndex = view.players.findIndex((p) => p.id === ctx.playerId && view.me);
      // serverOffset: animasyonlar sunucu saatine göre (her telefonda aynı an); tarife (data-state) girmez.
      last = { desc, meIndex, serverOffset: ctx.serverOffset ?? 0 };
      // Test/hata ayıklama için: kamera dışındaki her şey. Kart kapalıyken herkeste aynı olmalı.
      el.dataset.phase = desc.phase;
      el.dataset.sky = desc.sky;
      el.dataset.state = JSON.stringify(desc);
      if (!enabled) return;
      if (world) world.apply(last);
      else enable();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      world?.dispose();
      world = null;
      el.dataset.ready = 'disposed';
    },
  };
  // Testler karaktere gerçek dokunuş yapabilsin diye: ekran koordinatı.
  el.v3dProject = (id) => world?.project(id) ?? null;
  el.v3dHitAt = (x, y) => world?.hitAt(x, y) ?? null;
  return api;
}

// ---------- Three.js dünyası ----------

function buildWorld(T, host, { onTap, onLost, onDetached }) {
  const reduce = !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const DUR = reduce ? 0.3 : 2.5; // gece/gündüz geçişi (sn)
  const MOTION = reduce ? 0.3 : 1;

  const renderer = new T.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(1.5, globalThis.devicePixelRatio || 1));
  renderer.setClearColor(0x000000, 0);
  const canvas = renderer.domElement;
  canvas.className = 'v3d-canvas';
  host.prepend(canvas);
  const lost = (e) => { e.preventDefault(); onLost(); };
  canvas.addEventListener('webglcontextlost', lost);

  const scene = new T.Scene();
  const fog = new T.Fog(0xffffff, 10, 30);
  scene.fog = fog;
  const camera = new T.PerspectiveCamera(46, 1, 0.1, 90);

  const C = (hex) => new T.Color(hex);
  const mats = new Map();
  const lam = (hex) => {
    if (!mats.has(hex)) mats.set(hex, new T.MeshLambertMaterial({ color: hex, flatShading: true }));
    return mats.get(hex);
  };
  const basic = (opts) => new T.MeshBasicMaterial(opts);
  const mesh = (geo, mat, x = 0, y = 0, z = 0) => {
    const m = new T.Mesh(geo, mat);
    m.position.set(x, y, z);
    return m;
  };

  // --- Metin dokuları (isim, zzz, ❗) ---
  const texCache = new Map();
  function textTexture(key, draw, w = 256, h = 64) {
    if (texCache.has(key)) return texCache.get(key);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const tex = new T.CanvasTexture(c);
    tex.colorSpace = T.SRGBColorSpace;
    texCache.set(key, tex);
    return tex;
  }
  const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const emojiTex = (text) => textTexture(`e:${text}`, (g, w, h) => {
    g.font = `bold ${h * 0.7}px ${FONT}`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 6; g.strokeStyle = 'rgba(20,10,40,.6)';
    g.strokeText(text, w / 2, h / 2 + 2);
    g.fillStyle = '#fff';
    g.fillText(text, w / 2, h / 2 + 2);
  }, 128, 64);
  const labelTex = (name, alive) => textTexture(`l:${alive ? 1 : 0}:${name}`, (g, w, h) => {
    g.font = `600 30px ${FONT}`;
    const tw = Math.min(w - 8, g.measureText(name).width + 28);
    g.fillStyle = alive ? 'rgba(25,12,45,.62)' : 'rgba(40,40,50,.45)';
    const x = (w - tw) / 2, r = 18;
    g.beginPath();
    g.moveTo(x + r, 6); g.arcTo(x + tw, 6, x + tw, h - 6, r); g.arcTo(x + tw, h - 6, x, h - 6, r);
    g.arcTo(x, h - 6, x, 6, r); g.arcTo(x, 6, x + tw, 6, r); g.fill();
    g.fillStyle = alive ? '#fff' : '#b9b4c4';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(name, w / 2, h / 2 + 1, w - 30);
  });
  // Emoji yazı tipine güvenmeden çizilen işaretler
  const zzzTex = () => textTexture('zzz', (g, w, h) => {
    g.textBaseline = 'middle';
    g.lineWidth = 5; g.strokeStyle = 'rgba(40,30,90,.8)'; g.fillStyle = '#ffffff';
    [[8, 44, 26], [40, 32, 34], [80, 22, 44]].forEach(([x, y, size]) => {
      g.font = `900 ${size}px ${FONT}`;
      g.strokeText('z', x, y); g.fillText('z', x, y);
    });
  }, 128, 64);
  const bangTex = () => textTexture('bang', (g, w, h) => {
    g.fillStyle = '#ffcf33'; g.strokeStyle = '#7a2a12'; g.lineWidth = 5;
    g.beginPath(); g.arc(w / 2, h / 2, h / 2 - 4, 0, TAU); g.fill(); g.stroke();
    g.fillStyle = '#c4262e'; g.font = `900 ${h * 0.62}px ${FONT}`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('!', w / 2, h / 2 + 3);
  }, 64, 64);
  const sprite = (tex, sx, sy, fixed = false) => {
    // fixed: ekranda sabit boy (uzaktaki isimler de okunsun)
    const s = new T.Sprite(new T.SpriteMaterial({ map: tex, depthTest: false, transparent: true, fog: false, sizeAttenuation: !fixed }));
    s.scale.set(sx, sy, 1);
    s.renderOrder = 10;
    return s;
  };

  // --- Ortak geometriler ---
  const G = {
    body: new T.CapsuleGeometry(0.34, 0.42, 4, 10),
    head: new T.SphereGeometry(0.3, 12, 10),
    eye: new T.SphereGeometry(0.05, 6, 5),
    cheek: new T.SphereGeometry(0.06, 6, 5),
    arm: new T.CapsuleGeometry(0.08, 0.2, 2, 6).translate(0, -0.16, 0),
    shadow: new T.CircleGeometry(0.45, 16).rotateX(-Math.PI / 2),
    hit: new T.CylinderGeometry(0.45, 0.45, 1.9, 8).translate(0, 0.95, 0),
    ring: new T.RingGeometry(0.5, 0.66, 28).rotateX(-Math.PI / 2),
    tombBase: new T.BoxGeometry(0.46, 0.45, 0.14).translate(0, 0.225, 0),
    tombTop: new T.CylinderGeometry(0.23, 0.23, 0.14, 12).rotateX(Math.PI / 2).translate(0, 0.45, 0),
  };
  const M = {
    eye: lam('#2a1d33'),
    cheek: basic({ color: '#ff9fb4', transparent: true, opacity: 0.7 }),
    shadow: basic({ color: '#1a1030', transparent: true, opacity: 0.2, depthWrite: false }),
    hit: basic({ visible: false }),
    ring: basic({ color: '#ffd166', transparent: true, opacity: 0.95, depthWrite: false }),
    ghost: new T.MeshLambertMaterial({ color: '#eef0ff', emissive: '#55597a', transparent: true, opacity: 0.55, depthWrite: false }),
    tomb: lam('#9aa0ad'),
  };

  // --- Şapkalar (prosedürel) ---
  const hatGeo = {};
  const hg = (key, make) => (hatGeo[key] ??= make());
  function makeHat(type, color) {
    const g = new T.Group();
    const add = (geo, hex, x = 0, y = 0, z = 0) => { const m = mesh(geo, lam(hex), x, y, z); g.add(m); return m; };
    switch (type) {
      case 'kasket':
        add(hg('capDome', () => new T.SphereGeometry(0.31, 12, 6, 0, TAU, 0, Math.PI / 2)), color, 0, 0.06, 0);
        add(hg('capBrim', () => new T.BoxGeometry(0.34, 0.03, 0.22)), color, 0, 0.07, 0.3);
        break;
      case 'fes':
        add(hg('fes', () => new T.CylinderGeometry(0.15, 0.2, 0.26, 10)), '#d6283b', 0, 0.33, 0);
        add(hg('tassel', () => new T.SphereGeometry(0.04, 6, 5)), '#1d1d1d', 0.12, 0.38, 0.04);
        break;
      case 'kovboy':
        add(hg('cbBrim', () => new T.CylinderGeometry(0.5, 0.5, 0.04, 16)), '#a0663a', 0, 0.2, 0);
        add(hg('cbCrown', () => new T.CylinderGeometry(0.2, 0.25, 0.26, 10)), '#a0663a', 0, 0.33, 0);
        add(hg('cbBand', () => new T.CylinderGeometry(0.255, 0.255, 0.05, 10)), '#5b3418', 0, 0.23, 0);
        break;
      case 'tac': {
        add(hg('crown', () => new T.CylinderGeometry(0.22, 0.22, 0.14, 10, 1, true)), '#ffcc33', 0, 0.3, 0)
          .material = hg('crownMat', () => new T.MeshLambertMaterial({ color: '#ffcc33', flatShading: true, side: T.DoubleSide }));
        const spike = hg('spike', () => new T.ConeGeometry(0.05, 0.12, 4));
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * TAU;
          add(spike, '#ffcc33', Math.sin(a) * 0.2, 0.42, Math.cos(a) * 0.2);
        }
        add(hg('gem', () => new T.OctahedronGeometry(0.04)), '#e63973', 0, 0.3, 0.22);
        break;
      }
      case 'bere':
        add(hg('beanie', () => new T.SphereGeometry(0.315, 12, 6, 0, TAU, 0, Math.PI / 2.2)), color, 0, 0.04, 0);
        add(hg('pompom', () => new T.SphereGeometry(0.09, 8, 6)), '#ffffff', 0, 0.36, 0);
        break;
      case 'silindir':
        add(hg('thBrim', () => new T.CylinderGeometry(0.36, 0.36, 0.03, 16)), '#26222e', 0, 0.22, 0);
        add(hg('thTop', () => new T.CylinderGeometry(0.2, 0.2, 0.4, 14)), '#26222e', 0, 0.43, 0);
        add(hg('thBand', () => new T.CylinderGeometry(0.205, 0.205, 0.06, 14)), '#c2304b', 0, 0.27, 0);
        break;
      case 'kulah':
        add(hg('party', () => new T.ConeGeometry(0.18, 0.42, 10)), color, 0, 0.45, 0);
        add(hg('partyBall', () => new T.SphereGeometry(0.05, 6, 5)), '#ffffff', 0, 0.67, 0);
        break;
      default: { // cicek: başında filiz + çiçek
        add(hg('stem', () => new T.CylinderGeometry(0.015, 0.015, 0.22, 4)), '#3f9b3f', 0, 0.38, 0);
        add(hg('leaf', () => new T.SphereGeometry(0.06, 6, 4).scale(1.4, 0.4, 0.8)), '#5cc45c', 0.06, 0.38, 0);
        add(hg('petal', () => new T.SphereGeometry(0.1, 8, 6).scale(1, 0.5, 1)), '#ffffff', 0, 0.5, 0);
        add(hg('core', () => new T.SphereGeometry(0.045, 6, 5)), '#ffcc33', 0, 0.53, 0);
      }
    }
    return g;
  }

  // --- Çevre: zemin, meydan, ateş, evler, ağaçlar, gökyüzü ---
  const env = new T.Group();
  scene.add(env);
  env.add(mesh(new T.CylinderGeometry(16, 16, 0.4, 32), lam('#8fcf6b'), 0, -0.2, 0));
  const plaza = mesh(new T.CircleGeometry(1, 32).rotateX(-Math.PI / 2), lam('#e9d3a6'), 0, 0.01, 0);
  env.add(plaza);

  // Ateş
  const fire = new T.Group();
  env.add(fire);
  const stoneGeo = new T.DodecahedronGeometry(0.12);
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * TAU;
    const s = mesh(stoneGeo, lam('#8d8a96'), Math.sin(a) * 0.55, 0.06, Math.cos(a) * 0.55);
    s.rotation.set(a, a * 2, 0);
    fire.add(s);
  }
  const logGeo = new T.CylinderGeometry(0.07, 0.08, 0.75, 6);
  for (let i = 0; i < 3; i++) {
    const l = mesh(logGeo, lam('#7a4a2a'), 0, 0.1, 0);
    l.rotation.set(0, (i / 3) * Math.PI, Math.PI / 2);
    fire.add(l);
  }
  const flameOuter = mesh(new T.ConeGeometry(0.3, 0.75, 7), basic({ color: '#ff7a1f', fog: false }), 0, 0.48, 0);
  const flameInner = mesh(new T.ConeGeometry(0.17, 0.48, 6), basic({ color: '#ffd84a', fog: false }), 0, 0.38, 0);
  fire.add(flameOuter, flameInner);
  const fireLight = new T.PointLight('#ff9a3c', 6, 14, 1.3);
  fireLight.position.set(0, 0.9, 0);
  fire.add(fireLight);

  // Evler ve ağaçlar oyuncu sayısına göre yarıçapta; kamera sabit, evler hep arka planda.
  const windowMat = basic({ color: '#5d6b7a' });
  const houses = new T.Group();
  const trees = new T.Group();
  env.add(houses, trees);
  const wallGeo = new T.BoxGeometry(1.6, 1.1, 1.3).translate(0, 0.55, 0);
  const roofGeo = new T.ConeGeometry(1.3, 0.85, 4).rotateY(Math.PI / 4).scale(1.05, 1, 0.85).translate(0, 1.52, 0);
  const doorGeo = new T.BoxGeometry(0.34, 0.56, 0.04).translate(0, 0.28, 0);
  const winGeo = new T.PlaneGeometry(0.28, 0.28);
  const chimGeo = new T.BoxGeometry(0.2, 0.45, 0.2);
  const trunkGeo = new T.CylinderGeometry(0.08, 0.11, 0.5, 6).translate(0, 0.25, 0);
  const pineGeo = new T.ConeGeometry(0.5, 1.0, 7).translate(0, 0.95, 0);
  const pineTopGeo = new T.ConeGeometry(0.36, 0.7, 7).translate(0, 1.45, 0);
  const roundGeo = new T.IcosahedronGeometry(0.55, 0).translate(0, 1.0, 0);
  const HOUSES = [
    { a: 160, wall: '#fff1d6', roof: '#e0675a' }, { a: 205, wall: '#ffd9e3', roof: '#8a6fd1' },
    { a: 118, wall: '#d7f0ff', roof: '#e8915a' }, { a: 248, wall: '#dcf5df', roof: '#c9505f' },
  ];
  const TREES = [[182, 1.5, 'pine'], [138, 1.2, 'round'], [228, 1.3, 'pine'], [95, 0.6, 'round'], [272, 0.7, 'pine'],
    [70, 2.5, 'pine'], [292, 2.2, 'round'], [150, 4.0, 'pine'], [215, 4.2, 'round'], [190, 5.5, 'pine']];
  function layoutEnv(R) {
    plaza.scale.setScalar(R + 1.15);
    houses.clear();
    trees.clear();
    const HR = R + 3.4;
    for (const h of HOUSES) {
      const a = (h.a * Math.PI) / 180;
      const g = new T.Group();
      g.position.set(Math.sin(a) * HR, 0, Math.cos(a) * HR);
      g.rotation.y = Math.atan2(-g.position.x, -g.position.z);
      g.add(mesh(wallGeo, lam(h.wall)), mesh(roofGeo, lam(h.roof)), mesh(doorGeo, lam('#7a4a2a'), 0, 0, 0.66));
      g.add(mesh(chimGeo, lam('#b5574b'), 0.42, 1.7, -0.2));
      for (const x of [-0.48, 0.48]) g.add(mesh(winGeo, windowMat, x, 0.66, 0.656));
      houses.add(g);
    }
    for (const [deg, extra, kind] of TREES) {
      const a = (deg * Math.PI) / 180;
      const r = R + 2.0 + extra;
      const g = new T.Group();
      g.position.set(Math.sin(a) * r, 0, Math.cos(a) * r);
      g.scale.setScalar(0.85 + ((deg * 7) % 10) / 25);
      g.add(mesh(trunkGeo, lam('#7a5232')));
      if (kind === 'pine') g.add(mesh(pineGeo, lam('#3fa36a')), mesh(pineTopGeo, lam('#4fbf7a')));
      else g.add(mesh(roundGeo, lam('#6cc160')));
      trees.add(g);
    }
  }

  // Gökyüzü: CSS degrade (tuval saydam) + güneş, ay, yıldızlar. Sis rengi ufuk rengiyle aynı.
  const SKY = {
    day: { top: C('#8fd3ff'), hor: C('#ffe7c4') },
    night: { top: C('#0b1033'), hor: C('#3b3672') },
  };
  const sun = mesh(new T.SphereGeometry(1.1, 16, 12), basic({ color: '#ffd45c', fog: false }));
  const moon = mesh(new T.SphereGeometry(0.75, 16, 12), basic({ color: '#f4f1ff', fog: false }));
  env.add(sun, moon);
  const starPos = [];
  for (let i = 0; i < 90; i++) {
    const r1 = Math.sin(i * 12.9898) * 43758.5453;
    const r2 = Math.sin(i * 78.233) * 12543.123;
    starPos.push(((r1 - Math.floor(r1)) - 0.5) * 60, 1 + (r2 - Math.floor(r2)) * 14, -26 - (i % 5));
  }
  const starGeo = new T.BufferGeometry();
  starGeo.setAttribute('position', new T.Float32BufferAttribute(starPos, 3));
  const starMat = new T.PointsMaterial({ color: '#ffffff', size: 0.18, transparent: true, opacity: 0, fog: false });
  env.add(new T.Points(starGeo, starMat));

  const hemi = new T.HemisphereLight('#ffffff', '#8bbf6a', 1.6);
  const sunLight = new T.DirectionalLight('#fff3dd', 1.6);
  sunLight.position.set(-4, 8, 6);
  const moonLight = new T.DirectionalLight('#9fb0ff', 0);
  moonLight.position.set(5, 7, 4);
  scene.add(hemi, sunLight, moonLight);

  // Yargılama spot ışığı (sanık)
  const spot = new T.SpotLight('#fff6d0', 0, 12, 0.42, 0.6, 1);
  spot.position.set(0, 6, 0);
  scene.add(spot, spot.target);
  const beamMat = basic({ color: '#fff6c8', transparent: true, opacity: 0, depthWrite: false, fog: false });
  const beam = mesh(new T.ConeGeometry(0.75, 5, 16, 1, true).translate(0, 2.5, 0), beamMat);
  beam.visible = false;
  const pool = mesh(new T.CircleGeometry(0.8, 24).rotateX(-Math.PI / 2).translate(0, 0.025, 0),
    basic({ color: '#fff3b0', transparent: true, opacity: 0, depthWrite: false }));
  beam.add(pool);
  scene.add(beam);

  // --- Karakterler ---
  const chars = new Map();
  const hits = [];
  let R = 2.1;

  function makeChar(c) {
    const look = lookOf(c.id);
    const root = new T.Group();
    const rig = new T.Group();
    const bodyMat = lam(look.color);
    const body = mesh(G.body, bodyMat, 0, 0.55, 0);
    const head = new T.Group();
    head.position.set(0, 1.28, 0);
    const headMesh = mesh(G.head, bodyMat);
    const eyes = [mesh(G.eye, M.eye, -0.1, 0.04, 0.27), mesh(G.eye, M.eye, 0.1, 0.04, 0.27)];
    const cheeks = [mesh(G.cheek, M.cheek, -0.18, -0.06, 0.22), mesh(G.cheek, M.cheek, 0.18, -0.06, 0.22)];
    cheeks.forEach((m) => m.scale.set(1, 0.6, 0.4));
    const hatColor = COLORS[(hashId(c.id) >>> 4) % COLORS.length];
    const hat = makeHat(look.hat, hatColor === look.color ? '#ffffff' : hatColor);
    head.add(headMesh, ...eyes, ...cheeks, hat);
    const arms = [mesh(G.arm, bodyMat, -0.37, 0.78, 0), mesh(G.arm, bodyMat, 0.37, 0.78, 0)];
    rig.add(body, head, ...arms);
    const tomb = new T.Group();
    tomb.add(mesh(G.tombBase, M.tomb), mesh(G.tombTop, M.tomb));
    tomb.position.set(0, 0, 0.35);
    const shadow = mesh(G.shadow, M.shadow, 0, 0.02, 0);
    const ring = mesh(G.ring, M.ring, 0, 0.03, 0);
    const hit = mesh(G.hit, M.hit);
    hit.userData.id = c.id;
    hits.push(hit);
    const label = sprite(labelTex(c.name, true), 0.2, 0.05, true);
    label.position.y = 2.25;
    const zzz = sprite(zzzTex(), 0.8, 0.4);
    const mark = sprite(bangTex(), 0.42, 0.42);
    mark.position.y = 2.7;
    root.add(shadow, ring, tomb, rig, hit, label, zzz, mark);
    scene.add(root);
    return {
      id: c.id, look, root, rig, body, head, headMesh, eyes, cheeks, hat, arms, tomb, shadow, ring, label, zzz, mark, hit,
      bodyMat, labelKey: '', markKey: '', alive: null, state: c,
      yaw: 0, angle: 0, angleTarget: 0, sleep: c.sleeping ? 1 : 0, stretch: 0, wasSleeping: c.sleeping,
    };
  }

  // --- Aşama 2: ölüm / sürgün efektleri ---
  // Zaman saniye; t=0 anlatıcının açıklama satırı (sunucu saati, her telefonda aynı an). tombAt: mezar taşı "pop",
  // ghostAt: hayalet çıkar, end: animasyon biter (sonrası Aşama 1'deki hayalet + mezar taşı). Azaltılmış harekette
  // animasyon yok: açıklama anında doğrudan hayalet.
  const FX = reduce
    ? { bats: { end: 0, ghostAt: 0, tombAt: 0 }, tomb: { end: 0, ghostAt: 0, tombAt: 0 }, coffin: { end: 0, ghostAt: 0, tombAt: 0 },
      catapult: { end: 0, ghostAt: 0, tombAt: 0 }, relief: { end: 0 } }
    : { bats: { end: 3.4, ghostAt: 2.5, tombAt: 2.3 }, tomb: { end: 3.0, ghostAt: 2.1, tombAt: 1.4 },
      coffin: { end: 3.6, ghostAt: 2.9, tombAt: 2.6 }, catapult: { end: 4.4, ghostAt: 3.7, tombAt: 3.6 }, relief: { end: 2.2 } };
  const fxRoot = new T.Group();
  scene.add(fxRoot);
  const fxObjs = []; // her karede önce hepsi gizlenir, oynayan efekt açar
  const fxAdd = (o, parent = fxRoot) => { o.visible = false; parent.add(o); fxObjs.push(o); return o; };
  const batSprites = Array.from({ length: 7 }, () => fxAdd(sprite(emojiTex('🦇'), 0.7, 0.35)));
  const dustMat = basic({ color: '#d9ccb2', transparent: true, opacity: 0, depthWrite: false });
  const dustGeo = new T.IcosahedronGeometry(0.14, 0);
  const dust = Array.from({ length: 9 }, () => fxAdd(mesh(dustGeo, dustMat)));
  const twinkle = fxAdd(sprite(emojiTex('✨'), 1.4, 0.7));
  const sigh = fxAdd(sprite(emojiTex('😮‍💨'), 1.0, 0.5));
  const wood = lam('#8a5a34');
  const darkWood = lam('#5a3620');
  // Tabut: içi boş kutu + menteşeli kapak (karakter içinde görünsün)
  const coffin = fxAdd(new T.Group());
  const box = (w, h, d, mat, x, y, z) => mesh(new T.BoxGeometry(w, h, d), mat, x, y, z);
  coffin.add(box(0.86, 1.95, 0.06, darkWood, 0, 0.98, -0.26), box(0.06, 1.95, 0.56, darkWood, -0.43, 0.98, 0),
    box(0.06, 1.95, 0.56, darkWood, 0.43, 0.98, 0), box(0.86, 0.06, 0.56, darkWood, 0, 1.95, 0), box(0.86, 0.06, 0.56, darkWood, 0, 0.03, 0));
  const lid = new T.Group();
  lid.position.set(-0.43, 0, 0.28);
  lid.add(box(0.86, 1.95, 0.06, wood, 0.43, 0.98, 0), box(0.08, 0.7, 0.03, lam('#e6c35c'), 0.43, 1.25, 0.04),
    box(0.4, 0.08, 0.03, lam('#e6c35c'), 0.43, 1.38, 0.04));
  coffin.add(lid);
  // Mancınık: kaide + tekerlek + kol (pivot) + kova. Kol +z yönünde; rotation.x eksiye dönünce kova yukarı-geriye savrulur.
  const catapult = fxAdd(new T.Group());
  catapult.add(box(0.9, 0.18, 1.2, wood, 0, 0.3, 0));
  const wheelGeo = new T.CylinderGeometry(0.22, 0.22, 0.1, 10).rotateZ(Math.PI / 2);
  for (const [x, z] of [[-0.5, -0.4], [0.5, -0.4], [-0.5, 0.4], [0.5, 0.4]]) catapult.add(mesh(wheelGeo, darkWood, x, 0.22, z));
  catapult.add(box(0.1, 0.7, 0.1, darkWood, -0.3, 0.65, 0), box(0.1, 0.7, 0.1, darkWood, 0.3, 0.65, 0), box(0.7, 0.1, 0.1, darkWood, 0, 0.95, 0));
  const arm = new T.Group();
  arm.position.set(0, 0.85, 0);
  const ARM_L = 1.2;
  arm.add(box(0.12, 0.12, ARM_L, wood, 0, 0, ARM_L / 2), mesh(new T.CylinderGeometry(0.3, 0.2, 0.22, 10), darkWood, 0, 0.12, ARM_L));
  catapult.add(arm);
  const CAT_Z = -1.1; // mancınık sanığın arkasında (kök yerel ekseninde)
  const bucketAt = (a, out) => out.set(0, 0.85 - ARM_L * Math.sin(a) + 0.2, CAT_Z + ARM_L * Math.cos(a));
  const PROPS = ['🔥', '🔱'];
  const PALE = C('#e9edf6');
  const easeOutBack = (x) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2; };
  const clamp01 = (x) => Math.min(1, Math.max(0, x));
  let serverOffset = 0;
  const serverNow = () => Date.now() + serverOffset;

  // Bu karakter için oynayan efekt (sadece herkese açık anlatımdan): { type, t, cfg } | null
  function fxFor(id) {
    const n = desc?.narr;
    if (!n || !n.endsAt) return null;
    let type = null;
    let reveal = 0;
    if (n.kind === 'dawn' && n.deadId === id) { type = n.style || 'tomb'; reveal = DAWN_REVEAL; }
    else if (n.kind === 'verdict' && n.trial?.targetId === id) { type = n.trial.hanged ? 'catapult' : 'relief'; reveal = VERDICT_REVEAL; }
    if (!type) return null;
    const start = n.startedAt + (n.endsAt - n.startedAt) * reveal;
    return { type, t: (serverNow() - start) / 1000, cfg: FX[type] };
  }

  function puff(center, k) {
    dust.forEach((d, i) => {
      const a = (i / dust.length) * TAU;
      const r = 0.25 + 0.9 * k;
      d.visible = true;
      d.position.set(center.x + Math.sin(a) * r, 0.12 + 0.35 * k + 0.1 * Math.sin(i * 7), center.z + Math.cos(a) * r);
      d.scale.setScalar(1 + 1.4 * k);
    });
    dustMat.opacity = 0.75 * (1 - k);
  }

  function setGhost(ch, ghost) {
    const m = ghost ? M.ghost : ch.bodyMat;
    ch.body.material = m;
    ch.headMesh.material = m;
    ch.arms.forEach((a) => { a.material = m; });
    ch.hat.visible = !ghost;
    ch.cheeks.forEach((x) => { x.visible = !ghost; });
    ch.tomb.visible = ghost;
    ch.shadow.scale.setScalar(ghost ? 0.6 : 1);
  }

  let desc = null;
  let nightT = 0;
  let nightTarget = 0;
  let first = true;
  let spotOn = 0;

  function apply({ desc: d, meIndex, serverOffset: off }) {
    desc = d;
    serverOffset = off ?? 0;
    const meId = meIndex >= 0 ? d.chars[meIndex]?.id : null;
    const n = d.chars.length;
    const newR = Math.max(2.1, 0.62 + n * 0.2);
    if (newR !== R || first) { R = newR; layoutEnv(R); resize(); }
    const seen = new Set();
    const base = meIndex >= 0 ? meIndex : -0.5; // izleyici: kimse tam önde değil
    d.chars.forEach((c, i) => {
      seen.add(c.id);
      let ch = chars.get(c.id);
      if (!ch) { ch = makeChar(c); chars.set(c.id, ch); }
      ch.state = c;
      ch.angleTarget = ((i - base) / n) * TAU;
      if (first || ch.alive === null) ch.angle = ch.angleTarget;
      ch.alive = c.alive;
      const mk = c.nominee ? '!' : c.allies ? `🧛${c.allies > 1 ? c.allies : ''}` : '';
      if (mk && ch.markKey !== mk) {
        ch.mark.material.map = mk === '!' ? bangTex() : emojiTex(mk);
        ch.mark.scale.set(mk === '!' ? 0.42 : 0.8, mk === '!' ? 0.42 : 0.4, 1);
        ch.mark.material.needsUpdate = true;
      }
      ch.markKey = mk;
      ch.mark.visible = !!mk;
      ch.ring.visible = c.ring;
      ch.label.visible = c.id !== meId; // kendi karakterin hep önde, sırtı dönük; adı ateşi kapatmasın
      if (ch.wasSleeping && !c.sleeping && c.alive) ch.stretch = 1; // sabah: uyan, gerin
      ch.wasSleeping = c.sleeping;
      if (first) ch.sleep = c.sleeping ? 1 : 0;
    });
    for (const [id, ch] of chars) {
      if (seen.has(id)) continue;
      scene.remove(ch.root);
      hits.splice(hits.indexOf(ch.hit), 1);
      chars.delete(id);
    }
    nightTarget = d.sky === 'night' ? 1 : 0;
    if (first) { nightT = nightTarget; first = false; }
    kick();
    requestAnimationFrame(() => kick()); // vampir.js bloğu update()'ten hemen sonra yerleştirir
  }

  // --- Kamera ve boyut ---
  let width = 0;
  let height = 0;
  const camBase = new T.Vector3();
  const camLook = new T.Vector3(0, 0.6, -0.4);
  const camFocus = new T.Vector3(0, 0.6, -0.4);
  const camTmp = new T.Vector3();
  const camTmp2 = new T.Vector3();
  let camW = 0; // odak (ölen / sanık)
  let camPB = 0; // akşam geri çekilme
  let gather = 1; // oyun sonu: herkes ateşe yaklaşır
  function resize() {
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (!w || !h) return;
    width = w; height = h;
    renderer.setSize(w, h, false);
    const aspect = w / h;
    camera.aspect = aspect;
    const half = R + 1.1;
    const tanH = Math.tan((camera.fov * Math.PI) / 360) * aspect;
    const dist = Math.max(7, half / tanH + 1.2);
    const pitch = (30 * Math.PI) / 180;
    camBase.set(0, 0.6 + dist * Math.sin(pitch), dist * Math.cos(pitch) - 0.4);
    camLook.set(0, 0.6, -0.4);
    camera.position.copy(camBase);
    camera.lookAt(camLook);
    camera.updateProjectionMatrix();
    fog.near = dist + 1;
    fog.far = dist + 20;
    sun.position.z = -22; moon.position.z = -22;
    kick();
  }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
  ro?.observe(host);

  // --- Dokunma ---
  const ray = new T.Raycaster();
  const ndc = new T.Vector2();
  const hitAt = (x, y) => {
    const rect = canvas.getBoundingClientRect();
    ndc.set(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    return ray.intersectObjects(hits, false)[0]?.object.userData.id ?? null;
  };
  const onClick = (e) => {
    const id = hitAt(e.clientX, e.clientY);
    if (id) onTap(id);
  };
  canvas.addEventListener('click', onClick);

  // --- Döngü (~30 fps; görünmezken durur) ---
  let raf = 0;
  let detachTimer = 0;
  let lastFrame = 0;
  let lastT = 0;
  let onScreen = true;
  let disposed = false;
  const io = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((es) => { onScreen = es[es.length - 1].isIntersecting; kick(); })
    : null;
  io?.observe(host);
  const onVis = () => kick();
  document.addEventListener('visibilitychange', onVis);

  function kick() {
    if (disposed || raf) return;
    if (!host.isConnected) {
      // vampir.js her çizimde bloğu yeniden yerleştirir; uzun süre yoksa (lobiye dönüldü) kendini kapat.
      if (!detachTimer) detachTimer = setTimeout(() => { detachTimer = 0; if (!host.isConnected) onDetached(); else kick(); }, 4000);
      return;
    }
    if (document.hidden || !onScreen) return;
    lastT = performance.now();
    raf = requestAnimationFrame(frame);
  }
  function frame(now) {
    raf = 0;
    if (disposed) return;
    if (!host.isConnected || document.hidden || !onScreen) return kick();
    raf = requestAnimationFrame(frame);
    if (now - lastFrame < 1000 / FPS - 3) return;
    lastFrame = now;
    const dt = Math.min(0.1, (now - lastT) / 1000);
    lastT = now;
    if (!width || host.clientWidth !== width || host.clientHeight !== height) resize();
    if (!width) return;
    step(dt, now / 1000);
    renderer.render(scene, camera);
  }

  const lerp = (a, b, k) => a + (b - a) * k;
  const approach = (v, target, rate) => (v < target ? Math.min(target, v + rate) : Math.max(target, v - rate));
  const angleLerp = (a, b, k) => a + ((((b - a) % TAU) + TAU * 1.5) % TAU - Math.PI) * k;
  const smooth = (x) => x * x * (3 - 2 * x);
  const LIGHT = {
    skyDay: C('#ffffff'), skyNight: C('#6670c0'), groundDay: C('#8bbf6a'), groundNight: C('#1e2440'),
    winDay: C('#5d6b7a'), winNight: C('#ffcf6e'),
  };
  const tmpTop = new T.Color();
  const tmpHor = new T.Color();
  let lastSkyKey = '';

  function step(dt, t) {
    nightT = approach(nightT, nightTarget, dt / DUR);
    const k = smooth(nightT);
    // gökyüzü
    tmpTop.lerpColors(SKY.day.top, SKY.night.top, k);
    tmpHor.lerpColors(SKY.day.hor, SKY.night.hor, k);
    const skyKey = k.toFixed(3);
    if (skyKey !== lastSkyKey) {
      lastSkyKey = skyKey;
      host.style.background = `linear-gradient(180deg, #${tmpTop.getHexString()} 0%, #${tmpHor.getHexString()} 62%)`;
    }
    fog.color.copy(tmpHor);
    hemi.intensity = lerp(1.7, 0.55, k);
    hemi.color.lerpColors(LIGHT.skyDay, LIGHT.skyNight, k);
    hemi.groundColor.lerpColors(LIGHT.groundDay, LIGHT.groundNight, k);
    sunLight.intensity = lerp(1.6, 0, k);
    moonLight.intensity = lerp(0, 0.55, k);
    sun.position.set(lerp(-5, -9, k), lerp(4.5, -4, k), -22);
    moon.position.set(lerp(9, 6, k), lerp(-4, 4.2, k), -22);
    starMat.opacity = Math.max(0, k * 1.2 - 0.2);
    windowMat.color.lerpColors(LIGHT.winDay, LIGHT.winNight, k);
    // ateş
    const flick = 1 + MOTION * (0.12 * Math.sin(t * 13) + 0.08 * Math.sin(t * 7.3 + 1));
    fireLight.intensity = lerp(5, 18, k) * flick;
    flameOuter.scale.set(1, lerp(0.9, 1.25, k) * flick, 1);
    flameInner.scale.set(1, lerp(0.9, 1.3, k) * (2 - flick), 1);
    flameOuter.rotation.y = t * 0.8 * MOTION;
    // spot
    const accused = desc?.spotlight ? chars.get(desc.spotlight) : null;
    spotOn = approach(spotOn, accused ? 1 : 0, dt / Math.min(0.6, DUR));
    spot.intensity = 28 * spotOn;
    beamMat.opacity = 0.22 * spotOn;
    pool.material.opacity = 0.6 * spotOn;
    // yargılamada meydan biraz kararır, sanık öne çıkar
    hemi.intensity *= 1 - 0.45 * spotOn;
    sunLight.intensity *= 1 - 0.6 * spotOn;
    beam.visible = spotOn > 0.01;
    if (accused) {
      const p = accused.root.position;
      spot.position.set(p.x, 6, p.z);
      spot.target.position.set(p.x, 0, p.z);
      beam.position.set(p.x, 0, p.z);
    }
    // kamera: akşam yavaşça geri çekil, sabah ölene / kararda sanığa yaklaş, sonra normale dön
    const n = desc?.narr;
    let wantW = 0;
    let wantPB = 0;
    if (!reduce && n && n.endsAt) {
      const frac = (serverNow() - n.startedAt) / Math.max(1, n.endsAt - n.startedAt);
      let focusId = null;
      if (n.kind === 'dusk' && frac < 0.92) wantPB = 1;
      if (n.kind === 'dawn' && n.deadId && frac >= DAWN_REVEAL - 0.05 && frac < 0.88) focusId = n.deadId;
      if (n.kind === 'verdict' && n.trial && frac < 0.9) focusId = n.trial.targetId;
      const fc = focusId ? chars.get(focusId) : null;
      if (fc) { wantW = 1; camFocus.set(fc.root.position.x, 0.8, fc.root.position.z); }
    }
    camW = approach(camW, wantW, dt / 1.1);
    camPB = approach(camPB, wantPB, dt / 2.5);
    if (width) {
      const w = smooth(camW);
      camTmp.copy(camLook).lerp(camFocus, 0.8 * w);
      camTmp2.copy(camBase).sub(camLook).multiplyScalar(1 + 0.22 * smooth(camPB)).add(camLook);
      camTmp2.lerp(camFocus, 0.32 * w);
      camera.position.copy(camTmp2);
      camera.lookAt(camTmp);
    }
    gather = approach(gather, desc?.phase === 'over' ? 0.8 : 1, dt / 2);
    for (const o of fxObjs) o.visible = false;
    // karakterler
    const verdict = n?.kind === 'verdict' && n.trial?.hanged && n.endsAt ? fxFor(n.trial.targetId) : null;
    const torches = verdict && !reduce && verdict.t > -0.2 && verdict.t < 3.8 ? clamp01(Math.min((verdict.t + 0.2) / 0.5, (3.8 - verdict.t) / 0.5)) : 0;
    let propI = 0;
    for (const ch of chars.values()) {
      const c = ch.state;
      ch.angle = angleLerp(ch.angle, ch.angleTarget, Math.min(1, dt * 4));
      const x = Math.sin(ch.angle) * R * gather;
      const z = Math.cos(ch.angle) * R * gather;
      ch.root.position.set(x, 0, z);
      let yawTarget = Math.atan2(-x, -z);
      if (c.look === 'accused' && accused) {
        const p = accused.root.position;
        yawTarget = Math.atan2(p.x - x, p.z - z);
      }
      ch.yaw = angleLerp(ch.yaw, yawTarget, Math.min(1, dt * 3));
      ch.root.rotation.y = ch.yaw;
      const s = ch.look.seed * TAU;
      const fx = fxFor(ch.id);
      const running = fx && fx.t < fx.cfg.end;
      // Ölü ama açıklama/animasyon henüz o noktaya gelmediyse canlı görünür (sabah herkes aynı anda öğrenir).
      const ghostVis = !c.alive && !(fx && fx.cfg.ghostAt != null && fx.t < fx.cfg.ghostAt);
      if (ghostVis !== ch.ghostVis) { setGhost(ch, ghostVis); ch.ghostVis = ghostVis; }
      const lk = `${c.name}|${!ghostVis}`;
      if (ch.labelKey !== lk) { ch.labelKey = lk; ch.label.material.map = labelTex(c.name, !ghostVis); ch.label.material.needsUpdate = true; }
      if (ch.paled && !(running && fx.type === 'bats')) { ch.paled = false; if (!ghostVis) setGhost(ch, false); }
      ch.rig.visible = true;
      ch.rig.rotation.z = 0;
      ch.tomb.scale.setScalar(1);
      if (ch.prop) ch.prop.visible = false;
      if (running && fx.t >= 0 && fx.type !== 'relief') {
        animateDeath(ch, fx, t, s);
        continue;
      }
      if (ghostVis) {
        ch.rig.position.set(0, 0.35 + 0.08 * MOTION * Math.sin(t * 1.5 + s), -0.1);
        ch.rig.rotation.x = 0;
        ch.head.rotation.set(0, 0, 0);
        ch.zzz.visible = false;
        ch.label.position.y = 2.55;
        continue;
      }
      ch.label.position.y = 2.25;
      ch.rig.position.set(0, 0, 0);
      ch.sleep = approach(ch.sleep, c.sleeping ? 1 : 0, dt / (DUR * (desc?.phase === 'dusk' ? 1.4 : 0.8)));
      const sl = smooth(ch.sleep);
      ch.head.rotation.x = sl * 0.75;
      ch.head.rotation.y = (1 - sl) * 0.28 * MOTION * Math.sin(t * 0.55 + s * 3);
      ch.rig.rotation.x = sl * 0.16;
      const breathe = sl > 0.5 ? 0.04 * Math.sin(t * 1.3 + s) : 0.022 * Math.sin(t * 2.2 + s);
      let stretchK = 0;
      if (ch.stretch > 0) {
        ch.stretch = Math.max(0, ch.stretch - dt / (reduce ? 0.4 : 1.5));
        stretchK = Math.sin(Math.PI * (1 - ch.stretch));
      }
      ch.body.scale.set(1, 1 + breathe * MOTION + 0.08 * stretchK, 1);
      ch.head.position.y = 1.28 + 0.06 * stretchK + breathe * 0.4 * MOTION;
      let armUp = 2.4 * stretchK;
      // Sürgün: köylüler meşale / yaba kaldırır
      if (torches && c.alive && c.id !== n.trial.targetId) {
        armUp = Math.max(armUp, torches * (2.5 + 0.25 * Math.sin(t * 9 + s * 5)));
        if (!ch.prop) { ch.prop = sprite(emojiTex(PROPS[propI % 2]), 0.8, 0.4); ch.root.add(ch.prop); ch.propKind = propI % 2; }
        ch.prop.visible = true;
        ch.prop.position.set(0.42, 1.25 + 0.75 * torches, 0.05);
        ch.prop.material.opacity = torches;
        propI++;
      }
      ch.arms[0].rotation.z = -0.25 - armUp;
      ch.arms[1].rotation.z = 0.25 + armUp;
      // Kurtulan sanık: rahatlama zıplaması + 😮‍💨
      if (running && fx.type === 'relief' && fx.t >= 0) {
        ch.rig.position.y = fx.t < 1.2 ? 0.35 * Math.abs(Math.sin(fx.t * Math.PI * 2.5)) : 0;
        if (fx.t > 0.2) {
          sigh.visible = true;
          ch.root.updateMatrixWorld();
          sigh.position.set(0.15, 2.0 + 0.2 * clamp01(fx.t - 0.2), 0.2).applyMatrix4(ch.root.matrixWorld);
          sigh.material.opacity = clamp01((fx.cfg.end - fx.t) / 0.4);
        }
      }
      // göz: uykuda kapalı, gündüz arada bir kırp
      const blink = ((t + s * 4) % 4.2) < 0.12 ? 0.15 : 1;
      const eyeY = sl > 0.5 ? 0.18 : blink;
      ch.eyes.forEach((e) => { e.scale.y = eyeY; });
      ch.zzz.visible = sl > 0.7;
      if (ch.zzz.visible) {
        const f = (t * 0.45 + ch.look.seed) % 1;
        ch.zzz.position.set(0.3 + f * 0.15, 1.75 + f * 0.45, 0.1);
        ch.zzz.material.opacity = Math.sin(Math.PI * f);
      }
      if (ch.ring.visible) ch.ring.scale.setScalar(1 + 0.06 * MOTION * Math.sin(t * 4));
      if (ch.mark.visible) ch.mark.position.y = 2.7 + 0.08 * MOTION * Math.sin(t * 3);
    }
  }

  const fxV = new T.Vector3();
  const fxW = new T.Vector3();
  // Ölüm / sürgün animasyonu (t ≥ 0). Bittiğinde normal hayalet + mezar taşı döngüsü devralır.
  function animateDeath(ch, fx, now, s) {
    const { type, t, cfg } = fx;
    const pos = ch.root.position;
    ch.zzz.visible = false;
    ch.label.position.y = 2.25;
    ch.head.rotation.set(0, 0, 0);
    ch.rig.rotation.set(0, 0, 0);
    ch.rig.position.set(0, 0, 0);
    ch.body.scale.set(1, 1, 1);
    ch.head.position.y = 1.28;
    ch.eyes.forEach((e) => { e.scale.y = 1; });
    ch.arms[0].rotation.z = -0.25;
    ch.arms[1].rotation.z = 0.25;
    // mezar taşı "pop" (hayalet görünümü açılınca setGhost taşı gösterir; öncesinde biz)
    if (t >= cfg.tombAt) {
      ch.tomb.visible = true;
      ch.tomb.scale.setScalar(Math.max(0.01, easeOutBack(clamp01((t - cfg.tombAt) / 0.45))));
      const dk = (t - cfg.tombAt) / 0.8;
      if (dk < 1) puff(pos, dk);
    } else ch.tomb.visible = false;
    if (t >= cfg.ghostAt) {
      // hayalet yükselir
      const k = smooth(clamp01((t - cfg.ghostAt) / 0.8));
      ch.rig.position.set(0, 0.35 * k + 0.08 * Math.sin(now * 1.5 + s) * k, -0.1 * k);
      ch.label.position.y = 2.25 + 0.3 * k;
      return;
    }
    if (type === 'bats') {
      const k = smooth(clamp01((t - 0.3) / 1.1));
      if (!ch.paled) { ch.paleMat ??= ch.bodyMat.clone(); ch.paled = true; for (const m of [ch.body, ch.headMesh, ...ch.arms]) m.material = ch.paleMat; }
      ch.paleMat.color.copy(ch.bodyMat.color).lerp(PALE, k);
      ch.arms[0].rotation.z = -0.25 - 2.2 * clamp01(t / 0.4) * (t < 1.4 ? 1 : 0);
      ch.arms[1].rotation.z = 0.25 + 2.2 * clamp01(t / 0.4) * (t < 1.4 ? 1 : 0);
      const fall = smooth(clamp01((t - 1.4) / 0.55));
      ch.rig.rotation.z = fall * 1.45;
      ch.eyes.forEach((e) => { e.scale.y = fall > 0.5 ? 0.15 : 1; });
      if (t < 2.4) {
        const out = smooth(clamp01((t - 1.7) / 0.7));
        batSprites.forEach((b, i) => {
          const a = t * 4.2 + (i / batSprites.length) * TAU;
          const r = 0.75 + 0.12 * Math.sin(t * 5 + i) + 3 * out;
          b.visible = true;
          b.position.set(pos.x + Math.sin(a) * r, 1.0 + 0.35 * Math.sin(t * 3 + i * 1.7) + 3 * out, pos.z + Math.cos(a) * r);
          b.material.opacity = 1 - out;
        });
      }
    } else if (type === 'tomb') {
      if (t < 0.6) ch.rig.rotation.z = 0.18 * Math.sin(t * 20) * (1 - t / 0.6);
      else {
        const k = clamp01((t - 0.6) / 0.5);
        ch.rig.rotation.z = -1.5 * k * k + (k >= 1 ? 0.06 * Math.sin((t - 1.1) * 14) * Math.max(0, 1 - (t - 1.1) * 3) : 0);
        ch.eyes.forEach((e) => { e.scale.y = 0.15; });
      }
    } else if (type === 'coffin') {
      coffin.visible = true;
      if (coffin.parent !== ch.root) ch.root.add(coffin);
      let y = 0;
      if (t < 0.7) y = 5 * (1 - (t / 0.7) ** 2);
      else if (t < 0.9) y = 0.15 * Math.sin((Math.PI * (t - 0.7)) / 0.2);
      else if (t > 1.5) y = -2.2 * smooth(clamp01((t - 1.5) / 1.0));
      coffin.position.set(0, y, 0);
      lid.rotation.y = t < 0.95 ? -1.9 : -1.9 * (1 - clamp01((t - 0.95) / 0.3) ** 2);
      if (t < 0.95) { ch.arms[0].rotation.z = -2.5; ch.arms[1].rotation.z = 2.5; } // çığlık
      ch.rig.visible = t < 1.25;
      coffin.visible = t < 2.5;
      if (t >= 1.25 && t < 2.05) puff(pos, (t - 1.25) / 0.8);
    } else if (type === 'catapult') {
      ch.root.rotation.y = 0; // herkes için aynı yön: kameradan uzağa, evlerin üstünden
      catapult.visible = t < cfg.tombAt;
      if (catapult.parent !== ch.root) ch.root.add(catapult);
      catapult.position.set(0, 0, CAT_Z);
      catapult.scale.setScalar(easeOutBack(clamp01(t / 0.5)));
      const REST = 0.45;
      const TOP = -2.3;
      let a = REST;
      if (t >= 1.5) a = REST + (TOP - REST) * clamp01((t - 1.5) / 0.3) ** 2;
      arm.rotation.x = a;
      if (t < 1.0) {
        ch.arms[0].rotation.z = -0.25 - 0.4 * Math.sin(t * 12); // telaş
        ch.arms[1].rotation.z = 0.25 + 0.4 * Math.sin(t * 12 + 1);
      } else if (t < 1.8) {
        bucketAt(a, fxV);
        const hop = clamp01((t - 1.0) / 0.35);
        ch.rig.position.set(0, fxV.y * hop + 0.4 * Math.sin(Math.PI * hop), fxV.z * hop);
        ch.arms[0].rotation.z = -2.6; ch.arms[1].rotation.z = 2.6;
      } else {
        bucketAt(TOP, fxV);
        const tau = t - 1.8;
        ch.rig.position.set(0, fxV.y + 7 * tau - 4 * tau * tau, fxV.z - 7 * tau);
        ch.rig.rotation.x = -tau * 11;
        ch.arms[0].rotation.z = -2.6; ch.arms[1].rotation.z = 2.6;
        ch.label.position.y = -50; // ad uçmasın
        if (tau > 1.5) {
          ch.rig.visible = false;
          const tk = (tau - 1.5) / 0.6;
          if (tk < 1) {
            ch.root.updateMatrixWorld();
            fxW.set(0, fxV.y + 10.5 - 9, fxV.z - 10.5).applyMatrix4(ch.root.matrixWorld);
            twinkle.visible = true;
            twinkle.position.copy(fxW);
            twinkle.scale.set(1.4 * (1 + Math.sin(Math.PI * tk)), 0.7 * (1 + Math.sin(Math.PI * tk)), 1);
            twinkle.material.opacity = 1 - tk;
          }
        }
      }
    }
  }

  const v = new T.Vector3();
  return {
    apply,
    hitAt,
    project(id) {
      const ch = chars.get(id);
      if (!ch || !width) return null;
      ch.root.updateMatrixWorld(true);
      v.set(0, ch.state.alive ? 1.3 : 1.6, 0).applyMatrix4(ch.root.matrixWorld).project(camera);
      const rect = canvas.getBoundingClientRect();
      return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      clearTimeout(detachTimer);
      ro?.disconnect();
      io?.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      canvas.removeEventListener('click', onClick);
      canvas.removeEventListener('webglcontextlost', lost);
      const geos = new Set();
      const ms = new Set();
      scene.traverse((o) => {
        if (o.geometry) geos.add(o.geometry);
        if (o.material) ms.add(o.material);
      });
      [coffin, catapult].forEach((o) => o.traverse((x) => { if (x.geometry) geos.add(x.geometry); }));
      for (const ch of chars.values()) if (ch.paleMat) ms.add(ch.paleMat);
      [dustGeo, wheelGeo].forEach((g) => geos.add(g));
      [...Object.values(G), ...Object.values(hatGeo).filter((x) => x.isBufferGeometry),
        wallGeo, roofGeo, doorGeo, winGeo, chimGeo, trunkGeo, pineGeo, pineTopGeo, roundGeo].forEach((g) => geos.add(g));
      [...Object.values(M), ...mats.values(), ...Object.values(hatGeo).filter((x) => x.isMaterial)].forEach((m) => ms.add(m));
      geos.forEach((g) => g.dispose());
      ms.forEach((m) => m.dispose());
      texCache.forEach((tx) => tx.dispose());
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
      host.style.background = '';
    },
  };
}
