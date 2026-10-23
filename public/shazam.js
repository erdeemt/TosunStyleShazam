// Tosun Style Shazam — istemci tarafı oyun mantığı.
import { mountLobby } from './lobby.js';
import { net } from './net.js';
// Online bölüm ui.js'in el()'ini kullanır (false/null nitelikleri atlar, dizileri açar); eski bölümler yerel el()'i.
import { countdown, el as uiEl } from './ui.js';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n) => String(Math.round(n * 100) / 100);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}

async function api(path) {
  const res = await fetch(path);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? 'Sunucu hatası');
  return json;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Tarayıcı depolaması sadece kolaylık için (oyuncular, linkler, ayarlar hatırlansın).
const store = {
  load(key, fallback) {
    try { return JSON.parse(localStorage.getItem(`tss:${key}`)) ?? fallback; } catch { return fallback; }
  },
  save(key, value) {
    try { localStorage.setItem(`tss:${key}`, JSON.stringify(value)); } catch { /* yok say */ }
  },
};

// ======================================================================
// Tahmin kontrolü
// ======================================================================

const TR_MAP = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', â: 'a', î: 'i', û: 'u' };

function norm(s) {
  return (s ?? '')
    .toLocaleLowerCase('tr')
    .replace(/[çğıöşüâîû]/g, (c) => TR_MAP[c])
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s[-–—]\s.*\b(remaster\w*|version|edit|mix|live|mono|stereo|from|radio|acoustic|akustik|featured|soundtrack|ost|theme)\b.*$/, '')
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/\b(feat|ft|featuring)\b.*$/, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N} ]/gu, ' ') // Türkçe katlandıktan sonra her dildeki harfler kalır
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

function answerCandidates(track) {
  const raw = [track.title, ...(track.alt ?? [])];
  const out = new Set();
  for (const r of raw) {
    const n = norm(r);
    if (n) { out.add(n); out.add(n.replace(/^the /, '')); }
  }
  return [...out].filter(Boolean);
}

function isCorrect(guess, track) {
  const g = norm(guess);
  if (!g) return false;
  const gCompact = g.replace(/ /g, '');
  const artistLen = norm(track.artist ?? '').length;
  for (const c of answerCandidates(track)) {
    if (g === c || gCompact === c.replace(/ /g, '')) return true;
    // Ufak yazım hataları: kısa isimlerde tam eşleşme, 6+ harfte 1, 9+ harfte 2 hata, uzunlarda ~%20.
    const maxEdits = Math.max(c.length >= 9 ? 2 : c.length >= 6 ? 1 : 0, Math.floor(c.length * 0.2));
    if (maxEdits && levenshtein(g, c) <= maxEdits) return true;
    // "tarkan şımarık" gibi sanatçı + şarkı yazılmışsa
    if (c.length >= 3 && ` ${g} `.includes(` ${c} `) && g.length <= c.length + artistLen + 3) return true;
    // Uzun isimlerin büyük kısmı yazılmışsa ("bohemian rhapsody" yerine "bohemian rhaps")
    if (g.length >= 6 && c.startsWith(g) && g.length >= c.length * 0.6) return true;
  }
  return false;
}

// ======================================================================
// YouTube oynatıcı
// ======================================================================

const YT_ERRORS = {
  2: 'geçersiz video', 5: 'oynatılamıyor', 100: 'video bulunamadı',
  101: 'sahibi gömmeye izin vermiyor', 150: 'sahibi gömmeye izin vermiyor',
};

const yt = {
  player: null,
  listener: null,
  ready: null,

  init() {
    this.ready = new Promise((resolve) => {
      const create = () => {
        this.player = new YT.Player('yt-player', {
          width: '100%',
          height: '100%',
          playerVars: { controls: 0, disablekb: 1, rel: 0, playsinline: 1, iv_load_policy: 3, fs: 0 },
          events: {
            onReady: () => resolve(),
            onStateChange: (e) => this.listener?.({ type: 'state', data: e.data }),
            onError: (e) => this.listener?.({ type: 'error', data: e.data }),
          },
        });
      };
      if (window.YT?.loaded) create();
      else {
        const prev = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = () => { prev?.(); create(); };
      }
    });
  },

  // Bir oynatıcı durumunu bekler; hata gelirse veya süre dolarsa reddeder.
  waitFor(match, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.listener = null; reject(new Error('YouTube yanıt vermedi')); }, timeout);
      this.listener = (ev) => {
        if (ev.type === 'error') {
          clearTimeout(timer); this.listener = null;
          reject(new Error(YT_ERRORS[ev.data] ?? `YouTube hatası ${ev.data}`));
        } else if (match(ev.data)) {
          clearTimeout(timer); this.listener = null; resolve();
        }
      };
    });
  },

  async playlistIds(listId) {
    await withTimeout(this.ready, 10000, 'YouTube oynatıcısı yüklenemedi');
    let failed = null;
    this.listener = (ev) => { if (ev.type === 'error') failed = ev.data; };
    this.player.cuePlaylist({ listType: 'playlist', list: listId });
    let ids = null;
    for (let i = 0; i < 50 && !ids?.length && failed == null; i++) {
      await sleep(300);
      ids = this.player.getPlaylist();
    }
    this.listener = null;
    this.player.stopVideo();
    if (!ids?.length) throw new Error('Playlist boş, gizli veya bulunamadı');
    return ids;
  },

  // Videoyu sessizce yükleyip tamponlar, sonra durdurur. Süreyi döner.
  async prepare(videoId) {
    await withTimeout(this.ready, 10000, 'YouTube oynatıcısı yüklenemedi');
    this.player.mute();
    const playing = this.waitFor((s) => s === YT.PlayerState.PLAYING);
    this.player.loadVideoById({ videoId });
    await playing;
    this.player.pauseVideo();
    await sleep(50);
    return this.player.getDuration();
  },
};

function withTimeout(promise, ms, msg) {
  return Promise.race([promise, sleep(ms).then(() => { throw new Error(msg); })]);
}

// ======================================================================
// Ortak medya katmanı (30 sn önizleme sesi veya YouTube)
// ======================================================================

