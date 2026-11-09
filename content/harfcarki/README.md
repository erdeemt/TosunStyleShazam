# 🔤 Harf Çarkı ipucu bankası

`clues.json` → `{ version, clues: [{ id, letter, mode, clue, answer, alt, category, difficulty }] }`. Kurallar: PLAN.md §4.13.

- **letter**: çarktaki 28 harf (Ğ yok). `I` noktasız, `İ` noktalı.
- **mode**: `starts` (cevap harfle başlar) | `contains` (harfi içerir ama onunla başlamaz; sadece I, J, Ö, Ü, V, Z).
- **id**: `<kod>-<sıra>`; kod Ç→CH, I→IH, İ→I, Ö→OE, Ş→SH, Ü→UE. Kimlikler kalıcı (görülen ipucu geçmişi bunlara bakar):
  ipucu silinirse kimliği yeniden kullanma, yeni ipucuna harfin en büyük numarasından sonrakini ver.
- **alt**: kabul edilen ek yazımlar (Türkçe karakter / büyük-küçük / boşluk / noktalama farkı zaten otomatik). Harf kuralına uymalı.
- **category**: genel, cografya, tarih, bilim, spor, sinema, muzik, edebiyat, yemek, doga, deyim, populer.
- **difficulty**: 1 herkes bilir, 2 genel kültür, 3 meraklısı bilir.

Doğrulama: `node content/harfcarki/validate.mjs` (0 hata olmalı; birim testi de çalıştırır). Denetlenenler: şema, harf kuralı,
harf içinde tekrar eden cevap/alt, cevabın (kökünün) ipucunda geçmesi, cevabın bir kategori etiketiyle aynı olması, ipucu
uzunluğu (≤150), harf başına ≥80; uyarılar: belirsiz kalıplar ("bir tür", "bir şey", "vb."), harften bahseden ipucu,
3 kelimeden uzun cevap, boşluksuz deyim ipucu.

## Kaynaklar

Tüm ipuçları bu proje için özgün olarak Türkçe yazıldı (2026-11, 2777 ipucu). Sözlük/ansiklopedi ya da televizyon yarışması
metni kopyalanmadı; Vikisözlük (CC BY-SA) metni kullanılmadı. Kelime anlamlarında TDK Güncel Türkçe Sözlük yazımı esas alındı.
