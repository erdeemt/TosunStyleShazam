# Kaldığımız yer (2026-10-22)

Bir sonraki oturum buradan devam eder. Ayrıntılı şartname: `PLAN.md`.

## Bitenler (yerelde commit'li, GitHub'a henüz gönderilmedi — `main` 5 commit önde)

- **P0 altyapı:** WebSocket lobi (`server/lobby.js`), kalıcı kimlik (`data/identities.json`), bot kütüphanesi,
  Playwright testleri, IP başına sınırlar (`server/limits.js`), CSP.
- **P1 oyunlar:** 🕵️ Casus Kim? (lobili) ve 🟩 Wordle TR (günlük + sınırsız, arkadaş sıralaması).
- **Ajan ekibi** (`.claude/agents/`): game-builder, content-writer-tr, qa-player, lobby-swarm, security-auditor.
- Güvenlik denetimi ve QA turu yapıldı, bulgular düzeltildi (son commit: "Güvenlik ve QA düzeltmeleri").
- Testler: `npm test` (birim + sürü + güvenlik) ve `npm run e2e` (tarayıcı) — hepsi yeşildi.

## Yarım kalan

- **lobby-swarm ajanının raporu gelmedi** (PC kapatıldı). Yazdığı ama commit edilmemiş dosyalar diskte:
  `tests/swarm/swarm-*.mjs`, `tests/lib/bot.js` değişikliği. Bunlardan 4 test kırmızıydı
  (yeniden bağlanma fırtınası, oylama sırasında kick, suçlananı kick, aynı ms yarışı) — gerçek hata mı,
  yoksa yeni güvenlik sınırlarından mı (ör. bağlantı başına 3 hello) kaynaklanıyor **henüz incelenmedi**.
  Devam: lobby-swarm ajanını bu dosyalarla yeniden çalıştır, raporunu al, bulguları düzelt.
- Kopuk oyuncular suçlama oylamasını 45 sn bekletiyor (QA notu) — oylamada sadece bağlı oyuncuları saymak düşünülebilir.

## Sıradaki adımlar

1. Swarm bulgularını düzelt → `npm test` + `npm run e2e` yeşil → commit.
2. Kullanıcıya P1 özetini ver, GitHub'a push için onay al.
3. P2 için kuralları kullanıcıyla netleştir (PLAN.md §4.3): 🧛 Vampir Köylü, 👉 Hangimiz?, 😂 Komik Cevap, 🚫 Tabu.
4. Domain alınınca RPi'ye deploy (güvenlik raporundaki sertleştirme önerileri: reverse proxy, systemd, TRUST_PROXY=1).

## Kullanıcıya sorulacak küçük kararlar

- Wordle cevap listesinde sınırda kelimeler var (kanka, moruk, salak, eroin, esrar, namaz…) — çıkarılsın mı?
  (`content/wordle/curation/answers-exclude.txt`'e ekleyip `node content/wordle/build.mjs`.)
- Wordle listeleri CC BY-SA kaynaklardan; repo herkese açıksa atıf README'de var, uygun mu?
