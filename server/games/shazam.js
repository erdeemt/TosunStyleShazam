// 🎵 Tosun Shazam — online (lobili) mod. Kurallar: PLAN.md §4.4.
// Herkese aynı şarkı; herkes kendi telefonunda kendi hızında 0.5 → 1.5 → 5 → 10 → 20 sn ilerler ve tahmin eder.
// Şarkı adı/sanatçı/kapak tur açıklanana kadar istemciye gitmez; tahmin sunucuda kontrol edilir.
import { randomBytes } from 'node:crypto';
import { GameError, cleanText, num, str } from '../errors.js';
import { isCorrect, trackKey } from '../matcher.js';

export const STAGES = [0.5, 1.5, 5, 10, 20];
const MAX_TRACKS = 300;
const MAX_GUESS_LENGTH = 80;
const MAX_SOURCES = 20;
const MAX_PREP_BYTES = 150_000; // oda başına şarkı verisi üst sınırı (bellek)
const DECOYS = 3; // havuzda her zaman çalınmayacak en az 3 şarkı kalsın (elemeyle cevap bulunamasın)
const REVEAL_AUTO_MS = 30_000; // host açılışta beklerse sıradaki şarkıya kendiliğinden geç

// Sadece bilinen müzik CDN'leri (host başka sunuculara istek attıramasın / oyuncuların IP'sini toplayamasın).
const AUDIO_HOSTS = [/^p\.scdn\.co$/, /^cdnt-preview\.dzcdn\.net$/, /^cdns-preview-[a-z0-9]\.dzcdn\.net$/];
const COVER_HOSTS = [/^i\.scdn\.co$/, /^image-cdn-[a-z0-9-]+\.spotifycdn\.com$/, /^i\.ytimg\.com$/, /^e-cdns-images\.dzcdn\.net$/, /^cdn-images\.dzcdn\.net$/];

function safeUrl(raw, hosts) {
  const s = str(raw);
  if (!s || s.length > 300) return null;
  try {
    const u = new URL(s);
    if (u.username || u.password || u.port) return null;
    return u.protocol === 'https:' && hosts.some((re) => re.test(u.hostname)) ? u.href : null;
  } catch {
    return null;
  }
}

const text = (v, max = 100) => cleanText(v, max);

// Host'un gönderdiği tek bir şarkıyı doğrula; geçersizse null.
function cleanTrack(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const title = text(raw.title);
  if (!title) return null;
  const ytId = /^[\w-]{6,20}$/.test(str(raw.ytId)) ? str(raw.ytId) : null;
  const audio = ytId ? null : safeUrl(raw.audio, AUDIO_HOSTS);
  if (!ytId && !audio) return null; // çalınacak bir şey yok (önizlemesi olmayan Spotify şarkısı)
  const alt = Array.isArray(raw.alt) ? raw.alt.slice(0, 2).map((a) => text(a, 100)).filter(Boolean) : [];
  return {
    title,
    artist: text(raw.artist, 60),
    alt,
    ytId,
    audio,
    cover: safeUrl(raw.cover, COVER_HOSTS),
    spotifyId: /^[A-Za-z0-9]{10,30}$/.test(str(raw.spotifyId)) ? str(raw.spotifyId) : null,
  };
}

function poolEntries(tracks) {
  const seen = new Set();
  const out = [];
  for (const t of tracks) {
    const label = t.artist ? `${t.title} — ${t.artist}` : t.title;
    if (!seen.has(label)) { seen.add(label); out.push(label); }
  }
  return out;
}

const playersIn = (state) => state.players.filter((p) => !p.left);

function startRound(state, ctx) {
  const track = state.tracks[state.roundIndex];
  state.round = {
    number: state.roundIndex + 1,
    key: randomBytes(6).toString('hex'), // istemci ses önbelleği için; şarkıyı ele vermez
    track,
    startFraction: state.settings.start === 'begin' ? null : ctx.rng.next(),
    phase: 'play',
    endsAt: ctx.setTimer(state.settings.roundSeconds * 1000),
    progress: Object.fromEntries(playersIn(state).map((p) => [p.id, { stage: 0, guesses: [], done: false, won: false, points: 0, at: null }])),
    firstAtStage: {}, // stage -> playerId (o adımda ilk bilen +1)
  };
}

