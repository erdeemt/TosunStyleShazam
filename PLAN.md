# Tosun Style — Yol Haritası ve Teknik Şartname

Bu dosya hem insanlar hem de ajanlar için **tek doğru kaynak**tır. Bir oyun yazmadan veya test etmeden önce
ilgili bölümü oku. Burada yazmayan bir karar gerekiyorsa, kendin uydurma; raporunda "açık soru" olarak belirt.

## 1. Kararlar (kullanıcı ile netleşti, 2026-10-22)

| Konu | Karar |
|---|---|
| Ağ | Şimdilik **aynı Wi-Fi** (sunucu bir bilgisayarda, `0.0.0.0:3000`). İleride domain + RPi. Kod buna hazır olmalı (göreli URL'ler, `ws(s)://` otomatik). |
| Cihaz | Lobili oyunlarda **herkes kendi telefonundan**. Oda sahibi (host) de oyuncudur. Ortak TV ekranı **yok**. Elden ele (pass-and-play) **yok**. |
| Kimlik | **Takma ad, şifresiz.** Cihaz `localStorage`'da `playerId` + `token` tutar; aynı cihaz aynı kişi sayılır. |
| Grup | Genelde **6–10 kişi**; oyunlar 3–12 arasında çalışmalı, denge 6–10'a göre ayarlanır. |
| Dil | Arayüz ve içerik **Türkçe**. Kod tanımlayıcıları İngilizce, yorumlar Türkçe (mevcut stil). |

## 2. Oyun listesi ve aşamalar

| Aşama | Oyun | Menü | Not |
|---|---|---|---|
| **P0** | Lobi altyapısı, bot kütüphanesi, test araçları | — | Her şeyin temeli |
| **P1** | 🕵️ Casus Kim? (Spyfall) | Çok | Lobi sisteminin ilk gerçek kullanıcısı |
| **P1** | 🟩 Wordle TR (günlük + sınırsız) | Tek | Günlük bulmaca + arkadaş sıralaması altyapısı |
| P2 | 🧛 Vampir Köylü | Çok | Gece/gündüz fazları, roller, sunucu anlatıcı |
| P2 | 🎨 Nüans | Tek + Çok | Renk hafızası; günlük + sınırsız + lobi (§4.4) |
| P2 | 🔊 Ton Avı | Tek + Çok | Perde hafızası; günlük + sınırsız + lobi (§4.5) |
| P2 | 👁️ Algıla | Tek | Günlük algı testi, 5 test (§4.7) |
| P2 | ⚽ Tosun Top | Çok | HaxBall tarzı gerçek zamanlı futbol (§4.8, altyapı §3.7) |
| P2 | 👉 Hangimiz? | Çok | Gizli oylama |
| P2 | 😂 Komik Cevap (Quiplash) | Çok | Yaz → oyla |
| P2 | 🚫 Tabu | Çok | Takımlar, anlatan + gözcü |
| P3 | 📝 İsim Şehir Hayvan | Çok | Harf, süre, otomatik/oylu puan |
| P3 | 🟦 Kod Adı (Codenames) | Çok | 2 takım, lider görünümü |
| P3 | 🎵 Online Shazam | Çok | Mevcut motor + senkron çalma |
| P3 | 🎨 Çiz Bakalım | Çok | Canvas, gerçek zamanlı çizgi akışı |
| P4 | 🔗 Bağlantı (Connections) | Tek | Günlük |
| P4 | 🎵 Günlük Shazam | Tek | Herkese aynı şarkı, sıralama |
| P4 | 🪢 Adam Asmaca, 🔀 Anagram | Tek | Wordle kelime havuzunu kullanır |
| P4 | ⬆️⬇️ Daha Çok / Daha Az | Tek | Veri seti gerekir |
| P4 | 🗺️ İl Bil | Tek | İl silüetleri/plaka/komşuluk |
| P4 | ⚽ Futbolcu Bil | Tek | Veri en zor; en sona |

Her aşama: **geliştir → oyuncu-testi + sürü testi → güvenlik denetimi → düzelt → commit**.

## 3. Mimari

```
server.js                 HTTP + /api/* (mevcut) + WebSocket /ws'yi bağlar
server/lobby.js           Oda yöneticisi: kod üretimi, katılma, yeniden bağlanma, host devri, mesaj yönlendirme
server/rng.js             Tohumlu rastgele sayı (test için tekrarlanabilir)
server/games/<id>.js      Sunucu tarafı oyun mantığı (aşağıdaki arayüz)
server/daily.js           Günlük bulmaca + sıralama (data/ altında JSON)
content/<id>/*.json       Türkçe içerik (kelime listeleri, mekânlar, sorular)
data/                     Çalışma zamanı verisi (git'e girmez)
public/net.js             WebSocket istemcisi (otomatik yeniden bağlanma, kimlik)
public/lobby.js           Ortak lobi arayüzü (oda kur / katıl / bekleme odası / host ayarları)
public/games/<id>.js      İstemci tarafı oyun arayüzü
public/games.js           Oyun kayıt listesi (menü buradan oluşur)
tests/lib/bot.js          Node WebSocket bot istemcisi (sürü testleri için)
tests/e2e/*.mjs           Playwright tarayıcı testleri
tests/swarm/*.mjs         Çok botlu lobi senaryoları
```

Bağımlılıklar: `ws` (sunucu WebSocket). Geliştirme: `playwright-core` (sistemdeki Chrome'u kullanır, tarayıcı indirmez).
Başka paket eklemeden önce gerekçeyi raporla.

### 3.1 Sunucu yetkilidir (authoritative)

- Oyun durumunun tamamı **yalnızca sunucuda** tutulur. İstemciye **asla** tam durum gönderilmez.
- Her oyun `view(state, playerId)` ile **oyuncuya özel bir görünüm** üretir; ağdan sadece bu gider.
  Casusun kim olduğu, vampirler, Kod Adı renk haritası, Wordle cevabı… sadece görmesi gerekene gider.
- İstemciden gelen her eylem sunucuda doğrulanır (sıra, faz, rol, geçerli hedef, tekrar oy vb.).

### 3.2 Sunucu oyun modülü arayüzü

```js
export default {
  id: 'spyfall',
  name: 'Casus Kim?',
  minPlayers: 3, maxPlayers: 12,
  defaultSettings: { rounds: 3, minutes: 8 },
  validateSettings(settings) { return cleanSettings },      // istemciden geleni temizle/sınırla
  setup({ players, settings, rng, content }) { return state }, // players: [{ id, name }]
  action(state, playerId, action, ctx) { /* durumu değiştir; geçersizse throw new GameError('...') */ },
  tick(state, ctx) { /* opsiyonel: zamanlayıcı dolunca çağrılır */ },
  view(state, playerId) { return publicAndPrivateViewFor(playerId) },
  isOver(state) { return boolean },
  onPlayerLeave(state, playerId, ctx) { /* opsiyonel: oyun sırasında kalıcı ayrılma */ },
};
```

`ctx = { now, rng, setTimer(ms), clearTimer(), log }`. Zamanlayıcılar `ctx.setTimer` ile kurulur; lobi süreyi
`TIME_SCALE` ortam değişkeniyle ölçekler (testlerde `TIME_SCALE=0.02` → 8 dk ≈ 10 sn).

### 3.3 WebSocket protokolü (`/ws`, JSON)

İstemci → sunucu:

| `t` | Alanlar | Anlam |
|---|---|---|
| `hello` | `playerId?, token?, name` | Kimlik. İlk seferde sunucu yeni `playerId`+`token` üretir. |
| `create` | `game` | Oda kur (gönderen host olur). |
| `join` | `code` | Odaya katıl. Oyun sürüyorsa: eski oyuncuysa geri döner, değilse izleyici olarak bekler. |
| `leave` | — | Odadan çık. |
| `settings` | `settings` | Host: oyun ayarlarını değiştir (bekleme odasında). |
| `start` | — | Host: oyunu başlat. |
| `action` | `action` | Oyuna özel eylem, `{ type, ... }`. |
| `kick` | `playerId` | Host: oyuncuyu çıkar. |
| `rename` | `name` | Ad değiştir (bekleme odasında). |
| `prep` | `data` | Host: bekleme odasında oyuna özel hazırlık verisi (ör. Shazam şarkı listesi). Oyun modülü `prep(prev, data)` ile doğrular; `room.prep` alanında sadece `prepInfo` özeti herkese gider. |
| `backToLobby` | — | Host: oyun **bittikten sonra** bekleme odasına dön (oyun sürerken reddedilir). |
| `lobbyAction` | `data` | Bekleme odasında **her oyuncunun** yapabildiği oyuna özel seçim (ör. Tosun Top takım seçimi). `game.lobbyAction(prep, playerId, data, { isHost, playerIds, rng })` doğrular, yeni `prep` döner. |
| `input` | `x, y, k` | Gerçek zamanlı oyun girdisi (§3.7): yön vektörü + şut. Hızlı yol; yanıt yok. |
| `ping` | `c` (sayı) | Gecikme ölçümü; sunucu `pong` ile aynı `c`'yi döner. Hızlı yol. |

Sunucu → istemci:

| `t` | Alanlar |
|---|---|
| `welcome` | `playerId, token, name` |
| `room` | `code, game, hostId, phase ('lobby'\|'playing'\|'over'), players: [{id, name, connected, isHost}], settings` |
| `view` | `view` (o oyuncuya özel oyun görünümü), `seq` |
| `error` | `code, message` (Türkçe, kullanıcıya gösterilebilir) |
| `kicked` | — |
| `frame` | `s` (gönderim sırası), `k` (sunucu fizik adımı), oyuna özel kısa alanlar — gerçek zamanlı kare (§3.7) |
| `pong` | `c, now` |

Kurallar:
- Oda kodu: 4 harf, karışabilen harfler yok (`ABCDEFGHJKLMNPRSTUVYZ`). Paylaşım linki: `#/join/ABCD`.
- Bağlantısı kopan oyuncu **120 sn** yerini korur (`connected:false`). Süre dolarsa `onPlayerLeave`.
- Host ayrılırsa en eski bağlı oyuncu host olur.
- Boş oda 10 dk sonra silinir.

### 3.4 Güvenlik ve sağlamlık sınırları (testler bunları zorlar)

- Mesaj boyutu ≤ 8 KB (Çiz Bakalım çizgi paketleri dahil); fazlası bağlantıyı kapatır.
- Bağlantı başına hız sınırı (ör. 30 mesaj / 5 sn; aşan mesajlar düşer, ısrar ederse bağlantı kapanır).
- Ad: 1–16 karakter, baş/son boşluk kırpılır, kontrol karakterleri atılır; oda içinde benzersiz (sonuna 2, 3 eklenir).
- Oda başına en fazla 12 oyuncu; sunucu genelinde en fazla 200 oda.
- **Tüm kullanıcı metinleri istemcide `textContent` ile basılır**, asla `innerHTML` ile.
- `token` sadece sahibine gider; başka oyuncunun görünümünde `token` olmaz.
- Sunucu hiçbir istemci girdisini dosya yolu, URL veya regex olarak kullanmaz.
- `/api/resolve` vb. dış istekler sadece bilinen alan adlarına gider (SSRF yok).
- **Gizli uyaran medyası** (2026-10-31, `server/media-tokens.js` + `server/media-encode.js`): ekranda gösterilen/çalınan ama
  sayı olarak ağda görünmemesi gereken cevaplar (Nüans hedefi, Ton Avı Zor perdesi, Algıla "Say" noktaları) JSON'a yazılmaz;
  JSON'da sadece `/api/media/<128 bit jeton>` gider. İstemci `POST /api/media/<jeton>` + gövdede `playerId, token` ile indirir
  (`public/media.js`). Jeton sahibine bağlı (kimlik; lobide ayrıca kimliğin o anki oda kodu), ömrü ezber/gösterim süresi + 3 sn,
  en fazla 2 kullanım; başkası → 403, yok/süresi geçmiş/tükenmiş → 404. Toplam ≤ 5000 jeton (en eskisi atılır), IP başına
  dakikada 120 istek (`LIMIT_MEDIA_PER_MIN`). Yanıt: tam `Content-Type` (`image/png` | `audio/wav`), `Cache-Control: no-store`,
  `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin`. Bağımlılıksız kodlayıcılar: PNG (zlib + CRC32),
  WAV PCM16 mono 22050 Hz. CSP `img-src`'ye sadece `blob:` eklendi (Nüans görseli `<img src=blob:>`).
  Mükemmel gizlilik imkânsız (görülen/duyulan şey analiz edilebilir: PNG'nin ortalaması, WAV'ın FFT'si, PNG'deki noktalar);
  amaç ağ sekmesinden "hazır cevap" okunmasını engellemek.
- Testlere özel `GET /api/_test/secret` (sadece `TEST_GAMES=1`, `FAKE_TODAY` gibi): oda/oyun için ham hedef/uyaran (kusursuz cevap testleri).

### 3.5 İstemci tarafı oyun modülü

`public/games/<id>.js`, kabuğun (shell.js) beklediği `enter(category)` / `leave()` fonksiyonlarını export eder.
Lobili oyunlar ortak `lobby.js`'i kullanır: oda kur/katıl/bekleme odası ekranı hazırdır; oyun modülü sadece
`render(view, send)` sağlar. Her `view` mesajında ekran baştan çizilebilir (basitlik > performans).
Mobil öncelikli tasarım: 360 px genişlikte kusursuz çalışmalı, butonlar ≥ 44 px.

### 3.6 Günlük bulmacalar ve sıralama

- Günün bulmacası tarih (Europe/Istanbul) + oyun kimliğiyle tohumlanır; herkese aynı.
- **Cevap istemciye gitmez** (Wordle: tahmin sunucuda değerlendirilir, `POST /api/wordle/guess`).
- Sonuçlar `data/daily.json`'da: `{ game, date, playerId, name, score, detail }`. Aynı oyuncu aynı gün bir kez.
- Hafıza oyunları (Nüans, Ton Avı) kendi uçlarını ve `data/recall-daily.json`'u kullanır (§4.4–4.5 ortak bölüm).
- Sıralama `GET /api/daily/:game/:date`. Arkadaş ortamı: güven modeli gevşek ama sunucu, sonucun o günün
  bulmacasıyla tutarlı olduğunu doğrulamalı (ör. Wordle: sunucunun gördüğü tahmin geçmişinden puan hesaplanır).

### 3.6.1 Günlük sıralama: yan hesap kuralı (2026-10-31)

Kimlik `createdAt` taşır (`server/lobby.js`; eski kayıtlarda yok = eski hesap). Günlük bulmacanın İstanbul gününde açılmış
hesap (gerçek saatle; `FAKE_TODAY`'den bağımsız) oynayabilir ama o günün sıralamasına girmez: `entries[i].fresh = true`,
`rank = null`, sıralananlardan sonra en altta "🆕 sıralama dışı" (Wordle, Nüans/Ton Avı, Algıla; `rankDaily` server/wordle.js).
Adlar benzersiz/güvenilir değildir: sıralama kimliğe göre, ad sadece etiket (taklit edilebilir, kabul edildi).

### 3.7 Gerçek zamanlı oyunlar (lobi çekirdeği kancaları) — 2026-10-29

Hızlı akan oyunlar (Tosun Top) için lobiye eklenen, oyundan bağımsız ve opsiyonel kancalar. Diğer oyunlar etkilenmez.

- `game.realtime = { hz, sendHz, step(state, ctx) → bool, frame(state) → nesne }`. Faz `playing` iken lobi oda başına **tek
  `setInterval`** kurar (aralık ⌊1000/hz⌋ ms) ve `performance.now()` birikimiyle sabit adım atar: saniyede `hz` kez `step`,
  `hz/sendHz` adımda bir `frame`. Takılmadan sonra en fazla 8 adım yetişilir (spiral yok). `step` true dönerse (gol, faz,
  disk listesi değişti) lobi `afterChange` ile `room` + `view` yayınlar — o adımın karesinden **önce** (istemci yeni disk
  listesini kareden önce tanır); yani `view` sadece yavaş değişen durumu taşır.
  Kare **bir kez** JSON'lanır ve tüm soketlere aynı metin gider (`{t:'frame', s, ...}`); soketin `bufferedAmount`'ı 32 KB'ı
  aşarsa o kare o sokete **atlanır** (bağlantı kesilmez; diğer mesajlar için 1 MB'ta kesme kuralı aynen geçerli).
- Döngü maç bitince (`isOver`), `backToLobby`'de ve oda silinince durur. `step` hata fırlatırsa: bir kez loglanır, döngü durur,
  opsiyonel `game.abort(state, err)` çağrılır (Tosun Top: sonuç "⚠️ Teknik hata"), faz `over` olur ve yayınlanır — host
  bekleme odasına dönebilir; döngü kendiliğinden yeniden başlamaz.
- Canlı maç sınırı: sunucu genelinde aynı anda en fazla 20 gerçek zamanlı maç, oda kuran ağ başına 2 (`LIMIT_LIVE_PER_IP`);
  aşan `start` Türkçe hatayla reddedilir.
  Ctx: `{ timeScale, rng, log }` (TIME_SCALE fiziğe uygulanmaz; oyun isterse süreleri ölçekler).
- `game.input(state, playerId, msg)`: `input` mesajı **hızlı yoldan** gelir — genel 30/5 sn sayacını tüketmez, görünüm üretmez,
  hata yanıtı yoktur. Hızlı yolun kendi sınırı: soket başına 1 sn pencerede ≤ 64 mesaj işlenir; fazlası düşer ama pencereyi
  aşan **en yeni girdi bekletilir** ve pencere sıfırlanınca uygulanır (yön değişimi kaybolmaz). 600'ü aşan bağlantı kapanır.
  Hızlı yol sadece ≤ 256 **bayt** mesajı önce ayrıştırır; uzun mesaj önce genel hız sınırından geçer, sonra ayrıştırılır.
  `ping` sadece oynanan bir odadayken `pong` alır.
- Hız sınırı aşımı (genel 120 / 5 sn veya hızlı 600 / sn): `close(1008)` + `dead` bayrağı (sonraki mesajlar hiç ayrıştırılmaz)
  + 200 ms sonra `terminate()` (kapanış el sıkışmasını bekleyip 30 sn açık kalmaz).
  İzleyici, kimliksiz soket veya oyun dışındaki girdi yok sayılır. Değerleri oyun modülü temizler (asla konum kabul edilmez).
- `game.onConnection(state, playerId, connected, ctx)`: oyun sırasında oyuncunun bağlantısı koptu/geri geldi (opsiyonel).
- `game.canStart(prep, settings, players)`: üçüncü argüman `[{ id, connected }]` (eski oyunlar yok sayar).
- `stats()` → `loops` (çalışan döngü sayısı). `GET /api/_test/stats` sadece `TEST_GAMES=1` iken: `stats()` + `process.cpuUsage()`.
- İstemci: `net.on('frame')`, `net.frame` (son kare), `net.sendFast(msg)` (bağlı değilse kuyruğa girmez, düşer).
  Oynanan odadayken kopunca yeniden bağlanma beklemesi en fazla 1 sn (normalde üstel, 8 sn'ye kadar).

## 4. Oyun kuralları ve kabul kriterleri

### 4.1 🕵️ Casus Kim? (P1)

- 3–12 oyuncu. Her turda rastgele bir **mekân** (≥ 40 mekân, her biri 6–10 rol: "Hastane → Doktor, Hemşire, Hasta…").
- 1 casus (9+ oyuncuda ayarla 2 casus seçilebilir). Casus olmayanlar mekânı ve kendi rolünü görür; casus sadece "Casussun" görür
  ve tahmin için **tüm mekân listesini** görür.
- Tur süresi (varsayılan 8 dk) sayaç olarak herkeste görünür.
- **Soru-cevap sırası (kullanıcı isteği, 2026-10-24):** ekranda "X → Y" yazar: X, Y'ye bir soru sorar. Soran "Sordum", sorulan
  "Cevapladım" der; **ikisi de onaylayınca** cevap veren yeni soran olur ve kendisine az önce sorana geri soramaz (yeni hedef
  kalanlardan rastgele). İlk soran rastgele. İkiliden biri ayrılırsa sıra yeniden kurulur. Suçlama sırasında onay yapılmaz.
- Sorular sesli/sohbetle sorulur; uygulama **suçlama** ve **oylama** yönetir:
  - Herhangi bir oyuncu turda bir kez birini suçlayabilir → herkes Evet/Hayır oylar (suçlanan hariç). Oybirliği Evet ise suçlanan açıklanır.
  - Süre dolarsa zorunlu oylama: herkes bir şüpheli seçer, en çok oy alan açıklanır (eşitlikte casus kazanır).
  - Casus istediği an "Mekânı tahmin et" der → doğruysa casus kazanır, yanlışsa kaybeder.
- Puan (Spyfall standardı): casus süre dolup kimse mahkûm edilmezse (eşitlik/oy yok) 2; masum biri mahkûm edilirse veya mekânı doğru tahmin ederse 4. Köylüler kazanırsa her biri 1, casusu yakalayan suçlamayı başlatan +1.
- 2 casuslu oyunda casuslar birbirini bilmez; casuslardan biri yakalanınca tur köylülerin olur ve iki casus da açıklanır.
- Rol kartı her yeni turda ve yeni oyunda gizli başlar (dokununca açılır).
- Kabul: mekân/rol bilgisi casusun görünümünde **hiçbir alanda** yok; casusun kimliği diğerlerinin görünümünde yok (sonuç açıklanana kadar).

### 4.2 🟩 Wordle TR (P1)

- 5 harfli Türkçe kelime, 6 hak. Türkçe klavye (Ç Ğ I İ Ö Ş Ü). Büyük/küçük harf Türkçe kurallarına göre (`i→İ`, `ı→I`).
- İki liste: **cevap listesi** (yaygın, düzgün kelimeler, ≥ 1000) ve **geçerli tahmin listesi** (daha geniş).
  Geçersiz kelime → "Sözlükte yok" titreşimi, hak gitmez.
- Renkler: yeşil (doğru yer), sarı (kelimede var), gri (yok); tekrar eden harf kuralları NYT Wordle ile aynı.
- **Günlük mod**: sunucu değerlendirir, sonuç sıralamaya gider; paylaşılabilir emoji özeti (🟩🟨⬛).
  **Sınırsız mod**: rastgele kelime, sıralama yok.
- Kabul: günlük cevap ağ trafiğinde, sayfa kaynağında, JS'de görünmez (oyun bitene kadar).

### 4.3 🧛 Vampir Köylü (P2) — kullanıcı ile netleşti (2026-10-23)

**Kurulum**
- 5–12 oyuncu. Vampir sayısı otomatik: 5–7 → 1, 8–10 → 2, 11–12 → 3. Host elle de seçebilir ama üst sınır
  oyuncuların üçte birinden az: 5–6 → 1, 7–9 → 2, 10+ → 3 (fazlası ilk geceden sonra oyunu bitirir).
- Özel roller (host her oyunda açıp kapatır, varsayılan hepsi açık): 🩺 **Doktor**, 🔮 **Gözcü**, 🤡 **Deli**.
  Her özel rolden en fazla bir tane; kalanlar 🧑‍🌾 **Köylü**. Vampirler birbirini bilir; başka kimse kimseyi bilmez.
- Ayarlar: gündüz tartışma süresi (2–8 dk, varsayılan 4), savunma süresi (15–60 sn, varsayılan 30),
  gece süresi (30–120 sn, varsayılan 60), vampir sayısı (otomatik / 1 / 2 / 3), roller.

**Gece** (ekranda yazı; ses yok)
- Herkesin ekranında aynı anda bir görev ve aynı görünüm olur — kimin dokunduğundan rol anlaşılmasın.
  **Seçim sadece rol kartı açıkken yapılır**; kart kapalıyken herkesin düğmeleri, vurgusu ve dokunuşa tepkisi aynıdır
  ("Seçim yapmak için kartını aç"). Rol kartı her faz değişiminde kendiliğinden kapanır; tüm rollerin kartı aynı renktedir.
  - Vampirler: kurban seçer; vampirler birbirinin seçimini canlı görür. En çok oy alan ölür; eşitlikte eşitler arasından rastgele.
    Hiç oy yoksa kimse ölmez. Vampirler birbirini seçemez.
  - Doktor: bir kişiyi korur (kendini de seçebilir); **aynı kişiyi üst üste iki gece koruyamaz**. Korunan kurbansa kimse ölmez.
  - Gözcü: bir kişiyi seçer, anında "Vampir" / "Vampir değil" öğrenir (Deli "vampir değil" görünür). Sonuçlar gözcüde birikir.
  - Köylü, Deli ve ölmemiş diğerleri: sahte görev "En çok şüphelendiğin kişiyi seç" (sonucu kimseye gösterilmez).
- Gece, yaşayan herkes seçim yapınca veya süre dolunca biter.

**Gündüz**
- Sabah duyurusu: "Bu gece X öldü." veya "Bu gece kimse ölmedi." — **roller hiçbir zaman açıklanmaz** (oyun sonuna kadar),
  doktorun kimi kurtardığı da söylenmez.
- Tartışma (sohbet sesli/Discord'dan). Saat işler; host erken bitirebilir ("Geceye geç").
- **Aday gösterme:** yaşayan her oyuncu günde bir kez birini aday gösterebilir; başka bir yaşayan oyuncu "Destekliyorum" derse
  yargılama başlar. Destek gelmezse aday 30 sn sonra düşer (herkese yayınlanır). Aynı anda tek aday; bekleyen aday varken
  host günü bitiremez.
- **Yargılama:** tartışma saati durur → aday "savunma süresi" kadar konuşur → yaşayanlar (aday hariç) "Asılsın mı?" Evet/Hayır;
  oylar gizli (sadece "x/y oy" görünür, herkes kendi oyunu görür); oy vermeyen Hayır sayılır; **oy hakkı olanların yarısından fazlası Evet** derse asılır ve gece başlar; değilse tartışma kaldığı yerden sürer.
- Tartışma süresi biterse o gün kimse asılmaz, gece başlar.

**Kazanma** (her ölümden sonra kontrol)
- 🤡 Deli gündüz **asılırsa** tek başına kazanır, oyun biter (gece öldürülürse kazanamaz).
- Tüm vampirler ölürse köy kazanır.
- Yaşayan vampir sayısı ≥ yaşayan vampir olmayanlar sayısı ise vampirler kazanır.
- Oyun sonunda herkesin rolü, kimin ne zaman öldüğü ve gözcünün sonuçları açıklanır.

**Ölüler ve ayrılanlar**
- Ölüler izleyici olur: oy veremez, aday gösteremez, rolleri ve gece olayları onlara da açıklanmaz. "Ölüler konuşmaz" ekranda hatırlatılır.
- Kalıcı olarak ayrılan oyuncu ölmüş sayılır (duyurulmaz, sadece "oyundan ayrıldı"); kazanma koşulu tekrar kontrol edilir.

**Kabul kriterleri**
- Bir oyuncunun görünümünde, oyun bitene kadar, kendi rolü dışında hiçbir rol yok — vampirler hariç (birbirlerini görür).
  Doktorun koruma hedefi sadece doktorda, gözcü sonuçları sadece gözcüde, vampir oyları sadece vampirlerde.
- Gece ekranı her rol için aynı yapıda (aynı sayıda düğme, aynı başlık uzunluğu yaklaşık); ölüler gece görev almaz.
- Ölüm duyurusunda rol yok; ölü oyuncunun görünümünde de diğer roller yok.
- Doktor aynı kişiyi üst üste koruyamaz; vampir vampiri seçemez; ölü kimse eylem yapamaz.

### 4.4 🎵 Tosun Shazam — Online (lobili) mod — kullanıcı ile netleşti (2026-10-23)

- Menü: Çok Oyunculu → Tosun Shazam → 🌐 Online. 2–12 oyuncu, herkes kendi telefonundan; **ses her telefonda çalar**.
- **Şarkıları sadece oda sahibi ekler** (bekleme odasında Spotify/YouTube/Deezer linkleri veya tek oyunculu modda kayıtlı
  listeleri). Linkler host'un tarayıcısında çözülür, `prep` mesajıyla parça parça (≤ 60 şarkı/mesaj) sunucuya gider.
  Sunucu doğrular: ses/kapak adresleri sadece bilinen CDN'ler (p.scdn.co, *.dzcdn.net, i.ytimg.com, Spotify görsel CDN'i),
  metinler kısaltılır, aynı şarkı (ad + ilk sanatçı) bir kez, en fazla 300 şarkı. Önizlemesi olmayan Spotify şarkısı alınmaz.
  En az 4 şarkı gerekir; havuzda her zaman en az 3 şarkı çalınmadan kalır (son turun cevabı elemeyle bulunamasın), yani
  tur sayısı = min(ayar, şarkı − 3). Şarkılar bayt boyutuna göre parçalanarak gönderilir (≤ 6 KB/mesaj). Host odadaki listeyi temizleyebilir.
- Ayarlar: şarkı sayısı (3–30, varsayılan 10), tur süresi (45–180 sn, varsayılan 90), başlangıç noktası (rastgele / baştan).
- **Akış — herkes aynı anda, kendi hızında:** her turda herkese aynı şarkı ve aynı başlangıç noktası gelir. Herkes kendi
  telefonunda 0.5 → 1.5 → 5 → 10 → 20 sn ilerler: Çal, tahmin et (yanlışsa bir sonraki süre açılır), Geç veya Pes et.
  Şarkı yüklenince **kendiliğinden 3-2-1 geri sayım ve çalma** (butona basmadan; tarayıcı izin vermezse bir kez ▶). Pes et her
  adımda var. Yazarken odadaki şarkı listesinden öneri çıkar. Herkes bitirince veya tur süresi dolunca cevap açılır; host
  "Sonraki şarkı" der ya da 30 sn sonra kendiliğinden geçilir. Klip süresi medyanın kendi saatiyle ölçülür (Mac/Safari gecikmesi).
- **Puan:** bildiği adıma göre 5, 4, 3, 2, 1; o adımda **ilk bilen +1**. Bilemeyen 0.
- Oyun sırasında diğer oyuncuların sadece ilerlemesi görünür (kaçıncı adımda, bitirdi mi, bildi mi) — tahmin metinleri görünmez.
- **Gizlilik:** şarkı adı, sanatçı, kapak ve Spotify kimliği tur açıklanana kadar hiçbir istemciye gitmez; tahmin sunucuda
  kontrol edilir (`server/matcher.js`, tek oyunculu kontrolle aynı). ~~Sınırlama: YouTube video kimliği istemciye gider~~ →
  ses vekiliyle kapatıldı (aşağıda, 2026-10-31).
- **Ses vekili (2026-10-31, `server/clips.js` + `server/mp3.js`):** istemciye şarkı kimliği / CDN adresi hiç gitmez.
  `view.media = { key, clip }`: `clip` = `/api/clip/<128 bit base64url>` — oyuncuya ve adıma özel; tur açılınca iptal (404),
  sonraki turda açılış klibi iptal, ayrılan oyuncununkiler iptal, ayrıca 15 dk mutlak süre. Bitirmiş oyuncu / izleyiciye oyunda `null`.
  Sunucu önizlemeyi sadece izinli CDN'den (p.scdn.co, cdnt-preview / cdns-preview-X .dzcdn.net; https, portsuz, yönlendirmeler elle
  ve her adımda alan adı denetlenerek, 10 sn zaman aşımı, ≤ 1.5 MB, aynı anda ≤ 6 indirme) indirir; bellek önbelleği LRU (48 MB / 64
  parça; oda başına tur başında sadece şu anki + sıradaki şarkı önceden indirilir). MP3 çerçeve sınırında kesilir (MPEG-1/2/2.5
  Layer III, ID3v2/ID3v1 ve Xing/Info/VBRI atlanır): oyunda `[başlangıç − 2 çerçeve, başlangıç + adım + 1 çerçeve]`, açılışta
  başlangıçtan sona. Uzun adımın adresi ancak oyuncu o adıma gelince üretilir (sonraki adım önceden yüklenemez — bilerek).
  Başlangıç noktası sunucuda: `f × max(0, süre − 20 − 0.5)`; istemci klibi 0. saniyeden çalar (+80 ms pay).
  **Bağlama:** `POST /api/clip-session {playerId, token}` → imzalı (HMAC, süreç başına rastgele anahtar) `tss_clip` çerezi:
  HttpOnly, SameSite=Strict, Path=/api/clip, 12 saat (https vekil arkasında Secure). Klip isteğindeki çerez belirtecin sahibini
  göstermiyorsa 403 (başkasıyla paylaşılan adres işe yaramaz). Yanıt: `audio/mpeg`, `no-store`, `Accept-Ranges: bytes`;
  tek aralık Range → 206 (Safari `<audio>` önce `bytes=0-1` ister), çoklu aralık → 200 tamamı, geçersiz → 416; Range sadece
  kesilmiş klibin içinde. Sınırlar: IP başına 900/dk (`LIMIT_CLIP_PER_MIN`), oyuncu başına 120/dk (`LIMIT_CLIP_PER_PLAYER_PER_MIN`);
  /api/* genel sayacına girmez. İndirilemezse 502 → istemci "Şarkı yüklenemedi" (tahmin/geç yine çalışır).
  **YouTube online modda:** prep'te `ytId` kabul edilmez. Host'un istemcisi "Odaya gönder"de YouTube (ve önizlemesiz Spotify)
  şarkılarını `GET /api/deezer-match?t=…&a=…` (≤ 20 çift, tek dış istek sayılır) ile Deezer önizlemesine çevirir; eşleşme
  eşleştiriciyle sıkı denetlenir, bulunamayanlar host'a "Bu şarkı online modda çalınamıyor (önizleme bulunamadı)" notuyla listelenir.
  Tek cihaz modları (Serbest/Puanlı/Yarışma) değişmedi. **Hâlâ görünen:** öneri havuzu (kasıtlı aday listesi), klibin kendisi
  (sesi dinleyip tanımak oyunun kendisi). Test sunucusunda (TEST_MODE=1) dış ağa çıkılmaz (sentetik sessiz MP3; yolunda "yok"
  geçen adres 404) ve tur anahtarı oyun anahtarı + başlıktan türetilir (testler cevabı bilsin; `SHAZAM_OPAQUE_KEYS=1` ile rastgele).

### 4.5 🎨 Nüans (renk hafızası) — kullanıcı ile netleşti (2026-10-24)

Ortak motor: `server/recall.js` (Ton Avı ile aynı), saf matematik `public/recall-math.js` (sunucu ve istemci aynı dosyayı kullanır),
istemci `public/games/recall-client.js` + `public/games/nuance.js`, lobi modülü `server/games/nuance.js`.

**Kurallar**
- 5 tur. Her turda hedef renk büyük bir karede **Normal 5 sn / Uzman 2 sn** görünür (geri sayımlı), sonra kaybolur.
  Günlük her zaman Normal.
- Hatırlama: 30 sn. Girdi **HSB yay kadranları** (270°, parmakla çevrilir; Ton 0–360, Doygunluk 0–100, Parlaklık 0–100) +
  büyük canlı önizleme dairesi + düzenlenebilir **hex kutusu** (`#RRGGBB`), iki yönlü bağlı. Ton halkası gökkuşağı, D/P halkaları
  seçili tona göre degrade. Her kadranın içinde görünmez bir range girdisi (klavye/ekran okuyucu). Kartın içinde "🎯 Kilitle".
  (playnuance.com tarzı, kullanıcı isteği 2026-10-25.)
  **Her turda girdi rastgele bir renkten başlar** (dokunmadan gönderen ortadan puan alamasın).
  Süre dolunca o anki renk kendiliğinden gönderilir; "Rengimi gönder" ile erken gönderilir.
- Hedefler: HSB'de ton düzgün dağılımlı, doygunluk ve parlaklık 25–100 (neredeyse siyah / gri yığını olmasın).

**Puan (kullanıcı kararı: algısal CIEDE2000)**
- RGB → doğrusal sRGB → XYZ (D65) → CIELAB → **ΔE00** (Sharma–Wu–Dalal 2005, kL = kC = kH = 1).
- Tur puanı = `round(1000 / (1 + (ΔE/12)²))` → aynı renk 1000, ΔE 5 → 852, ΔE 10 → 590, ΔE 20 → 265, siyah–beyaz (ΔE 100) → 14.
- Sonuç (Chroma) = 5 turun ortalaması, yuvarlanmış, 0–1000. Seviyeler: <400 Acemi, 400–600 Orta, 600–750 İyi, 750–880 Uzman, 880+ Elit.
- Gerekçe: playnuance.com'un RGB-uzaklığı formülü (`1000 × (1 − d/441.67)^2.3`) gözün algısıyla örtüşmez (koyu tonlarda
  fark abartılır, yeşilde küçümsenir) ve "hep orta gri" stratejisi puan toplar. ΔE00 ile orta gri rastgele hedeflere karşı
  ortalama ~170 alır (birim test < 300'ü zorlar). Eski formül `scorePlaynuance` adıyla sadece karşılaştırma için duruyor.

**Sonuç ekranı**: her tur hedef karesi + oyuncunun karesi, iki hex, tur puanı; toplam + seviye; paylaşım
`Tosun Nüans #12 · 812/1000 (Uzman)`.

### 4.6 🔊 Ton Avı (perde hafızası) — kullanıcı ile netleşti (2026-10-24)

İstemci `public/games/tone.js` (+ `tone-audio.js`), lobi modülü `server/games/tone.js`; motor §4.4 ile ortak.

**Kurallar**
- 5 tur. Sinüs tonu (Web Audio `OscillatorNode`, ses dosyası yok, 30 ms açılış/kapanış rampası, ılımlı seviye;
  `localStorage['tss:volume']` 0–1, varsayılan 0.6) **3 sn** çalar, nabız/dalga animasyonuyla; **tekrar dinlenemez**.
  Tarayıcı sesi kilitlemişse "🔊 Sesi aç ve dinle" düğmesi kalan süreyi çalar.
- Hatırlama: 30 sn. Siyah sahne + parlak dalga şeritleri (canvas, `public/games/tone-wave.js`; dialed.gg tarzı): bas-tut-kaydır (yukarı tiz, aşağı pes), parmak bastıkça ton canlı çalar
  (pointer olayları, `touch-action: none`); bırakınca ses durur, değer kalır; istediğin kadar dene. Ok tuşlarıyla da ayarlanır.
  Dalgalar perdeyle sıklaşır, basılıyken parlar; ezberde dalga hedeften bağımsızdır (gözle eşleştirilmesin). Kartın içinde "🎯 Kilitle".
  Ped konumu → frekans **logaritmik** (eşit kaydırma = eşit sent). **Her turda ped rastgele bir perdeden başlar.**
- Modlar: **Kolay** 80–1200 Hz, Hz değeri ayar sırasında görünür; **Zor** 60–1400 Hz, değer gizli. Günlük = Kolay.
- Hedefler: mod aralığında logaritmik frekansta (sent) düzgün dağılım, 0.1 Hz'e yuvarlanır. Tahmin aralığa kırpılır.

**Puan (perde aralığına göre; frekanstan ve moddan bağımsız)**
- `c = |1200 · log2(tahmin / hedef)|` (sent).
- Tur puanı = `10 × max(exp(−(c/140)²), 0.75 · exp(−c/390))`, 2 ondalık (0.00–10.00). Toplam = 5 turun toplamı (0–50).
- Sabitler: σ = 140 sent (dar Gauss: yakın tahmin cömert ödüllenir), kuyruk 0.75 · e^(−c/390) (uzak tahmin de biraz alır).
  Sabitlenmiş değerler: 10 sent → 9.95, 50 → 8.80, 100 (yarım ton) → 6.00, 200 → 4.49, 1200 (oktav) → 0.35.
- Gerekçe: önceki ERB-aralığına-normalize formülde Zor'un geniş aralığı Zor'u Kolay'dan **kolay** yapıyordu ve alçak notalar
  fazla hoşgörülüydü. Sent farkı kulağın perde algısıyla aynı ölçektir; Zor sadece aralık ve gizli Hz ile zorlaşır.

**Sonuç ekranı**: her tur hedef Hz – senin Hz, işaretli sent farkı + yorum ("Biraz pes", "Yarım ton tiz", "Yaklaşık bir oktav pes"…),
tur puanı; **sadece sonuç ekranında** hedefi/kendi tonunu tekrar çalma düğmeleri (▶); paylaşım `Tosun Ton Avı · 38.42/50`.

### 4.5–4.6 ortak: modlar, protokol ve kabul kriterleri

**Tek oyunculu (HTTP, Wordle gibi; `server/recall.js`)** — 📅 Günlük (İstanbul günü, herkese aynı hedefler, tek hak,
arkadaş sıralaması) ve ♾️ Sınırsız (rastgele, zorluk seçilir, sıralama yok). Uçlar `POST /api/recall/<nuance|tone>/<uç>`,
gövdede `playerId, token`:

| Uç | Alanlar | Yanıt |
|---|---|---|
| `start` | `mode: 'daily'\|'free', difficulty` | oyun: `gameId, difficulty, memorizeMs, recallMs, played[], pending, done, total, puzzleNo?` — hedef yok |
| `round` | `mode, gameId, round` (0'dan) | **o turun hedefi** (bir kez); `startedAt` kaydedilir; başlamış tur tekrar başlatılamaz, tur atlanamaz |
| `submit` | `mode, gameId, round, guess` | sunucu puanlar; `startedAt + ezber + hatırlama + 3 sn` sonrası gelen cevap sayılmaz (0, `timedOut`) |
| `leaderboard` | — | bugünün bitirenleri (toplama göre); tur ayrıntıları (hedef/cevap) sadece kendi oyununu bitirene görünür |

- Günlük hedefler `HMAC-SHA256(recallSalt, "tosun-<oyun>-v1:<tarih>:<tur>")`'dan türetilir: bir turun hedefi açılınca
  sonraki turlar hesaplanamaz. Tuz `data/secrets.json` → `recallSalt` (testler `RECALL_SALT`; `FAKE_TODAY` Wordle'daki gibi).
  1 numaralı günlük: 2026-10-24. Sonuçlar `data/recall-daily.json` (başlamış tur da kaydedilir; yeniden başlatma turu sıfırlamaz).
- Cevaplanmadan bırakılan tur, süresi geçince 0 sayılır. Sayfa yenilenirse süren turda hedef tekrar gösterilmez.
- Süreler `TIME_SCALE` ile ölçeklenir (yanıttaki `memorizeMs/recallMs` ölçekli).

**Çok oyunculu (lobi)** — 1–12 kişi (tek kişi de oda açıp başlatabilir). Ayarlar: tur 3–10 (varsayılan 5), zorluk, hatırlama 15–60 sn (varsayılan 30).
Herkes aynı hedefleri aynı anda görür. Her tur fazları (isimli zamanlayıcılar):
`memorize` (hedef görünümde, `endsAt`) → `recall` (hedef **yok**, herkes cevaplar; kimin gönderdiği görünür, cevapları görünmez;
herkes gönderince hemen biter) → `reveal` (hedef + herkesin cevabı ve puanı yan yana; host "Sonraki" veya 20 sn sonra otomatik)
→ … → `over` (toplam sıralaması: Nüans ortalama 0–1000, Ton Avı toplam 0–50).
- Eylemler: `{ type: 'submit', round, guess }`, `{ type: 'next', round }` (sadece host). `round` güncel tur değilse eylem
  **sessizce yok sayılır** (geç otomatik gönderim, çift dokunma). Ezberde gönderim, çift gönderim, bozuk değer hata verir;
  Ton Avı tahmini aralığa kırpılır.
- İstemci kendi süresi dolunca son değeri otomatik gönderir; sunucu `endsAt + 2 sn`'ye kadar kabul eder; göndermeyen 0 alır.
- Ayrılan oyuncu çıkarılır; kalanların hepsi göndermişse tur hemen biter.
- İstemci kancası: `mountLobby(..., { patchGame(view, ctx) })` true dönerse ekran baştan çizilmez (kaydırıcı/ped sürüklenirken
  başkası cevap verince sürükleme kopmasın).

**Kabul kriterleri**
- Hedef hiçbir görünümde `recall` fazında yok; tek oyunculuda hedef sadece `round` yanıtında, bir kez.
- Başka oyuncunun o turdaki cevabı `reveal` öncesi hiçbir mesajda yok; sıralamada başkalarının cevapları ancak bitirince.
- Puanlar sunucuda hesaplanır; birim testler formülleri sabitler (bkz. `tests/unit/recall.test.mjs`).
- Günlük: kişi başı günde bir deneme; sunucu yeniden başlasa da ilerleme korunur.
- Gizli hedef (2026-10-31): Nüans'ta (tek + lobi, her zorluk) ve Ton Avı **Zor**'da hedef ezberde JSON'da yok; `round` yanıtı /
  lobi `memorize` görünümü `media: '/api/media/<jeton>'` taşır (lobide oyuncu başına ayrı jeton). Nüans: 64×64 RGB PNG, her
  pikselde her kanala ±3 gürültü (her istek yeni tohum; göz damlası yaklaşık değer verir), istemci diskte yumuşak büyütür.
  Ton Avı Zor: sinüs WAV (30 ms rampa, mono 22050 Hz, uzunluk = ezber süresi), istemci `decodeAudioData` + `tss:volume`
  ile çalar, ses kilidi akışı aynı. Kolay modda Hz sayısı gider (osilatör). Açıklama/sonuçta kesin hex / Hz görünür.
- 360 px'te yatay kaydırma yok, dokunma hedefleri ≥ 44 px; e2e'de konsol hatası yok.

### 4.7 👁️ Algıla (günlük algı testi, perceptle.com tarzı) — 2026-10-26

Tek oyunculu (aşağıda) + lobili çok oyunculu (bölüm sonunda, 2026-10-29). Tek oyunculu sunucu `server/perceptle.js`, saf matematik `public/perceptle-math.js` (sunucu ve istemci ortak),
istemci `public/games/perceptle.js` (akış) + `public/games/perceptle-tests.js` (beş testin canvas ekranları), tık sesi `tone-audio.js`.

**Puan**: her test `round(100 · e^(−½·(hata/tolerans)²))` (0×tol → 100, 0.5× → 88, 1× → 61, 2× → 14). Sonuç = 5 testin ortalaması
(yuvarlanmış). Notlar: S 95–100, A 85–94, B 70–84, C 55–69, D 40–54, F 0–39. Paylaşım `Tosun Algıla #3 · 87 (A)` + 5 kare
(🟩 ≥ 85, 🟨 ≥ 55, 🟥 diğer); Cuma'da başlığa 🃏.

**Testler** (hep bu sırayla; girdi asla doğru cevaptan başlamaz) — tolerans Normal / 🃏 Cuma:
1. 🔢 **Say** — 45–85 üst üste binmeyen nokta (yarıçap genişliğin %1.2–2.6'sı) 2 sn görünür; büyük sayısal kutuya tahmin (0–999, boş başlar).
   Hata `|tahmin − gerçek| / gerçek`; 0.20 / 0.32. Cuma: noktalar 0.12–0.30 birim/sn hızla kayar, duvarlardan seker.
2. ☄️ **Yörünge** — saha 1000 × 700 birim, zemin çizgisi. Top atılır, uçuşun %38–52'si (en az 0.55 sn) yayı çizilerek görünür, sonra
   kaybolur (yay kalır). Oyuncu sahada dokunur/kaydırır (x'e eşlenir), "🎯 Kilitle". Hata `|x − iniş|` birim; 60 / 90.
   Normal: g = 600, duvar yok, iniş 40–960. Cuma: g = 320, top yan duvarlardan seker (1–2 yansıma, iniş yansımalarla hesaplanır).
3. 📐 **Açı** — hedef sayı ("137°") + sağa bakan kesikli 0° çizgisi; sürükleyince çizgi parmağı izler (saat yönünün tersine), canlı yay
   var ama değer yazmaz; başlangıç hedefe ≥ 40° uzak rastgele. Normal: 10–350°, bırakınca (veya Kilitle) gönderilir, hata en kısa yay
   (359↔1 = 2°); 8°. Cuma: 30–1080°, sarım (tur) sayılır, yay sarmal çizilir, bırakmak göndermez (yeniden tutmak için) → Kilitle; hata düz fark; 14°.
4. 🥁 **Ritim** — BPM 80–140. 1.5 sn hazırlık, 4 duyulur tık (0, I, 2I, 3I; birlikte vurmak isteğe bağlı = ısınma), sonra 8 sessiz vuruş
   oyuncunun: Normal 4I…11I, Cuma vuruş aralarında 4.5I…11.5I. Büyük ped + Boşluk tuşu. Gecikme = ısınma dokunuşlarının (3.5I öncesi,
   −I/2 sonrası) en yakın duyulur vuruşa göre medyan sapması (yoksa 0), ±150 ms. Her sessiz dokunuş en yakın beklenen vuruşa eşlenir;
   vuruş başına en iyi |sapma − gecikme| (≤ 250), eksik vuruş 250 ms, aynı vuruşa fazladan her dokunuş ek bir 250 ms terimi (rastgele
   dokunma ödüllenmesin). Hata = RMS; 60 / 85 ms. İstemci ilk duyulur vuruşa göre ms dizisi (≤ 40) yollar; sunucu kendi BPM'iyle hesaplar.
5. ✂️ **Böl** — çizgi + istenen kesir ("3/7", payda 2–12, sadeleşmiş) ya da yüzde ("%42", %3–97). İşaretçi rastgele yerden başlar
   (hedefe ≥ 0.15), kaydırılır, Kilitle. Hata `|konum − hedef|` (çizgi boyu = 1); 0.05. Cuma: değer −0.5…0 ya da 1…1.5 (8/5, −1/4, %130,
   −%20); çizgi sahnenin ortadaki %50'si, uzantı kesikli; 0.10.

**Modlar ve protokol** — 📅 Günlük (İstanbul günü, herkese aynı, tek hak; Cuma günleri otomatik "🃏 Cuma kuralları"; 1 numara
2026-10-26) ve ♾️ Sınırsız (rastgele, kayıt yok, Normal/Cuma seçilir, kişi başı en fazla 3 açık oyun, sunucuda 5000 üstü "yoğun").
Uçlar `POST /api/perceptle/<uç>`, gövdede `playerId, token`:

| Uç | Alanlar | Yanıt |
|---|---|---|
| `start` | `mode, rules?: 'friday'` | `gameId, puzzleNo?, friday, tests, played[], pending, done, total, grade` — uyaran yok |
| `test` | `mode, gameId, index` (0–4) | **o testin uyaranı** (bir kez) + `showMs, leadMs, timeScale, endsAt`; önceki cevaplanmadan başlamaz |
| `submit` | `mode, gameId, index, answer` | sunucu puanlar; `played[i] = { truth, answer, error, score, detail, label? }` |
| `leaderboard` | — | bugünün bitirenleri (ilk 50 + sen); başkalarının test puanları sadece kendi oyununu bitirene |

- Günlük uyaranlar `HMAC-SHA256(perceptleSalt, "tosun-perceptle-v1:<tarih>:<test>")`'ten; tuz `data/secrets.json` (testler `PERCEPTLE_SALT`).
  Kayıt `data/perceptle-daily.json` (45 günden eskisi silinir). `FAKE_TODAY` sadece `TEST_GAMES=1` ile.
- Gösterim süresi (say 2 sn, yörünge görünür kısım, ritim hazırlık + son sessiz vuruş) bitmeden gelen cevap reddedilir (150 ms pay);
  gösterimden sonra 90 sn + 3 sn pay içinde gelmeyen cevap 0 (`timedOut`), bırakılan test sonradan 0 sayılır. Süreler `TIME_SCALE` ile ölçeklenir.
- Sayfa test sürerken yenilenirse zamanlı uyaran (noktalar, top, ritim) tekrar gelmez (ritim boş gönderilir); açı/böl hedefi tekrar gelir.
- Sonuç ekranı: test başına "Gerçek 63 · Sen 58 · %8 hata" + büyük puan; yörünge/açı/böl için doğru (yeşil) ve senin (pembe) çizimin.
  Final: büyük harf notu, toplam, 5 satır, paylaş, sıralama.

**Kabul**: uyaran sadece `test` yanıtında, bir kez; sıra atlanamaz; erken cevap reddedilir; puanlar sunucuda (`tests/unit/perceptle.test.mjs`
formülleri sabitler); 360 px'te yatay kaydırma yok, dokunma hedefleri ≥ 44 px, sürükleme yüzeyleri `touch-action: none`, canvas DPR'ye göre.
Gizli uyaran (2026-10-31, §3.4 "Gizli uyaran medyası"): **Say** noktaları koordinat listesi değil sunucuda çizilmiş PNG
(`stimulus: { image, size, frames, fps }`; normal 640×640 gri+alfa, kenarı yumuşatılmış; 🃏 Cuma hareketli: 320 px kareler,
15 kare/sn × 2 sn = 31 kare alt alta tek PNG şeridi, istemci gerçek zamana göre kare seçer, INK rengine boyar).
**Yörünge** sadece görünen kısmın örnekleri (`{ samples: [[t, x, y]…] (49 + duvar sekme anları), visible, walls }`); yerçekimi,
hız, iniş hiçbir JSON'da yok; sonuçta `played[i].stimulus` / lobi `history[i].stimulus` = tüm uçuşun 73 örneği + `landing`.
Ritim/Açı/Böl değişmedi (zaten ekranda/duyuluyor). Kalan bilinçli sınırlama: PNG'deki noktalar sayılabilir, örneklere
parabol uydurulabilir (cevap "hazır" değil ama hesaplanabilir).

**Çok oyunculu (lobi, 2026-10-29)** — sunucu `server/games/perceptle.js`, istemci `public/games/perceptle-lobby.js`
(test ekranları yine `perceptle-tests.js`; `perceptle.js` `enter('multi')` ile lobiye geçer). 1–12 kişi (tek kişi de başlatabilir).
Ayarlar (host): `rules: 'normal'|'friday'` (varsayılan: oda İstanbul'da Cuma günü kurulursa 🃏 Cuma, yoksa Normal; host değiştirir), `tests`: virgüllü test listesi (varsayılan hepsi; en az 1, sıra hep
Say, Yörünge, Açı, Ritim, Böl; bilinmeyen/boş → hepsi). Uyaranlar oyun başında **kripto RNG** ile (oda tohumu değil), herkese aynı.
Her test fazları (isimli zamanlayıcılar, `TIME_SCALE` ile ölçekli):
`intro` (ad + kural, 4 sn geri sayım; host `go` ile atlar) → `play` (uyaran **ilk kez burada**; `startAt = şimdi + 0.7 sn`
herkes için aynı sunucu anı, istemci `serverOffset` ile yerel saate çevirip animasyonu/vuruşları o an başlatır;
`recallAt = startAt + gösterim`, `endsAt = recallAt + 30 sn`, sunucu `endsAt + 2 sn`'ye kadar kabul eder; herkes cevaplayınca
hemen biter) → `reveal` (gerçek değer, herkesin cevabı ve puanı, eşit puan eşit sıra; host `next` ya da 12 sn) → … →
`over` (ortalama + S–F notu, test başına puan tablosu, beraberlikte "Berabere").
- Eylemler: `{ type: 'answer', index, answer }`, `{ type: 'go', index }`, `{ type: 'next', index }` (son ikisi sadece host).
  `index` güncel test değilse ya da faz uymuyorsa **sessizce yok sayılır**. `recallAt − 150 ms` öncesi cevap reddedilir
  ("Önce gösterim bitmeli"), çift cevap ve bozuk değer hata verir (temizlik tek oyunculudaki `cleanAnswer`), ritim ≤ 40 sayı,
  ilk duyulur vuruşa göre ölçekli ms; puan `evaluate` ile, Cuma toleransları oda ayarından.
- Gizli bilgi: uyaran sadece `play`'de ve sadece oyunculara (izleyiciye değil); zamanlı uyaranlar (noktalar, top, tempo)
  `recallAt` sonrası görünümden çıkar (yeniden bağlanan tekrar görmez; ritimde boş gönderilir). `play`'de başkaları için sadece
  `answered` (✓); cevaplar ve gerçek değer `history`'de, test bitince.
- Oyun ortası katılan izleyicidir (intro/açıklama/final görür, cevap veremez). Ayrılan oyuncu kalan testlerden 0 alır ve
  sıralamadan düşer; kalanların hepsi cevapladıysa test hemen biter; kimse kalmazsa oyun biter.
- İstemci: girdi düğümü (sürükleme/yazı) aynı görünüm anahtarında korunur (`patchGame` + aynı-öğe önbelleği); süre dolunca
  dokunulmuş son değer otomatik gönderilir; ses kapalıysa Ritim introsunda "🔊 Sesi aç", ritim başladığında hâlâ kapalıysa
  pedde "🔇 Ses kapalı — dokun". Gönderilen cevap 1.5 sn içinde (ya da yeniden bağlanınca) onaylanmazsa bir kez kendiliğinden
  yeniden gönderilir, o da tutmazsa Kilitle tekrar açılır. Host değişince (intro/açıklama) yeni hostun düğmeleri hemen görünür.
- Testler: `tests/swarm/perceptle-lobby.test.mjs`, `tests/e2e/perceptle-lobby.test.mjs` (ekranlar `test-results/perceptle-lobby/`).

### 4.8 ⚽ Tosun Top (HaxBall tarzı gerçek zamanlı futbol) — 2026-10-29

Sadece lobili, 2–8 kişi (1'e 1 olur). Fizik `public/haxball-physics.js` (saf, deterministik; sunucu çalıştırır), sunucu
`server/games/haxball.js`, istemci `public/games/haxball.js`. Altyapı §3.7.

**Bekleme odası**: herkes 🔴 Kırmızı / 🔵 Mavi / 👀 İzle seçer (`lobbyAction {type:'team'}`); host "🔀 Takımları karıştır /
dengele" (`{type:'shuffle'}`, izleyiciler izleyici kalır). Seçmeyenler başlarken az olan takıma konur; iki takımda da en az bir
bağlı oyuncu yoksa başlamaz. Ayarlar (host): süre 2/3/5 dk (3), gol limiti 3/5/sınırsız (3), saha Otomatik/Küçük/Orta
(otomatik: sahada ≤ 4 kişi küçük, fazlası orta).

**Fizik** (HaxBall birimleri, 60 adım/sn, hız birim/adım): oyuncu r 15, top r 10, direk r 8 (sabit disk). İvme 0.1
(şut tuşu basılıyken 0.07), sürtünme oyuncu 0.96 (→ en yüksek hız 2.4 = 144 birim/sn), top 0.99. Ters kütle oyuncu 0.5,
top 1. Disk–disk esnek çarpışma, katsayı iki diskin çarpımı (0.5·0.5); top–duvar 0.5. Şut: tuş basılı ve diskler arası boşluk
≤ 4 ise topa oyuncudan topa doğru +5 hız; sonra 12 adım (200 ms) bekleme. Hız sınırı top 16, oyuncu 6 (tünelleme yok;
top–duvar tarafı adımın başındaki konumdan belirlenir). Küçük saha: top alanı ±370×±170, kale ağzı ±64, ağ derinliği 30,
oyuncu sınırı ±420×±200, orta yuvarlak 70. Orta: ±550×±240, kale ±85, derinlik 35, sınır ±610×±275, yuvarlak 80.
Top sadece kenar çizgileri + ağlarla sınırlı; oyuncular dış sınırla (ağa girmezler, direkler herkese katı).
**Gol**: top kale çizgisini **tamamen** geçince (`|x| − r > w`, ağız içinde); çizgide duran veya direkten dönen top gol değil.
Golcü = topa son dokunan (şut veya çarpışma); rakip kaleye değilse "kendi kalesine".
**Başlama vuruşu**: maç başı Kırmızı, her golden sonra yiyen takım. Herkes diziliş yerine, top ortada; top dokunulana kadar
herkes kendi yarısında, vuruşu yapmayan takım orta yuvarlağa da giremez (yapan girebilir). Saat başlama vuruşunda durur;
vuran takım 5 sn içinde dokunmazsa kısıt kalkar, herkes topa oynayabilir ve saat işler. Gol sevinci 2.5 sn (saat durur).
**Bitiş**: gol limiti → biter; süre dolunca önde olan kazanır, berabereyse ⚡ **altın gol** (ilk gol kazanır; en fazla 3 dk,
sonra berabere). Hükmen: bir takım açıkça ayrılma/atılma (veya 120 sn yer tutma süresinin dolması) ile sahada hiç diski
kalmayınca hemen, ya da bir takımın 30 sn boyunca hiç bağlı oyuncusu olmazsa. 60 sn kimseden girdi gelmezse maç biter
("💤 Kimse oynamadı"). Sonuç ekranı: skor, kazanan, goller (dakika, golcü, kk), takımlar; host "Bekleme odasına dön".
**Kopma / katılma** (arkadaş telefonları kopar-bağlanır): bağlantısı kopan oyuncunun diski girdisiz, donuk (soluk çizilir)
sahada kalır; 20 sn içinde dönerse kaldığı yerden oynar, dönmezse disk kalkar (`view.removed`) ve maçı izler. Bir takımın
bağlı kimsesi yokken saat durur (`view.paused`, HUD "⏸️ Bağlantı bekleniyor"). Oyun ortası katılan izleyicidir.
1.5 sn girdi gelmeyen oyuncu durdurulur.

**Ağ**: sunucu 60 Hz adım, 30 Hz kare: `{t:'frame', s, k, v, c, b:[x,y], p:[x,y,…], f}` — konumlar ×10 tamsayı, `p`
`view.discs` sırasında, `v` disk listesi sürümü (sıra değişince artar; istemci uyuşmayan kareyi o sürümün listesiyle çizer),
`c` saat (sn; eksi = altın gol süresi), `f` şut tuşu basılı disklerin bit maskesi. 8 kişide ~200 bayt (< 1 KB şartı).
`view` (yavaş): faz (kickoff/play/goal/over), skor, goller, diskler, takımlar, benim takımım, saha, sonuç.
Girdi `{t:'input', x, y, k}`: istemci değişince (en sık 33 ms'de bir) + 100 ms kalp atışıyla yollar; sunucu sonlu olmayanı 0
yapar, |(x,y)| > 1 ise birim vektöre indirir, `k` sadece 1/true.
**Ara değer**: top ve diğer diskler sunucu zamanının `gecikme` kadar gerisinden iki kare arasında doğrusal ara değerle çizilir.
Zaman eşlemesi en hızlı gelen kareye göre (yavaş yukarı uyum). `gecikme` uyarlanabilir: kare geliş sarsıntısının tepe izleyen
ortalaması `j` ile `clamp(2j + 25, 50, 150)` ms (LAN ≈ 50 ms). Kare gecikirse son hızla en fazla 100 ms ileri götürülür (donma yok).
**Kendi disk tahmini** (varsayılan açık; `localStorage['tss:hx-predict']='0'` kapatır): istemci ortak fizikle (`predictDisc`:
hareket, direkler, sınır, başlama kısıtı) kendi diskini sunucunun girdiyi işleyeceği adıma kadar (son gelen adım + RTT, yavaş
değişen öndelik) ilerletir ve her adımı geçmişe yazar. Kare gelince sunucunun o adımdaki konumu geçmişle kıyaslanır; fark
kare başına %8 (küçük) / %20 (büyük) eklenir ve geçmiş de kaydırılır; 60 birimden büyük fark (diziliş, itilme) sunucu konumuna geçer.
Tahminli disk topla farklı zaman çizgisinde olduğu için topa 80 birimden yakınken çizim yumuşakça ara değerli (sunucu)
konuma geçer — yoksa sürerken disk topun içine girmiş görünür (ölçüm: %66 → %1). Ölçülen tuş → ekran (masaüstü, vekil):
doğrudan 147 → ~55 ms, RTT 150: 318 → ~40–60 ms, kötü tünel (RTT ~230, sarsıntı 0–150): 391 → ~45 ms ve donma 11/96 → 0.
Ping (2 sn'de bir) HUD'da; 500 ms kare gelmezse veya soket kapalıysa sahnede "📡 Bağlantı koptu, yeniden bağlanıyor…".

**İstemci**: tam ekran sahne (yatay önerilir; dikeyde "📱 Telefonu yan çevir" ipucu, ama saha 90° döner — kendi takımın yukarı
hücum eder, joystick/klavye yönü de döner; saha ≈ 2 kat büyük), yatay dokunmatikte saha sola kayar ve ŞUT sağ boşlukta
durur (kaleyi örtmez), tam ekran düğmesi sadece destekleniyorsa, disklerde baş harfler (tam ad sadece kendi diskinde), tuval DPR'ye göre,
`requestAnimationFrame` ile çizim, sekme gizlenince durur ve sıfır girdi yollar. Telefon: sol tarafta parmağın indiği yerde
beliren joystick (ölü bölge 0.15, uzaklaşınca peşinden gelir), sağda büyük ŞUT (ve sağ %40'a dokunmak da şut); çoklu
dokunuş (Pointer Events), `touch-action: none`. Masaüstü: WASD/oklar + Boşluk/X. HUD: skor, saat, ping, tam ekran, çık.
Test kancası: `action {type:'debugPlace', ball, me}` sadece `TEST_GAMES=1` (üretimde "Bilinmeyen eylem").

**Kabul**: fizik birim testleri (çarpışma, duvar, tünelleme, gol çizgisi/direk, şut/bekleme, başlama kısıtı, determinizm,
girdi temizleme); sürü: 2v2 ve 4v4 tam maç (yapay gecikmeyle), kopma/dönme, izleyici, girdi seli/bozuk girdi, host ayrılması,
paralel odalar, döngü sızıntısı, yük (4 oda × 8 kişi sunucu işlemcisi < %50); e2e: iki yatay + bir dikey telefon, joystick +
ŞUT aynı anda, gol, maç sonu; masaüstü klavye. 360×800 ve 800×360'ta yatay kaydırma yok, dokunma hedefleri ≥ 44 px.

### 4.9 Sonraki aşamalar (P2 kalanı – P4)
Her biri başlamadan önce bu bölüm, aynı ayrıntıda kural + kabul kriteriyle genişletilecek (kullanıcıya danışılarak).
Ön notlar:
- **Tabu:** iki takım; anlatanın telefonunda kart; rakip takımdan bir "gözcü"nün telefonunda da kart + "Yasak!" butonu.
- **Kod Adı:** liderlerin telefonunda renk haritası; takım üyelerinde sadece kelimeler.
- **Çiz Bakalım:** çizgiler sıkıştırılmış nokta paketleri halinde, ≤ 8 KB/mesaj.

## 5. Test ve kalite

- `npm test` → birim + sürü testleri (sunucuyu `TIME_SCALE=0.02 SEED=1 PORT=0` ile kendisi başlatır).
- `npm run e2e` → Playwright tarayıcı testleri (Chrome, 360×800 mobil ve 1280×800 masaüstü).
- Her oyun için en az: tam bir oyun akışı (botlarla), rol/gizli bilgi sızıntı testi, yeniden bağlanma testi,
  geçersiz eylem testi (yanlış faz, yanlış oyuncu, tekrar oy), eş zamanlı eylem testi.
- Hata raporu formatı: **adımlar → beklenen → gerçekleşen → kanıt (log/ekran görüntüsü yolu) → önem (kritik/yüksek/orta/düşük)**.
