// ⚽ Tosun Top — saf fizik motoru (sunucu yetkili simülasyonu bunu çalıştırır; istemci sadece sabitleri okur).
// HaxBall tarzı birimler: uzunluk "birim", hız "birim/adım", sabit 60 adım/sn. Rastgelelik ve saat yok:
// aynı başlangıç + aynı girdi dizisi → bit bit aynı sonuç (deterministik). Bkz. PLAN.md §4.8.
//
// Koordinatlar: saha merkezi (0,0); Kırmızı (takım 0) solda (x<0) savunur, sağdaki kaleye atar; Mavi (1) tersi.

export const HZ = 60;
export const RED = 0;
export const BLUE = 1;

export const PHYS = {
  playerRadius: 15,
  ballRadius: 10,
  postRadius: 8,
  playerAccel: 0.1, // girdi başına hızlanma (birim/adım²)
  playerKickAccel: 0.07, // şut tuşu basılıyken biraz yavaşlar (HaxBall gibi)
  playerDamping: 0.96, // → en yüksek koşu hızı ≈ 0.1·0.96/0.04 = 2.4 birim/adım (144 birim/sn)
  ballDamping: 0.99,
  playerInvMass: 0.5,
  ballInvMass: 1,
  playerBounce: 0.5, // çarpışma katsayısı iki diskin çarpımı (oyuncu–top 0.25)
  ballBounce: 0.5,
  postBounce: 0.5,
  wallBounce: 1, // top–duvar: 0.5 · 1
  kickStrength: 5, // topa eklenen hız (birim/adım), oyuncudan topa doğru
  kickReach: 4, // diskler arası boşluk bu kadar veya azsa şut değer
  kickCooldown: 12, // adım (200 ms): basılı tutunca makineli tüfek olmasın
  maxBallSpeed: 16, // tünelleme olmasın (top+direk çapı 36)
  maxPlayerSpeed: 6,
};

// w,h: topun oynadığı alanın yarı genişlik/yükseklik; goal: kale ağzının yarısı; depth: ağ derinliği;
// outerW/outerH: oyuncuların çıkamadığı dış sınır; circle: orta yuvarlak yarıçapı.
export const PITCHES = {
  small: { id: 'small', w: 370, h: 170, goal: 64, depth: 30, outerW: 420, outerH: 200, circle: 70 },
  medium: { id: 'medium', w: 550, h: 240, goal: 85, depth: 35, outerW: 610, outerH: 275, circle: 80 },
};

// Diziliş (kırmızı için; x saha yarı genişliğine, y yarı yüksekliğe oran). Mavi aynalanır.
const FORMATIONS = [
  [],
  [[-0.5, 0]],
  [[-0.5, -0.35], [-0.5, 0.35]],
  [[-0.35, 0], [-0.65, -0.45], [-0.65, 0.45]],
  [[-0.3, -0.3], [-0.3, 0.3], [-0.7, -0.5], [-0.7, 0.5]],
  [[-0.25, 0], [-0.45, -0.5], [-0.45, 0.5], [-0.75, -0.25], [-0.75, 0.25]],
  [[-0.25, -0.3], [-0.25, 0.3], [-0.5, -0.6], [-0.5, 0], [-0.5, 0.6], [-0.8, 0]],
  [[-0.25, -0.3], [-0.25, 0.3], [-0.5, -0.6], [-0.5, 0], [-0.5, 0.6], [-0.8, -0.3], [-0.8, 0.3]],
];

export function formationSpot(pitch, team, index, count) {
  const row = FORMATIONS[Math.min(count, FORMATIONS.length - 1)] ?? FORMATIONS[1];
  const [fx, fy] = row[index % row.length] ?? [-0.5, 0];
  const sign = team === RED ? 1 : -1;
  return { x: fx * pitch.w * sign, y: fy * pitch.h };
}

// Topun çarptığı doğru parçaları (kale ağzı hariç kenarlar + ağlar). Parça uçları direk diskleri veya köşelerle kapanır.
function buildWalls(p) {
  const segs = [];
  const add = (x1, y1, x2, y2) => {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    segs.push({ x1, y1, dx, dy, len2: len * len, nx: -dy / len, ny: dx / len });
  };
  add(-p.w, -p.h, p.w, -p.h); // üst
  add(-p.w, p.h, p.w, p.h); // alt
  for (const s of [-1, 1]) {
    const x = s * p.w;
    const back = s * (p.w + p.depth);
    add(x, -p.h, x, -p.goal); // kale çizgisi üst parçası
    add(x, p.goal, x, p.h); // alt parçası
    add(x, -p.goal, back, -p.goal); // ağ üst
    add(x, p.goal, back, p.goal); // ağ alt
    add(back, -p.goal, back, p.goal); // ağ arka
  }
  return segs;
}

