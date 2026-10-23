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
| `backToLobby` | — | Host: oyun bitince bekleme odasına dön. |

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
- Sıralama `GET /api/daily/:game/:date`. Arkadaş ortamı: güven modeli gevşek ama sunucu, sonucun o günün
  bulmacasıyla tutarlı olduğunu doğrulamalı (ör. Wordle: sunucunun gördüğü tahmin geçmişinden puan hesaplanır).

## 4. Oyun kuralları ve kabul kriterleri

### 4.1 🕵️ Casus Kim? (P1)

- 3–12 oyuncu. Her turda rastgele bir **mekân** (≥ 40 mekân, her biri 6–10 rol: "Hastane → Doktor, Hemşire, Hasta…").
- 1 casus (9+ oyuncuda ayarla 2 casus seçilebilir). Casus olmayanlar mekânı ve kendi rolünü görür; casus sadece "Casussun" görür
  ve tahmin için **tüm mekân listesini** görür.
- Tur süresi (varsayılan 8 dk) sayaç olarak herkeste görünür. İlk soruyu kim soracak rastgele gösterilir.
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
- 5–12 oyuncu. Vampir sayısı otomatik: 5–7 → 1, 8–10 → 2, 11–12 → 3 (host ayarda 1–3 arası elle de seçebilir;
  vampir sayısı her zaman köylü tarafından az olmalı).
- Özel roller (host her oyunda açıp kapatır, varsayılan hepsi açık): 🩺 **Doktor**, 🔮 **Gözcü**, 🤡 **Deli**.
  Her özel rolden en fazla bir tane; kalanlar 🧑‍🌾 **Köylü**. Vampirler birbirini bilir; başka kimse kimseyi bilmez.
- Ayarlar: gündüz tartışma süresi (2–8 dk, varsayılan 4), savunma süresi (15–60 sn, varsayılan 30),
  gece süresi (30–120 sn, varsayılan 60), vampir sayısı (otomatik / 1 / 2 / 3), roller.

**Gece** (ekranda yazı; ses yok)
- Herkesin ekranında aynı anda bir görev ve aynı görünüm olur — kimin dokunduğundan rol anlaşılmasın:
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
  yargılama başlar (destek gelmezse aday düşer, 30 sn sonra veya yeni aday gelince). Aynı anda tek aday.
- **Yargılama:** tartışma saati durur → aday "savunma süresi" kadar konuşur → yaşayanlar (aday hariç) "Asılsın mı?" Evet/Hayır;
  oy vermeyen Hayır sayılır; **oy hakkı olanların yarısından fazlası Evet** derse asılır ve gece başlar; değilse tartışma kaldığı yerden sürer.
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

### 4.4 Sonraki aşamalar (P2 kalanı – P4)

Her biri başlamadan önce bu bölüm, aynı ayrıntıda kural + kabul kriteriyle genişletilecek (kullanıcıya danışılarak).
Ön notlar:
- **Tabu:** iki takım; anlatanın telefonunda kart; rakip takımdan bir "gözcü"nün telefonunda da kart + "Yasak!" butonu.
- **Kod Adı:** liderlerin telefonunda renk haritası; takım üyelerinde sadece kelimeler.
- **Online Shazam:** sunucu şarkıyı ve başlangıç anını seçer; istemciler sesi kendileri çalar (sunucu saati ile senkron).
- **Çiz Bakalım:** çizgiler sıkıştırılmış nokta paketleri halinde, ≤ 8 KB/mesaj.

## 5. Test ve kalite

- `npm test` → birim + sürü testleri (sunucuyu `TIME_SCALE=0.02 SEED=1 PORT=0` ile kendisi başlatır).
- `npm run e2e` → Playwright tarayıcı testleri (Chrome, 360×800 mobil ve 1280×800 masaüstü).
- Her oyun için en az: tam bir oyun akışı (botlarla), rol/gizli bilgi sızıntı testi, yeniden bağlanma testi,
  geçersiz eylem testi (yanlış faz, yanlış oyuncu, tekrar oy), eş zamanlı eylem testi.
- Hata raporu formatı: **adımlar → beklenen → gerçekleşen → kanıt (log/ekran görüntüsü yolu) → önem (kritik/yüksek/orta/düşük)**.
