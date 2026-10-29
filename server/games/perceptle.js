// 👁️ Algıla — lobili (çok oyunculu) sürüm. Kurallar: PLAN.md §4.7 "Çok oyunculu (lobi)". Tek oyunculu: server/perceptle.js.
// Herkes aynı uyaranı aynı sunucu anında görür. Her test: intro (ad + kural, geri sayım) → play (uyaran + cevap)
// → reveal (gerçek değer + herkesin cevabı ve puanı) → … → over (ortalama + harf notu).
// Puan tek oyunculudaki formülle sunucuda hesaplanır (public/perceptle-math.js evaluate).
import { randomBytes } from 'node:crypto';
import { cryptoRng } from '../rng.js';
import { GameError, num, str } from '../errors.js';
import { cleanAnswer, isFriday, todayIstanbul } from '../perceptle.js';
import { TESTS, TEMPO, evaluate, finalScore, gradeOf, makeStimulus, splitLabel, stimulusMs, truthOf } from '../../public/perceptle-math.js';

const INTRO_MS = 4000; // test adı + kural, 3-2-1 (host atlayabilir)
const SYNC_MS = 700; // görünüm herkese ulaşsın diye uyaran biraz sonra başlar (startAt)
const ANSWER_MS = 30_000; // gösterim bittikten sonra cevap süresi
const GRACE_MS = 2000; // süre dolduktan sonra ağ payı (geç otomatik gönderim)
const REVEAL_MS = 12_000;
const EARLY_SLACK_MS = 150; // saat/ağ farkı payı (tek oyunculudaki gibi)

// Zamanlı uyaranlar (noktalar, top, tempo) sadece gösterim bitene kadar görünümde; sonra yeniden bağlanana tekrar gitmez.
const TIMED = new Set(['count', 'track', 'tempo']);
// Açıklamada çizim için uyaranı gösterilen testler (nokta listesi büyük, tempoda sadece BPM yeter).
const DRAWN = new Set(['track', 'angle', 'split']);

export const DEFAULT_TESTS = TESTS.join(',');

// "count,tempo" → sabit sırada, bilinen, tekrarsız; boşsa hepsi.
export function cleanTests(raw) {
  const want = new Set(str(raw).split(',').map((s) => s.trim()));
  const list = TESTS.filter((t) => want.has(t));
  return list.length ? list.join(',') : DEFAULT_TESTS;
}

const activePlayers = (state) => state.players.filter((p) => !p.left);
const sc = (ctx, ms) => Math.max(1, Math.round(ms * ctx.timeScale));

function startIntro(state, ctx, index) {
  ctx.clearTimer('reveal');
  state.index = index;
  state.phase = 'intro';
  state.answers = {};
  state.startAt = null;
  state.recallAt = null;
  state.endsAt = ctx.setTimer(INTRO_MS, 'intro');
}

function startPlay(state, ctx) {
  ctx.clearTimer('intro');
  const test = state.tests[state.index];
  const stim = state.stimuli[state.index];
  const showMs = stimulusMs(test, stim, state.settings.rules === 'friday');
  const now = Date.now();
  state.phase = 'play';
  state.answers = {};
  state.startAt = now + sc(ctx, SYNC_MS);
  state.recallAt = state.startAt + sc(ctx, showMs);
  state.endsAt = state.recallAt + sc(ctx, ANSWER_MS);
  state.closeAt = ctx.setTimer(SYNC_MS + showMs + ANSWER_MS + GRACE_MS, 'play');
}

function finishTest(state, ctx) {
  ctx.clearTimer('play');
  const test = state.tests[state.index];
  const stim = state.stimuli[state.index];
  const results = {};
  for (const p of activePlayers(state)) {
    const a = state.answers[p.id];
    results[p.id] = a
      ? { answer: a.answer, score: a.score, error: a.error, detail: a.detail, timedOut: false }
      : { answer: null, score: 0, error: null, detail: null, timedOut: true };
    p.scores.push(results[p.id].score);
  }
  state.history.push({
    index: state.index,
    test,
    truth: truthOf(test, stim),
    label: test === 'split' ? splitLabel(stim) : null,
    stimulus: DRAWN.has(test) ? stim : null,
    results,
  });
  state.phase = 'reveal';
  state.startAt = null;
  state.recallAt = null;
  state.endsAt = ctx.setTimer(REVEAL_MS, 'reveal');
}

function endGame(state, ctx) {
  for (const name of ['intro', 'play', 'reveal']) ctx.clearTimer(name);
  state.phase = 'over';
  state.over = true;
  state.endsAt = null;
  state.startAt = null;
  state.recallAt = null;
}

function advance(state, ctx) {
  if (state.index + 1 >= state.tests.length) endGame(state, ctx);
  else startIntro(state, ctx, state.index + 1);
}

function maybeAllIn(state, ctx) {
  if (state.phase === 'play' && activePlayers(state).every((p) => state.answers[p.id])) finishTest(state, ctx);
}

