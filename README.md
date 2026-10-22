# 🎵 Tosun Style Shazam

Arkadaşlarla oynanan şarkı tahmin oyunu (Heardle / melodicx tarzı). Şarkı önce 0.5 sn çalar,
bilemezsen veya geçersen süre uzar: 1.5 → 5 → 10 → 20 sn (melodicx ile aynı). Ne kadar erken bilirsen o kadar çok puan.

## Çalıştırma

```bash
npm start          # http://localhost:3000
PORT=8080 npm start
```

Harici paket yok, Node 18+ yeterli. Sunucu `0.0.0.0` üzerinde dinler; aynı ağdaki TV/telefondan
`http://<bilgisayar-ip>:3000` ile de açılır.

## Desteklenen linkler

| Kaynak  | Playlist | Albüm | Tek şarkı | Ses |
|---------|:-:|:-:|:-:|---|
| Spotify | ✅ | ✅ | ✅ | Spotify'ın 30 sn önizlemesi; yoksa Deezer'da aranır |
| YouTube | ✅ | — | ✅ | Gizli YouTube oynatıcı, tur sonunda video görünür |
| Deezer  | ✅ | ✅ | ✅ | 30 sn önizleme |

Bilinen sınırlar:
- Spotify playlistlerinden en fazla 100 şarkı gelir (embed sayfası sınırı), YouTube playlistlerinden en fazla 200.
- Sahibi gömmeye izin vermeyen YouTube videoları otomatik atlanır.
- Spotify'da önizleme yalnızca 30 sn olduğu için "rastgele yer" seçeneği bu 30 sn içinden seçilir.

## Modlar

Ana ekranda seçilir:

- **🏆 Yarışma** — aşağıdaki puanlı, sıralı oyun.
- **🎧 Serbest** — puan, sıra, tahmin kutusu yok (melodicx mantığı). Süre butonlarıyla (0.5 / 1.5 / 5 / 10 / 20 sn)
  istediğin uzunluğu istediğin kadar çal, **Cevabı göster** ile şarkıyı aç, **Sonraki** ile geç.
  Liste bitince karıştırılıp baştan başlar.

## Yarışma modu

- Oyuncular sırayla oynar, her tur bir oyuncunun.
- Şarkının adını yazarsın. Kontrol Türkçe karakterlere, büyük/küçük harfe, "(feat. …)", "- Remastered",
  "(Official Video)" gibi eklere ve ufak yazım hatalarına takılmaz. Sanatçı + şarkı adı yazmak da olur.
- Sistem doğru bir cevabı haksız yere reddederse tur sonunda o tahminin yanındaki **Doğru say** ile kabul edilir.
- Puan: 1. adımda bilen 5, son adımda bilen 1 puan alır (süreler sabit: 0.5 / 1.5 / 5 / 10 / 20 sn).
- Kısayol: tahmin kutusu boşken **Enter** = şarkıyı çal.

## Yapı

- `server.js` — statik dosyalar + `/api/resolve`, `/api/yt-meta`, `/api/deezer-search`, `/api/spotify-cover`
- `public/app.js` — kurulum, oyun akışı, tahmin kontrolü, ses / YouTube oynatma
- `?debug` ile açınca oyun durumu konsolda `window.tss` olarak erişilebilir.

## Sonraki adım

Online mod: oda kodu, herkes kendi telefonundan tahmin yazar (WebSocket).
