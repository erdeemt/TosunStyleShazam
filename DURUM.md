# Kaldığımız yer (2026-10-22)

Bir sonraki oturum buradan devam eder. Ayrıntılı şartname: `PLAN.md`.

## Bitenler (yerelde commit'li, GitHub'a henüz gönderilmedi)

- **P0 altyapı:** WebSocket lobi (`server/lobby.js`), kalıcı kimlik (`data/identities.json`), bot kütüphanesi,
  Playwright testleri, IP başına sınırlar (`server/limits.js`), CSP.
- **P1 oyunlar:** 🕵️ Casus Kim? (lobili) ve 🟩 Wordle TR (günlük + sınırsız, arkadaş sıralaması).
- **Ajan ekibi** (`.claude/agents/`): game-builder, content-writer-tr, qa-player, lobby-swarm, security-auditor.
- Güvenlik denetimi ve QA turu yapıldı, bulgular düzeltildi (son commit: "Güvenlik ve QA düzeltmeleri").
- Testler: `npm test` (birim + sürü + güvenlik) ve `npm run e2e` (tarayıcı) — hepsi yeşildi.

## Lobby-swarm bulguları — DÜZELTİLDİ (2026-10-23)

B1–B5 düzeltildi, `todo` testleri artık normal regresyon testi: güvenli girdi dönüştürücüleri (`server/errors.js`
`str`/`num`), hello hataları yakalanıyor, host izleyiciye geçmiyor (`pickHost`), reddedilen create/rename yan etki
bırakmıyor, ayarlarda sadece düz değerler. `npm test` 76/76, `npm run e2e` 10/10.

Açık küçük notlar:
- Kopuk oyuncular suçlama oylamasını 45 sn bekletiyor (QA notu) — oylamada sadece bağlı oyuncuları saymak düşünülebilir.
- Öneri: sadece TEST_GAMES=1 iken `/api/stats` (odalar, kimlikler, açık soket, bellek).

## Sıradaki adımlar

1. Kullanıcıya P1 özetini ver, GitHub'a push için onay al.
2. P2 için kuralları kullanıcıyla netleştir (PLAN.md §4.3): 🧛 Vampir Köylü, 👉 Hangimiz?, 😂 Komik Cevap, 🚫 Tabu.
3. Domain alınınca RPi'ye deploy (güvenlik raporundaki sertleştirme önerileri: reverse proxy, systemd, TRUST_PROXY=1).

## Kullanıcıya sorulacak küçük kararlar

- Wordle cevap listesinde sınırda kelimeler var (kanka, moruk, salak, eroin, esrar, namaz…) — çıkarılsın mı?
  (`content/wordle/curation/answers-exclude.txt`'e ekleyip `node content/wordle/build.mjs`.)
- Wordle listeleri CC BY-SA kaynaklardan; repo herkese açıksa atıf README'de var, uygun mu?