// players: [{ id, team }] (sıra korunur; istemciye giden kare bu sırayla).
export function createWorld(pitchId, players) {
  const pitch = PITCHES[pitchId] ?? PITCHES.small;
  const world = {
    pitch,
    walls: buildWalls(pitch),
    posts: [-1, 1].flatMap((s) => [-1, 1].map((t) => ({ x: s * pitch.w, y: t * pitch.goal }))),
    ball: { x: 0, y: 0, vx: 0, vy: 0, px: 0, py: 0, r: PHYS.ballRadius },
    players: players.map((pl) => newDisc(pl.id, pl.team)),
    kickoff: RED, // başlama vuruşunu yapan takım; top dokunulunca null
    goalsEnabled: true,
    tick: 0,
    lastTouch: -1, // topa son dokunan oyuncunun dizindeki yeri
    events: { goal: -1, kicks: 0, touched: false }, // her adımda yeniden kullanılır (ayırma yok)
  };
  resetKickoff(world, RED);
  return world;
}

function newDisc(id, team) {
  return { id, team, x: 0, y: 0, vx: 0, vy: 0, r: PHYS.playerRadius, ix: 0, iy: 0, kick: false, kickCd: 0 };
}

export function addPlayer(world, id, team) {
  const d = newDisc(id, team);
  world.players.push(d);
  return d;
}

export function removePlayer(world, id) {
  const i = world.players.findIndex((d) => d.id === id);
  if (i < 0) return false;
  world.players.splice(i, 1);
  if (world.lastTouch === i) world.lastTouch = -1;
  else if (world.lastTouch > i) world.lastTouch--;
  return true;
}

// Herkes diziliş yerine, top ortaya; `team` başlama vuruşunu yapar (diğer takım orta yuvarlağa giremez).
export function resetKickoff(world, team) {
  const { pitch } = world;
  for (const t of [RED, BLUE]) {
    const mine = world.players.filter((d) => d.team === t);
    mine.forEach((d, i) => {
      const s = formationSpot(pitch, t, i, mine.length);
      d.x = s.x; d.y = s.y; d.vx = 0; d.vy = 0; d.kickCd = 0;
    });
  }
  const b = world.ball;
  b.x = 0; b.y = 0; b.vx = 0; b.vy = 0; b.px = 0; b.py = 0;
  world.kickoff = team;
  world.goalsEnabled = true;
  world.lastTouch = -1;
}

// Girdi: x,y yön (uzunluk ≤ 1), kick boolean. Doğrulama burada da yapılır (sunucu ayrıca temizler).
export function setInput(disc, x, y, kick) {
  let ix = typeof x === 'number' && Number.isFinite(x) ? x : 0;
  let iy = typeof y === 'number' && Number.isFinite(y) ? y : 0;
  const len = Math.hypot(ix, iy);
  if (len > 1) { ix /= len; iy /= len; } // yön vektörü: uzunluk en fazla 1
  if (!Number.isFinite(ix) || !Number.isFinite(iy)) { ix = 0; iy = 0; }
  disc.ix = ix;
  disc.iy = iy;
  disc.kick = kick === true;
}

function clampSpeed(d, max) {
  const s2 = d.vx * d.vx + d.vy * d.vy;
  if (s2 > max * max) {
    const k = max / Math.sqrt(s2);
    d.vx *= k; d.vy *= k;
  }
}

// İki diskin çarpışması (HaxBall: kütle oranıyla ayrılır, normal yönde esnek itme). Dönen değer: çarpıştılar mı.
function collide(a, ia, b, ib, bounce) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const rr = a.r + b.r;
  const d2 = dx * dx + dy * dy;
  if (d2 >= rr * rr) return false;
  const sum = ia + ib;
  if (sum === 0) return false;
  let nx = 1;
  let ny = 0;
  let d = Math.sqrt(d2);
  if (d > 1e-9) { nx = dx / d; ny = dy / d; } else d = 0;
  const pen = rr - d;
  a.x += nx * pen * (ia / sum); a.y += ny * pen * (ia / sum);
  b.x -= nx * pen * (ib / sum); b.y -= ny * pen * (ib / sum);
  const rel = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
  if (rel < 0) {
    const j = -rel * (1 + bounce);
    a.vx += nx * j * (ia / sum); a.vy += ny * j * (ia / sum);
    b.vx -= nx * j * (ib / sum); b.vy -= ny * j * (ib / sum);
  }
  return true;
}

