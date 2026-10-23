# Kaldığımız yer (2026-10-23)

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

## Şu an: 🧛 Vampir Köylü (dal `game/vampir`)

- Kurallar kullanıcıyla netleşti → PLAN.md §4.3. Roller: Vampir/Köylü/Doktor/Gözcü/Deli; roller oyun sonuna kadar
  hiç açıklanmaz; anlatıcı sadece yazı; klasik oylama (aday + destek → savunma → Asılsın mı?).
- Yapıldı ve commit'li (dalda): server/games/vampir.js, public/games/vampir.js, 17 sürü + 1 tarayıcı testi.
  `npm test` 93/93, `npm run e2e` 11/11.
- Çalışıyor/çalıştırıldı: qa-player, lobby-swarm, security-auditor ajanları Vampir üzerinde (raporlar gelince düzelt).
- Sonra: düzeltmeler → testler yeşil → `game/vampir`'i main'e merge (merge commit) → push.

## Sıradaki adımlar

1. Vampir ajan raporlarını düzelt, merge + push (kullanıcı bu akışı onayladı: oyun başına dal, bitince merge).
2. Sıradaki P2 oyunu için kullanıcıyla kural netleştir: 😂 Komik Cevap, 👉 Hangimiz?, 🚫 Tabu.
3. Domain alınınca RPi'ye deploy (güvenlik raporundaki sertleştirme önerileri: reverse proxy, systemd, TRUST_PROXY=1).

## Kullanıcı kararları (2026-10-23)

- Wordle sınırda kelimeler: hepsi kalsın. Mevcut geçmiş main'e doğrudan push edildi; yeni oyunlar kendi dalında.