const media = {
  kind: null, // 'audio' | 'youtube'
  audio: new Audio(),
  stopTimer: null,
  raf: null,
  playing: false,

  async prepare(track) {
    this.stop();
    if (track.ytId) {
      this.kind = 'youtube';
      return yt.prepare(track.ytId);
    }
    if (!track.audio) {
      // Spotify önizlemesi yoksa Deezer'da ara.
      const { track: dz } = await api(`/api/deezer-search?q=${encodeURIComponent(`${track.artist} ${track.title}`)}`);
      if (!dz?.audio) throw new Error('önizleme bulunamadı');
      track.audio = dz.audio;
      track.cover ??= dz.cover;
    }
    this.kind = 'audio';
    const a = this.audio;
    a.src = track.audio;
    a.preload = 'auto';
    a.load();
    await new Promise((resolve, reject) => {
      const done = (fn, arg) => {
        clearTimeout(timer);
        a.removeEventListener('canplaythrough', ok);
        a.removeEventListener('error', bad);
        fn(arg);
      };
      const ok = () => done(resolve);
      const bad = () => done(reject, new Error('ses yüklenemedi'));
      // iOS kullanıcı dokunmadan ön yükleme yapmayabilir; hata yoksa yine de dene.
      const timer = setTimeout(ok, 8000);
      a.addEventListener('canplaythrough', ok);
      a.addEventListener('error', bad);
    });
    return a.duration;
  },

  // Ses seviyesi (0–1), tarayıcıda hatırlanır. iOS donanım tuşlarını kullanır, bunu yok sayar.
  volume: store.load('volume', 0.6),

  setVolume(v) {
    this.volume = Math.min(1, Math.max(0, Number(v) || 0));
    store.save('volume', this.volume);
    this.audio.volume = this.volume;
    if (this.kind === 'youtube') yt.player?.setVolume(Math.round(this.volume * 100));
  },

  // start'tan itibaren dur saniye çalar, onProgress(geçen sn) ile ilerleme bildirir.
  // Süre duvar saatiyle DEĞİL medyanın kendi saatiyle ölçülür: Mac/Safari ve Bluetooth kulaklıkta play()
  // döndükten sonra sesin gerçekten başlaması yüzlerce ms sürebiliyor; duvar saatiyle 0.5 sn'lik klip hiç duyulmuyordu.
  async playClip(start, dur, onProgress) {
    this.stop();
    const token = this.clipToken;
    let clock;
    if (this.kind === 'youtube') {
      const p = yt.player;
      p.seekTo(start, true);
      p.unMute();
      p.setVolume(Math.round(this.volume * 100));
      const playing = yt.waitFor((st) => st === YT.PlayerState.PLAYING, 10000);
      p.playVideo();
      await playing;
      clock = () => p.getCurrentTime();
    } else {
      this.audio.volume = this.volume;
      this.audio.currentTime = start;
      await this.audio.play();
      clock = () => this.audio.currentTime;
    }
    if (token !== this.clipToken) return; // bu arada durduruldu
    this.playing = true;
    const base = clock(); // çalma başladığı andaki konum; ilerleme buna göre ölçülür
    return new Promise((resolve) => {
      const finish = () => {
        cancelAnimationFrame(this.raf);
        clearTimeout(this.stopTimer);
        this.pause();
        this.playing = false;
        onProgress(dur);
        resolve();
      };
      this.clipResolve = resolve; // stop() çağrılırsa bekleyen söz askıda kalmasın
      // Güvenlik ağı: medya saati hiç ilerlemezse (takılma) en geç bu kadar sonra dur.
      this.stopTimer = setTimeout(finish, dur * 1000 + 3000);
      const tick = () => {
        if (token !== this.clipToken) return;
        const elapsed = Math.max(0, clock() - base);
        onProgress(Math.min(elapsed, dur));
        if (elapsed >= dur || (this.kind === 'audio' && this.audio.ended)) return finish(); // önizleme kısa olabilir
        this.raf = requestAnimationFrame(tick);
      };
      tick();
    });
  },

  playFrom(start) {
    this.stop();
    if (this.kind === 'youtube') {
      yt.player.seekTo(start, true);
      yt.player.unMute();
      yt.player.setVolume(Math.round(this.volume * 100));
      yt.player.playVideo();
    } else {
      this.audio.volume = this.volume;
      this.audio.currentTime = start;
      this.audio.play().catch(() => {});
    }
  },

  isPaused() {
    if (this.kind === 'youtube') return yt.player?.getPlayerState() !== YT.PlayerState.PLAYING;
    return this.audio.paused;
  },

  pause() {
    if (this.kind === 'youtube') yt.player?.pauseVideo();
    else this.audio.pause();
  },

  resume() {
    if (this.kind === 'youtube') yt.player?.playVideo();
    else this.audio.play().catch(() => {});
  },

  clipToken: 0,
  clipResolve: null,

  stop() {
    clearTimeout(this.stopTimer);
    cancelAnimationFrame(this.raf);
    this.clipToken++;
    this.clipResolve?.();
    this.clipResolve = null;
    this.playing = false;
    if (this.kind) this.pause();
  },
};

// ======================================================================
// Kurulum ekranı
// ======================================================================

const state = {
  players: store.load('players', []),
  category: 'single', // 'single' | 'multi' — menüden gelir
  mode: 'free', // single: 'free' | 'solo', multi: 'contest' (| 'online' ileride)
  sources: [], // { url, src, name, tracks, loading, error }
  game: null,
};

const STAGES = [0.5, 1.5, 5, 10, 20]; // melodicx ile aynı

function sourceKind(url) {
  if (/spotify/i.test(url)) return 'spotify';
  if (/deezer/i.test(url)) return 'deezer';
  if (/youtu/i.test(url)) return 'youtube';
  return '?';
}

function renderPlayers() {
  const list = $('player-list');
  list.replaceChildren(...state.players.map((name, i) =>
    el('li', {}, name, el('button', {
      title: 'Kaldır',
      onclick: () => { state.players.splice(i, 1); store.save('players', state.players); renderPlayers(); },
    }, '×'))));
}

// Aynı şarkı farklı kaynaklarda/albümlerde farklı ID ile gelebilir: ad + ilk sanatçı ile eşleştir.
// Sanatçısı bilinmeyen şarkılar birleştirilmez (aynı adlı farklı şarkılar karışmasın).
function trackKey(t) {
  const artist = norm((t.artist ?? '').split(/,|&|\s+(?:feat\.?|ft\.?|x|ve|and|with)\s+/i)[0]);
  const title = norm(t.title);
  return artist && title ? `${title.replace(/ /g, '')}|${artist.replace(/ /g, '')}` : t.id ?? `src:${t.ytId ?? t.audio ?? t.title}`;
}

function allTracks() {
  const seen = new Set();
  const out = [];
  for (const s of state.sources) {
    for (const t of s.tracks ?? []) {
      const key = trackKey(t);
      if (!seen.has(t.id) && !seen.has(key)) out.push(t);
      seen.add(t.id);
      seen.add(key);
    }
  }
  return out;
}

function renderSources() {
  $('source-list').replaceChildren(...state.sources.map((s, i) => {
    const kind = sourceKind(s.url);
    const count = s.loading ? 'yükleniyor…' : s.error ? `⚠️ ${s.error}` : `${s.tracks.length} şarkı`;
    return el('li', {},
      el('span', { class: `badge ${kind}` }, kind),
      el('span', { class: 'src-name', title: s.url }, s.name ?? s.url),
      el('span', { class: 'src-count' }, count),
      el('button', {
        title: 'Kaldır',
        onclick: () => { state.sources.splice(i, 1); saveSources(); renderSources(); },
      }, '×'));
  }));
  const total = allTracks().length;
  const dupes = state.sources.reduce((n, s) => n + (s.tracks?.length ?? 0), 0) - total;
  const loading = state.sources.some((s) => s.loading);
  $('track-total').textContent = !total ? 'Henüz şarkı yok.'
    : `Toplam ${total} şarkı.${dupes > 0 ? ` (${dupes} tekrar eden şarkı bir kez sayıldı)` : ''}`;
  $('start-btn').disabled = !total || loading;
}

function saveSources() {
  store.save('sources', state.sources.filter((s) => !s.error).map((s) => s.url));
}

