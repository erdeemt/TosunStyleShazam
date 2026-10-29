# Kaldığımız yer (2026-10-24)

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

## Durum (2026-10-24 akşam)

- main'de (GitHub'da): Shazam online mod (otomatik 3-2-1, Mac klip düzeltmesi, ses seviyesi), Casus soru-cevap sırası,
  YouTube acil düzeltmesi, npm run online (Cloudflare tüneli).
- **game/recall dalı (GitHub'da, main'e BİRLEŞTİRİLMEDİ):** 🎨 Nüans + 🔊 Ton Avı. Geliştirici ajan yaptı, main ile
  birleştirildi (lobby.js çakışması çözüldü: patchGame + aynı-öğe önbelleği birlikte). Worktree:
  .claude/worktrees/agent-a98d26aa86517536e. Birleştirme sonrası tam test çalışması yarıda kaldı → tekrar çalıştır.
- Puanlama (kullanıcı onayladı): Nüans CIEDE2000, 1000/(1+(ΔE/12)²), 5 tur ortalaması; Ton Avı cent,
  10×max(exp(−(c/140)²), 0.75·exp(−c/390)), 5 tur toplamı.

## 🎨 Nüans + 🔊 Ton Avı — BİTTİ, main'e merge + push edildi (2026-10-24 gece)

- Kullanıcı kararı: tek kişi de oda açıp başlatabilir (minPlayers 1).
- Güvenlik: ezber bitmeden cevap reddedilir, önceki tur cevaplanmadan yeni hedef verilmez, sıralama ilk 50 + sen,
  45 günden eski günlük kayıtlar silinir, jsonStore aynı ada aynı kaydı döner (secrets ezilmesin), bozuk JSON'da durur.
- Lobi (tüm oyunlar): oyun ortası izleyici host olsa da oyuncu atamaz.
- QA: sonradan verilen ad sıralamada, süre çubuğu, beraberlik, gri hex ton korunur, kaydırıcı 44 px.
- `npm test` 235/235, `npm run e2e` 34/34. Not: "8 kişi, 5 tur" sürü testi tam turda bir kez yük altında düştü (kararsız).
- Bilinçli bırakılanlar: hedef istemciye gitmek zorunda (devtools ile görülebilir); tek kişilik odada bağlantı
  kopunca süre işlemeye devam eder; gece yarısını geçen günlük tur kaybolur; serbest modda yenileyince oyun kaybolur.

## 👁️ Algıla — game/perceptle dalında (main'e BİRLEŞTİRİLMEDİ, 2026-10-26)

- perceptle.com tarzı günlük algı testi, sadece tek oyunculu: Say, Yörünge, Açı, Ritim, Böl; Cuma günleri 🃏 Cuma kuralları.
  Kurallar ve sabitler PLAN.md §4.7. Dosyalar: server/perceptle.js, public/perceptle-math.js, public/games/perceptle(-tests).js.
- Testler: tests/unit/perceptle.test.mjs, tests/swarm/perceptle-api.test.mjs, tests/security/sec-perceptle-forgery.test.mjs,
  tests/e2e/perceptle.test.mjs (ekran görüntüleri test-results/perceptle/).
- Kullanıcı denemeli: özellikle Ritim (telefon ses gecikmesi; ısınma kalibrasyonu) ve Cuma açı sarımı. Sonra main'e merge.

## Sıradaki adımlar

1. Kullanıcı arkadaşlarla deneyip geri bildirim verecek; "geç" deyince Komik Cevap / Hangimiz? / Tabu.
2. Domain alınınca RPi'ye deploy.

## Kullanıcı kararları (2026-10-23)

- Wordle sınırda kelimeler: hepsi kalsın. Mevcut geçmiş main'e doğrudan push edildi; yeni oyunlar kendi dalında.

## 👁️ Algıla — BİTTİ, main'e merge + push edildi (2026-10-28)

- perceptle.com tarzı tek oyunculu günlük algı testi: Say, Yörünge, Açı, Ritim, Böl; Cuma kuralları; Günlük + Sınırsız.
- QA + güvenlik turları yapıldı, bulgular düzeltildi: günlük uyaran önbelleği, TIME_SCALE sadece TEST_MODE=1
  (tests/lib/server.js verir), ağ kesintisinde otomatik yeniden deneme + "Tekrar gönder", Açı/Böl'de Kilitle dokununca açılır,
  normal Açı'da tek dokunuş göndermez, canvas ölçüsü, 44 px dokunma, touch-action. npm test artık tests/security'yi de çalıştırır.
- Bilinçli bırakılan: günlük uyaranlar herkese aynı (yan hesapla önizleme mümkün, Wordle gibi).
- npm test 260/260, npm run e2e 46/46.

## ⚽ Tosun Top — game/haxball dalında (main'e BİRLEŞTİRİLMEDİ, 2026-10-29)

- HaxBall tarzı gerçek zamanlı futbol, sadece lobili (2–8 kişi, 1'e 1 olur). Kurallar, fizik sabitleri ve ağ tasarımı
  PLAN.md §4.8; lobi çekirdeğine eklenen genel kancalar §3.7 (`realtime` döngüsü, hızlı `input`/`ping` yolu, `frame` mesajı,
  `lobbyAction`, `onConnection`, `canStart` 3. argüman, TEST_GAMES'e özel `/api/_test/stats`).
- Dosyalar: public/haxball-physics.js (saf fizik), server/games/haxball.js, public/games/haxball.js, tests/unit/haxball.test.mjs,
  tests/swarm/haxball(-load).test.mjs + haxball-lib.mjs, tests/e2e/haxball.test.mjs (ekran görüntüleri test-results/haxball/).
- Ölçüm: 8 kişilik kare ~200 bayt; 4 oda × 8 bot sunucu işlemcisi ~%8, kare hızı 30/sn.
- İstemci tahmini yok (sadece 100 ms ara değer): kendi diskinde gecikme ≈ RTT + 100 ms. Kullanıcı tünel üzerinden telefonla
  denemeli; ağır gelirse kendi disk için tahmin eklenebilir. Sonra main'e merge.
