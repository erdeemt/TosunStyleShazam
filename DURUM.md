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

## 🧛 Vampir Köylü — BİTTİ, main'e merge + push edildi (2026-10-23)

- Kurallar PLAN.md §4.3. QA, sürü ve güvenlik turları yapıldı, tüm bulgular düzeltildi.
- Güvenlik turunda bulunan kritik açık: gameKey tohumlu RNG çıktısıydı → roller (ve Casus'ta mekân/casus)
  hesaplanabiliyordu. Artık gerçek oyunlar crypto RNG kullanıyor (tohumlu üreteç sadece SEED ile, testlerde).
- `npm test` 122/122 (2 soak SOAK=1 ile), `npm run e2e` 18/18.
- Not: tests/e2e/qa-spyfall-robust "6 kişi host devri" testi bir çalıştırmada zaman aşımına düştü (sonraki geçti) — kararsız olabilir.

## Şu an: 🎵 Shazam online mod (dal `game/shazam-online`)

- Kullanıcı kararları: herkes aynı anda kendi hızında; şarkıları sadece host ekler; ses herkesin telefonunda. PLAN.md §4.4.
- Yapıldı ve commit'li (dalda): server/games/shazam.js, lobi `prep` mesajı, server/matcher.js, shazam.js Online bölümü.
  npm test 131/131, e2e 18/19 (qa-spyfall-robust "6 kişi host devri" yük altında kararsız — QA ajanı inceliyor).
- Gerçek Deezer albümüyle ses çalma doğrulandı. QA / sürü / güvenlik ajanları çalışıyor; raporlar → düzelt → merge + push.
- İnternetten oynama: `npm run online` (Cloudflare Quick Tunnel) main'de.

## Sıradaki adımlar

1. **BEKLE:** kullanıcı arkadaşlarıyla mevcut oyunları (Shazam, Casus Kim?, Wordle, Vampir Köylü) deneyecek;
   geri bildirimini topla, düzelt. Yeni oyunlara (Komik Cevap, Hangimiz?, Tabu) kullanıcı "geç" deyince geçilecek.
2. Domain alınınca RPi'ye deploy (reverse proxy, systemd, TRUST_PROXY=1; XFF son öğe kullanılıyor).

## Kullanıcı kararları (2026-10-23)

- Wordle sınırda kelimeler: hepsi kalsın. Mevcut geçmiş main'e doğrudan push edildi; yeni oyunlar kendi dalında.