async function loadSource(source) {
  try {
    const res = await api(`/api/resolve?url=${encodeURIComponent(source.url)}`);
    if (res.youtubePlaylist) {
      const ids = await yt.playlistIds(res.youtubePlaylist);
      source.name = res.name ?? 'YouTube playlist';
      source.tracks = [];
      for (let i = 0; i < ids.length; i += 50) {
        const { tracks } = await api(`/api/yt-meta?ids=${ids.slice(i, i + 50).join(',')}`);
        source.tracks.push(...tracks);
        renderSources();
      }
    } else {
      source.name = res.name;
      source.tracks = res.tracks;
    }
    if (!source.tracks.length) throw new Error('şarkı bulunamadı');
  } catch (err) {
    source.error = err.message;
    source.tracks = [];
  } finally {
    source.loading = false;
    renderSources();
  }
}

async function addSources(urls) {
  const fresh = urls
    .map((u) => u.trim())
    .filter((u) => u && !state.sources.some((s) => s.url === u))
    .map((url) => ({ url, name: null, tracks: [], loading: true }));
  if (!fresh.length) return;
  state.sources.push(...fresh);
  renderSources();
  // Sırayla: YouTube playlistleri tek oynatıcıyı paylaşıyor.
  for (const s of fresh) await loadSource(s);
  saveSources();
}

function readSettings() {
  const settings = {
    perPlayer: Math.max(1, Math.min(50, Number($('set-per-player').value) || 5)),
    start: $('set-start').value,
  };
  store.save('settings', settings);
  return settings;
}

function restoreSettings() {
  const s = store.load('settings', null);
  if (!s) return;
  if (s.perPlayer) $('set-per-player').value = s.perPlayer;
  if (s.start) $('set-start').value = s.start;
}

// ======================================================================
// Oyun
// ======================================================================

function show(screen) {
  // Sadece Shazam'ın kendi ekranları (online lobinin iç .screen'i değil)
  for (const s of document.querySelectorAll('#game-shazam > main.screen')) s.classList.toggle('active', s.id === `screen-${screen}`);
  window.scrollTo(0, 0);
}

function startGame() {
  const settings = readSettings();
  const tracks = allTracks();
  const mode = state.mode;
  const names = mode === 'free' ? []
    : mode === 'solo' ? ['Sen']
    : state.players.length ? state.players : ['Oyuncu'];
  const n = names.length;
  let total = Infinity; // serbest mod bitmez
  if (mode !== 'free') {
    total = Math.min(settings.perPlayer * n, tracks.length);
    if (total >= n) total -= total % n; // herkes eşit sayıda şarkı alsın
  }
  state.game = {
    ...settings,
    stages: STAGES,
    mode,
    players: names.map((name) => ({ name, score: 0 })),
    queue: shuffle(tracks),
    round: 0,
    total,
    current: null,
  };
  buildSuggestionPool(tracks);
  $('quit-btn').textContent = mode === 'free' ? 'Ayarlara dön' : 'Oyunu bitir';
  show('game');
  nextRound();
}

// ---------- Kategoriye göre modlar (menüden: Tek Oyunculu / Çok Oyunculu) ----------

const MODES = {
  single: [
    { id: 'free', icon: '🎧', name: 'Serbest', desc: 'Puan yok — dinle, tahmin et, geç', start: 'Serbest dinlemeye başla' },
    { id: 'solo', icon: '🎯', name: 'Puanlı', desc: 'Tek kişilik skor, ne kadar erken o kadar puan', start: 'Oyunu başlat' },
  ],
  multi: [
    { id: 'contest', icon: '🏆', name: 'Yarışma', desc: 'Tek ekran, sırayla tahmin, skor tablosu', start: 'Yarışmayı başlat' },
    { id: 'online', icon: '🌐', name: 'Online', desc: 'Oda kur, herkes kendi telefonundan', start: '' },
  ],
};

function setMode(mode) {
  const info = MODES[state.category].find((m) => m.id === mode);
  if (!info || info.disabled) return;
  state.mode = mode;
  store.save(`mode:${state.category}`, mode);
  document.body.dataset.mode = mode;
  for (const card of document.querySelectorAll('.mode-card')) card.classList.toggle('selected', card.dataset.mode === mode);
  $('start-btn').textContent = info.start;
  $('per-player-label').textContent = mode === 'solo' ? 'Şarkı sayısı' : 'Kişi başı şarkı';
  if (mode === 'online') mountOnline(); else unmountOnline();
}

function renderModes() {
  $('mode-pick').replaceChildren(...MODES[state.category].map((m) =>
    el('button', {
      type: 'button',
      class: `mode-card${m.disabled ? ' disabled' : ''}`,
      'data-mode': m.id,
      ...(m.disabled ? { disabled: '' } : {}),
      onclick: () => setMode(m.id),
    }, el('span', { class: 'mode-icon' }, m.icon), el('b', {}, m.name), el('small', {}, m.desc))));
}

function stopGame() {
  media.stop();
  hideReveal();
  state.game = null;
}

// Kabuk (shell.js) bu oyunu bir kategoriden açınca çağırır.
export function enter(category) {
  stopGame();
  state.category = MODES[category] ? category : 'single';
  renderModes();
  const saved = store.load(`mode:${state.category}`, null);
  const fallback = MODES[state.category].find((m) => !m.disabled).id;
  show('setup'); // önce: setMode('online') lobi ekranını çizer, show onu kapatmasın
  // Bir Shazam odasındaysa (ör. davet linkiyle gelindi) doğrudan online moda geç.
  const inShazamRoom = state.category === 'multi' && net.room?.game === 'shazam';
  setMode(inShazamRoom ? 'online' : MODES[state.category].some((m) => m.id === saved && !m.disabled) ? saved : fallback);
}

// Başka bir sayfaya geçince sesi kes, oyunu kapat.
export function leave() {
  stopGame();
  unmountOnline();
}

// ---------- Serbest mod ----------

function renderFree() {
  const g = state.game;
  const r = g.current;
  $('round-label').textContent = `Şarkı ${g.round + 1}`;
  $('stage-chips').replaceChildren(...g.stages.map((s, i) =>
    el('button', {
      type: 'button',
      class: `btn ghost${i === r.stage ? ' active' : ''}`,
      onclick: () => playStage(i),
    }, `${fmt(s)} sn`)));
  $('guesses').replaceChildren(...r.guesses.map((guess) =>
    el('li', { class: guess.type }, `${guess.type === 'right' ? '✓' : '✗'} ${guess.text}`)));
  $('free-controls').classList.toggle('hidden', r.done);
  $('free-next-btn').classList.toggle('hidden', r.done);
  $('guess-form').classList.toggle('hidden', r.done);
  $('guess-input').value = '';
  renderStagebar();
}

// Serbest modda tahmin: puan yok; yanlışsa süre bir adım uzar (son adımda kalır).
function submitFreeGuess(text) {
  const g = state.game;
  const r = g.current;
  media.stop();
  if (isCorrect(text, r.track)) {
    r.guesses.push({ type: 'right', text });
    r.won = true;
    return revealFree();
  }
  r.guesses.push({ type: 'wrong', text });
  toast('Yanlış!');
  if (r.stage < g.stages.length - 1) r.stage++;
  renderFree();
  setPlayState('ready');
  $('guess-input').focus();
}

// Serbest modda herhangi bir süreyi istediğin sırayla çal.
function playStage(i) {
  const r = state.game?.current;
  if (!r?.track || r.done) return;
  media.stop();
  r.stage = i;
  renderFree();
  playCurrentClip();
}