// Top–duvar: hangi tarafta olduğu adımın başındaki konumdan bilinir (hızlı top duvarın içinden geçemez).
function ballWalls(world) {
  const b = world.ball;
  const r = PHYS.ballRadius;
  const bounce = PHYS.ballBounce * PHYS.wallBounce;
  for (const s of world.walls) {
    const t = ((b.x - s.x1) * s.dx + (b.y - s.y1) * s.dy) / s.len2;
    if (t < 0 || t > 1) continue;
    const dist = (b.x - s.x1) * s.nx + (b.y - s.y1) * s.ny;
    const prev = (b.px - s.x1) * s.nx + (b.py - s.y1) * s.ny;
    const side = prev < 0 ? -1 : prev > 0 ? 1 : (dist < 0 ? -1 : 1);
    if (side * dist >= r) continue;
    const push = r - side * dist;
    b.x += s.nx * side * push;
    b.y += s.ny * side * push;
    const vn = (b.vx * s.nx + b.vy * s.ny) * side;
    if (vn < 0) {
      b.vx -= s.nx * side * vn * (1 + bounce);
      b.vy -= s.ny * side * vn * (1 + bounce);
    }
  }
}

// Başlama vuruşu kısıtı: herkes kendi yarısında; vuruşu yapmayan takım orta yuvarlağa da giremez,
// vuruşu yapan takım orta yuvarlağın içine girebilir.
function kickoffLimit(world, d) {
  const { pitch } = world;
  const r = PHYS.playerRadius;
  const side = d.team === RED ? -1 : 1; // kendi yarısının işareti
  const inHalf = d.x * side >= r;
  const dist = Math.hypot(d.x, d.y);
  if (d.team !== world.kickoff) {
    if (!inHalf) { d.x = side * r; if (d.vx * side < 0) d.vx = 0; }
    const min = pitch.circle + r;
    const dd = Math.hypot(d.x, d.y);
    if (dd < min) {
      const nx = dd > 1e-9 ? d.x / dd : side;
      const ny = dd > 1e-9 ? d.y / dd : 0;
      d.x = nx * min; d.y = ny * min;
      const vn = d.vx * nx + d.vy * ny;
      if (vn < 0) { d.vx -= nx * vn; d.vy -= ny * vn; }
    }
    return;
  }
  const inner = pitch.circle - r;
  if (inHalf || dist <= inner) return;
  // Hem yarının hem yuvarlağın dışında: en yakın izinli noktaya taşı.
  const hx = side * r;
  const hy = d.y;
  const cx = (d.x / dist) * inner;
  const cy = (d.y / dist) * inner;
  if (Math.hypot(d.x - hx, d.y - hy) <= Math.hypot(d.x - cx, d.y - cy)) {
    d.x = hx; if (d.vx * side < 0) d.vx = 0;
  } else {
    d.x = cx; d.y = cy;
    const nx = d.x / inner;
    const ny = d.y / inner;
    const vn = d.vx * nx + d.vy * ny;
    if (vn > 0) { d.vx -= nx * vn; d.vy -= ny * vn; }
  }
}

const POST = { x: 0, y: 0, vx: 0, vy: 0, r: PHYS.postRadius };

