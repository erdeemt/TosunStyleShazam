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
- Kullanıcı denemeli: özellikle Ritim (telefon ses gecikmesi; ısınma kalibrasyonu) ve Cuma açı sarımı.

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
- Bilinçli bırakılan: günlük uyaranlar herkese aynı (yan hesapla önizleme mümkün, Wordle gibi). → 2026-10-31: aynı gün açılan hesap sıralama dışı.
- npm test 260/260, npm run e2e 46/46.

## ⚽ Tosun Top — main'e merge + push edildi (2026-10-29)

- HaxBall tarzı gerçek zamanlı futbol, sadece lobili (2–8 kişi, 1'e 1 olur). Kurallar, fizik sabitleri ve ağ tasarımı
  PLAN.md §4.8; lobi çekirdeğine eklenen genel kancalar §3.7 (`realtime` döngüsü, hızlı `input`/`ping` yolu, `frame` mesajı,
  `lobbyAction`, `onConnection`, `canStart` 3. argüman, TEST_GAMES'e özel `/api/_test/stats`).
- Dosyalar: public/haxball-physics.js (saf fizik), server/games/haxball.js, public/games/haxball.js, tests/unit/haxball.test.mjs,
  tests/swarm/haxball(-load).test.mjs + haxball-lib.mjs, tests/e2e/haxball.test.mjs (ekran görüntüleri test-results/haxball/).
- Ölçüm: 8 kişilik kare ~200 bayt; 4 oda × 8 bot sunucu işlemcisi ~%8, kare hızı 30/sn.
- QA/sürü/güvenlik turu düzeltmeleri (2026-10-29): kopan disk 20 sn donuk bekler, takım bağlantısızken saat durur, hükmen
  sadece açık ayrılma veya 30 sn boş takım; canlı maçta yeniden bağlanma ≤ 1 sn; step istisnası maçı "Teknik hata" ile bitirir;
  hız aşımında terminate + dead bayrağı, bayt sayımı, canlı maç sınırı (20 / ağ başına 2), 60 sn girdisiz maç biter, odasız
  ping yanıtsız, pencereyi aşan son girdi bekletilir; başlama vuruşunda saat durur (5 sn sonra kısıt kalkar).
- İstemci: uyarlanabilir ara değer (50–150 ms) + kendi disk tahmini (topa yakınken ara değerli konuma geçer). RTT 150'de
  tuş→ekran 318 → ~50 ms. Dikeyde saha döner (~2 kat büyük), ŞUT sağ boşlukta, "Bağlantı koptu" bandı.
- Ajan testleri: tests/security/sec-haxball-dos, tests/swarm/swarm-haxball-{core,rules,abuse,load}, tests/e2e/qa-haxball-{play,net}.
- Kullanıcı tünel üzerinden telefonla denemeli (özellikle tahmin hissi; `localStorage['tss:hx-predict']='0'` ile kapatılabilir).
## 👁️ Algıla çok oyunculu — main'e merge + push edildi (2026-10-29)

- Lobili mod: 1–12 kişi, host Normal/🃏 Cuma ve test seçimi yapar; her test intro (4 sn) → play (herkese aynı anda) → açıklama (12 sn) → final.
  Kurallar PLAN.md §4.7 "Çok oyunculu". Dosyalar: server/games/perceptle.js, public/games/perceptle-lobby.js (+ küçük ekler:
  perceptle.js enter('multi'), perceptle-tests.js value(), games.js, style.css).
- Testler: tests/swarm/perceptle-lobby.test.mjs (11), tests/e2e/perceptle-lobby.test.mjs (2). Tek oyunculu değişmedi.
- Kullanıcı denemeli: telefonlarda eşzamanlılık (özellikle Ritim) ve 30 sn cevap süresi yeterli mi.

## 🔒 Gizli uyaranlar + yan hesap kuralı — main'e merge + push edildi (2026-11-01)

- Ağ sekmesinden cevap okunmasın: Nüans hedefi (tek + lobi) gürültülü PNG, Ton Avı Zor hedefi WAV, Algıla Say noktaları PNG
  (Cuma: kare şeridi), Yörünge sadece görünen kısmın örnekleri. Hepsi `/api/media/<jeton>` (sahibine + odaya bağlı, kısa ömürlü,
  2 kullanım, IP sınırı, no-store). Kurallar PLAN.md §3.4, §3.6.1, §4.5–4.7. Dosyalar: server/media-tokens.js, server/media-encode.js,
  public/media.js; testler tests/unit/media.test.mjs, tests/security/sec-hidden-media.test.mjs, tests/e2e/secure-hidden.test.mjs
  (ekranlar test-results/secure-hidden/), yardımcı tests/lib/media.js; testler ham uyaranı `/api/_test/secret`'ten alır (TEST_GAMES=1 ve TEST_MODE=1).
- Günlük: bulmacanın gününde açılan hesap sıralama dışı ("🆕 sıralama dışı", en altta). Kimliklere `createdAt` eklendi.
- Kullanıcı denemeli: telefonda Nüans diski (görsel gecikmesi), Ton Avı Zor sesi (iOS kilit açma), Cuma Say animasyonu akıcılığı.
## 🎵 Shazam online ses vekili — main'e merge + push edildi (2026-11-01)

- Ağ sekmesinden cevap sızıntısı kapatıldı: istemci sadece `/api/clip/<opak>` görür (YouTube kimliği / CDN adresi yok),
  klip o adımın süresi kadar (sunucuda MP3 çerçeve kesici, bağımlılıksız). Ayrıntı: PLAN.md §4.4 "Ses vekili".
- YouTube şarkıları online modda Deezer önizlemesine çevrilir; bulunamayan host'a notla listelenir.
- Testler: `tests/unit/mp3.test.mjs`, `tests/swarm/swarm-shazam-clip.test.mjs`, `tests/e2e/shazam-secure.test.mjs`.
- Açık: gerçek Safari/iOS cihazda Range + çerezli `<audio>` denenmedi (206 yolu testte var); sonraki adımın klibi bilerek
  önceden yüklenmiyor (adım kapısını delerdi) — yavaş ağda adım geçişinde kısa "yükleniyor" görülebilir.

## 🧛 Vampir 3D – Aşama 1 — game/vampir-3d dalında (main'e BİRLEŞTİRİLMEDİ, 2026-10-31)

- Oyun ekranının üstünde sevimli, Feign tarzı low-poly köy meydanı (sadece görsel; kurallar ve sunucu değişmedi). Ayrıntı PLAN.md §4.3 sonu.
  - Ortada kamp ateşi (titreyen ışık + alev), 4 renkli ev, ağaçlar, toprak meydan. Oyuncular ateşin çevresinde halka; herkes
    kendini önde, sırtı kameraya dönük görür (izleyici: nötr). Fasulye gövde + kafa + nokta gözler + yanak, kimlikten sabit renk ve
    şapka (kasket, fes, kovboy, taç, bere, silindir, parti külahı, çiçek). İsimler ekranda sabit boy. Nefes alma, kafa çevirme, göz kırpma.
  - Gece/gündüz 2,5 sn geçiş (reduced-motion: 0,3 sn): güneş batar/ay doğar, gökyüzü + sis + ışık rengi, yıldızlar, pencereler yanar,
    ateş gece daha parlak. Gece yaşayanlar başını eğer, gözler kapanır, "zzz"; sabah uyanıp gerinir. Ölüler: yarı saydam hayalet + mezar taşı.
  - Gündüz adayın üstünde ❗; savunma/oylamada sanığa spot (meydan biraz kararır) ve herkes ona döner.
  - Gece karaktere dokunmak = hedef düğmesi (aynı kart kapısı ve uyarı); halka ve müttefik işareti sadece kart açıkken. Gündüz dokunmak
    listede o satıra kaydırır.
  - Performans: DPR ≤ 1.5, ≤ 30 fps, sekme gizli/blok ekran dışıyken durur, gölge yok (sahte daire gölge), ortak geometri/malzeme.
    WebGL2 yoksa veya bağlam koparsa blok sessizce gizlenir. Lobiye dönülünce 4 sn sonra kendini kapatır.
- Dosyalar: public/games/vampir-3d.js (yeni), public/games/vampir.js (blok yerleştirme, ortak `tapTarget`, satırlara data-pid),
  public/style.css (.v3d), public/vendor/three/ (three.module.min.js + LICENSE).
- Testler: tests/unit/vampir-3d.test.mjs (tarif sızıntı testi), tests/e2e/vampir-3d.test.mjs (7 telefon, 2 vampir; ekranlar
  test-results/vampir-3d/: night, day, trial, night-card-open-vampire).
- Kullanıcı denemeli: gerçek telefonlarda akıcılık/ısınma, arkadaki karaktere dokunma kolaylığı, 12 kişide isimlerin çakışması.

**Sıradaki aşamalar**
- **Aşama 2 — ölüm/asılma animasyonları:** sabah rastgele komik ölümler (yarasa sürüsü + hayalet çıkışı, mezar taşı "pop", tabut),
  asılma yerine komik sürgün (mancınıkla fırlatma veya kafes).
- **Aşama 3 — rol efektleri ve final:** kart açıkken rolüne göre efektler (yine sadece kart açıkken!), oyun sonunda rol açılışı +
  kazananların dansı, sesler + sessiz düğmesi.

## 🤖 Botlar (Vampir) — game/vampir-bots dalında (main'e BİRLEŞTİRİLMEDİ, 2026-10-31)

- Tek telefonla Vampir (5–12 kişi) denemek için: host bekleme odasında "🤖 Bot ekle" / bot satırında ✕. Ayrıntı PLAN.md §3.8.
- Genel, opsiyonel lobi kancası `game.bots = { plan, act }`; şimdilik sadece Vampir tanımlıyor (diğer oyunlarda düğme yok,
  sunucu da reddeder). Botlar sunucuda, odanın zamanlayıcı haritasıyla; eylemleri insanlarla aynı doğrulamadan geçer.
- Botlar kimlik dosyasına/sıralamaya yazılmaz, hep bağlı, host olamaz, lobiye dönüşte kalır; sadece botlar kalırsa oda kapanır.
  İnsan adlarından 🤖 silinir (bot taklidi olmasın).
- Dosyalar: server/lobby.js (addBot/removeBot, scheduleBots/runBot, ortak applyAction, stats bots/botTimers),
  server/games/vampir.js (`bots`), public/lobby.js (+ .add-bot stili).
- Testler: tests/unit/vampir-bots.test.mjs (sanal saatle 40 tam bot oyunu), tests/swarm/vampir-bots.test.mjs (7),
  tests/e2e/vampir-bots.test.mjs (tek telefon + 4 bot, bir gece; ekranlar test-results/vampir-bots/).
- Kullanıcı denemeli: tek telefon + 4–11 bot; gündüzü hızlandırmak için "🌙 Geceye geç". Botlar konuşmaz, oyları rastgele.