function revealFree() {
  const r = state.game?.current;
  if (!r?.track || r.done) return;
  r.done = true;
  renderFree();
  showReveal();
}

function currentPlayer() {
  const g = state.game;
  return g.players[g.round % g.players.length];
}

function pickStart(duration) {
  const g = state.game;
  const maxStage = g.stages[g.stages.length - 1];
  if (g.start === 'begin' || !Number.isFinite(duration) || duration <= maxStage + 1) return 0;
  if (media.kind === 'audio') {
    // 30 sn önizleme zaten şarkının ortasından; içinde rastgele bir yer seç.
    return Math.random() * (duration - maxStage - 0.5);
  }
  // YouTube: intro/outro'dan kaçın, %15–%65 aralığı.
  const lo = duration * 0.15;
  const hi = Math.max(lo, duration * 0.65 - maxStage);
  return lo + Math.random() * (hi - lo);
}

async function nextRound() {
  const g = state.game;
  media.stop();
  hideReveal();
  if (g.mode === 'free') {
    if (!g.queue.length) {
      g.queue = shuffle(allTracks());
      toast('Liste bitti, yeniden karıştırıldı.');
    }
  } else if (g.round >= g.total) return endGame();

  const round = { track: null, stage: 0, guesses: [], done: false, start: 0 };
  g.current = round;
  renderRound();
  setPlayState('loading');

  while (g.queue.length) {
    const track = g.queue.shift();
    try {
      const duration = await media.prepare(track);
      if (state.game !== g || g.current !== round) return; // bu arada oyun bitti
      round.track = track;
      round.start = pickStart(duration);
      if (media.kind === 'youtube') yt.player.seekTo(round.start, true);
      setPlayState('ready');
      $('guess-input').focus();
      return;
    } catch (err) {
      if (state.game !== g) return;
      toast(`Atlandı: ${track.title} — ${err.message}`);
    }
  }
  toast('Çalınabilecek şarkı kalmadı.');
  endGame();
}

function setPlayState(mode) {
  const btn = $('play-btn');
  const label = $('play-label');
  const r = state.game?.current;
  btn.classList.toggle('playing', mode === 'playing');
  btn.disabled = mode !== 'ready';
  if (mode === 'loading') label.textContent = 'Şarkı yükleniyor…';
  else if (mode === 'playing') label.textContent = 'Dinle…';
  else if (r) label.textContent = `${fmt(state.game.stages[r.stage])} sn dinle`;
}

function renderStagebar() {
  const g = state.game;
  const stages = g.stages;
  const max = stages[stages.length - 1];
  $('stagebar-unlocked').style.width = `${(stages[Math.min(g.current.stage, stages.length - 1)] / max) * 100}%`;
  $('stagebar-progress').style.width = '0';
  $('stagebar-ticks').replaceChildren(...stages.slice(0, -1).map((s) => {
    const tick = el('i');
    tick.style.left = `${(s / max) * 100}%`;
    return tick;
  }));
  $('stagebar-max').textContent = `${fmt(max)} sn`;
}

function renderRound() {
  const g = state.game;
  if (g.mode === 'free') return renderFree();
  const r = g.current;
  const stages = g.stages;

  $('round-label').textContent = `Tur ${g.round + 1} / ${g.total}`;
  $('turn-name').textContent = currentPlayer().name;
  $('mini-scores').replaceChildren(...g.players.map((p) =>
    el('li', { class: p === currentPlayer() ? 'current' : '' }, p.name, el('b', {}, String(p.score)))));

  $('guesses').replaceChildren(...stages.map((_, i) => {
    const guess = r.guesses[i];
    if (!guess) return el('li', { class: i === r.stage && !r.done ? 'active' : '' });
    if (guess.type === 'skip') return el('li', { class: 'skip' }, `⏭ Geçildi (${fmt(stages[i])} sn)`);
    if (guess.type === 'right') return el('li', { class: 'right' }, `✓ ${guess.text}`);
    return el('li', { class: 'wrong' },
      `✗ ${guess.text}`,
      r.done && !r.won
        ? el('button', { class: 'btn ghost', style: 'margin-left:auto;padding:4px 10px', onclick: () => acceptGuess(i) }, 'Doğru say')
        : null);
  }));

  renderStagebar();

  const last = r.stage >= stages.length - 1;
  $('skip-btn').textContent = last ? 'Pes et' : `Geç (+${fmt(stages[r.stage + 1] - stages[r.stage])} sn)`;
  $('guess-form').classList.toggle('hidden', r.done);
  $('guess-input').value = '';
}

async function playCurrentClip() {
  const g = state.game;
  const r = g?.current;
  if (!r?.track || r.done || media.playing) return;
  const max = g.stages[g.stages.length - 1];
  setPlayState('playing');
  try {
    await media.playClip(r.start, g.stages[r.stage], (t) => {
      $('stagebar-progress').style.width = `${(t / max) * 100}%`;
    });
  } catch (err) {
    toast(`Çalınamadı: ${err.message}`);
  }
  if (g.current !== r || r.done) return;
  setPlayState('ready');
  setTimeout(() => { if (!media.playing) $('stagebar-progress').style.width = '0'; }, 600);
  $('guess-input').focus();
}

function advanceStage() {
  const g = state.game;
  const r = g.current;
  r.stage++;
  if (r.stage >= g.stages.length) return finishRound(false);
  renderRound();
  setPlayState('ready');
}

function submitGuess(text) {
  const r = state.game?.current;
  if (!r?.track || r.done) return;
  if (!text.trim()) return playCurrentClip(); // boş Enter = çal
  if (state.game.mode === 'free') return submitFreeGuess(text);
  media.stop();
  if (isCorrect(text, r.track)) {
    r.guesses[r.stage] = { type: 'right', text };
    finishRound(true);
  } else {
    r.guesses[r.stage] = { type: 'wrong', text };
    toast('Yanlış!');
    advanceStage();
  }
}

function skipStage() {
  const r = state.game?.current;
  if (!r?.track || r.done) return;
  media.stop();
  r.guesses[r.stage] = { type: 'skip' };
  advanceStage();
}

function pointsFor(stageIndex) {
  return state.game.stages.length - stageIndex;
}

function finishRound(won, stageIndex = state.game.current.stage) {
  const g = state.game;
  const r = g.current;
  r.done = true;
  r.won = won;
  r.points = won ? pointsFor(stageIndex) : 0;
  currentPlayer().score += r.points;
  renderRound();
  showReveal();
}

// Sistem doğru cevabı reddettiyse sunucu elle kabul edebilir.
function acceptGuess(i) {
  const r = state.game.current;
  if (r.won) return;
  r.guesses[i].type = 'right';
  r.won = true;
  r.points = pointsFor(i);
  currentPlayer().score += r.points;
  renderRound();
  renderResult();
}

function renderResult() {
  const r = state.game.current;
  const msg = $('result-msg');
  msg.className = `result-msg ${r.won ? 'good' : 'bad'}`;
  if (state.game.mode === 'free') {
    msg.textContent = r.won ? '🎉 Bildin!' : '';
    return;
  }
  const who = state.game.mode === 'solo' ? '' : `${currentPlayer().name} `;
  msg.textContent = r.won ? `🎉 ${who}+${r.points} puan!` : '😬 Bilemedin';
}

