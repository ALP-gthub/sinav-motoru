# Sınav Motoru

[English](README.md)

Teknik eğitim sınıfları için web tabanlı küçük bir sınav sistemi. Katılımcı bağlantıyı açar
ya da karekodu okutur, bilgilerini girer ve sınavı kendi cihazında çözer. Sonuçlar yalnızca
eğitmenin gizli Google E-Tablosuna yazılır; katılımcıya puan gösterilmez.

**Bu depoda hiçbir soru, cevap ya da sınava özel içerik yoktur.** Depo yalnızca sınavı
gösteren motoru içerir.

## Nasıl çalışır

| Parça | Nerede | Görevi |
|---|---|---|
| Sınav sayfası | GitHub Pages (`docs/`) | Giriş ekranı, soru gösterimi, sayaç, gönderim. Soru yok. |
| Arka uç | Google Apps Script (`google/Code.gs`) | Erişim kodlarını doğrular, soruları verir, puanlar, sonucu yazar. |
| Soru havuzu ve kayıtlar | Eğitmenin gizli Google Drive alanı | Sorular Google Dokümanlarında; sınavlar, oturumlar ve sonuçlar Google E-Tablosunda. |

## Gizlilik ve güvenilirlik

- Sorular yalnızca geçerli bir oturum kodu ya da kişisel kodla verilir.
- Cevap anahtarı tarayıcıya hiç gönderilmez; puanlama sunucuda yapılır.
- Şıkların sırası her katılımcı için karıştırılabilir.
- Cevaplar işaretlendikçe kaydedilir; bağlantı koparsa sınav kaldığı yerden devam eder.
- Soru havuzu kendiliğinden denetlenir. Eksiksiz okunamayan ya da onaydan sonra değişen
  soru karantinaya alınır ve düzeltilene kadar kullanılmaz.

---

Hazırlayan: ALP ATA