function finishRound(state, ctx) {
  ctx.clearTimer();
  const r = state.round;
  for (const prog of Object.values(r.progress)) if (!prog.done) prog.done = true;
  r.phase = 'reveal';
  r.endsAt = ctx.setTimer(REVEAL_AUTO_MS); // host beklerse kendiliğinden sıradaki şarkı
}

function nextRound(state, ctx) {
  state.roundIndex++;
  if (state.roundIndex >= state.tracks.length) { state.over = true; return; }
  startRound(state, ctx);
}

function maybeFinish(state, ctx) {
  const active = playersIn(state).filter((p) => state.round.progress[p.id]);
  if (active.every((p) => state.round.progress[p.id].done)) finishRound(state, ctx);
}

export default {
  id: 'shazam',
  name: 'Tosun Shazam',
  minPlayers: 2,
  maxPlayers: 12,
  defaultSettings: { rounds: 10, roundSeconds: 90, start: 'random' },

  validateSettings(s) {
    const clamp = (v, lo, hi, def) => {
      const n = Math.round(num(v));
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
    };
    return {
      rounds: clamp(s.rounds, 3, 30, 10),
      roundSeconds: clamp(s.roundSeconds, 45, 180, 90),
      start: s.start === 'begin' ? 'begin' : 'random',
    };
  },

  // ---------- Bekleme odası: host şarkıları parça parça gönderir ----------
  initialPrep: () => ({ tracks: [], sources: [] }),

  prep(prev, data) {
    const cur = prev ?? { tracks: [], sources: [] };
    if (data.op === 'reset') return { tracks: [], sources: [] };
    if (data.op !== 'add') throw new GameError('Geçersiz hazırlık.');
    const incoming = Array.isArray(data.tracks) ? data.tracks.slice(0, 60) : [];
    const keys = new Set(cur.tracks.map(trackKey));
    const tracks = [...cur.tracks];
    let bytes = cur.bytes ?? 0;
    for (const raw of incoming) {
      if (tracks.length >= MAX_TRACKS) break;
      const t = cleanTrack(raw);
      if (!t) continue;
      const size = JSON.stringify(t).length;
      if (bytes + size > MAX_PREP_BYTES) break;
      const k = trackKey(t);
      if (keys.has(k)) continue;
      keys.add(k);
      tracks.push(t);
      bytes += size;
    }
    const sources = [...cur.sources];
    const name = text(data.source, 60);
    if (name && !sources.includes(name) && sources.length < MAX_SOURCES) sources.push(name);
    return { tracks, sources, bytes };
  },

  prepInfo: (prep) => ({ trackCount: prep?.tracks.length ?? 0, sources: prep?.sources ?? [], maxTracks: MAX_TRACKS }),

  canStart(prep) {
    if (!prep || prep.tracks.length < DECOYS + 1) return `Önce en az ${DECOYS + 1} şarkı ekle (oda sahibi).`;
    return null;
  },

  setup({ players, settings, prep, rng, ctx }) {
    // Havuzda çalınmayacak en az DECOYS şarkı kalır: son turun cevabı elemeyle bulunamasın.
    const tracks = rng.shuffle(prep.tracks).slice(0, Math.min(settings.rounds, prep.tracks.length - DECOYS));
    const state = {
      settings: { ...settings, rounds: tracks.length },
      stages: STAGES,
      tracks,
      pool: poolEntries(prep.tracks),
      players: players.map((p) => ({ id: p.id, name: p.name, score: 0, left: false })),
      roundIndex: 0,
      round: null,
      over: false,
      gameKey: randomBytes(4).toString('hex'),
    };
    startRound(state, ctx);
    return state;
  },

  action(state, playerId, action, ctx) {
    const r = state.round;
    if (action.type === 'next') {
      if (r.phase !== 'reveal') throw new GameError('Tur henüz bitmedi.');
      if (playerId !== ctx.hostId) throw new GameError('Sonraki şarkıyı oda sahibi başlatır.');
      return nextRound(state, ctx);
    }
    if (r.phase !== 'play') throw new GameError('Bu tur bitti.');
    const prog = r.progress[playerId];
    if (!prog) throw new GameError('Bu turda oynamıyorsun.');
    if (prog.done) throw new GameError('Bu şarkıyı bitirdin.');

    switch (action.type) {
      case 'guess': {
        const guess = text(action.text, MAX_GUESS_LENGTH);
        if (!guess) throw new GameError('Bir tahmin yaz.');
        if (isCorrect(guess, r.track)) {
          prog.guesses.push({ text: guess, ok: true });
          prog.done = true;
          prog.won = true;
          prog.at = ctx.now;
          const bonus = r.firstAtStage[prog.stage] ? 0 : 1;
          if (bonus) r.firstAtStage[prog.stage] = playerId;
          prog.points = STAGES.length - prog.stage + bonus;
          const p = state.players.find((x) => x.id === playerId);
          p.score += prog.points;
        } else {
          prog.guesses.push({ text: guess, ok: false });
          prog.stage++;
          if (prog.stage >= STAGES.length) { prog.done = true; prog.stage = STAGES.length - 1; }
        }
        return maybeFinish(state, ctx);
      }
      case 'skip': {
        prog.guesses.push({ text: null, ok: false });
        prog.stage++;
        if (prog.stage >= STAGES.length) { prog.done = true; prog.stage = STAGES.length - 1; }
        return maybeFinish(state, ctx);
      }
      case 'giveUp': {
        prog.done = true;
        return maybeFinish(state, ctx);
      }
      default:
        throw new GameError('Bilinmeyen eylem.');
    }
  },

  tick(state, ctx) {
    if (state.round.phase === 'play') finishRound(state, ctx);
    else if (state.round.phase === 'reveal') nextRound(state, ctx);
  },

  onPlayerLeave(state, playerId, ctx) {
    const p = state.players.find((x) => x.id === playerId);
    if (!p) return;
    p.left = true;
    if (playersIn(state).length < 1) { state.over = true; return; }
    if (state.round.phase === 'play') {
      delete state.round.progress[playerId];
      maybeFinish(state, ctx);
    }
  },

  shared: (state) => ({ key: state.gameKey, data: { pool: state.pool } }),

  isOver: (state) => state.over,

  view(state, playerId) {
    const r = state.round;
    const revealed = r.phase === 'reveal' || state.over;
    const mine = r.progress[playerId];
    return {
      gameKey: state.gameKey,
      round: r.number,
      totalRounds: state.tracks.length,
      phase: state.over ? 'over' : r.phase,
      endsAt: r.endsAt,
      stages: STAGES,
      // Çalmak için gereken en az bilgi: şarkı adı/sanatçı/kapak/Spotify kimliği YOK.
      media: { key: r.key, ytId: r.track.ytId, audio: r.track.audio, startFraction: r.startFraction },
      me: mine ? { stage: mine.stage, guesses: mine.guesses, done: mine.done, won: mine.won, points: mine.points } : null,
      players: playersIn(state).map((p) => {
        const prog = r.progress[p.id];
        return {
          id: p.id,
          name: p.name,
          score: p.score,
          // Diğerlerinin tahmin metinleri görünmez (doğru tahmin cevabı ele verirdi); sadece ilerleme.
          stage: prog?.stage ?? null,
          done: prog?.done ?? null,
          won: prog?.won ?? null,
          roundPoints: revealed ? prog?.points ?? 0 : undefined,
          tries: revealed ? prog?.guesses.length ?? 0 : undefined,
        };
      }),
      reveal: revealed
        ? { title: r.track.title, artist: r.track.artist, cover: r.track.cover, spotifyId: r.track.spotifyId, ytId: r.track.ytId }
        : null,
      over: state.over,
    };
  },
};
