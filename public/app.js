// Tosun Style Shazam — istemci tarafı oyun mantığı.

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
    .replace(/[^a-z0-9 ]/g, ' ')
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
  for (const c of answerCandidates(track)) {
    if (g === c || gCompact === c.replace(/ /g, '')) return true;
    // Ufak yazım hataları: kısa isimlerde tam eşleşme, 6+ harfte 1, 9+ harfte 2 hata, uzunlarda ~%20.
    const maxEdits = Math.max(c.length >= 9 ? 2 : c.length >= 6 ? 1 : 0, Math.floor(c.length * 0.2));
    if (maxEdits && levenshtein(g, c) <= maxEdits) return true;
    // "tarkan şımarık" gibi sanatçı + şarkı yazılmışsa
    if (c.length >= 3 && ` ${g} `.includes(` ${c} `)) return true;
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

  // start'tan itibaren dur saniye çalar, onProgress(geçen sn) ile ilerleme bildirir.
  async playClip(start, dur, onProgress) {
    this.stop();
    if (this.kind === 'youtube') {
      const p = yt.player;
      p.seekTo(start, true);
      p.unMute();
      p.setVolume(100);
      const playing = yt.waitFor((s) => s === YT.PlayerState.PLAYING, 10000);
      p.playVideo();
      await playing;
    } else {
      this.audio.currentTime = start;
      await this.audio.play();
    }
    this.playing = true;
    const t0 = performance.now();
    return new Promise((resolve) => {
      const finish = () => {
        cancelAnimationFrame(this.raf);
        this.pause();
        this.playing = false;
        onProgress(dur);
        resolve();
      };
      this.stopTimer = setTimeout(finish, dur * 1000);
      const tick = () => {
        onProgress(Math.min((performance.now() - t0) / 1000, dur));
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
      yt.player.playVideo();
    } else {
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

  stop() {
    clearTimeout(this.stopTimer);
    cancelAnimationFrame(this.raf);
    this.playing = false;
    if (this.kind) this.pause();
  },
};

// ======================================================================
// Kurulum ekranı
// ======================================================================

const state = {
  players: store.load('players', []),
  mode: 'contest', // 'contest' | 'free'
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
  return artist && title ? `${title.replace(/ /g, '')}|${artist.replace(/ /g, '')}` : t.id;
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
      for (let i = 0; i < ids.length; i += 100) {
        const { tracks } = await api(`/api/yt-meta?ids=${ids.slice(i, i + 100).join(',')}`);
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
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('active', s.id === `screen-${screen}`);
  window.scrollTo(0, 0);
}

function startGame() {
  const settings = readSettings();
  const tracks = allTracks();
  const mode = state.mode;
  const names = mode === 'free' ? [] : state.players.length ? state.players : ['Oyuncu'];
  const n = names.length;
  let total = Infinity; // serbest mod bitmez
  if (mode === 'contest') {
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
  $('quit-btn').textContent = mode === 'free' ? 'Ana menü' : 'Oyunu bitir';
  show('game');
  nextRound();
}

function setMode(mode) {
  state.mode = mode;
  store.save('mode', mode);
  document.body.dataset.mode = mode;
  for (const card of document.querySelectorAll('.mode-card')) card.classList.toggle('selected', card.dataset.mode === mode);
  $('start-btn').textContent = mode === 'free' ? 'Serbest dinlemeye başla' : 'Yarışmayı başlat';
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
  msg.textContent = r.won ? `🎉 ${currentPlayer().name} +${r.points} puan!` : '😬 Bilemedin';
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
for (const card of document.querySelectorAll('.mode-card')) {
  card.addEventListener('click', () => setMode(card.dataset.mode));
}
$('again-btn').addEventListener('click', startGame);
$('menu-btn').addEventListener('click', () => show('setup'));
window.addEventListener('resize', placeYoutube);

// ======================================================================
// Başlangıç
// ======================================================================

if (new URLSearchParams(location.search).has('debug')) Object.assign(window, { tss: { state, media, yt } });

yt.init();
setMode(store.load('mode', 'contest') === 'free' ? 'free' : 'contest');
restoreSettings();
renderPlayers();
renderSources();
addSources(store.load('sources', []));
