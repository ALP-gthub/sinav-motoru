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
- **Havuz:** Soru bankası. Her soru bir satır: `soru_id` (KONU-NNNN, ör. PLC-0042), `surum`, `durum` (TASLAK, ONAYLI, ESKI), `konu`, `bolum`, `zorluk`, `grup`, `grup_notu` ve `grup_gorsel` (birden fazla soruda ortak şekil), `soru`, `gorsel`, `tur` (`coktan` ya da `sayi`), `A` … `E`, `dogru`, `tolerans`, `birim`, `gerekce`, `kaynak`. Onaylı bir soru değiştirilmez; panelden yeni sürümü açılır, eski sürüm saklanır.
- **Kodlar:** MERKEZ, FIRMA ve KONU kısa kodları ve tam adları.
- **Sinavlar:** Her sınav bir satır. `kod` (MERKEZ-FIRMA-KONU-NNN), `durum` (TASLAK, ONAYLI, ARSIV), `baslik`, `alt_baslik`, `sure_dk`, `aciklama` (talimatlar; `{soru_sayisi}` ve `{sure_dk}` yer tutucuları kullanılabilir), `kvkk_metni`, `firma_sor`, `gorev_sor`, `bilmiyorum`, `sik_karistir`, `gorsel_klasor_id`, `hazirlayan`.
- **Sinav_Sorulari:** Sınavın hangi soruların hangi sürümünden oluştuğu.
- **Formlar:** Her sınavın formları (A, B, C …): soru sırası ve şık yerleşimi. Sorular aynı kaldığı için sonuçlar formlar arasında karşılaştırılabilir.
- **Kullanim:** Kâğıt üzerinde yapılan sınavların kaydı (tarih, form, kişi sayısı).
- **Oturumlar:** Panelden açılan oturumlar, ortak kodları ve kullanılan form.
- **Davetler:** Her katılımcının kişisel kodu ve durumu (ortak kodla girenler dahil).
- **Sonuclar:** Her katılımcı için doğru, yanlış, boş, puan ve bölüm bazında sonuç.
- **Detay_<SINAV KODU>:** Otomatik açılır; soru kodu bazında verilen cevaplar, doğrular yeşil, yanlışlar kırmızı.

## Soru havuzu ve sınav hazırlama

Paneldeki **Sınavlar** sekmesinde merkez, firma ve konu seçilerek yeni sınav hazırlanır. Her soru için kaç sınavda ve oturumda kullanıldığı, ölçülen doğru oranı ve seçilen firmanın o soruyu daha önce görüp görmediği gösterilir. "Öner" bölümlere orantılı dağıtır; firmanın görmediği ve az kullanılan soruları öne alır, ortak şekilli soruları bölmez. Sınav taslak olarak kaydedilir, onaylanınca oturumlarda kullanılabilir. Aynı firmaya daha önce verilmiş bir sınavın birebir aynısı onaylanamaz.

Aynı çalışma içinde sınav tekrarlanacaksa sınav sayfasındaki "Yeni form oluştur" ile soruların sırası (bölüm içinde) ve şıkların yeri değişen yeni bir form üretilir.

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