// Bir fizik adımı. Dönen nesne her adımda aynıdır: { goal: -1 | RED | BLUE (gol atan takım), kicks, touched }.
export function step(world) {
  const ev = world.events;
  ev.goal = -1; ev.kicks = 0; ev.touched = false;
  const b = world.ball;
  const P = PHYS;
  const ps = world.players;
  world.tick++;

  // 1) Şut: tuş basılı + top menzilde + bekleme bitti.
  for (let i = 0; i < ps.length; i++) {
    const d = ps[i];
    if (d.kickCd > 0) d.kickCd--;
    if (!d.kick || d.kickCd > 0) continue;
    const dx = b.x - d.x;
    const dy = b.y - d.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist - P.playerRadius - P.ballRadius > P.kickReach || dist < 1e-9) continue;
    b.vx += (dx / dist) * P.kickStrength;
    b.vy += (dy / dist) * P.kickStrength;
    d.kickCd = P.kickCooldown;
    ev.kicks++;
    ev.touched = true;
    world.lastTouch = i;
  }

  // 2) Hareket + sürtünme.
  for (let i = 0; i < ps.length; i++) {
    const d = ps[i];
    const acc = d.kick ? P.playerKickAccel : P.playerAccel;
    d.vx += d.ix * acc;
    d.vy += d.iy * acc;
    clampSpeed(d, P.maxPlayerSpeed);
    d.x += d.vx; d.y += d.vy;
    d.vx *= P.playerDamping; d.vy *= P.playerDamping;
  }
  b.px = b.x; b.py = b.y;
  clampSpeed(b, P.maxBallSpeed);
  b.x += b.vx; b.y += b.vy;
  b.vx *= P.ballDamping; b.vy *= P.ballDamping;

  // 3) Disk–disk (oyuncu–oyuncu, oyuncu–top), sonra direkler.
  for (let i = 0; i < ps.length; i++) {
    const a = ps[i];
    for (let j = i + 1; j < ps.length; j++) collide(a, P.playerInvMass, ps[j], P.playerInvMass, P.playerBounce * P.playerBounce);
    if (collide(a, P.playerInvMass, b, P.ballInvMass, P.playerBounce * P.ballBounce)) { ev.touched = true; world.lastTouch = i; }
  }
  for (const post of world.posts) {
    POST.x = post.x; POST.y = post.y; POST.vx = 0; POST.vy = 0;
    collide(b, P.ballInvMass, POST, 0, P.ballBounce * P.postBounce);
    for (let i = 0; i < ps.length; i++) { POST.x = post.x; POST.y = post.y; collide(ps[i], P.playerInvMass, POST, 0, P.playerBounce * P.postBounce); }
  }

  // 4) Top duvarlardan seker; oyuncular dış sınırda kalır (+ başlama vuruşu kısıtı).
  ballWalls(world);
  const { pitch } = world;
  const r = P.playerRadius;
  if (ev.touched) world.kickoff = null;
  for (let i = 0; i < ps.length; i++) {
    const d = ps[i];
    if (world.kickoff != null) kickoffLimit(world, d);
    const mx = pitch.outerW - r;
    const my = pitch.outerH - r;
    if (d.x < -mx) { d.x = -mx; if (d.vx < 0) d.vx = 0; } else if (d.x > mx) { d.x = mx; if (d.vx > 0) d.vx = 0; }
    if (d.y < -my) { d.y = -my; if (d.vy < 0) d.vy = 0; } else if (d.y > my) { d.y = my; if (d.vy > 0) d.vy = 0; }
  }
  // Güvenlik ağı: sayısal bir hata topu sahadan dışarı atamasın.
  const lim = pitch.w + pitch.depth;
  if (!(Math.abs(b.x) <= lim) || !(Math.abs(b.y) <= pitch.h)) {
    if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) { b.x = 0; b.y = 0; b.vx = 0; b.vy = 0; }
    b.x = Math.max(-lim, Math.min(lim, b.x));
    b.y = Math.max(-pitch.h, Math.min(pitch.h, b.y));
  }

  // 5) Gol: top kale çizgisini TAMAMEN geçince (direğe çarpan veya çizgide duran top gol değil).
  if (world.goalsEnabled) {
    if (b.x - P.ballRadius > pitch.w && Math.abs(b.y) < pitch.goal) ev.goal = RED;
    else if (b.x + P.ballRadius < -pitch.w && Math.abs(b.y) < pitch.goal) ev.goal = BLUE;
  }
  return ev;
}

// Durumun kısa özeti (testlerde determinizm karşılaştırması için).
export function snapshot(world) {
  const round = (v) => Math.round(v * 1e6) / 1e6;
  return {
    tick: world.tick,
    ball: [round(world.ball.x), round(world.ball.y), round(world.ball.vx), round(world.ball.vy)],
    players: world.players.map((d) => [d.id, round(d.x), round(d.y), round(d.vx), round(d.vy)]),
    kickoff: world.kickoff,
  };
}
