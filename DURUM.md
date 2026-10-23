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

## Durum (2026-10-24 akşam)

- main'de (GitHub'da): Shazam online mod (otomatik 3-2-1, Mac klip düzeltmesi, ses seviyesi), Casus soru-cevap sırası,
  YouTube acil düzeltmesi, npm run online (Cloudflare tüneli).
- **game/recall dalı (GitHub'da, main'e BİRLEŞTİRİLMEDİ):** 🎨 Nüans + 🔊 Ton Avı. Geliştirici ajan yaptı, main ile
  birleştirildi (lobby.js çakışması çözüldü: patchGame + aynı-öğe önbelleği birlikte). Worktree:
  .claude/worktrees/agent-a98d26aa86517536e. Birleştirme sonrası tam test çalışması yarıda kaldı → tekrar çalıştır.
- Puanlama (kullanıcı onayladı): Nüans CIEDE2000, 1000/(1+(ΔE/12)²), 5 tur ortalaması; Ton Avı cent,
  10×max(exp(−(c/140)²), 0.75·exp(−c/390)), 5 tur toplamı.

## Sıradaki adımlar

1. game/recall: npm test + npm run e2e (worktree'de) → QA / sürü / güvenlik ajanları → düzelt → main'e merge + push.
2. Builder'ın açık soruları kullanıcıya: tek kişiyle lobi başlatılabilsin mi? (şu an min 2)
3. Domain alınınca RPi'ye deploy.

## Kullanıcı kararları (2026-10-23)

- Wordle sınırda kelimeler: hepsi kalsın. Mevcut geçmiş main'e doğrudan push edildi; yeni oyunlar kendi dalında.
