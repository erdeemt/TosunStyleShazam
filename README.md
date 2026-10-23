# 🎮 Tosun Style

Arkadaşlarla oynanan oyun salonu. Sol menüde **Tek Oyunculu** ve **Çok Oyunculu** kategorileri var;
oyunlar desteklediği kategorilerin altında listelenir. Şimdilik tek oyun var: **🎵 Tosun Shazam**.

## Çalıştırma

```bash
npm start          # http://localhost:3000
PORT=8080 npm start
```

Harici paket yok, Node 18+ yeterli. Sunucu `0.0.0.0` üzerinde dinler; aynı ağdaki TV/telefondan
`http://<bilgisayar-ip>:3000` ile de açılır. `index.html`'i doğrudan açmak çalışmaz (API sunucuda).

### İnternetten oynamak (farklı evlerden)

Domain gerekmeden geçici bir link açılır (Cloudflare Quick Tunnel, ücretsiz, hesap gerekmez):

```bash
winget install Cloudflare.cloudflared   # bir kez
npm run online                          # sunucu + tünel; ekrana paylaşılacak linki yazar
```

Link (`https://xxx.trycloudflare.com`) her açılışta değişir; Ctrl+C ikisini birden kapatır. Sunucu tünel arkasında
gerçek ziyaretçi IP'sini `CF-Connecting-IP` / `X-Forwarded-For` (son öğe) başlığından okur — sadece bağlantı aynı makineden
(loopback) geliyorsa; dışarıdan doğrudan gelen bağlantıda bu başlıklar yok sayılır.

## 🎵 Tosun Shazam

Heardle / melodicx tarzı şarkı tahmini. Şarkı önce 0.5 sn çalar, bilemezsen veya geçersen süre uzar:
0.5 → 1.5 → 5 → 10 → 20 sn. Ne kadar erken bilirsen o kadar çok puan.

| Kategori | Mod | Açıklama |
|---|---|---|
| 👤 Tek Oyunculu | 🎧 Serbest | Puan yok. Süre butonlarıyla istediğin uzunluğu çal, tahmin et, **Cevabı göster**, **Şarkıyı atla**. Liste bitince karışıp baştan başlar. |
| 👤 Tek Oyunculu | 🎯 Puanlı | Tek kişilik skor; seçtiğin sayıda şarkı. |
| 👥 Çok Oyunculu | 🏆 Yarışma | Tek ekran, oyuncular sırayla tahmin eder, skor tablosu. |
| 👥 Çok Oyunculu | 🌐 Online | Yakında — herkes kendi telefonundan. |

- Tahmin yazarken yüklenen şarkılardan öneri listesi çıkar (↑↓ + Enter ile seç, ikinci Enter tahmin eder).
- Kontrol Türkçe karakterlere, büyük/küçük harfe, "(feat. …)", "- Remastered", "(Official Video)" gibi eklere
  ve ufak yazım hatalarına takılmaz. Sanatçı + şarkı adı yazmak da olur.
- Sistem doğru bir cevabı haksız yere reddederse tur sonunda o tahminin yanındaki **Doğru say** ile kabul edilir.
- Puan: 1. adımda bilen 5, son adımda bilen 1 puan alır.
- Farklı playlist/kaynaklardaki aynı şarkı (ad + ilk sanatçı) bir kez sayılır.
- Kısayol: tahmin kutusu boşken **Enter** = şarkıyı çal.

### Desteklenen linkler

| Kaynak  | Playlist | Albüm | Tek şarkı | Ses |
|---------|:-:|:-:|:-:|---|
| Spotify | ✅ | ✅ | ✅ | Spotify'ın 30 sn önizlemesi; yoksa Deezer'da aranır |
| YouTube | ✅ | — | ✅ | Gizli YouTube oynatıcı, tur sonunda video görünür |
| Deezer  | ✅ | ✅ | ✅ | 30 sn önizleme |

Bilinen sınırlar:
- Spotify playlistlerinden en fazla 100 şarkı gelir (embed sayfası sınırı), YouTube playlistlerinden en fazla 200.
- Sahibi gömmeye izin vermeyen YouTube videoları otomatik atlanır.
- Spotify/Deezer önizlemesi 30 sn olduğu için "rastgele yer" bu 30 sn içinden seçilir.

## Yapı

- `server.js` — statik dosyalar + `/api/resolve`, `/api/yt-meta`, `/api/deezer-search`, `/api/spotify-cover`
- `public/games.js` — **oyun kayıt listesi**: kategoriler ve oyunlar (menü ve ana sayfa buradan oluşur)
- `public/shell.js` — sol menü, ana sayfa, `#/kategori/oyun` yönlendirmesi
- `public/shazam.js` — Tosun Shazam (kurulum, oyun akışı, tahmin kontrolü, ses / YouTube oynatma)
- `?debug` ile açınca Shazam durumu konsolda `window.tss` olarak erişilebilir.

### Yeni oyun eklemek

1. `public/<oyun>.js` modülü yaz; `enter(categoryId)` (oyun açılınca, `'single'` veya `'multi'`) ve
   `leave()` (başka sayfaya geçince) fonksiyonlarını export etsin.
2. `index.html`'e `<div id="game-<oyun>" class="hidden">…</div>` kapsayıcısını ekle.
3. `games.js`'teki `GAMES` listesine kaydı ekle; `categories` hangi menü başlıklarında görüneceğini belirler.
   Aynı oyun her iki kategoride olabilir — modlarını `enter`'a gelen kategoriye göre kendisi seçer.

## Sonraki adım

Online mod: oda kodu, herkes kendi telefonundan tahmin yazar (WebSocket). Çok oyunculu oyunların çoğu buna dayanacak.