function showReveal() {
  const r = state.game.current;
  const t = r.track;
  setPlayState('done');
  $('play-label').textContent = '';
  $('play-btn').disabled = true;
  $('reveal').classList.remove('hidden');
  renderResult();
  $('reveal-title').textContent = t.title;
  $('reveal-artist').textContent = t.artist ?? '';
  $('pause-btn').textContent = '⏸ Durdur';

  const cover = $('reveal-cover');
  const slot = $('yt-slot');
  if (media.kind === 'youtube') {
    cover.removeAttribute('src');
    slot.classList.add('on');
    placeYoutube();
  } else {
    slot.classList.remove('on');
    cover.src = t.cover ?? '';
    if (!t.cover && t.spotifyId) {
      api(`/api/spotify-cover?id=${t.spotifyId}`)
        .then(({ cover: c }) => { t.cover = c; if (state.game?.current === r) cover.src = c ?? ''; })
        .catch(() => {});
    }
  }
  media.playFrom(r.start);
  $('next-btn').focus();
}

function placeYoutube() {
  const wrap = $('yt-wrap');
  const slot = $('yt-slot');
  if (!slot.classList.contains('on') || $('reveal').classList.contains('hidden')) {
    wrap.classList.add('masked');
    wrap.removeAttribute('style');
    return;
  }
  const rect = slot.getBoundingClientRect();
  wrap.classList.remove('masked');
  Object.assign(wrap.style, {
    left: `${rect.left + window.scrollX}px`,
    top: `${rect.top + window.scrollY}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  });
}

function hideReveal() {
  $('reveal').classList.add('hidden');
  $('yt-slot').classList.remove('on');
  placeYoutube();
}

function endGame() {
  media.stop();
  hideReveal();
  const g = state.game;
  state.game = null;
  if (!g || g.mode === 'free') return show('setup');
  const ranked = [...g.players].sort((a, b) => b.score - a.score);
  const medals = ['🥇', '🥈', '🥉'];
  $('final-scores').replaceChildren(...ranked.map((p, i) =>
    el('li', {}, el('span', {}, `${medals[i] ?? `${i + 1}.`} ${p.name}`), el('b', {}, `${p.score} puan`))));
  show('end');
}

// ======================================================================
// Tahmin önerileri (yüklenen şarkılardan anlık liste)
// ======================================================================

const ac = { pool: [], items: [], index: -1 };

function buildSuggestionPool(tracks) {
  const seen = new Set();
  ac.pool = [];
  for (const t of tracks) {
    const label = `${t.title}\u0000${t.artist ?? ''}`;
    if (seen.has(label)) continue;
    seen.add(label);
    ac.pool.push({ track: t, title: norm(t.title), all: norm(`${t.title} ${t.artist ?? ''}`) });
  }
}

function hideSuggestions() {
  ac.items = [];
  ac.index = -1;
  $('ac-list').classList.add('hidden');
  $('guess-input').setAttribute('aria-expanded', 'false');
}

function renderSuggestions() {
  const q = norm($('guess-input').value);
  if (!q) return hideSuggestions();
  // Önce adı yazılanla başlayanlar, sonra bir kelimesi başlayanlar, sonra herhangi bir yerde geçenler.
  const rank = (p) => (p.title.startsWith(q) ? 0 : ` ${p.all}`.includes(` ${q}`) ? 1 : 2);
  ac.items = ac.pool
    .filter((p) => p.all.includes(q))
    .sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title))
    .slice(0, 8);
  ac.index = Math.min(ac.index, ac.items.length - 1);
  const list = $('ac-list');
  list.replaceChildren(...ac.items.map((p, i) =>
    el('li', {
      role: 'option',
      class: i === ac.index ? 'active' : '',
      // mousedown: input odağını kaybetmeden seç
      onmousedown: (e) => { e.preventDefault(); chooseSuggestion(i); },
    },
    el('span', { class: 'ac-title' }, p.track.title),
    p.track.artist ? el('span', { class: 'ac-artist' }, p.track.artist) : null)));
  list.classList.toggle('hidden', !ac.items.length);
  $('guess-input').setAttribute('aria-expanded', String(ac.items.length > 0));
  list.children[ac.index]?.scrollIntoView({ block: 'nearest' });
}

function chooseSuggestion(i) {
  const item = ac.items[i];
  if (!item) return;
  $('guess-input').value = item.track.title;
  hideSuggestions();
  $('guess-input').focus();
}

$('guess-input').addEventListener('input', () => { ac.index = -1; renderSuggestions(); });
$('guess-input').addEventListener('blur', hideSuggestions);
$('guess-input').addEventListener('keydown', (e) => {
  if (!ac.items.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = ac.items.length;
    ac.index = e.key === 'ArrowDown' ? (ac.index + 1) % n : (ac.index - 1 + n) % n;
    renderSuggestions();
  } else if (e.key === 'Enter' && ac.index >= 0) {
    e.preventDefault(); // ilk Enter seçer, ikinci Enter tahmin eder
    chooseSuggestion(ac.index);
  } else if (e.key === 'Escape') {
    hideSuggestions();
  }
});

// ======================================================================
// Olaylar
// ======================================================================

$('player-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('player-input').value.trim();
  if (!name || state.players.includes(name)) return;
  state.players.push(name);
  store.save('players', state.players);
  $('player-input').value = '';
  renderPlayers();
});

$('source-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const urls = $('source-input').value.split(/\s+/);
  $('source-input').value = '';
  addSources(urls);
});

$('start-btn').addEventListener('click', startGame);
$('play-btn').addEventListener('click', playCurrentClip);
$('guess-form').addEventListener('submit', (e) => {
  e.preventDefault();
  hideSuggestions();
  submitGuess($('guess-input').value);
});
$('skip-btn').addEventListener('click', skipStage);
$('next-btn').addEventListener('click', () => { state.game.round++; nextRound(); });
$('pause-btn').addEventListener('click', () => {
  if (media.isPaused()) { media.resume(); $('pause-btn').textContent = '⏸ Durdur'; }
  else { media.pause(); $('pause-btn').textContent = '▶ Devam'; }
});
$('quit-btn').addEventListener('click', () => {
  if (state.game?.mode === 'free' || confirm('Oyun bitirilsin mi?')) endGame();
});
$('free-reveal-btn').addEventListener('click', revealFree);
$('free-next-btn').addEventListener('click', () => { state.game.round++; nextRound(); });
$('again-btn').addEventListener('click', startGame);
$('menu-btn').addEventListener('click', () => show('setup'));
window.addEventListener('resize', placeYoutube);

// ======================================================================
// Online mod (lobili, herkes kendi telefonundan). Kurallar: PLAN.md §4.4; mantık sunucuda (server/games/shazam.js).
// Şarkıları oda sahibi ekler (yukarıdaki kaynak motoru), ses her telefonda çalar, tahmin sunucuda kontrol edilir.
// ======================================================================

let online = null; // mountLobby tutamacı
let offRoomWatch = null;

// Shazam odasındayken mod kartları yer kaplamasın (odadan çıkınca geri gelir).
const syncModePick = () => $('mode-pick').classList.toggle('hidden', Boolean(online && net.room?.game === 'shazam'));
const ol = {
  key: null, // hazırlanan şarkının tur anahtarı
  ready: false,
  failed: false,
  start: 0,
  playing: false,
  revealedKey: null,
  draft: '',
  focus: false,
  linkDraft: '',
  syncing: false,
  coverFor: null,
  cover: null,
  countdown: null, // 3-2-1 geri sayımı (her şarkının ilk çalınışında)
  pending: null, // gönderilmiş ama cevabı gelmemiş eylem (çift dokunuş koruması)
  countedKey: null,
};

function mountOnline() {
  if (online) return;
  online = mountLobby($('shazam-online'), {
    id: 'shazam',
    name: 'Tosun Shazam',
    icon: '🎵',
    howTo: [
      'Oda sahibi Spotify / YouTube / Deezer linklerini ekler ve odaya gönderir.',
      'Her turda herkese aynı şarkı gelir; herkes kendi telefonunda 0.5 sn\'den başlayıp dinler.',
      'Yanlış tahmin veya "Geç" bir sonraki süreyi açar: 0.5 → 1.5 → 5 → 10 → 20 sn.',
      'Ne kadar erken bilirsen o kadar puan: 5, 4, 3, 2, 1. O adımda ilk bilen +1.',
      'Herkes bitince (veya süre dolunca) cevap açılır. Kulaklık önerilir. 🎧',
    ],
    renderSettings: onlineSettings,
    renderGame: onlineGame,
  });
  offRoomWatch = net.on('room', syncModePick);
  document.addEventListener('pointerdown', unlockAudio, { capture: true });
  document.addEventListener('keydown', unlockAudio, { capture: true });
  syncModePick();
}

function unmountOnline() {
  online?.unmount();
  online = null;
  offRoomWatch?.();
  offRoomWatch = null;
  syncModePick();
  ol.key = null;
  media.stop();
}

const compactTrack = (t) => ({
  title: t.title, artist: t.artist, alt: t.alt, ytId: t.ytId, audio: t.audio, cover: t.cover, spotifyId: t.spotifyId,
});

// Yüklü kaynakları odaya gönder: önce sıfırla, sonra kaynak kaynak ≤ 25 şarkılık parçalar (mesaj sınırı 8 KB).
async function syncPrep(sendPrep) {
  if (ol.syncing) return;
  ol.syncing = true;
  online?.rerender();
  try {
    sendPrep({ op: 'reset' });
    const seen = new Set();
    for (const s of state.sources) {
      const tracks = (s.tracks ?? []).filter((t) => (t.ytId || t.audio) && !seen.has(trackKey(t)));
      tracks.forEach((t) => seen.add(trackKey(t)));
      // Parçalar şarkı sayısına değil bayt boyutuna göre: sunucu 8 KB üstü mesajda bağlantıyı keser
      // (gerçek Deezer önizleme adresleri ~280 karakter → 25 şarkı ~10 KB ediyordu).
      let chunk = [];
      let size = 0;
      const flush = async () => {
        if (!chunk.length) return;
        sendPrep({ op: 'add', source: s.name ?? s.url, tracks: chunk });
        chunk = [];
        size = 0;
        await sleep(200); // hız sınırına takılmasın
      };
      for (const t of tracks.map(compactTrack)) {
        const bytes = new TextEncoder().encode(JSON.stringify(t)).length + 1;
        if (size + bytes > 6000) await flush();
        chunk.push(t);
        size += bytes;
      }
      await flush();
    }
  } finally {
    ol.syncing = false;
    online?.rerender();
  }
}

function onlineSettings(settings, { editable, change, room, sendPrep }) {
  const prep = room.prep ?? { trackCount: 0, sources: [] };
  const select = (key, options, label) => uiEl('label', {},
    label,
    uiEl('select', { disabled: !editable, onchange: (e) => change({ [key]: key === 'start' ? e.target.value : Number(e.target.value) }) },
      options.map(([v, textLabel]) => uiEl('option', { value: String(v), selected: settings[key] === v }, textLabel))));

  const summary = uiEl('p', { class: prep.trackCount ? 'hint' : 'hint warn-text' },
    prep.trackCount
      ? `🎶 Odada ${prep.trackCount} şarkı${prep.sources.length ? ` (${prep.sources.join(', ')})` : ''}.`
      : editable ? 'Henüz odada şarkı yok: link ekle ve "Odaya gönder"e bas.' : 'Oda sahibi şarkıları ekliyor…');

  let hostTools = null;
  if (editable) {
    const loading = state.sources.some((s) => s.loading);
    const local = allTracks().filter((t) => t.ytId || t.audio).length;
    const input = uiEl('textarea', {
      rows: '2',
      placeholder: 'Spotify / YouTube / Deezer linki — playlist, albüm veya tek şarkı',
      oninput: (e) => { ol.linkDraft = e.target.value; },
    });
    input.value = ol.linkDraft;
    hostTools = uiEl('div', { class: 'stack' },
      input,
      uiEl('div', { class: 'row' },
        uiEl('button', {
          class: 'btn',
          disabled: loading,
          onclick: async () => {
            const urls = ol.linkDraft.split(/\s+/).filter(Boolean);
            ol.linkDraft = '';
            const loadingDone = addSources(urls); // kaynaklar hemen listeye girer (yükleniyor…)
            online?.rerender();
            await loadingDone;
            online?.rerender();
            await syncPrep(sendPrep); // yüklenince otomatik gönder
          },
        }, loading ? 'Yükleniyor…' : 'Linkleri yükle'),
        uiEl('button', { class: 'btn primary', disabled: loading || ol.syncing || !local, onclick: () => syncPrep(sendPrep) },
          ol.syncing ? 'Gönderiliyor…' : `🔄 Odaya gönder (${local})`),
        prep.trackCount ? uiEl('button', {
          class: 'btn ghost',
          disabled: ol.syncing,
          onclick: () => { if (confirm('Odadaki şarkı listesi temizlensin mi?')) sendPrep({ op: 'reset' }); },
        }, '🗑️ Odadaki listeyi temizle') : null),
      state.sources.length
        ? uiEl('ul', { class: 'sources' }, state.sources.map((s, i) => uiEl('li', {},
          uiEl('span', { class: `badge ${sourceKind(s.url)}` }, sourceKind(s.url)),
          uiEl('span', { class: 'src-name', title: s.url }, s.name ?? s.url),
          uiEl('span', { class: 'src-count' }, s.loading ? 'yükleniyor…' : s.error ? `⚠️ ${s.error}` : `${s.tracks.length} şarkı`),
          uiEl('button', { title: 'Kaldır', onclick: () => { state.sources.splice(i, 1); saveSources(); online?.rerender(); } }, '×'))))
        : null,
      uiEl('p', { class: 'hint' }, 'Tek oyunculu modda eklediğin listeler burada da hazır. Önizlemesi olmayan Spotify şarkıları atlanır.'));
  }

  return uiEl('div', { class: 'stack' },
    summary,
    hostTools,
    uiEl('div', { class: 'settings' },
      select('rounds', [3, 5, 10, 15, 20, 30].map((n) => [n, `${n} şarkı`]), 'Şarkı sayısı'),
      select('roundSeconds', [45, 60, 90, 120, 180].map((n) => [n, `${n} saniye`]), 'Tur süresi'),
      select('start', [['random', 'Rastgele yer'], ['begin', 'Şarkının başı']], 'Başlangıç noktası')));
}

// Bu turun şarkısını sessizce yükle; herkes aynı başlangıç noktasını hesaplasın (startFraction sunucudan).
function prepareOnlineMedia(view) {
  const m = view.media;
  if (ol.key === m.key) return;
  ol.key = m.key;
  ol.ready = false;
  ol.failed = false;
  ol.playing = false;
  ol.draft = '';
  media.prepare({ ytId: m.ytId, audio: m.audio, title: '', artist: '' })
    .then((duration) => {
      if (ol.key !== m.key) return;
      const f = m.startFraction;
      let start = 0;
      if (f != null && Number.isFinite(duration)) {
        if (media.kind === 'audio') start = f * Math.max(0, duration - view.stages.at(-1) - 0.5);
        else {
          const lo = duration * 0.15;
          const hi = Math.max(lo, duration * 0.65 - view.stages.at(-1));
          start = lo + f * (hi - lo);
        }
      }
      ol.start = start;
      ol.ready = true;
      online?.rerender();
      // Butona basmadan: hazır olunca 3-2-1 geri sayım ve otomatik çalma
      const v = net.view;
      if (v?.phase === 'play' && v.me && !v.me.done && v.media?.key === m.key) playOnlineClip(v);
    })
    .catch(() => {
      if (ol.key !== m.key) return;
      ol.failed = true;
      online?.rerender();
    });
}

async function playOnlineClip(view) {
  if (!ol.ready || ol.playing || ol.countdown || !view.me) return;
  // Her şarkının ilk çalınışında 3-2-1: herkes hazırlansın, kimse "habersiz" kaçırmasın.
  if (ol.countedKey !== ol.key) {
    ol.countedKey = ol.key;
    const key = ol.key;
    for (let n = 3; n >= 1; n--) {
      ol.countdown = n;
      online?.rerender();
      await sleep(1000);
      if (ol.key !== key) { ol.countdown = null; return; } // bu arada tur değişti
    }
    ol.countdown = null;
    view = net.view; // geri sayım sırasında durum değişmiş olabilir
    if (!view?.me || view.me.done || view.phase !== 'play') { online?.rerender(); return; }
  }
  ol.playing = true;
  ol.needsTap = false;
  online?.rerender();
  const dur = view.stages[view.me.stage];
  try {
    await media.playClip(ol.start, dur, (t) => {
      const bar = document.getElementById('ol-bar-fill');
      if (bar) bar.style.width = `${(t / view.stages.at(-1)) * 100}%`;
    });
  } catch (err) {
    // Tarayıcı dokunmadan sese izin vermedi (Safari): bir kez ▶'ye basınca açılır
    ol.needsTap = err?.name === 'NotAllowedError';
    toast(ol.needsTap ? 'Ses için ▶ düğmesine bir kez dokun.' : 'Şarkı çalınamadı.');
  }
  ol.playing = false;
  online?.rerender();
}

// Tarayıcılar (özellikle Safari) dokunuş olmadan ses çalmaya izin vermez. Oyuncunun ilk dokunuşunda
// (ör. "Katıl") ses öğesini sessizce bir kez çalıp durdururuz; sonraki otomatik çalmalara izin verilir.
function silentWav() {
  const n = 800; // 0.1 sn, 8 kHz, 8-bit mono
  const bytes = new Uint8Array(44 + n);
  const dv = new DataView(bytes.buffer);
  const str4 = (o, t) => [...t].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  str4(0, 'RIFF'); dv.setUint32(4, 36 + n, true); str4(8, 'WAVE'); str4(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, 8000, true); dv.setUint32(28, 8000, true); dv.setUint16(32, 1, true); dv.setUint16(34, 8, true);
  str4(36, 'data'); dv.setUint32(40, n, true); bytes.fill(128, 44);
  return `data:audio/wav;base64,${btoa(String.fromCharCode(...bytes))}`;
}

let audioUnlocked = false;
function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  const a = media.audio;
  if (!a.paused) return; // zaten çalıyor = kilit açık; çalanı durdurma
  const hadSrc = Boolean(a.getAttribute('src'));
  if (!hadSrc) a.src = silentWav();
  a.muted = true;
  a.play().then(() => { a.pause(); a.muted = false; if (!hadSrc) a.removeAttribute('src'); }).catch(() => { a.muted = false; audioUnlocked = false; });
}

function suggestionsFor(pool, q) {
  const n = norm(q);
  if (!n) return [];
  return pool
    .map((label) => ({ label, key: norm(label) }))
    .filter((x) => x.key.includes(n))
    .sort((a, b) => Number(!a.key.startsWith(n)) - Number(!b.key.startsWith(n)))
    .slice(0, 6);
}

function onlineGame(view, ctx) {
  prepareOnlineMedia(view);
  if (view.me && ol.pending !== `${view.media.key}:${view.me.stage}:${view.me.guesses.length}`) ol.pending = null;
  const me = view.me;
  const stages = view.stages;
  const parts = [uiEl('div', { class: 'game-head' },
    uiEl('div', { class: 'round' }, view.phase === 'over' ? 'Oyun bitti' : `Şarkı ${view.round} / ${view.totalRounds}`),
    view.endsAt ? uiEl('div', { class: 'big-timer' }, '⏱️ ', countdown(view.endsAt, ctx.serverOffset)) : null)];

  if (view.phase === 'play' && me && !me.done) parts.push(playPanel(view, ctx));
  else if (view.phase === 'play' && me?.done) {
    parts.push(uiEl('section', { class: 'card center' },
      uiEl('div', { class: `result-msg ${me.won ? 'good' : 'bad'}` }, me.won ? `🎉 Bildin! +${me.points}` : '😬 Bu sefer olmadı'),
      uiEl('p', { class: 'hint' }, 'Diğerleri bitirince cevap açılacak…')));
  }

  if (view.phase === 'reveal' || view.phase === 'over') parts.push(revealPanel(view, ctx));

  // Oyuncular: puan + bu turdaki ilerleme (tahmin metinleri yok)
  const ranked = [...view.players].sort((a, b) => b.score - a.score);
  parts.push(uiEl('section', { class: 'card' },
    uiEl('h2', {}, view.phase === 'over' ? '🏆 Final skorları' : '👥 Oyuncular'),
    uiEl('ul', { class: 'player-list' }, ranked.map((p) => {
      let status = '';
      if (view.phase === 'play') status = p.done ? (p.won ? '✓ bildi' : '✗ bitirdi') : p.stage != null ? `🎧 ${stages[p.stage]} sn` : '';
      else if (p.roundPoints != null && view.phase === 'reveal') status = p.roundPoints ? `+${p.roundPoints}` : '0';
      return uiEl('li', { class: ctx.connected(p.id) ? '' : 'offline' },
        uiEl('span', { class: 'player-name' }, p.name),
        p.id === ctx.playerId ? uiEl('span', { class: 'tag' }, 'sen') : null,
        status ? uiEl('span', { class: 'tag' }, status) : null,
        uiEl('span', { class: 'score' }, `${p.score} puan`));
    }))));

  // Yazarken yeniden çizim odağı kaçırmasın
  if (ol.focus) {
    requestAnimationFrame(() => {
      const input = document.getElementById('ol-guess');
      if (input && document.activeElement !== input) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    });
  }
  return uiEl('div', { class: 'stack' }, parts);
}

// Aynı adımda ikinci kez eylem gönderme (çift dokunuş iki adım atlatmasın); sunucu da adımı kontrol eder.
function sendOnce(view, ctx, action) {
  const key = `${view.media.key}:${view.me.stage}:${view.me.guesses.length}`;
  if (ol.pending === key) return false;
  ol.pending = key;
  ctx.act({ ...action, stage: view.me.stage, round: view.round });
  return true;
}

function playPanel(view, ctx) {
  const me = view.me;
  const stages = view.stages;
  const isLast = me.stage >= stages.length - 1;
  const acList = uiEl('ul', { class: 'ol-ac', id: 'ol-ac' });
  const renderAc = () => {
    acList.replaceChildren(...suggestionsFor(ctx.shared?.pool ?? view.pool ?? [], ol.draft).map((s) =>
      uiEl('li', {}, uiEl('button', {
        type: 'button',
        onmousedown: (e) => e.preventDefault(),
        onclick: () => {
          ol.draft = s.label.split(' — ')[0];
          const input = document.getElementById('ol-guess');
          if (input) { input.value = ol.draft; input.focus(); }
          acList.replaceChildren();
        },
      }, s.label))));
  };
  const input = uiEl('input', {
    id: 'ol-guess', type: 'text', autocomplete: 'off', placeholder: 'Şarkının adı ne? (boş Enter = çal)',
    oninput: (e) => { ol.draft = e.target.value; renderAc(); },
    onfocus: () => { ol.focus = true; },
    onblur: () => { ol.focus = false; },
  });
  input.value = ol.draft;
  renderAc();

  return uiEl('section', { class: 'card game-card' },
    uiEl('ol', { class: 'guesses' }, me.guesses.map((g, i) =>
      uiEl('li', { class: g.text == null ? 'skip' : 'wrong' }, g.text == null ? `⏭ Geçildi (${stages[i]} sn)` : `✗ ${g.text}`))),
    uiEl('div', { class: 'ol-stages' }, stages.map((s, i) =>
      uiEl('span', { class: `ol-stage${i === me.stage ? ' current' : i < me.stage ? ' past' : ''}` }, `${s} sn`))),
    uiEl('div', { class: 'ol-bar' }, uiEl('i', { id: 'ol-bar-fill' })),
    uiEl('div', { class: 'play-wrap' },
      uiEl('button', {
        // Geri sayımda soluklaşmasın diye pasif değil (tıklamayı playOnlineClip yok sayar), nabız efektiyle.
        class: `play-btn${ol.playing || ol.countdown != null ? ' playing' : ''}`,
        disabled: !ol.ready || ol.playing,
        'aria-label': 'Çal',
        onclick: () => playOnlineClip(view),
      }, uiEl('span', { class: ol.countdown != null ? 'play-count' : 'play-icon' }, ol.countdown != null ? String(ol.countdown) : '▶')),
      uiEl('div', { class: 'play-label' }, ol.countdown != null ? 'Hazır ol…' : ol.needsTap && !ol.playing ? '▶ Ses için bir kez dokun' : ol.failed ? '⚠️ Şarkı yüklenemedi — tahmin edebilir veya geçebilirsin' : ol.ready ? `${stages[me.stage]} sn dinle` : 'Şarkı yükleniyor…')),
    uiEl('form', {
      class: 'guess-form',
      onsubmit: (e) => {
        e.preventDefault();
        const textValue = ol.draft.trim();
        if (!textValue) return playOnlineClip(view);
        if (!sendOnce(view, ctx, { type: 'guess', text: textValue })) return;
        ol.draft = '';
        media.stop();
      },
    },
    input,
    acList,
    uiEl('div', { class: 'row' },
      isLast ? null : uiEl('button', { type: 'button', class: 'btn ghost', onclick: () => { if (sendOnce(view, ctx, { type: 'skip' })) media.stop(); } },
        `Geç (+${fmt(stages[me.stage + 1] - stages[me.stage])} sn)`),
      uiEl('button', { type: 'submit', class: 'btn primary' }, 'Tahmin et')),
    uiEl('button', { type: 'button', class: 'btn link', onclick: () => { if (confirm('Bu şarkıyı pas geçmek istiyor musun? (0 puan)') && sendOnce(view, ctx, { type: 'giveUp' })) media.stop(); } }, '🏳️ Pes et')));
}

function revealPanel(view, ctx) {
  const r = view.reveal;
  if (!r) return null;
  // Tur açılınca şarkıyı bir kez baştan çal
  if (view.phase === 'reveal' && ol.revealedKey !== view.media.key && ol.ready) {
    ol.revealedKey = view.media.key;
    media.playFrom(ol.start);
  }
  // Kapak: Spotify playlist şarkılarında yok → sonradan çek; YouTube'da küçük resim
  let cover = r.cover ?? (r.ytId ? `https://i.ytimg.com/vi/${r.ytId}/hqdefault.jpg` : null);
  if (!cover && r.spotifyId) {
    if (ol.coverFor !== r.spotifyId) {
      ol.coverFor = r.spotifyId;
      ol.cover = null;
      api(`/api/spotify-cover?id=${r.spotifyId}`).then(({ cover: c }) => { ol.cover = c; online?.rerender(); }).catch(() => {});
    }
    cover = ol.cover;
  }
  const last = view.round >= view.totalRounds;
  return uiEl('section', { class: 'card center' },
    view.phase === 'over' ? uiEl('div', { class: 'result-msg good' }, '🏁 Oyun bitti!') : null,
    cover ? uiEl('img', { class: 'ol-cover', src: cover, alt: '' }) : null,
    view.me ? uiEl('div', { class: `result-msg ${view.me.won ? 'good' : 'bad'}` }, view.me.won ? `✓ Bildin! +${view.me.points}` : '✗ Bu sefer olmadı') : null,
    uiEl('div', { class: 'reveal-title' }, r.title),
    uiEl('div', { class: 'reveal-artist' }, r.artist ?? ''),
    view.phase === 'reveal'
      ? uiEl('div', { class: 'row center' },
        uiEl('button', { class: 'btn ghost', onclick: () => { if (media.isPaused()) media.resume(); else media.pause(); } }, '⏯ Durdur / Devam'),
        ctx.isHost
          ? uiEl('button', { class: 'btn primary', onclick: (e) => { e.currentTarget.disabled = true; media.stop(); ctx.act({ type: 'next', round: view.round }); } }, last ? 'Sonuçları göster' : 'Sonraki şarkı →')
          : uiEl('p', { class: 'hint' }, 'Sıradaki şarkı birazdan kendiliğinden başlayacak (oda sahibi beklemeden de geçirebilir).'))
      : null);
}

// ======================================================================
// Başlangıç
// ======================================================================

if (new URLSearchParams(location.search).has('debug')) Object.assign(window, { tss: { state, media, yt } });

yt.init();
$('volume-range').value = String(Math.round(media.volume * 100));
$('volume-range').addEventListener('input', (e) => media.setVolume(Number(e.target.value) / 100));
restoreSettings();
renderPlayers();
renderSources();
addSources(store.load('sources', []));
