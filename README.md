# Sınav Motoru

Eğitim sınıfları için web tabanlı sınav altyapısı. Katılımcı, kendisine gönderilen kişiye özel bağlantıyı açar, bilgilerini girer ve sınavı kendi cihazında çözer. Sonuçlar yalnızca eğitmenin Google E-Tablosuna yazılır; katılımcıya puan gösterilmez.

Bu depoda **hiçbir soru, cevap ya da sınava özel metin yoktur.** Depo yalnızca sınavı gösteren motoru içerir.

## Katılım

- **Ortak kod (önerilen):** E-Tablodaki **Sınav > Yönetim paneli** ile bir oturum açılır: sınav, firma, eğitim merkezi, kişi sayısı ve giriş saatleri. Sistem 6 karakterlik bir kod, bir bağlantı ve bir karekod üretir. Herkes aynı kodla girer; her katılımcıya girişte ayrı ve gizli bir kişisel kod verilir, sınavı ve sonucu yalnızca kendisine aittir. Kişi sayısı dolunca ya da giriş saati geçince yeni giriş kabul edilmez; oturum panelden kapatılabilir.
- **Kişiye özel bağlantı:** **Sınav > Kişiye özel davet bağlantısı oluştur** ile her kişiye ayrı bağlantı.

Yönetim panelinde oturumların canlı durumu ve her oturum için rapor bulunur: puan dağılımı, ortalama ve medyan, bölüm bazında başarı, soru bazında doğru oranı ve en sık seçilen yanlış şık, katılımcı listesi. Panel yalnızca E-Tablonun sahibi tarafından açılabilir; web uygulaması üzerinden çağrılamaz.

## Nasıl çalışır

| Parça | Nerede | İçinde ne var |
|---|---|---|
| Sınav sayfası | GitHub Pages (`docs/`) | Giriş ekranı, soru gösterimi, sayaç, gönderim. Soru yok. |
| Arka uç | Google Apps Script (`google/Code.gs`) | Davet kodunu doğrular, soruları verir, puanlar, sonucu yazar. |
| Soru bankası ve sonuçlar | Eğitmenin gizli Google E-Tablosu | Sınavlar, sorular, cevap anahtarı, davetler, sonuçlar. |
| Görseller | Eğitmenin gizli Google Drive klasörü | Soru şekilleri. |

Gizlilik:

- Sorular yalnızca geçerli, kişiye özel bir davet koduyla açılır. Kodsuz ya da yanlış kodla hiçbir soru gelmez.
- Cevap anahtarı tarayıcıya hiç gönderilmez; puanlama Google tarafında yapılır.
- Bir bağlantıyla sınav bitirildikten sonra aynı bağlantı tekrar açılamaz.
- Şıkların sırası her katılımcı için farklı karıştırılır (sınav ayarıyla kapatılabilir).
- Cevaplar işaretlendikçe kaydedilir; bağlantı koparsa aynı bağlantıyla kaldığı yerden devam edilir, süre işlemeye devam eder. Süre bitince cevaplar otomatik gönderilir.

## E-Tablo sekmeleri

- **Ayarlar:** `sinav_sayfasi` satırında bu sayfanın adresi.
- **Sinavlar:** Her sınav bir satır. `kod`, `baslik`, `alt_baslik`, `sure_dk`, `aktif` (EVET/HAYIR), `aciklama` (katılımcıya gösterilen talimatlar; numaralı satırlar liste olur), `kvkk_metni`, `firma_sor`, `gorev_sor`, `bilmiyorum` (her soruya "Bilmiyorum" seçeneği), `sik_karistir`, `gorsel_klasor_id`, `hazirlayan` (sınav bilgilerinin altında gösterilir).
- **Sorular:** Her soru bir satır. `sinav`, `no`, `bolum`, `grup_notu` ve `grup_gorsel` (birden fazla soruda ortak şekil), `soru`, `gorsel`, `tur` (`coktan` ya da `sayi`), `A` … `E`, `dogru`, `tolerans` ve `birim` (sayı girişli sorular için).
- **Oturumlar:** Panelden açılan oturumlar ve ortak kodları.
- **Davetler:** Her katılımcının kişisel kodu ve durumu (ortak kodla girenler dahil).
- **Sonuclar:** Her katılımcı için doğru, yanlış, boş, puan ve bölüm bazında sonuç.
- **Detay_<SINAV KODU>:** Otomatik açılır; soru bazında verilen cevaplar, doğrular yeşil, yanlışlar kırmızı.

Yeni bir firma ya da konu için kod değişikliği gerekmez: Sinavlar sekmesine bir satır, Sorular sekmesine soruları ekleyip davet bağlantısı oluşturmak yeterlidir.

## Kurulum

1. Soru bankası dosyasını Google Drive'a yükleyin, açın ve **Dosya > Google E-Tablolar olarak kaydet** deyin.
2. Görselleri Drive'da bir klasöre yükleyin. Klasör adresindeki `folders/` sonrasındaki kimliği Sinavlar sekmesindeki `gorsel_klasor_id` sütununa yazın. Klasörü kimseyle paylaşmayın.
3. E-Tabloda **Uzantılar > Apps Script** açın, `google/Code.gs` içeriğini yapıştırıp kaydedin.
4. **Dağıt > Yeni dağıtım > Web uygulaması** seçin. "Şu kullanıcı olarak yürüt: Ben", "Erişimi olanlar: Herkes". İzinleri onaylayın ve web uygulaması adresini kopyalayın.
5. Bu adresi `docs/config.js` içindeki `SINAV_API` değerine yazın.
6. E-Tabloyu yenileyin ve **Sınav > Yönetim paneli** ile oturum oluşturun. Eksik sekme ve sütunlar ilk kullanımda kendiliğinden eklenir.
7. Kişiye özel bağlantı kullanılıyorsa sınav günü Sinavlar sekmesinde `aktif` değerini EVET yapın; sınavdan sonra HAYIR yapın. Oturumla yapılan sınavlarda bu ayar gerekmez.

`google/panel.html` değiştirildiğinde önce `python3 tools/build.py` çalıştırılır. `Code.gs` değiştirildiğinde **Dağıt > Dağıtımları yönet** ile mevcut dağıtımın yeni sürümünü yayınlayın; adres değişmez.

---

Hazırlayan: ALP ATA
