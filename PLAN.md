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

Sunucu → istemci:

| `t` | Alanlar |
|---|---|
| `welcome` | `playerId, token, name` |
| `room` | `code, game, hostId, phase ('lobby'\|'playing'\|'over'), players: [{id, name, connected, isHost}], settings` |
| `view` | `view` (o oyuncuya özel oyun görünümü), `seq` |
| `error` | `code, message` (Türkçe, kullanıcıya gösterilebilir) |
| `kicked` | — |

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
  kontrol edilir (`server/matcher.js`, tek oyunculu kontrolle aynı). Sınırlama: ses telefonda çaldığı için YouTube video kimliği
  istemciye gider — geliştirici araçlarıyla bakan biri YouTube şarkısını bulabilir (arkadaş ortamı için kabul edildi).

### 4.5 🎨 Nüans (renk hafızası) — kullanıcı ile netleşti (2026-10-24)

Ortak motor: `server/recall.js` (Ton Avı ile aynı), saf matematik `public/recall-math.js` (sunucu ve istemci aynı dosyayı kullanır),
istemci `public/games/recall-client.js` + `public/games/nuance.js`, lobi modülü `server/games/nuance.js`.

**Kurallar**
- 5 tur. Her turda hedef renk büyük bir karede **Normal 5 sn / Uzman 2 sn** görünür (geri sayımlı), sonra kaybolur.
  Günlük her zaman Normal.
- Hatırlama: 30 sn. Girdi **HSB kaydırıcıları** (Ton 0–360, Doygunluk 0–100, Parlaklık 0–100) + büyük canlı önizleme
  + düzenlenebilir **hex kutusu** (`#RRGGBB`), iki yönlü bağlı. Ton kaydırıcısı gökkuşağı, D/P kaydırıcıları seçili tona göre degrade.
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
- Hatırlama: 30 sn. Büyük dikey ped: bas-tut-kaydır (yukarı tiz, aşağı pes), parmak bastıkça ton canlı çalar
  (pointer olayları, `touch-action: none`); bırakınca ses durur, değer kalır; istediğin kadar dene. Ok tuşlarıyla da ayarlanır.
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

**Çok oyunculu (lobi)** — 2–12 kişi. Ayarlar: tur 3–10 (varsayılan 5), zorluk, hatırlama 15–60 sn (varsayılan 30).
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
- 360 px'te yatay kaydırma yok, dokunma hedefleri ≥ 44 px; e2e'de konsol hatası yok.

### 4.7 Sonraki aşamalar (P2 kalanı – P4)

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
