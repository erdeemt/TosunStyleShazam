# Kaldığımız yer (2026-10-22)

Bir sonraki oturum buradan devam eder. Ayrıntılı şartname: `PLAN.md`.

## Bitenler (yerelde commit'li, GitHub'a henüz gönderilmedi — `main` 5 commit önde)

- **P0 altyapı:** WebSocket lobi (`server/lobby.js`), kalıcı kimlik (`data/identities.json`), bot kütüphanesi,
  Playwright testleri, IP başına sınırlar (`server/limits.js`), CSP.
- **P1 oyunlar:** 🕵️ Casus Kim? (lobili) ve 🟩 Wordle TR (günlük + sınırsız, arkadaş sıralaması).
- **Ajan ekibi** (`.claude/agents/`): game-builder, content-writer-tr, qa-player, lobby-swarm, security-auditor.
- Güvenlik denetimi ve QA turu yapıldı, bulgular düzeltildi (son commit: "Güvenlik ve QA düzeltmeleri").
- Testler: `npm test` (birim + sürü + güvenlik) ve `npm run e2e` (tarayıcı) — hepsi yeşildi.

## Yarım kalan: lobby-swarm bulguları (rapor geldi, henüz DÜZELTİLMEDİ)

Testleri commit'li: `tests/swarm/swarm-*.mjs`. Açık hatalar `todo` olarak işaretli (npm test yeşil kalır);
düzeltince testteki `todo` seçeneğini kaldır → regresyon testi olur.

- **B1 (yüksek):** `{"t":"hello","name":{"toString":1}}` (veya playerId olarak nesne) → `sanitizeName` içinde
  TypeError; handleHello GameError dışını yeniden fırlatıyor, handleMessage'da hello try/catch dışında →
  soket sessizleşiyor (global uncaughtException sayesinde süreç ayakta). Düzelt: hello'yu try/catch'e al +
  `typeof name/playerId === 'string'` kontrolü. Test: swarm-fuzz.test.mjs.
- **B2 (orta):** host devri izleyiciye düşebiliyor (removePlayer + hostHandoff) → tur sonunda kimse "sonraki tur"
  diyemiyor. Düzelt: yeni host seçerken izleyici olmayan bağlı oyuncuyu tercih et. Test: swarm-spyfall-chaos (seed 7).
- **B3 (düşük):** reddedilen `create` (sunucu dolu / IP kotası) kullanıcıyı mevcut odasından çıkarıyor —
  createRoom'da leaveRoom'u kontrollerden sonraya al (IP kotası sayımında kendi odasını hariç tut).
- **B4 (düşük):** oyun sırasında reddedilen `rename` yine de kalıcı adı değiştiriyor — faz kontrolünü atamadan önce yap.
- **B5 (düşük):** toString tuzaklı nesneler diğer alanlarda "internal" hata veriyor (create.game, join.code,
  rename.name, kick.playerId, settings, action.targetId) — girişlerde `typeof === 'string'/'number'` kontrolü.
- Öneri: sadece TEST_GAMES=1 iken `/api/stats` (odalar, kimlikler, açık soket, bellek).
- Kopuk oyuncular suçlama oylamasını 45 sn bekletiyor (QA notu) — sadece bağlı oyuncuları saymak düşünülebilir.
- Soak (20 oda × 8 bot, 120 sn): 859 oyun, 0 takılma, 0 kural ihlali; heap sabit.

## Sıradaki adımlar

1. Yukarıdaki B1–B5'i düzelt → `npm test` + `npm run e2e` yeşil → commit.
2. Kullanıcıya P1 özetini ver, GitHub'a push için onay al.
3. P2 için kuralları kullanıcıyla netleştir (PLAN.md §4.3): 🧛 Vampir Köylü, 👉 Hangimiz?, 😂 Komik Cevap, 🚫 Tabu.
4. Domain alınınca RPi'ye deploy (güvenlik raporundaki sertleştirme önerileri: reverse proxy, systemd, TRUST_PROXY=1).

## Kullanıcıya sorulacak küçük kararlar

- Wordle cevap listesinde sınırda kelimeler var (kanka, moruk, salak, eroin, esrar, namaz…) — çıkarılsın mı?
  (`content/wordle/curation/answers-exclude.txt`'e ekleyip `node content/wordle/build.mjs`.)
- Wordle listeleri CC BY-SA kaynaklardan; repo herkese açıksa atıf README'de var, uygun mu?