export default {
  id: 'perceptle',
  name: 'Algıla',
  minPlayers: 1, // tek kişi de oda açıp başlatabilir
  maxPlayers: 12,
  // İstanbul'da Cuma günü kurulan odada varsayılan 🃏 Cuma kuralları (host değiştirebilir). Oda kurulurken okunur.
  get defaultSettings() {
    return { rules: isFriday(todayIstanbul()) ? 'friday' : 'normal', tests: DEFAULT_TESTS };
  },

  validateSettings(s) {
    return {
      rules: s.rules === 'friday' ? 'friday' : 'normal',
      tests: cleanTests(s.tests),
    };
  },

  setup({ players, settings, ctx }) {
    const friday = settings.rules === 'friday';
    const tests = settings.tests.split(',');
    // Uyaranlar her zaman kripto üreteçle (tohumlu oda üreteci değil): çıktıdan sonraki testler hesaplanamasın.
    const rng = cryptoRng();
    const state = {
      settings,
      timeScale: ctx.timeScale, // istemci animasyonu (gerçek süre × ölçek) için
      gameKey: randomBytes(4).readUInt32BE(0),
      tests,
      stimuli: tests.map((t) => makeStimulus(t, rng, friday)),
      players: players.map((p) => ({ id: p.id, name: p.name, left: false, scores: [] })),
      index: 0,
      phase: 'intro',
      answers: {}, // bu testin cevapları: playerId -> { answer, score, error, detail, at }
      history: [], // biten testler: [{ index, test, truth, label, stimulus, results: { playerId: {...} } }]
      startAt: null,
      recallAt: null,
      endsAt: null,
      closeAt: null,
      over: false,
    };
    startIntro(state, ctx, 0);
    return state;
  },

  action(state, playerId, action, ctx) {
    const me = state.players.find((p) => p.id === playerId && !p.left);
    if (!me) throw new GameError('Bu oyunda değilsin.');
    const type = str(action.type);
    if (!['answer', 'go', 'next'].includes(type)) throw new GameError('Bilinmeyen eylem.');
    // Eski teste/faza ait eylemler (geç otomatik gönderim, çift dokunma) sessizce yok sayılır.
    if (num(action.index) !== state.index || state.over) return;
    if (type === 'go') {
      if (state.phase !== 'intro') return;
      if (playerId !== ctx.hostId) throw new GameError('Testi oda sahibi başlatır.');
      startPlay(state, ctx);
      return;
    }
    if (type === 'next') {
      if (state.phase !== 'reveal') return;
      if (playerId !== ctx.hostId) throw new GameError('Sonraki testi oda sahibi başlatır.');
      advance(state, ctx);
      return;
    }
    // answer
    if (state.phase !== 'play') return;
    if (state.answers[playerId]) throw new GameError('Cevabını zaten gönderdin.');
    if (ctx.now < state.recallAt - EARLY_SLACK_MS) throw new GameError('Önce gösterim bitmeli.');
    if (ctx.now > state.endsAt + sc(ctx, GRACE_MS)) throw new GameError('Süre doldu, cevap sayılmadı.');
    const test = state.tests[state.index];
    const friday = state.settings.rules === 'friday';
    let answer = cleanAnswer(test, action.answer, friday);
    // Ritim: dokunuşlar ölçekli zamanda (ilk duyulur vuruşa göre) gelir; puan gerçek zamana çevrilerek hesaplanır.
    const forScore = test === 'tempo' ? answer.map((x) => x / ctx.timeScale) : answer;
    if (test === 'tempo') answer = answer.length; // görünümde sadece dokunuş sayısı
    const r = evaluate(test, state.stimuli[state.index], forScore, friday);
    state.answers[playerId] = { answer, score: r.score, error: r.error, detail: r.detail, at: ctx.now };
    maybeAllIn(state, ctx);
  },

  tick(state, ctx, name) {
    if (name !== state.phase) return; // eski zamanlayıcı
    if (state.phase === 'intro') startPlay(state, ctx);
    else if (state.phase === 'play') finishTest(state, ctx); // cevap vermeyen 0 puan
    else if (state.phase === 'reveal') advance(state, ctx);
  },

  onPlayerLeave(state, playerId, ctx) {
    const p = state.players.find((x) => x.id === playerId);
    if (!p || p.left) return;
    p.left = true; // kalan testlerden 0, sıralamadan düşer
    delete state.answers[playerId];
    if (!activePlayers(state).length) { endGame(state, ctx); return; }
    maybeAllIn(state, ctx);
  },

  isOver: (state) => state.over,

  view(state, playerId) {
    const playing = state.players.some((p) => p.id === playerId && !p.left);
    const test = state.tests[state.index];
    const inPlay = state.phase === 'play';
    // Uyaran sadece play fazında, sadece oyunculara; zamanlı olanlar gösterim bitince görünümden çıkar.
    const showStim = inPlay && playing && (!TIMED.has(test) || Date.now() < state.recallAt);
    const mine = inPlay ? state.answers[playerId] : null;
    const friday = state.settings.rules === 'friday';
    return {
      game: 'perceptle',
      gameKey: state.gameKey,
      phase: state.phase,
      over: state.over,
      friday,
      tests: state.tests,
      index: state.index,
      test,
      endsAt: state.endsAt,
      startAt: inPlay ? state.startAt : null,
      recallAt: inPlay ? state.recallAt : null,
      leadMs: inPlay && test === 'tempo' ? TEMPO.leadMs : 0, // ölçeksiz; istemci timeScale ile çarpar
      timeScale: state.timeScale,
      stimulus: showStim ? state.stimuli[state.index] : null,
      me: { playing, answered: Boolean(mine), answer: mine ? mine.answer : null },
      players: state.players.filter((p) => !p.left).map((p) => {
        const total = finalScore(p.scores);
        return {
          id: p.id,
          name: p.name,
          answered: inPlay ? Boolean(state.answers[p.id]) : null,
          scores: p.scores,
          total,
          grade: state.over ? gradeOf(total) : null,
        };
      }),
      // Başkalarının cevapları sadece test bittikten sonra (history) görünür.
      history: state.history,
      last: state.phase === 'reveal' || state.phase === 'over' ? state.history.at(-1) ?? null : null,
    };
  },
};
