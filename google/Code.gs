/**
 * Sınav motoru: Google Apps Script arka ucu.
 *
 * Bu dosya, sınav sorularının, cevap anahtarının ve sonuçların durduğu
 * Google E-Tablo'ya bağlıdır (Uzantılar > Apps Komut Dosyası). Web uygulaması
 * olarak yayınlanır ve sınav sayfası yalnızca bu adresle konuşur.
 *
 * Katılım iki yolla olur:
 *  - Oturum kodu: Yönetim panelinde oluşturulan ortak kod (bağlantı ya da karekod).
 *    Her katılımcıya girişte ayrı, gizli bir kişisel kod verilir.
 *  - Kişiye özel bağlantı: Sınav menüsünden üretilen tek kişilik bağlantı.
 *
 * Gizlilik kuralları:
 *  - Sorular yalnızca geçerli bir kodla, katılımcı bilgileri girildikten sonra verilir.
 *  - Cevap anahtarı hiçbir zaman tarayıcıya gönderilmez; puanlama burada yapılır.
 *  - Katılımcıya puan gösterilmez; sonuçlar yalnızca bu tabloya yazılır.
 *
 * Sekmeler: Ayarlar, Kodlar (merkez, firma, konu kısa kodları), Havuz (sürümlü soru
 * havuzu), Sinavlar (MERKEZ-FIRMA-KONU-NNN), Sinav_Sorulari, Formlar, Kullanim (kâğıt
 * sınavlar gibi sistem dışı kullanımlar), Oturumlar, Davetler, Sonuclar ve her sınav
 * için otomatik açılan Detay_<SINAV KODU>.
 *
 * Not: Bu dosya google/panel.html'den derlenir (tools/build.py). Yönetim
 * panelinin sayfası dosyanın sonundaki PANEL_HTML değişkenindedir.
 */

// Belgelerde şekil en fazla ~10,9 cm genişlik ve ~8,6 cm yükseklik (orijinal kâğıt kitapçık ölçüleri; Google Dokümanlar piksel kullanır, 96 piksel = 2,54 cm).
var SEKIL_EN_GENIS_PX = 413;
var SEKIL_EN_YUKSEK_PX = 327;
var SURE_TOLERANSI_SN = 120; // Bağlantı gecikmesi için gönderimde tanınan ek süre.
var OTURUM_HARFLERI = "ACDEFGHJKMNPQRTUVWXY34679"; // Karışabilecek harf ve rakamlar yok.

// ---------------------------------------------------------------------------
// Web uygulaması giriş noktaları
// ---------------------------------------------------------------------------

function doPost(e) {
  var cevap;
  try {
    var istek = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    cevap = isle_(istek);
  } catch (hata) {
    cevap = { ok: false, hata: "sunucu", mesaj: String(hata && hata.message ? hata.message : hata) };
  }
  return ContentService.createTextOutput(JSON.stringify(cevap)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, servis: "sinav-motoru" })).setMimeType(
    ContentService.MimeType.JSON
  );
}

function isle_(istek) {
  var islem = istek.islem;
  if (islem === "oturum_bilgi" || islem === "katil") {
    var ok = String(istek.oturum || "").trim().toUpperCase();
    if (!oturumKoduGecerli_(ok)) return { ok: false, hata: "gecersiz_oturum" };
    return islem === "oturum_bilgi" ? oturumBilgi_(ok) : katil_(ok, istek.katilimci || {});
  }
  var kod = String(istek.kod || "").trim();
  if (!/^[a-f0-9]{16,32}$/.test(kod)) return { ok: false, hata: "gecersiz_kod" };
  switch (islem) {
    case "bilgi":
      return bilgi_(kod);
    case "basla":
      return basla_(kod, istek.katilimci || {});
    case "kaydet":
      return kaydet_(kod, istek.cevaplar || {});
    case "bitir":
      return bitir_(kod, istek.cevaplar || {});
    default:
      return { ok: false, hata: "bilinmeyen_islem" };
  }
}

// ---------------------------------------------------------------------------
// Katılımcı işlemleri
// ---------------------------------------------------------------------------

function sinavBilgisi_(s, oturum) {
  return {
    baslik: s.baslik,
    alt_baslik: (oturum && oturum.egitim_merkezi) || s.alt_baslik || "",
    hazirlayan: s.hazirlayan || "",
    sure_dk: Number(s.sure_dk),
    soru_sayisi: sinavSorulari_(s.kod).length,
    aciklama: yerTutucular_(s.aciklama || "", s),
    kvkk: s.kvkk_metni || "",
    firma_sor: evet_(s.firma_sor),
    gorev_sor: evet_(s.gorev_sor),
  };
}

/** Kişisel kodla gelen katılımcının durumunu kontrol eder. */
function davetDurumu_(d, s, o) {
  if (!s) return "sinav_kapali";
  if (d.kayit.durum === "tamamlandi") return "tamamlandi";
  if (d.kayit.oturum) {
    // Oturumla başlamış biri, oturum sonradan kapansa da sınavını bitirebilir.
    if (!o) return "sinav_kapali";
    if (d.kayit.durum !== "basladi") return "sinav_kapali";
    return "";
  }
  if (!evet_(s.aktif)) return "sinav_kapali";
  if (d.kayit.son_tarih && new Date(d.kayit.son_tarih).getTime() < Date.now()) return "suresi_doldu";
  return "";
}

/** Kişisel kodu doğrular; soru göndermeden sınavın genel bilgilerini verir. */
function bilgi_(kod) {
  var d = davetBul_(kod);
  if (!d) return { ok: false, hata: "gecersiz_kod" };
  var s = sinavBul_(d.kayit.sinav);
  var o = d.kayit.oturum ? oturumBul_(d.kayit.oturum) : null;
  var h = davetDurumu_(d, s, o && o.kayit);
  if (h) return { ok: false, hata: h };
  return {
    ok: true,
    sinav: sinavBilgisi_(s, o && o.kayit),
    onceden: { ad: d.kayit.ad || "", soyad: d.kayit.soyad || "", firma: d.kayit.firma || "", gorev: d.kayit.gorev || "" },
    basladi: d.kayit.durum === "basladi",
  };
}

/** Katılımcı bilgisini kaydeder, süreyi başlatır ve soruları cevap anahtarı olmadan verir. */
function basla_(kod, k) {
  var kilit = LockService.getScriptLock();
  kilit.waitLock(20000);
  try {
    var d = davetBul_(kod);
    if (!d) return { ok: false, hata: "gecersiz_kod" };
    var s = sinavBul_(d.kayit.sinav);
    var o = d.kayit.oturum ? oturumBul_(d.kayit.oturum) : null;
    var h = davetDurumu_(d, s, o && o.kayit);
    if (h) return { ok: false, hata: h };

    var simdi = new Date();
    var guncelle;
    if (d.kayit.durum !== "basladi") {
      var ad = temizle_(k.ad, 60);
      var soyad = temizle_(k.soyad, 60);
      if (!ad || !soyad) return { ok: false, hata: "eksik_bilgi" };
      if (k.kvkk !== true && s.kvkk_metni) return { ok: false, hata: "kvkk_onayi_yok" };
      guncelle = {
        ad: ad,
        soyad: soyad,
        firma: temizle_(k.firma, 120),
        gorev: temizle_(k.gorev, 120),
        kvkk_onay: s.kvkk_metni ? simdi : "",
        durum: "basladi",
        baslama: simdi,
        giris_sayisi: 1,
      };
    } else {
      guncelle = { giris_sayisi: Number(d.kayit.giris_sayisi || 1) + 1 };
    }
    satirGuncelle_("Davetler", d.satir, guncelle);
    var baslama = guncelle.baslama || new Date(d.kayit.baslama);
    return sorulariVer_(s, kod, baslama, d.kayit.ara_kayit, d.kayit.form);
  } finally {
    kilit.releaseLock();
  }
}

function sorulariVer_(s, kod, baslama, araKayitMetni, form) {
  var kalan = Math.round(Number(s.sure_dk) * 60 - (Date.now() - baslama.getTime()) / 1000);
  if (kalan <= 0) return { ok: false, hata: "sure_bitti" };
  var araKayit = {};
  try {
    araKayit = araKayitMetni ? JSON.parse(araKayitMetni) : {};
  } catch (e) {
    araKayit = {};
  }
  return {
    ok: true,
    kod: kod,
    kalan_sn: kalan,
    bilmiyorum: evet_(s.bilmiyorum),
    sorular: katilimciSorulari_(s, kod, form),
    cevaplar: araKayit,
  };
}

/** Oturum kodunu doğrular ve soru göndermeden sınav bilgisini verir. */
function oturumBilgi_(okod) {
  var o = oturumBul_(okod);
  var h = oturumDurumu_(o);
  if (h) return { ok: false, hata: h };
  var s = sinavBul_(o.kayit.sinav);
  if (!s) return { ok: false, hata: "sinav_kapali" };
  return {
    ok: true,
    sinav: sinavBilgisi_(s, o.kayit),
    onceden: { ad: "", soyad: "", firma: String(o.kayit.firma || ""), gorev: "" },
    basladi: false,
  };
}

function oturumDurumu_(o) {
  if (!o) return "gecersiz_oturum";
  var k = o.kayit;
  if (String(k.durum).trim().toUpperCase() !== "ACIK") return "oturum_kapali";
  var simdi = Date.now();
  if (k.baslangic && new Date(k.baslangic).getTime() > simdi) return "oturum_baslamadi";
  if (k.bitis && new Date(k.bitis).getTime() < simdi) return "oturum_bitti";
  return "";
}

/** Ortak kodla gelen katılımcıya kişisel, gizli bir kod verir ve sınavını başlatır. */
function katil_(okod, k) {
  var kilit = LockService.getScriptLock();
  kilit.waitLock(20000);
  try {
    var o = oturumBul_(okod);
    var h = oturumDurumu_(o);
    if (h) return { ok: false, hata: h };
    var s = sinavBul_(o.kayit.sinav);
    if (!s) return { ok: false, hata: "sinav_kapali" };
    var ad = temizle_(k.ad, 60);
    var soyad = temizle_(k.soyad, 60);
    if (!ad || !soyad) return { ok: false, hata: "eksik_bilgi" };
    if (k.kvkk !== true && s.kvkk_metni) return { ok: false, hata: "kvkk_onayi_yok" };

    var kontenjan = Number(o.kayit.kontenjan) || 0;
    if (kontenjan > 0) {
      var sayi = tablo_("Davetler").kayitlar.filter(function (r) {
        return String(r.kayit.oturum).trim() === okod;
      }).length;
      if (sayi >= kontenjan) return { ok: false, hata: "kontenjan_dolu" };
    }

    var kod = yeniKisiselKod_();
    var simdi = new Date();
    var form = String(o.kayit.form || "A").trim() || "A";
    satirEkle_("Davetler", {
      kod: kod,
      sinav: s.kod,
      oturum: okod,
      form: form,
      ad: ad,
      soyad: soyad,
      firma: temizle_(k.firma, 120) || temizle_(o.kayit.firma, 120),
      gorev: temizle_(k.gorev, 120),
      durum: "basladi",
      baslama: simdi,
      giris_sayisi: 1,
      kvkk_onay: s.kvkk_metni ? simdi : "",
    });
    return sorulariVer_(s, kod, simdi, "", form);
  } finally {
    kilit.releaseLock();
  }
}

/** Ara kayıt: tarayıcı kapanırsa cevaplar kaybolmasın. */
function kaydet_(kod, cevaplar) {
  var d = davetBul_(kod);
  if (!d || d.kayit.durum !== "basladi") return { ok: false, hata: "kayit_yok" };
  satirGuncelle_("Davetler", d.satir, { ara_kayit: JSON.stringify(cevaplariTemizle_(cevaplar)), son_kayit: new Date() });
  return { ok: true };
}

/** Cevapları puanlar ve sonucu tabloya yazar. Katılımcıya puan dönmez. */
function bitir_(kod, cevaplar) {
  var kilit = LockService.getScriptLock();
  kilit.waitLock(20000);
  try {
    var d = davetBul_(kod);
    if (!d) return { ok: false, hata: "gecersiz_kod" };
    if (d.kayit.durum === "tamamlandi") return { ok: true, zaten: true };
    if (d.kayit.durum !== "basladi") return { ok: false, hata: "baslamadi" };
    var s = sinavBul_(d.kayit.sinav);
    var form = String(d.kayit.form || "A").trim() || "A";
    var temiz = cevaplariTemizle_(cevaplar);
    // Ekrandaki sıra (forma göre) soru kimliklerine, oradan sınavın asıl sırasına çevrilir.
    var cevapId = konumdanKimlige_(s.kod, form, temiz);
    var sorular = sinavSorulari_(s.kod);
    var p = puanla(sorular, kimliktenSiraya_(sorular, cevapId));

    var simdi = new Date();
    var baslama = new Date(d.kayit.baslama);
    var sureSn = Math.round((simdi.getTime() - baslama.getTime()) / 1000);
    var asim = sureSn > Number(s.sure_dk) * 60 + SURE_TOLERANSI_SN;
    var o = d.kayit.oturum ? oturumBul_(d.kayit.oturum) : null;

    satirEkle_("Sonuclar", {
      zaman: simdi,
      sinav: s.kod,
      form: form,
      oturum: d.kayit.oturum || "",
      egitim_merkezi: (o && o.kayit.egitim_merkezi) || "",
      davet_kodu: kod,
      ad: d.kayit.ad,
      soyad: d.kayit.soyad,
      firma: d.kayit.firma,
      gorev: d.kayit.gorev,
      baslama: baslama,
      bitis: simdi,
      sure_dk: Math.round(sureSn / 6) / 10,
      sure_asimi: asim ? "EVET" : "",
      dogru: p.dogru,
      yanlis: p.yanlis,
      bos: p.bos,
      bilmiyorum: p.bilmiyorum,
      toplam: p.toplam,
      puan: p.puan,
      bolumler: p.bolumMetni,
    });
    detayYaz_(s.kod, sorular, d.kayit, p, simdi);
    satirGuncelle_("Davetler", d.satir, {
      durum: "tamamlandi",
      bitis: simdi,
      ara_kayit: JSON.stringify(temiz),
      cevaplar_id: JSON.stringify(cevapId),
      puan: p.puan,
    });
    return { ok: true };
  } finally {
    kilit.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Puanlama (saf fonksiyon; test edilebilir)
// ---------------------------------------------------------------------------

/**
 * sorular: [{no, bolum, tur, dogru, tolerans}]
 * cevaplar: { "<no>": "A" | "B" | "C" | "D" | "E" | "?" (bilmiyorum) | "<sayı>" }
 */
function puanla(sorular, cevaplar) {
  var dogru = 0,
    yanlis = 0,
    bos = 0,
    bilmiyorum = 0;
  var bolumler = {};
  var sira = [];
  var detay = sorular.map(function (q) {
    var c = cevaplar[String(q.no)];
    var b = q.bolum || "Genel";
    if (!bolumler[b]) {
      bolumler[b] = { dogru: 0, toplam: 0 };
      sira.push(b);
    }
    bolumler[b].toplam++;
    var durum;
    if (c === undefined || c === null || c === "") {
      bos++;
      durum = "bos";
    } else if (c === "?") {
      bilmiyorum++;
      durum = "bilmiyorum";
    } else if (dogruMu_(q, c)) {
      dogru++;
      bolumler[b].dogru++;
      durum = "dogru";
    } else {
      yanlis++;
      durum = "yanlis";
    }
    return { no: q.no, cevap: c === undefined ? "" : c, durum: durum };
  });
  var toplam = sorular.length;
  return {
    dogru: dogru,
    yanlis: yanlis,
    bos: bos,
    bilmiyorum: bilmiyorum,
    toplam: toplam,
    puan: toplam ? Math.round((dogru / toplam) * 1000) / 10 : 0,
    bolumler: bolumler,
    bolumSira: sira,
    bolumMetni: sira
      .map(function (b) {
        return b + ": " + bolumler[b].dogru + "/" + bolumler[b].toplam;
      })
      .join(" | "),
    detay: detay,
  };
}

function dogruMu_(q, c) {
  if (q.tur === "sayi") {
    var v = Number(String(c).replace(",", "."));
    var hedef = Number(String(q.dogru).replace(",", "."));
    var tol = Number(String(q.tolerans || "0").replace(",", "."));
    return isFinite(v) && isFinite(hedef) && Math.abs(v - hedef) <= tol + 1e-9;
  }
  return String(c).toUpperCase() === String(q.dogru).trim().toUpperCase();
}

// ---------------------------------------------------------------------------
// Katılımcıya giden soru listesi (cevap anahtarı yok)
// ---------------------------------------------------------------------------

function katilimciSorulari_(s, kod, form) {
  var karistir = evet_(s.sik_karistir);
  var klasor = gorselKlasoru_(s);
  var fqs = formSorulari_(s.kod, form || "A");
  // Ortak şekilli grupların bu sınavdaki/formdaki gerçek soru numaraları.
  var grupNo = {};
  fqs.forEach(function (fq) {
    var g = String(fq.q.grup || "").trim();
    if (g) (grupNo[g] = grupNo[g] || []).push(fq.no);
  });
  return fqs.map(function (fq) {
    var q = fq.q;
    var secenekler = [];
    if (q.tur !== "sayi") {
      var harfler = karistir ? karistir_(fq.siklar.split(""), kod + ":" + q.id) : fq.siklar.split("");
      harfler.forEach(function (h) {
        if (q[h] !== undefined && String(q[h]).trim() !== "") secenekler.push({ id: h, metin: String(q[h]) });
      });
    }
    var g = String(q.grup || "").trim();
    return {
      no: fq.no,
      bolum: q.bolum || "",
      grup_baslik: g && (q.grup_notu || q.grup_gorsel) ? grupBasligi_(grupNo[g], !!q.grup_gorsel) : "",
      grup_notu: q.grup_notu || "",
      grup_gorsel: q.grup_gorsel ? gorsel_(klasor, q.grup_gorsel) : "",
      soru: q.soru,
      gorseller: String(q.gorsel || "")
        .split(",")
        .map(function (x) {
          return x.trim();
        })
        .filter(String)
        .map(function (ad) {
          return gorsel_(klasor, ad);
        }),
      tur: q.tur === "sayi" ? "sayi" : "coktan",
      birim: q.birim || "",
      secenekler: secenekler,
    };
  });
}

/** "Soru 12 ve 13 için ortak şekil" gibi, numaraları sınavın kendi sırasından yazar. */
function grupBasligi_(nolar, sekilli) {
  var n = (nolar || []).slice().sort(function (a, b) { return a - b; });
  var ne = sekilli ? "ortak şekil" : "ortak bilgi";
  if (n.length < 2) return "Soru " + (n[0] || "") + " için " + ne;
  return "Soru " + n.slice(0, -1).join(", ") + " ve " + n[n.length - 1] + " için " + ne;
}

// ---------------------------------------------------------------------------
// Sınav kitapçığı ve cevap anahtarı (Drive: Sınav Sistemi/Sınavlar/<kod - başlık>/)
// ---------------------------------------------------------------------------

function altKlasor_(ust, ad) {
  var it = ust.getFoldersByName(ad);
  return it.hasNext() ? it.next() : ust.createFolder(ad);
}

/** Sınavın Drive klasörü: ana tablonun bulunduğu klasör / Sınavlar / "<kod> - <başlık>". */
/** Kodlar sekmesinde klasör adı (yoksa tam ad, o da yoksa kod). */
function kodKlasorAdi_(tur, kod) {
  var bulunan = String(kod);
  tablo_("Kodlar").kayitlar.forEach(function (r) {
    var k = r.kayit;
    if (String(k.tur).trim().toUpperCase() === tur && String(k.kod).trim().toUpperCase() === String(kod).trim().toUpperCase()) {
      bulunan = String(k.klasor_adi || "").trim() || String(k.ad || "").trim() || bulunan;
    }
  });
  return bulunan.replace(/[\\/]/g, "-");
}

/** Sınav klasörünün adı: "ELK-001 - Endüstriyel Elektrik Teorik Sınavı_1126" (kodun son iki parçası, başlık, açıldığı ay ve yıl). */
function sinavKlasorAdi_(s, tarih) {
  var p = String(s.kod).split("-");
  var kisa = p.slice(-2).join("-");
  var aayy = Utilities.formatDate(tarih || new Date(), SpreadsheetApp.getActive().getSpreadsheetTimeZone() || "Europe/Istanbul", "MMyy");
  return kisa + " - " + String(s.baslik || "").trim() + "_" + aayy;
}

/**
 * Sınavın Drive klasörü: Sınavlar / <merkez> / <firma> / <ELK-001 - başlık_AAYY>.
 * Klasör kimliği Sinavlar sekmesinde tutulur; klasör elle yeniden adlandırılsa ya da taşınsa da bulunur.
 */
function sinavKlasoru_(s) {
  var id = String(s.klasor_id || "").trim();
  if (id) {
    try {
      var k = DriveApp.getFolderById(id);
      if (!k.isTrashed()) return k;
    } catch (e) {}
  }
  var sistem = DriveApp.getFileById(SpreadsheetApp.getActive().getId()).getParents().next();
  var firma = altKlasor_(altKlasor_(altKlasor_(sistem, "Sınavlar"), kodKlasorAdi_("MERKEZ", s.merkez)), kodKlasorAdi_("FIRMA", s.firma));
  var yeni = altKlasor_(firma, sinavKlasorAdi_(s));
  var t = tablo_("Sinavlar");
  t.kayitlar.forEach(function (r) {
    if (String(r.kayit.kod).trim() === String(s.kod).trim()) satirGuncelle_("Sinavlar", r.satir, { klasor_id: yeni.getId() });
  });
  s.klasor_id = yeni.getId();
  return yeni;
}

/** Bir formun sorularını kitapçık sırasıyla verir; şıklar formdaki yerleşimle yeniden harflenir. */
function kitapcikSorulari_(s, form) {
  var fqs = formSorulari_(s.kod, form);
  var grupNo = {};
  fqs.forEach(function (fq) {
    var g = String(fq.q.grup || "").trim();
    if (g) (grupNo[g] = grupNo[g] || []).push(fq.no);
  });
  var harf = ["A", "B", "C", "D", "E"];
  return fqs.map(function (fq) {
    var q = fq.q;
    var g = String(q.grup || "").trim();
    var siklar = [];
    var dogru = "";
    if (q.tur !== "sayi") {
      fq.siklar.split("").forEach(function (asil, i) {
        siklar.push({ harf: harf[i], metin: String(q[asil]) });
        if (asil === String(q.dogru).trim().toUpperCase()) dogru = harf[i];
      });
    } else {
      dogru = String(q.dogru) + (q.birim ? " " + q.birim : "") + (q.tolerans ? " (±" + q.tolerans + ")" : "");
    }
    return {
      no: fq.no, id: q.id, surum: q.surum, bolum: String(q.bolum || ""), grup: g,
      grup_ilk: g ? grupNo[g][0] === fq.no : false,
      grup_baslik: g && (q.grup_notu || q.grup_gorsel) ? grupBasligi_(grupNo[g], !!q.grup_gorsel) : "",
      grup_notu: String(q.grup_notu || ""), grup_gorsel: String(q.grup_gorsel || "").trim(),
      soru: String(q.soru), gorseller: sekilAdlari_(q), tur: q.tur === "sayi" ? "sayi" : "coktan",
      birim: String(q.birim || ""), siklar: siklar, dogru: dogru,
    };
  });
}

function belgeParagraf_(body, metin, o) {
  o = o || {};
  var p = body.appendParagraph(metin);
  if (o.baslik) p.setHeading(o.baslik); else p.setHeading(DocumentApp.ParagraphHeading.NORMAL);
  if (o.ortala) p.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
  p.setSpacingBefore(o.once || 0).setSpacingAfter(o.sonra === undefined ? 4 : o.sonra);
  if (o.girinti) p.setIndentStart(o.girinti).setIndentFirstLine(o.girinti);
  var t = p.editAsText();
  if (metin) {
    t.setBold(!!o.kalin).setItalic(!!o.italik).setFontSize(o.boy || 11).setForegroundColor(o.renk || "#000000");
    if (o.zemin) t.setBackgroundColor(o.zemin);
  }
  return p;
}

/**
 * Sayfa sonunda bir sorunun bölünmemesi için paragraf istekleri (Google Docs API).
 * icerik: Docs.Documents.get(...).body.content. baslarMi(metin, paragraf): paragraf yeni bir blok başlatıyorsa true.
 * yapiskanMi(metin): başlık gibi her zaman sonrakiyle kalması gereken paragraf.
 * Bir bloğun son paragrafı dışındakiler "sonrakiyle birlikte tut", hepsi "satırları bir arada tut" olur.
 */
function birlikteTutIstekleri_(icerik, baslarMi, yapiskanMi) {
  var ps = (icerik || []).filter(function (e) { return e.paragraph; });
  var metin = function (e) {
    return (e.paragraph.elements || []).map(function (x) { return x.textRun ? x.textRun.content : ""; }).join("").replace(/\n$/, "");
  };
  var istekler = [];
  ps.forEach(function (e, i) {
    var sonraki = ps[i + 1];
    var bitis = !sonraki || (baslarMi(metin(sonraki), sonraki.paragraph) && !(yapiskanMi && yapiskanMi(metin(e), e.paragraph)));
    var stil = { keepLinesTogether: true };
    if (!bitis) stil.keepWithNext = true;
    istekler.push({
      updateParagraphStyle: {
        range: { startIndex: e.startIndex, endIndex: e.endIndex },
        paragraphStyle: stil,
        fields: bitis ? "keepLinesTogether" : "keepLinesTogether,keepWithNext",
      },
    });
  });
  return istekler;
}

function kitapcikBlokBasi_(blokBasi, grupIlkNo) {
  return function (t) {
    var m = /^(\d+)\. /.exec(t);
    if (m) return !grupIlkNo[Number(m[1])];
    return blokBasi[t] === true;
  };
}

function birlikteTut_(belgeId, baslarMi, yapiskanMi) {
  if (typeof Docs === "undefined") return 0;
  var d = Docs.Documents.get(belgeId);
  var istekler = birlikteTutIstekleri_(d.body.content, baslarMi, yapiskanMi);
  for (var i = 0; i < istekler.length; i += 400) Docs.Documents.batchUpdate({ requests: istekler.slice(i, i + 400) }, belgeId);
  return istekler.length;
}

/** Yeni belgenin baştaki boş paragrafını kaldırır (Google boş metin yazmaya izin vermez). */
function bosIlkParagrafiSil_(body) {
  var ilk = body.getChild(0);
  if (body.getNumChildren() > 1 && ilk.getType() === DocumentApp.ElementType.PARAGRAPH && ilk.asParagraph().getText() === "") ilk.removeFromParent();
}

function belgeyeGorsel_(body, klasor, ad, genislik) {
  var it = klasor ? klasor.getFilesByName(ad) : null;
  if (!it || !it.hasNext()) {
    belgeParagraf_(body, "Şekil bulunamadı: " + ad, { renk: "#b42318" });
    return;
  }
  var p = body.appendParagraph("");
  p.setAlignment(DocumentApp.HorizontalAlignment.CENTER).setSpacingAfter(6);
  var im = p.appendInlineImage(it.next().getBlob());
  var w = im.getWidth(), h = im.getHeight();
  var oran = Math.min(1, Math.min(genislik, SEKIL_EN_GENIS_PX) / w, SEKIL_EN_YUKSEK_PX / h);
  im.setWidth(Math.round(w * oran)).setHeight(Math.round(h * oran));
}

/**
 * Bir formun kitapçığını ve cevap anahtarını Google Dokümanı olarak sınavın klasörüne yazar.
 * Kitapçıkta soru kodu ve doğru cevap yoktur. Aynı adda belge varsa üzerine yazmaz.
 */
function kitapcikOlustur_(kod, form) {
  var s = sinavBul_(kod);
  if (!s) throw new Error("Sınav bulunamadı: " + kod);
  form = String(form || "A").toUpperCase();
  if (!formBul_(kod, form)) throw new Error("Form bulunamadı: " + form);
  var klasor = sinavKlasoru_(s);
  var adK = "Form " + form + " - Kitapçık";
  var adC = "Form " + form + " - Cevap Anahtarı";
  if (klasor.getFilesByName(adK).hasNext() || klasor.getFilesByName(adC).hasNext()) throw new Error("Bu formun belgeleri zaten var: " + kod + " Form " + form);
  var sorular = kitapcikSorulari_(s, form);
  var gk = havuzGorselKlasoru_();
  var gKlasor = gk ? DriveApp.getFolderById(gk) : null;
  var merkez = String(s.alt_baslik || "");
  var ust = function (body, ikinci) {
    if (String(s.calisma || "").trim()) belgeParagraf_(body, String(s.calisma).trim(), { kalin: true, boy: 13 });
    belgeParagraf_(body, String(s.baslik) + (ikinci ? " " + ikinci : ""), { kalin: true, boy: 15, sonra: 6 });
    if (merkez) belgeParagraf_(body, merkez, { boy: 11 });
    belgeParagraf_(body, "Sınav kodu: " + kod + "   Form " + form + "   Soru sayısı: " + sorular.length + "   Süre: " + Number(s.sure_dk) + " dakika", { boy: 10, renk: "#444444" });
    if (String(s.hazirlayan || "").trim()) belgeParagraf_(body, "Hazırlayan: " + String(s.hazirlayan).trim(), { boy: 10, renk: "#444444" });
  };

  var olusan = [];
  try {
    return kitapcikYaz_(s, kod, form, klasor, adK, adC, sorular, gKlasor, ust, olusan);
  } catch (e) {
    olusan.forEach(function (id) {
      try { DriveApp.getFileById(id).setTrashed(true); } catch (e2) {}
    });
    throw e;
  }
}

function kitapcikYaz_(s, kod, form, klasor, adK, adC, sorular, gKlasor, ust, olusan) {
  // Kitapçık
  var dk = DocumentApp.create(adK);
  olusan.push(dk.getId());
  var b = dk.getBody();
  b.setMarginTop(50).setMarginBottom(50).setMarginLeft(60).setMarginRight(60);
  var genislik = b.getPageWidth() - 120;
  ust(b, "");
  var sonBolum = null;
  sorular.forEach(function (q) {
    if (q.bolum !== sonBolum) {
      belgeParagraf_(b, q.bolum, { kalin: true, boy: 12, zemin: "#fff2a8", once: 16, sonra: 8 });
      sonBolum = q.bolum;
    }
    if (q.grup_ilk && (q.grup_baslik || q.grup_notu || q.grup_gorsel)) {
      if (q.grup_baslik) belgeParagraf_(b, q.grup_baslik, { kalin: true, boy: 11, once: 8 });
      if (q.grup_notu) belgeParagraf_(b, q.grup_notu, { italik: true, boy: 11 });
      if (q.grup_gorsel) belgeyeGorsel_(b, gKlasor, q.grup_gorsel, genislik);
    }
    var p = belgeParagraf_(b, q.no + ". " + q.soru, { boy: 11, once: 10, sonra: 6 });
    p.editAsText().setBold(0, String(q.no).length, true);
    q.gorseller.forEach(function (ad) {
      belgeyeGorsel_(b, gKlasor, ad, genislik);
    });
    if (q.tur === "sayi") belgeParagraf_(b, "Cevap: ............ " + q.birim, { girinti: 18 });
    q.siklar.forEach(function (sk) {
      var ps = belgeParagraf_(b, sk.harf + ")  " + sk.metin, { girinti: 18, sonra: 2 });
      ps.editAsText().setBold(0, 1, true);
    });
  });
  bosIlkParagrafiSil_(b);
  dk.saveAndClose();
  var blokBasi = {};
  var grupIlkNo = {}; // ortak şekil başlığından sonra gelen soru, başlıkla aynı blokta kalır
  sorular.forEach(function (q) {
    blokBasi[q.bolum] = true;
    if (q.grup_ilk && (q.grup_baslik || q.grup_notu || q.grup_gorsel)) {
      if (q.grup_baslik) blokBasi[q.grup_baslik] = true;
      grupIlkNo[q.no] = true;
    }
  });
  birlikteTut_(dk.getId(), kitapcikBlokBasi_(blokBasi, grupIlkNo), function (t) { return blokBasi[t] === true; });

  // Cevap anahtarı
  var dc = DocumentApp.create(adC);
  olusan.push(dc.getId());
  var c = dc.getBody();
  c.setMarginTop(50).setMarginBottom(50).setMarginLeft(60).setMarginRight(60);
  ust(c, "Cevap Anahtarı");
  belgeParagraf_(c, "DEĞERLENDİRİCİ KULLANIMINA MAHSUSTUR", { kalin: true, boy: 10, once: 6, sonra: 8 });
  var coktan = sorular.filter(function (q) { return q.tur !== "sayi"; });
  var yarim = Math.ceil(sorular.length / 2);
  var satirlar = [];
  for (var i = 0; i < yarim; i++) {
    var r = [];
    [sorular[i], sorular[i + yarim]].forEach(function (q, j) {
      if (j) r.push(" ");
      if (!q) { r.push(" ", " ", " ", " ", " "); return; }
      if (q.tur === "sayi") { r.push(String(q.no), q.dogru, " ", " ", " "); return; }
      r.push(String(q.no), "A", "B", "C", "D");
    });
    satirlar.push(r);
  }
  var tb = c.appendTable(satirlar);
  tb.setBorderWidth(0);
  // Dar sütunlar ve sıkı satırlar: 60 soruluk anahtar tek sayfaya sığar.
  [26, 20, 20, 20, 20, 40, 26, 20, 20, 20, 20].forEach(function (g, i) { tb.setColumnWidth(i, g); });
  for (var ri = 0; ri < satirlar.length; ri++) {
    for (var ai = 0; ai < 11; ai++) {
      var ah = tb.getCell(ri, ai);
      ah.setPaddingTop(1).setPaddingBottom(1).setPaddingLeft(2).setPaddingRight(2);
      var ap = ah.getChild(0).asParagraph();
      ap.setSpacingBefore(0).setSpacingAfter(0).setLineSpacing(1).setAlignment(DocumentApp.HorizontalAlignment.CENTER);
      ah.editAsText().setFontSize(9);
    }
    [0, 6].forEach(function (bas, j) {
      var q = sorular[ri + j * yarim];
      for (var ci = 0; ci < 5; ci++) {
        var hucre = tb.getCell(ri, bas + ci);
        var t = hucre.editAsText();
        if (!t.getText().trim()) continue;
        t.setFontSize(9).setBold(ci === 0);
        if (ci > 0 && q && q.tur !== "sayi" && satirlar[ri][bas + ci] === q.dogru) {
          hucre.setBackgroundColor("#000000");
          t.setForegroundColor("#ffffff").setBold(true);
        }
      }
    });
  }
  belgeParagraf_(c, "Doğru cevaplar siyah zeminlidir. Şıklar bu formdaki yerleşime göredir.", { boy: 9, renk: "#444444", once: 6 });
  c.appendPageBreak();
  belgeParagraf_(c, "Soruların havuz kodları", { kalin: true, boy: 11, once: 0, sonra: 4 });
  var kodSatir = [["No", "Soru kodu", "Sürüm", "Bölüm"]].concat(sorular.map(function (q) { return [String(q.no), q.id, String(q.surum), q.bolum]; }));
  var tk = c.appendTable(kodSatir);
  tk.setBorderColor("#cccccc");
  for (var k = 0; k < kodSatir.length; k++) for (var m = 0; m < 4; m++) {
    var hc = tk.getCell(k, m);
    hc.setPaddingTop(1).setPaddingBottom(1);
    hc.editAsText().setFontSize(9).setBold(k === 0);
  }
  bosIlkParagrafiSil_(c);
  dc.saveAndClose();

  DriveApp.getFileById(dk.getId()).moveTo(klasor);
  DriveApp.getFileById(dc.getId()).moveTo(klasor);
  return { klasor: klasor.getUrl(), kitapcik: dk.getUrl(), anahtar: dc.getUrl(), soru: sorular.length, coktan: coktan.length };
}

/** Ortak şekil notlarındaki sabit soru numaralarını kaldırır ("12 ve 13 numaralı soruları aşağıdaki" -> "Aşağıdaki"). */
function grupNotuNumarasiz_(t) {
  return String(t || "").replace(/^\s*\d+(\s*,\s*\d+)*\s+ve\s+\d+\s+numaralı\s+soruları\s+aşağıdaki/i, "Aşağıdaki");
}

/** Havuzdaki notlarda kalan sabit numaraları temizler. Kaç satırın değiştiğini döndürür. */
function grupNotlariniDuzelt_() {
  var n = 0;
  tablo_("Havuz").kayitlar.forEach(function (r) {
    var eski = String(r.kayit.grup_notu || "");
    var yeni = grupNotuNumarasiz_(eski);
    if (yeni !== eski) {
      satirGuncelle_("Havuz", r.satir, { grup_notu: yeni });
      n++;
    }
  });
  return n;
}

/** Kişisel koda bağlı, her açılışta aynı kalan karıştırma. */
function karistir_(dizi, tohum) {
  var h = 2166136261;
  for (var i = 0; i < tohum.length; i++) {
    h ^= tohum.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  var a = dizi.slice();
  for (var j = a.length - 1; j > 0; j--) {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    var r = h % (j + 1);
    var t = a[j];
    a[j] = a[r];
    a[r] = t;
  }
  return a;
}

/** Görseli Drive klasöründen okur ve tarayıcıya veri adresi olarak verir. */
function gorsel_(klasorId, ad) {
  if (!klasorId || !ad) return "";
  var onbellek = CacheService.getScriptCache();
  var anahtar = "g:" + klasorId + ":" + ad;
  var kayitli = onbellek.get(anahtar);
  if (kayitli) return kayitli;
  var dosyalar = DriveApp.getFolderById(klasorId).getFilesByName(ad);
  if (!dosyalar.hasNext()) return "";
  var blob = dosyalar.next().getBlob();
  var veri = "data:" + blob.getContentType() + ";base64," + Utilities.base64Encode(blob.getBytes());
  if (veri.length < 95000) onbellek.put(anahtar, veri, 21600);
  return veri;
}

// ---------------------------------------------------------------------------
// Tablo yardımcıları
// ---------------------------------------------------------------------------

/** Sekmeyi verir; sistemin bildiği bir sekme yoksa başlıklarıyla oluşturur. */
function sayfa_(ad) {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(ad);
  if (!sh) {
    if (!BASLIKLAR[ad]) throw new Error("Sekme bulunamadı: " + ad);
    sh = ss.insertSheet(ad);
    sh.getRange(1, 1, 1, BASLIKLAR[ad].length).setValues([BASLIKLAR[ad]]).setFontWeight("bold");
    sh.setFrozenRows(1);
  }
  return sh;
}

/** Eksik sütun başlıklarını sona ekler ve güncel başlık listesini döndürür. */
function sutunlariTamamla_(sh, gerekenler) {
  var b = basliklar_(sh);
  gerekenler.forEach(function (k) {
    if (b.indexOf(k) < 0) {
      sh.getRange(1, b.length + 1).setValue(k).setFontWeight("bold");
      b.push(k);
    }
  });
  return b;
}

function tablo_(ad) {
  var degerler = sayfa_(ad).getDataRange().getValues();
  var basliklar = degerler[0].map(function (b) {
    return String(b).trim();
  });
  var kayitlar = [];
  for (var i = 1; i < degerler.length; i++) {
    var o = {};
    basliklar.forEach(function (b, j) {
      o[b] = degerler[i][j];
    });
    kayitlar.push({ satir: i + 1, kayit: o });
  }
  return { basliklar: basliklar, kayitlar: kayitlar };
}

function basliklar_(sh) {
  return sh
    .getRange(1, 1, 1, sh.getLastColumn())
    .getValues()[0]
    .map(function (b) {
      return String(b).trim();
    });
}

function satirGuncelle_(ad, satir, alanlar) {
  var sh = sayfa_(ad);
  var b = sutunlariTamamla_(sh, Object.keys(alanlar));
  Object.keys(alanlar).forEach(function (k) {
    sh.getRange(satir, b.indexOf(k) + 1).setValue(alanlar[k]);
  });
}

/** Sütun sırasından bağımsız satır ekler (başlık adına göre). */
function satirEkle_(ad, alanlar) {
  var sh = sayfa_(ad);
  var b = sutunlariTamamla_(sh, Object.keys(alanlar));
  sh.appendRow(
    b.map(function (k) {
      return alanlar[k] !== undefined ? alanlar[k] : "";
    })
  );
}

function davetBul_(kod) {
  var t = tablo_("Davetler");
  for (var i = 0; i < t.kayitlar.length; i++) {
    if (String(t.kayitlar[i].kayit.kod).trim() === kod) return t.kayitlar[i];
  }
  return null;
}

function sinavBul_(sinavKodu) {
  var t = tablo_("Sinavlar");
  for (var i = 0; i < t.kayitlar.length; i++) {
    var k = t.kayitlar[i].kayit;
    if (String(k.kod).trim() === String(sinavKodu).trim()) return k;
  }
  return null;
}

function oturumBul_(okod) {
  var t = tablo_("Oturumlar");
  for (var i = 0; i < t.kayitlar.length; i++) {
    if (String(t.kayitlar[i].kayit.kod).trim().toUpperCase() === okod) return t.kayitlar[i];
  }
  return null;
}

function oturumKoduGecerli_(k) {
  if (!/^[A-Z0-9]{6}$/.test(k)) return false;
  for (var i = 0; i < k.length; i++) if (OTURUM_HARFLERI.indexOf(k.charAt(i)) < 0) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Soru havuzu, sınav içerikleri ve formlar
// ---------------------------------------------------------------------------

/** Havuzdaki tüm soru sürümleri: { "PLC-0042@2": kayıt } */
function havuz_() {
  var m = {};
  tablo_("Havuz").kayitlar.forEach(function (r) {
    var k = r.kayit;
    var id = String(k.soru_id).trim();
    if (!id) return;
    k.soru_id = id;
    k.surum = Number(k.surum) || 1;
    k._satir = r.satir;
    m[id + "@" + k.surum] = k;
  });
  return m;
}

/** Sınavın soruları, sınavın asıl sırasıyla (no = 1..N). */
function sinavSorulari_(sinavKodu, havuz) {
  var h = havuz || havuz_();
  return tablo_("Sinav_Sorulari")
    .kayitlar.map(function (r) {
      return r.kayit;
    })
    .filter(function (x) {
      return String(x.sinav).trim() === String(sinavKodu).trim();
    })
    .sort(function (a, b) {
      return Number(a.sira) - Number(b.sira);
    })
    .map(function (x, i) {
      var q = h[String(x.soru_id).trim() + "@" + (Number(x.surum) || 1)];
      if (!q) throw new Error("Havuzda bulunamadı: " + x.soru_id + " v" + x.surum);
      var o = {};
      Object.keys(q).forEach(function (k) {
        o[k] = q[k];
      });
      o.id = q.soru_id;
      o.no = i + 1;
      return o;
    });
}

function formBul_(sinavKodu, form) {
  var t = tablo_("Formlar");
  for (var i = 0; i < t.kayitlar.length; i++) {
    var k = t.kayitlar[i].kayit;
    if (String(k.sinav).trim() === String(sinavKodu).trim() && String(k.form).trim() === String(form).trim()) return k;
  }
  return null;
}

/** Forma göre sıralanmış sorular: [{no, q, siklar: "CADB"}] */
function formSorulari_(sinavKodu, form, havuz) {
  var sorular = sinavSorulari_(sinavKodu, havuz);
  var f = formBul_(sinavKodu, form);
  var sira = f && f.sira ? JSON.parse(f.sira) : null;
  var siklar = f && f.siklar ? JSON.parse(f.siklar) : {};
  var idx = {};
  sorular.forEach(function (q) {
    idx[q.id] = q;
  });
  var liste = sira
    ? sira.map(function (id) {
        if (!idx[id]) throw new Error("Formdaki soru sınavda yok: " + id);
        return idx[id];
      })
    : sorular;
  return liste.map(function (q, i) {
    return { no: i + 1, q: q, siklar: siklar[q.id] || varsayilanSiklar_(q) };
  });
}

function varsayilanSiklar_(q) {
  return ["A", "B", "C", "D", "E"]
    .filter(function (h) {
      return q[h] !== undefined && String(q[h]).trim() !== "";
    })
    .join("");
}

/** Ekrandaki soru numarasına göre cevaplar -> soru kimliğine göre cevaplar. */
function konumdanKimlige_(sinavKodu, form, cevaplar) {
  var out = {};
  formSorulari_(sinavKodu, form).forEach(function (fq) {
    var c = cevaplar[String(fq.no)];
    if (c !== undefined && c !== "") out[fq.q.id] = c;
  });
  return out;
}

/** Soru kimliğine göre cevaplar -> sınavın asıl sırasına göre cevaplar (puanla için). */
function kimliktenSiraya_(sorular, cevapId) {
  var out = {};
  sorular.forEach(function (q) {
    if (cevapId[q.id] !== undefined) out[String(q.no)] = cevapId[q.id];
  });
  return out;
}

function yerTutucular_(metin, s) {
  return String(metin)
    .replace(/\{soru_sayisi\}/g, String(sinavSorulari_(s.kod).length))
    .replace(/\{sure_dk\}/g, String(Number(s.sure_dk)));
}

function gorselKlasoru_(s) {
  return String((s && s.gorsel_klasor_id) || ayar_("gorsel_klasor_id") || "").trim();
}

function yeniKisiselKod_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, "").slice(0, 24);
}

function cevaplariTemizle_(c) {
  var out = {};
  Object.keys(c || {})
    .slice(0, 500)
    .forEach(function (k) {
      if (!/^\d{1,4}$/.test(k)) return;
      var v = String(c[k]).trim().slice(0, 30);
      if (/^[A-Ea-e?]$/.test(v) || /^-?\d+([.,]\d+)?$/.test(v)) out[k] = v.length === 1 ? v.toUpperCase() : v;
    });
  return out;
}

function temizle_(v, n) {
  // Tabloya formül olarak yazılmasın diye baştaki = + - @ karakterleri atılır.
  return String(v || "")
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/^[=+\-@\s]+/, "")
    .trim()
    .slice(0, n);
}

function evet_(v) {
  var s = String(v).trim().toLocaleUpperCase("tr-TR");
  return v === true || s === "EVET" || s === "TRUE" || s === "DOĞRU";
}

/** Her sınav için soru bazında detay sekmesi: verilen cevap, yeşil doğru, kırmızı yanlış. */
function detayYaz_(sinavKodu, sorular, kisi, p, zaman) {
  var ad = "Detay_" + sinavKodu;
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(ad);
  var ustBasliklar = ["Zaman", "Ad", "Soyad", "Firma", "Görev", "Doğru", "Puan"];
  if (!sh) {
    sh = ss.insertSheet(ad);
    var baslik = ustBasliklar.concat(p.bolumSira).concat(
      sorular.map(function (q) {
        return q.id;
      })
    );
    sh.getRange(1, 1, 1, baslik.length).setValues([baslik]).setFontWeight("bold");
    var anahtar = ["CEVAP ANAHTARI", "", "", "", "", "", ""]
      .concat(
        p.bolumSira.map(function (b) {
          return p.bolumler[b].toplam;
        })
      )
      .concat(
        sorular.map(function (q) {
          return String(q.dogru);
        })
      );
    sh.getRange(2, 1, 1, anahtar.length).setValues([anahtar]).setFontStyle("italic");
    sh.setFrozenRows(2);
    sh.setFrozenColumns(3);
  }
  var renkler = [];
  var satir = [zaman, kisi.ad, kisi.soyad, kisi.firma, kisi.gorev, p.dogru, p.puan]
    .concat(
      p.bolumSira.map(function (b) {
        return p.bolumler[b].dogru;
      })
    )
    .concat(
      p.detay.map(function (d) {
        return d.durum === "bos" ? "-" : d.cevap;
      })
    );
  var on = ustBasliklar.length + p.bolumSira.length;
  for (var i = 0; i < satir.length; i++) {
    if (i < on) {
      renkler.push(null);
      continue;
    }
    var du = p.detay[i - on].durum;
    renkler.push(du === "dogru" ? "#e5f4e4" : du === "yanlis" ? "#fbebeb" : du === "bilmiyorum" ? "#f9eeda" : null);
  }
  var r = sh.getLastRow() + 1;
  sh.getRange(r, 1, 1, satir.length).setValues([satir]).setBackgrounds([renkler]);
}

// ---------------------------------------------------------------------------
// Tablo menüsü ve kurulum
// ---------------------------------------------------------------------------

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Sınav")
    .addItem("Yönetim paneli", "panelAc")
    .addSeparator()
    .addItem("Kişiye özel davet bağlantısı oluştur", "davetOlustur")
    .addItem("Eksik sekmeleri ve sütunları oluştur", "kurulum")
    .addToUi();
}

var BASLIKLAR = {
  Ayarlar: ["anahtar", "deger"],
  Kodlar: ["tur", "kod", "ad", "klasor_adi"],
  Havuz: ["soru_id", "surum", "durum", "konu", "bolum", "zorluk", "grup", "grup_notu", "grup_gorsel", "soru", "gorsel", "tur", "A", "B", "C", "D", "E", "dogru", "tolerans", "birim", "gerekce", "kaynak", "olusturma", "onay_tarihi", "not"],
  Sinavlar: ["kod", "merkez", "firma", "konu", "calisma", "baslik", "alt_baslik", "sure_dk", "durum", "aktif", "aciklama", "kvkk_metni", "firma_sor", "gorev_sor", "bilmiyorum", "sik_karistir", "gorsel_klasor_id", "hazirlayan", "klasor_id", "olusturma", "onay_tarihi", "not"],
  Sinav_Sorulari: ["sinav", "sira", "soru_id", "surum"],
  Formlar: ["sinav", "form", "sira", "siklar", "olusturma"],
  Kullanim: ["sinav", "form", "tarih", "katilimci_sayisi", "tur", "not"],
  Oturumlar: ["kod", "sinav", "form", "firma", "egitim_merkezi", "baslangic", "bitis", "kontenjan", "durum", "olusturma", "not"],
  Davetler: ["kod", "sinav", "form", "oturum", "baglanti", "ad", "soyad", "firma", "gorev", "son_tarih", "durum", "baslama", "bitis", "giris_sayisi", "kvkk_onay", "son_kayit", "ara_kayit", "cevaplar_id", "puan"],
  Sonuclar: ["zaman", "sinav", "form", "oturum", "egitim_merkezi", "davet_kodu", "ad", "soyad", "firma", "gorev", "baslama", "bitis", "sure_dk", "sure_asimi", "dogru", "yanlis", "bos", "bilmiyorum", "toplam", "puan", "bolumler"],
};


/** Eksik sekmeleri oluşturur; var olan sekmelere eksik sütunları sona ekler. Veriye dokunmaz. */
function kurulum() {
  var ss = SpreadsheetApp.getActive();
  var eklenen = [];
  Object.keys(BASLIKLAR).forEach(function (ad) {
    var sh = ss.getSheetByName(ad);
    if (!sh) {
      sh = ss.insertSheet(ad);
      eklenen.push(ad + " sekmesi");
    }
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, BASLIKLAR[ad].length).setValues([BASLIKLAR[ad]]).setFontWeight("bold");
      sh.setFrozenRows(1);
      return;
    }
    var var_olan = basliklar_(sh);
    BASLIKLAR[ad].forEach(function (b) {
      if (var_olan.indexOf(b) < 0) {
        var c = sh.getLastColumn() + 1;
        sh.getRange(1, c).setValue(b).setFontWeight("bold");
        var_olan.push(b);
        eklenen.push(ad + "." + b);
      }
    });
  });
  try {
    SpreadsheetApp.getUi().alert(eklenen.length ? "Eklendi: " + eklenen.join(", ") : "Tüm sekme ve sütunlar zaten tamam.");
  } catch (e) {
    /* menü dışından çalıştırıldı */
  }
  return eklenen;
}

function davetOlustur() {
  var ui = SpreadsheetApp.getUi();
  var adres = ayar_("sinav_sayfasi");
  if (!adres) {
    ui.alert("Ayarlar sekmesine 'sinav_sayfasi' satırını ve sınav sayfasının adresini yazın.");
    return;
  }
  var r1 = ui.prompt("Davet bağlantısı", "Sınav kodu (Sinavlar sekmesindeki 'kod'):", ui.ButtonSet.OK_CANCEL);
  if (r1.getSelectedButton() !== ui.Button.OK) return;
  var sinavKodu = r1.getResponseText().trim();
  if (!sinavBul_(sinavKodu)) {
    ui.alert("Bu kodla bir sınav yok: " + sinavKodu);
    return;
  }
  var r2 = ui.prompt("Davet bağlantısı", "Kaç kişilik bağlantı oluşturulsun?", ui.ButtonSet.OK_CANCEL);
  if (r2.getSelectedButton() !== ui.Button.OK) return;
  var n = parseInt(r2.getResponseText(), 10);
  if (!(n > 0 && n <= 500)) {
    ui.alert("1 ile 500 arasında bir sayı girin.");
    return;
  }
  for (var i = 0; i < n; i++) {
    var kod = yeniKisiselKod_();
    satirEkle_("Davetler", { kod: kod, sinav: sinavKodu, form: "A", baglanti: adres.replace(/\/?$/, "/") + "?k=" + kod, durum: "bekliyor" });
  }
  ui.alert(n + " davet bağlantısı Davetler sekmesine eklendi. Her bağlantıyı yalnızca bir kişiye gönderin.");
}

function ayar_(anahtar) {
  var t = tablo_("Ayarlar");
  for (var i = 0; i < t.kayitlar.length; i++) {
    if (String(t.kayitlar[i].kayit.anahtar).trim() === anahtar) return String(t.kayitlar[i].kayit.deger).trim();
  }
  return "";
}

// ---------------------------------------------------------------------------
// Yönetim paneli (yalnızca tablonun sahibi açabilir; web uygulamasından çağrılamaz)
// ---------------------------------------------------------------------------

function panelAc() {
  var html = HtmlService.createHtmlOutput(PANEL_HTML).setWidth(1180).setHeight(780).setTitle("Sınav yönetim paneli");
  SpreadsheetApp.getUi().showModalDialog(html, "Sınav yönetim paneli");
}

function tarih_(v) {
  if (!v) return "";
  var d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? "" : d.toISOString();
}

/** Panelin açılışta ihtiyaç duyduğu veriler. */
function panelVeri() {
  var havuz = havuz_();
  var formlar = tablo_("Formlar").kayitlar.map(function (r) {
    return r.kayit;
  });
  var sinavlar = tablo_("Sinavlar").kayitlar.map(function (r) {
    var s = r.kayit;
    var kod = String(s.kod).trim();
    return {
      kod: kod,
      baslik: String(s.baslik),
      alt_baslik: String(s.alt_baslik || ""),
      merkez: String(s.merkez || ""),
      firma: String(s.firma || ""),
      konu: String(s.konu || ""),
      durum: String(s.durum || "").toUpperCase(),
      sure_dk: Number(s.sure_dk),
      soru_sayisi: sinavSorulari_(kod, havuz).length,
      formlar: formlar
        .filter(function (f) {
          return String(f.sinav).trim() === kod;
        })
        .map(function (f) {
          return String(f.form);
        }),
    };
  });
  var davetler = tablo_("Davetler").kayitlar.map(function (r) {
    return r.kayit;
  });
  var oturumlar = tablo_("Oturumlar").kayitlar.map(function (r) {
    var o = r.kayit;
    var ok = String(o.kod).trim().toUpperCase();
    var kisiler = davetler.filter(function (d) {
      return String(d.oturum).trim() === ok;
    });
    return {
      kod: ok,
      sinav: String(o.sinav),
      form: String(o.form || "A"),
      firma: String(o.firma || ""),
      egitim_merkezi: String(o.egitim_merkezi || ""),
      baslangic: tarih_(o.baslangic),
      bitis: tarih_(o.bitis),
      kontenjan: Number(o.kontenjan) || 0,
      durum: String(o.durum || "").toUpperCase(),
      olusturma: tarih_(o.olusturma),
      basladi: kisiler.filter(function (d) {
        return d.durum === "basladi";
      }).length,
      tamamlandi: kisiler.filter(function (d) {
        return d.durum === "tamamlandi";
      }).length,
    };
  });
  oturumlar.reverse();
  return { sinavlar: sinavlar, oturumlar: oturumlar, sinav_sayfasi: ayar_("sinav_sayfasi"), kodlar: kodlar_() };
}

/** Yeni oturum ve ortak giriş kodu oluşturur. */
function oturumOlustur(g) {
  var s = sinavBul_(String(g.sinav || ""));
  if (!s) throw new Error("Sınav bulunamadı.");
  if (String(s.durum).toUpperCase() !== "ONAYLI") throw new Error("Yalnızca onaylı sınavlarla oturum açılabilir.");
  var form = String(g.form || "A").trim();
  if (!formBul_(s.kod, form)) throw new Error("Bu sınavın " + form + " formu yok.");
  var kontenjan = parseInt(g.kontenjan, 10);
  if (!(kontenjan > 0 && kontenjan <= 1000)) throw new Error("Kişi sayısı 1 ile 1000 arasında olmalı.");
  var bas = new Date(g.baslangic);
  var bit = new Date(g.bitis);
  if (isNaN(bas.getTime()) || isNaN(bit.getTime()) || bit <= bas) throw new Error("Giriş saatleri geçerli değil.");
  var kilit = LockService.getScriptLock();
  kilit.waitLock(20000);
  try {
    var kod;
    do {
      kod = "";
      for (var i = 0; i < 6; i++) kod += OTURUM_HARFLERI.charAt(Math.floor(Math.random() * OTURUM_HARFLERI.length));
    } while (oturumBul_(kod));
    satirEkle_("Oturumlar", {
      kod: kod,
      sinav: s.kod,
      form: form,
      firma: temizle_(g.firma, 120),
      egitim_merkezi: temizle_(g.egitim_merkezi, 120),
      baslangic: bas,
      bitis: bit,
      kontenjan: kontenjan,
      durum: "ACIK",
      olusturma: new Date(),
      not: temizle_(g.not, 300),
    });
    return kod;
  } finally {
    kilit.releaseLock();
  }
}

/** Oturumu açar ya da kapatır. Kapatmak yeni girişleri durdurur; başlamış sınavlar bitirilebilir. */
function oturumDurumDegistir(okod, acik) {
  var o = oturumBul_(String(okod).toUpperCase());
  if (!o) throw new Error("Oturum bulunamadı.");
  satirGuncelle_("Oturumlar", o.satir, { durum: acik ? "ACIK" : "KAPALI" });
  return true;
}

/** Bir oturumun sonuç istatistikleri. */
function oturumRaporu(okod) {
  okod = String(okod).toUpperCase();
  var o = oturumBul_(okod);
  if (!o) throw new Error("Oturum bulunamadı.");
  var sorular = sinavSorulari_(o.kayit.sinav);
  var kisiler = tablo_("Davetler")
    .kayitlar.map(function (r) {
      return r.kayit;
    })
    .filter(function (d) {
      return String(d.oturum).trim() === okod;
    });
  return raporHesapla(sorular, kisiler);
}

/** Saf fonksiyon: katılımcı kayıtlarından istatistik üretir (test edilebilir). */
function raporHesapla(sorular, kisiler) {
  var bitenler = [];
  var liste = kisiler.map(function (d) {
    var satir = {
      ad: String(d.ad || ""),
      soyad: String(d.soyad || ""),
      firma: String(d.firma || ""),
      gorev: String(d.gorev || ""),
      durum: String(d.durum || ""),
      baslama: tarih_(d.baslama),
      bitis: tarih_(d.bitis),
      puan: null,
      dogru: null,
    };
    if (d.durum === "tamamlandi") {
      var c = {};
      try {
        c = d.cevaplar_id ? kimliktenSiraya_(sorular, JSON.parse(d.cevaplar_id)) : d.ara_kayit ? JSON.parse(d.ara_kayit) : {};
      } catch (e) {
        c = {};
      }
      var p = puanla(sorular, c);
      satir.puan = p.puan;
      satir.dogru = p.dogru;
      satir.bolumler = p.bolumler;
      bitenler.push({ p: p, c: c });
    }
    return satir;
  });

  var puanlar = bitenler
    .map(function (b) {
      return b.p.puan;
    })
    .sort(function (a, b) {
      return a - b;
    });
  var n = puanlar.length;
  var ort = n
    ? puanlar.reduce(function (a, b) {
        return a + b;
      }, 0) / n
    : null;
  var medyan = n ? (n % 2 ? puanlar[(n - 1) / 2] : (puanlar[n / 2 - 1] + puanlar[n / 2]) / 2) : null;
  if (medyan !== null) medyan = Math.round(medyan * 10) / 10;
  var dagilim = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  puanlar.forEach(function (x) {
    dagilim[Math.min(9, Math.floor(x / 10))]++;
  });

  var bolumSira = [];
  var bolum = {};
  sorular.forEach(function (q) {
    var b = q.bolum || "Genel";
    if (!bolum[b]) {
      bolum[b] = { dogru: 0, toplam: 0 };
      bolumSira.push(b);
    }
  });
  bitenler.forEach(function (x) {
    bolumSira.forEach(function (b) {
      bolum[b].dogru += x.p.bolumler[b].dogru;
      bolum[b].toplam += x.p.bolumler[b].toplam;
    });
  });

  var soruIst = sorular.map(function (q) {
    var secim = {};
    var dogru = 0;
    bitenler.forEach(function (x) {
      var c = x.c[String(q.no)];
      var k = c === undefined || c === "" ? "-" : String(c);
      secim[k] = (secim[k] || 0) + 1;
      if (k !== "-" && k !== "?" && dogruMu_(q, k)) dogru++;
    });
    var yanlislar = Object.keys(secim).filter(function (k) {
      return k !== "-" && k !== "?" && !dogruMu_(q, k);
    });
    yanlislar.sort(function (a, b) {
      return secim[b] - secim[a];
    });
    return {
      no: q.no,
      id: q.id || "",
      bolum: q.bolum || "Genel",
      soru: String(q.soru),
      dogru_cevap: String(q.dogru),
      dogru_yuzde: n ? Math.round((dogru / n) * 1000) / 10 : null,
      secim: secim,
      en_sik_yanlis: yanlislar.length ? yanlislar[0] : "",
      en_sik_yanlis_sayi: yanlislar.length ? secim[yanlislar[0]] : 0,
    };
  });

  return {
    katilan: kisiler.length,
    devam_eden: kisiler.filter(function (d) {
      return d.durum === "basladi";
    }).length,
    tamamlayan: n,
    ortalama: ort === null ? null : Math.round(ort * 10) / 10,
    medyan: medyan,
    en_dusuk: n ? puanlar[0] : null,
    en_yuksek: n ? puanlar[n - 1] : null,
    dagilim: dagilim,
    bolumler: bolumSira.map(function (b) {
      var soru = sorular.filter(function (q) {
        return (q.bolum || "Genel") === b;
      }).length;
      return { ad: b, yuzde: bolum[b].toplam ? Math.round((bolum[b].dogru / bolum[b].toplam) * 1000) / 10 : null, soru: soru };
    }),
    sorular: soruIst,
    katilimcilar: liste,
  };
}

/**
 * Oturum raporunu Drive'da ayrı bir Google E-Tablo dosyası olarak oluşturur:
 * özet, bölüm başarısı, puan dağılımı, katılımcılar ve soru bazında doğru oranı,
 * iki grafikle. Dosya PDF ya da Excel olarak indirilebilir ve paylaşılabilir.
 * Soru metinleri ve cevap anahtarı rapora yazılmaz.
 */
function raporDosyasiOlustur(okod) {
  okod = String(okod).toUpperCase();
  var o = oturumBul_(okod);
  if (!o) throw new Error("Oturum bulunamadı.");
  var ok = o.kayit;
  var s = sinavBul_(ok.sinav) || { baslik: ok.sinav, kod: ok.sinav };
  var r = oturumRaporu(okod);
  var anaTablo = SpreadsheetApp.getActive();
  var tz = anaTablo.getSpreadsheetTimeZone();
  var gun = ok.baslangic ? Utilities.formatDate(new Date(ok.baslangic), tz, "dd.MM.yyyy") : "";
  var ad = ["Sınav raporu", s.baslik, ok.firma, gun].filter(String).join(" - ");
  var ss = SpreadsheetApp.create(ad);
  ss.setSpreadsheetTimeZone(tz);
  var sh = ss.getSheets()[0];
  sh.setName("Rapor");

  var satir = 1;
  function yaz(degerler, kalin) {
    var genislik = Math.max.apply(
      null,
      degerler.map(function (d) {
        return d.length;
      })
    );
    var dolu = degerler.map(function (d) {
      var x = d.slice();
      while (x.length < genislik) x.push("");
      return x;
    });
    var rg = sh.getRange(satir, 1, dolu.length, genislik);
    rg.setValues(dolu);
    if (kalin) sh.getRange(satir, 1, 1, genislik).setFontWeight("bold").setBackground("#f0efec");
    var bas = satir;
    satir += dolu.length + 1;
    return bas;
  }
  function yuzde(v) {
    return v === null || v === undefined ? "" : v / 100;
  }

  sh.getRange(1, 1).setValue(ad).setFontWeight("bold").setFontSize(14);
  satir = 3;
  yaz([
    ["Sınav", s.baslik],
    ["Eğitim merkezi", ok.egitim_merkezi || ""],
    ["Firma", ok.firma || ""],
    ["Oturum kodu", okod],
    ["Giriş aralığı", (ok.baslangic ? Utilities.formatDate(new Date(ok.baslangic), tz, "dd.MM.yyyy HH:mm") : "") + " - " + (ok.bitis ? Utilities.formatDate(new Date(ok.bitis), tz, "HH:mm") : "")],
    ["Hazırlayan", s.hazirlayan || ""],
    ["Rapor tarihi", Utilities.formatDate(new Date(), tz, "dd.MM.yyyy HH:mm")],
  ]);

  yaz(
    [
      ["Özet", ""],
      ["Katılan", r.katilan],
      ["Tamamlayan", r.tamamlayan],
      ["Ortalama puan", r.ortalama === null ? "" : r.ortalama],
      ["Medyan", r.medyan === null ? "" : r.medyan],
      ["En düşük puan", r.en_dusuk === null ? "" : r.en_dusuk],
      ["En yüksek puan", r.en_yuksek === null ? "" : r.en_yuksek],
    ],
    true
  );

  var bolumBas = yaz(
    [["Bölüm", "Soru sayısı", "Doğru cevap oranı"]].concat(
      r.bolumler.map(function (b) {
        return [b.ad, b.soru, yuzde(b.yuzde)];
      })
    ),
    true
  );
  sh.getRange(bolumBas + 1, 3, r.bolumler.length, 1).setNumberFormat("0.0%");

  var dagBas = yaz(
    [["Puan aralığı", "Kişi sayısı"]].concat(
      r.dagilim.map(function (v, i) {
        return [i * 10 + "-" + (i === 9 ? 100 : i * 10 + 9), v];
      })
    ),
    true
  );

  var bolumAdlari = r.bolumler.map(function (b) {
    return b.ad;
  });
  var kisiler = r.katilimcilar.slice().sort(function (a, b) {
    return (b.puan === null ? -1 : b.puan) - (a.puan === null ? -1 : a.puan);
  });
  var kisiBas = yaz(
    [["Ad soyad", "Firma", "Görev", "Durum", "Doğru", "Puan"].concat(bolumAdlari)].concat(
      kisiler.map(function (k) {
        var bol = bolumAdlari.map(function (b) {
          return k.bolumler && k.bolumler[b] && k.bolumler[b].toplam ? k.bolumler[b].dogru / k.bolumler[b].toplam : "";
        });
        return [k.ad + " " + k.soyad, k.firma, k.gorev, k.durum === "tamamlandi" ? "Bitirdi" : "Bitirmedi", k.dogru === null ? "" : k.dogru, k.puan === null ? "" : k.puan].concat(bol);
      })
    ),
    true
  );
  if (kisiler.length && bolumAdlari.length) sh.getRange(kisiBas + 1, 7, kisiler.length, bolumAdlari.length).setNumberFormat("0%");

  var soruBas = yaz(
    [["Soru no", "Soru kodu", "Bölüm", "Doğru cevap oranı"]].concat(
      r.sorular.map(function (q) {
        return [q.no, q.id, q.bolum, yuzde(q.dogru_yuzde)];
      })
    ),
    true
  );
  sh.getRange(soruBas + 1, 4, r.sorular.length, 1).setNumberFormat("0%");

  sh.setColumnWidth(1, 230);
  sh.setColumnWidth(2, 200);
  sh.setColumnWidth(3, 150);

  if (r.tamamlayan) {
    sh.insertChart(
      sh
        .newChart()
        .setChartType(Charts.ChartType.COLUMN)
        .addRange(sh.getRange(dagBas, 1, 11, 2))
        .setNumHeaders(1)
        .setPosition(3, 5, 0, 0)
        .setOption("title", "Puan dağılımı")
        .setOption("legend", { position: "none" })
        .setOption("vAxis", { title: "Kişi sayısı", format: "0", minValue: 0, gridlines: { count: -1 } })
        .setOption("hAxis", { title: "Puan" })
        .setOption("width", 560)
        .setOption("height", 300)
        .build()
    );
    sh.insertChart(
      sh
        .newChart()
        .setChartType(Charts.ChartType.BAR)
        .addRange(sh.getRange(bolumBas, 1, r.bolumler.length + 1, 1))
        .addRange(sh.getRange(bolumBas, 3, r.bolumler.length + 1, 1))
        .setNumHeaders(1)
        .setPosition(19, 5, 0, 0)
        .setOption("title", "Bölüm bazında doğru cevap oranı")
        .setOption("legend", { position: "none" })
        .setOption("hAxis", { minValue: 0, maxValue: 1, format: "percent" })
        .setOption("width", 560)
        .setOption("height", 300)
        .build()
    );
  }
  return { url: ss.getUrl(), ad: ad };
}

// ---------------------------------------------------------------------------
// Soru havuzu, sınav hazırlama, formlar ve kullanım takibi (yönetim paneli)
// ---------------------------------------------------------------------------

/** Merkez, firma ve konu kısa kodları: { MERKEZ: {IMES: "..."}, FIRMA: {...}, KONU: {...} } */
function kodlar_() {
  var out = { MERKEZ: {}, FIRMA: {}, KONU: {} };
  tablo_("Kodlar").kayitlar.forEach(function (r) {
    var t = String(r.kayit.tur).trim().toUpperCase();
    var k = String(r.kayit.kod).trim().toUpperCase();
    if (out[t] && k) out[t][k] = String(r.kayit.ad || "");
  });
  return out;
}

/** Yeni bir kısa kod ekler (ör. yeni firma). */
function kodEkle(tur, kod, ad) {
  tur = String(tur).trim().toUpperCase();
  kod = String(kod).trim().toUpperCase();
  if (["MERKEZ", "FIRMA", "KONU"].indexOf(tur) < 0) throw new Error("Tür MERKEZ, FIRMA ya da KONU olmalı.");
  if (!/^[A-Z0-9]{2,6}$/.test(kod)) throw new Error("Kod 2-6 büyük harf ya da rakam olmalı.");
  if (kodlar_()[tur][kod] !== undefined) throw new Error("Bu kod zaten var: " + kod);
  satirEkle_("Kodlar", { tur: tur, kod: kod, ad: temizle_(ad, 120) });
  return true;
}

function tarihMs_(v) {
  if (!v) return 0;
  var d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

/**
 * Kullanım özeti. Bir sınav "kullanılmış" sayılır: en az bir katılımcının girdiği bir oturumu
 * ya da Kullanim sekmesinde (kâğıt sınav gibi) bir kaydı varsa. Bir firmanın bir soruyu
 * "görmesi", o firma için hazırlanmış ve kullanılmış bir sınavda o sorunun yer almasıdır.
 */
function kullanimOzeti_(havuz) {
  var h = havuz || havuz_();
  var sinavlar = {};
  tablo_("Sinavlar").kayitlar.forEach(function (r) {
    var k = r.kayit;
    sinavlar[String(k.kod).trim()] = { kod: String(k.kod).trim(), firma: String(k.firma || "").trim().toUpperCase(), durum: String(k.durum || "").toUpperCase(), kullanim: [] };
  });
  var icerik = {}; // sinav -> [{id, surum}]
  tablo_("Sinav_Sorulari").kayitlar.forEach(function (r) {
    var k = r.kayit;
    var sk = String(k.sinav).trim();
    (icerik[sk] = icerik[sk] || []).push({ id: String(k.soru_id).trim(), surum: Number(k.surum) || 1 });
  });
  var davetler = tablo_("Davetler").kayitlar.map(function (r) {
    return r.kayit;
  });
  tablo_("Oturumlar").kayitlar.forEach(function (r) {
    var o = r.kayit;
    var ok = String(o.kod).trim().toUpperCase();
    var kisi = davetler.filter(function (d) {
      return String(d.oturum).trim() === ok && (d.durum === "basladi" || d.durum === "tamamlandi");
    }).length;
    var s = sinavlar[String(o.sinav).trim()];
    if (s && kisi > 0) s.kullanim.push({ tur: "WEB", oturum: ok, form: String(o.form || "A"), tarih: tarihMs_(o.baslangic), kisi: kisi });
  });
  tablo_("Kullanim").kayitlar.forEach(function (r) {
    var k = r.kayit;
    var s = sinavlar[String(k.sinav).trim()];
    if (s) s.kullanim.push({ tur: String(k.tur || "KAGIT"), oturum: "", form: String(k.form || ""), tarih: tarihMs_(k.tarih), kisi: Number(k.katilimci_sayisi) || 0, not: String(k.not || "") });
  });

  var soru = {}; // id -> özet
  function ozet(id) {
    return (soru[id] = soru[id] || { sinavlar: [], oturum: 0, katilimci: 0, firmalar: {}, son: 0, cevaplayan: 0, dogru: 0 });
  }
  Object.keys(icerik).forEach(function (sk) {
    var s = sinavlar[sk];
    if (!s) return;
    icerik[sk].forEach(function (x) {
      var z = ozet(x.id);
      if (z.sinavlar.indexOf(sk) < 0) z.sinavlar.push(sk);
      s.kullanim.forEach(function (u) {
        z.oturum++;
        z.katilimci += u.kisi;
        if (u.tarih > z.son) z.son = u.tarih;
        if (s.firma) z.firmalar[s.firma] = Math.max(z.firmalar[s.firma] || 0, u.tarih || 1);
      });
    });
  });
  // Ölçülen doğru oranı: bitirilmiş web sınavlarından, sınavda kullanılan sürümün anahtarıyla.
  davetler.forEach(function (d) {
    if (d.durum !== "tamamlandi" || !d.cevaplar_id) return;
    var c;
    try {
      c = JSON.parse(d.cevaplar_id);
    } catch (e) {
      return;
    }
    (icerik[String(d.sinav).trim()] || []).forEach(function (x) {
      var q = h[x.id + "@" + x.surum];
      if (!q) return;
      var z = ozet(x.id);
      z.cevaplayan++;
      if (c[x.id] !== undefined && c[x.id] !== "?" && dogruMu_(q, c[x.id])) z.dogru++;
    });
  });
  return { soru: soru, sinavlar: sinavlar, icerik: icerik };
}

function soruOzetiDisa_(z) {
  z = z || { sinavlar: [], oturum: 0, katilimci: 0, firmalar: {}, son: 0, cevaplayan: 0, dogru: 0 };
  var firmalar = {};
  Object.keys(z.firmalar).forEach(function (f) {
    firmalar[f] = z.firmalar[f] > 1 ? new Date(z.firmalar[f]).toISOString() : "";
  });
  return {
    sinavlar: z.sinavlar,
    oturum: z.oturum,
    katilimci: z.katilimci,
    firmalar: firmalar,
    son: z.son > 1 ? new Date(z.son).toISOString() : "",
    olculen: z.cevaplayan ? Math.round((z.dogru / z.cevaplayan) * 1000) / 10 : null,
    cevaplayan: z.cevaplayan,
  };
}

/** Panel: havuzdaki tüm sorular (her sorunun son sürümü öne), kullanım bilgisiyle. */
function havuzListesi() {
  var h = havuz_();
  var k = kullanimOzeti_(h);
  var sonSurum = {};
  Object.keys(h).forEach(function (key) {
    var q = h[key];
    if (!sonSurum[q.soru_id] || q.surum > sonSurum[q.soru_id].surum) sonSurum[q.soru_id] = q;
  });
  return Object.keys(sonSurum)
    .sort()
    .map(function (id) {
      var q = sonSurum[id];
      var onayli = Object.keys(h)
        .map(function (x) {
          return h[x];
        })
        .filter(function (x) {
          return x.soru_id === id && String(x.durum).toUpperCase() === "ONAYLI";
        })
        .map(function (x) {
          return x.surum;
        });
      return {
        id: id,
        surum: q.surum,
        durum: String(q.durum || "").toUpperCase(),
        onayli_surum: onayli.length ? Math.max.apply(null, onayli) : null,
        konu: String(q.konu || ""),
        bolum: String(q.bolum || ""),
        zorluk: String(q.zorluk || ""),
        grup: String(q.grup || ""),
        soru: String(q.soru || ""),
        sekil: sekilSayisi_(q),
        kullanim: soruOzetiDisa_(k.soru[id]),
      };
    });
}

function sekilAdlari_(q) {
  return String(q.gorsel || "").split(",").map(function (x) { return x.trim(); }).filter(String);
}

/** Soruda kendi şekli ve ortak şekil dahil kaç görsel var. */
function sekilSayisi_(q) {
  return sekilAdlari_(q).length + (String(q.grup_gorsel || "").trim() ? 1 : 0);
}

/** Havuz için görsel klasörü: Ayarlar'daki gorsel_klasor_id, yoksa bir sınavda tanımlı klasör. */
function havuzGorselKlasoru_() {
  var k = String(ayar_("gorsel_klasor_id") || "").trim();
  if (k) return k;
  var s = tablo_("Sinavlar").kayitlar.map(function (r) { return r.kayit; }).filter(function (x) { return String(x.gorsel_klasor_id || "").trim(); })[0];
  return s ? String(s.gorsel_klasor_id).trim() : "";
}

/** Panel: bir sorunun tam görünümü (metin, şekiller, şıklar ve doğru cevap). Yalnızca yöneticiye açıktır. */
function soruOnizle(id, surum) {
  var h = havuz_();
  var q = null;
  Object.keys(h).forEach(function (key) {
    var x = h[key];
    if (x.soru_id !== id) return;
    if (surum ? Number(x.surum) === Number(surum) : !q || x.surum > q.surum) q = x;
  });
  if (!q) throw new Error("Soru bulunamadı.");
  var klasor = havuzGorselKlasoru_();
  var gorselGetir = function (ad) {
    var v = gorsel_(klasor, ad);
    return { ad: ad, veri: v };
  };
  var siklar = [];
  if (q.tur !== "sayi") ["A", "B", "C", "D", "E"].forEach(function (h2) {
    if (q[h2] !== undefined && String(q[h2]).trim() !== "") siklar.push({ id: h2, metin: String(q[h2]) });
  });
  return {
    id: q.soru_id, surum: q.surum, durum: String(q.durum || "").toUpperCase(), konu: String(q.konu || ""), bolum: String(q.bolum || ""),
    zorluk: String(q.zorluk || ""), grup: String(q.grup || ""), grup_notu: String(q.grup_notu || ""),
    grup_gorsel: String(q.grup_gorsel || "").trim() ? gorselGetir(String(q.grup_gorsel).trim()) : null,
    soru: String(q.soru || ""), gorseller: sekilAdlari_(q).map(gorselGetir), tur: q.tur === "sayi" ? "sayi" : "coktan",
    siklar: siklar, dogru: String(q.dogru || ""), tolerans: String(q.tolerans || ""), birim: String(q.birim || ""),
    gerekce: String(q.gerekce || ""), kaynak: String(q.kaynak || ""), klasor_yok: !klasor,
  };
}

/** Taslak bir soru sürümünü onaylar; aynı sorunun önceki onaylı sürümü "ESKI" olur. */
function soruOnayla(id, surum) {
  var h = havuz_();
  var q = h[id + "@" + Number(surum)];
  if (!q) throw new Error("Soru bulunamadı.");
  if (String(q.durum).toUpperCase() !== "TASLAK") throw new Error("Yalnızca taslak sorular onaylanabilir.");
  if (!String(q.soru).trim() || !String(q.dogru).trim()) throw new Error("Soru metni ve doğru cevap boş olamaz.");
  if (q.tur !== "sayi" && !q[String(q.dogru).trim().toUpperCase()]) throw new Error("Doğru cevap olarak gösterilen şık boş.");
  Object.keys(h).forEach(function (k) {
    var x = h[k];
    if (x.soru_id === id && x.surum !== q.surum && String(x.durum).toUpperCase() === "ONAYLI") satirGuncelle_("Havuz", x._satir, { durum: "ESKI" });
  });
  satirGuncelle_("Havuz", q._satir, { durum: "ONAYLI", onay_tarihi: new Date() });
  return true;
}

/** Onaylı bir sorunun düzenlenebilir yeni sürümünü (taslak) oluşturur. Eski sürümler korunur. */
function soruYeniSurum(id) {
  var h = havuz_();
  var son = null;
  Object.keys(h).forEach(function (k) {
    if (h[k].soru_id === id && (!son || h[k].surum > son.surum)) son = h[k];
  });
  if (!son) throw new Error("Soru bulunamadı.");
  if (String(son.durum).toUpperCase() === "TASLAK") throw new Error("Bu sorunun zaten taslak bir sürümü var (v" + son.surum + ").");
  var yeni = {};
  BASLIKLAR.Havuz.forEach(function (b) {
    yeni[b] = son[b] !== undefined ? son[b] : "";
  });
  yeni.surum = son.surum + 1;
  yeni.durum = "TASLAK";
  yeni.olusturma = new Date();
  yeni.onay_tarihi = "";
  satirEkle_("Havuz", yeni);
  return yeni.surum;
}

function sonrakiSinavKodu_(merkez, firma, konu) {
  var on = [merkez, firma, konu].join("-") + "-";
  var max = 0;
  tablo_("Sinavlar").kayitlar.forEach(function (r) {
    var k = String(r.kayit.kod).trim();
    if (k.indexOf(on) === 0) max = Math.max(max, parseInt(k.slice(on.length), 10) || 0);
  });
  return on + ("00" + (max + 1)).slice(-3);
}

/** Panel: yeni sınav hazırlarken aday sorular ve bu firmanın daha önce gördükleri. */
function sinavHazirlik(merkez, firma, konu) {
  merkez = String(merkez).toUpperCase();
  firma = String(firma).toUpperCase();
  konu = String(konu).toUpperCase();
  var kd = kodlar_();
  if (kd.MERKEZ[merkez] === undefined || kd.FIRMA[firma] === undefined || kd.KONU[konu] === undefined) throw new Error("Merkez, firma ve konu kodları Kodlar sekmesinde tanımlı olmalı.");
  var liste = havuzListesi().filter(function (q) {
    return q.onayli_surum !== null && (!konu || q.konu.toUpperCase() === konu);
  });
  // Ayarlar için şablon: aynı konudaki en yeni sınav, yoksa herhangi bir sınav.
  var sablon = "";
  tablo_("Sinavlar").kayitlar.forEach(function (r) {
    var k = r.kayit;
    if (!sablon || String(k.konu).toUpperCase() === konu) sablon = String(k.kod);
  });
  return { kod: sonrakiSinavKodu_(merkez, firma, konu), adaylar: liste, sablon: sablon, firma_ad: kd.FIRMA[firma], merkez_ad: kd.MERKEZ[merkez] };
}

/**
 * Sınav taslağını kaydeder (yeni ya da mevcut taslak). Sorular, her birinin onaylı son sürümüyle eklenir.
 * g: {kod?, merkez, firma, konu, baslik, alt_baslik, sure_dk, sablon, sorular: [id...]}
 */
function sinavKaydet(g) {
  var kilit = LockService.getScriptLock();
  kilit.waitLock(20000);
  try {
    var h = havuz_();
    var onayli = {};
    Object.keys(h).forEach(function (k) {
      var q = h[k];
      if (String(q.durum).toUpperCase() === "ONAYLI" && (!onayli[q.soru_id] || q.surum > onayli[q.soru_id])) onayli[q.soru_id] = q.surum;
    });
    var ids = (g.sorular || []).map(String);
    if (!ids.length) throw new Error("En az bir soru seçin.");
    ids.forEach(function (id) {
      if (!onayli[id]) throw new Error("Onaylı sürümü olmayan soru: " + id);
    });
    var sure = parseInt(g.sure_dk, 10);
    if (!(sure > 0 && sure <= 600)) throw new Error("Süre 1-600 dakika olmalı.");

    var kod = String(g.kod || "").trim();
    var var_olan = kod ? sinavSatiri_(kod) : null;
    if (var_olan && String(var_olan.kayit.durum).toUpperCase() !== "TASLAK") throw new Error("Onaylanmış bir sınav değiştirilemez; yeni sınav oluşturun.");
    if (!var_olan) {
      var kd = kodlar_();
      var m = String(g.merkez).toUpperCase(),
        f = String(g.firma).toUpperCase(),
        k = String(g.konu).toUpperCase();
      if (kd.MERKEZ[m] === undefined || kd.FIRMA[f] === undefined || kd.KONU[k] === undefined) throw new Error("Kodlar tanımlı değil.");
      kod = sonrakiSinavKodu_(m, f, k);
      var sablon = g.sablon ? sinavBul_(g.sablon) : null;
      var satir = {};
      BASLIKLAR.Sinavlar.forEach(function (b) {
        satir[b] = sablon && sablon[b] !== undefined ? sablon[b] : "";
      });
      satir.kod = kod;
      satir.merkez = m;
      satir.firma = f;
      satir.konu = k;
      satir.durum = "TASLAK";
      satir.aktif = "HAYIR";
      satir.olusturma = new Date();
      satir.onay_tarihi = "";
      satir.not = "";
      satir.alt_baslik = temizle_(g.alt_baslik, 200) || kd.MERKEZ[m];
      satir.baslik = temizle_(g.baslik, 200);
      satir.sure_dk = sure;
      if (!satir.baslik) throw new Error("Sınav başlığı gerekli.");
      satirEkle_("Sinavlar", satir);
    } else {
      satirGuncelle_("Sinavlar", var_olan.satir, { baslik: temizle_(g.baslik, 200) || var_olan.kayit.baslik, alt_baslik: temizle_(g.alt_baslik, 200) || var_olan.kayit.alt_baslik, sure_dk: sure });
      satirlariSil_("Sinav_Sorulari", function (x) {
        return String(x.sinav).trim() === kod;
      });
    }
    ids.forEach(function (id, i) {
      satirEkle_("Sinav_Sorulari", { sinav: kod, sira: i + 1, soru_id: id, surum: onayli[id] });
    });
    return kod;
  } finally {
    kilit.releaseLock();
  }
}

function sinavSatiri_(kod) {
  var t = tablo_("Sinavlar");
  for (var i = 0; i < t.kayitlar.length; i++) if (String(t.kayitlar[i].kayit.kod).trim() === kod) return t.kayitlar[i];
  return null;
}

/** Koşula uyan satırları siler (alttan üste). */
function satirlariSil_(ad, kosul) {
  var sh = sayfa_(ad);
  var t = tablo_(ad);
  for (var i = t.kayitlar.length - 1; i >= 0; i--) if (kosul(t.kayitlar[i].kayit)) sh.deleteRow(t.kayitlar[i].satir);
}

/** Panel: bir sınavın soruları, kullanımları ve firmanın geçmişiyle örtüşmesi. */
function sinavDetay(kod) {
  var s = sinavBul_(kod);
  if (!s) throw new Error("Sınav bulunamadı.");
  var h = havuz_();
  var k = kullanimOzeti_(h);
  var firma = String(s.firma || "").toUpperCase();
  var sorular = sinavSorulari_(kod, h).map(function (q) {
    var z = soruOzetiDisa_(k.soru[q.id]);
    // Bu sınavın kendi kullanımı dışında, firmanın bu soruyu gördüğü en son tarih.
    var gordu = "";
    Object.keys(k.sinavlar).forEach(function (sk) {
      var x = k.sinavlar[sk];
      if (sk === kod || x.firma !== firma || !x.kullanim.length) return;
      if ((k.icerik[sk] || []).some(function (y) { return y.id === q.id; })) {
        var t = Math.max.apply(null, x.kullanim.map(function (u) { return u.tarih || 1; }));
        if (!gordu || t > tarihMs_(gordu)) gordu = t > 1 ? new Date(t).toISOString() : "tarihsiz";
      }
    });
    return { no: q.no, id: q.id, surum: q.surum, bolum: q.bolum || "", zorluk: q.zorluk || "", soru: String(q.soru), sekil: sekilSayisi_(q), kullanim: z, firma_gordu: gordu };
  });
  var onceki = Object.keys(k.sinavlar)
    .filter(function (sk) {
      return sk !== kod && k.sinavlar[sk].firma === firma && k.sinavlar[sk].kullanim.length;
    })
    .map(function (sk) {
      var ids = (k.icerik[sk] || []).map(function (y) { return y.id; });
      var ortak = sorular.filter(function (q) { return ids.indexOf(q.id) >= 0; }).length;
      return { kod: sk, ortak: ortak, toplam: ids.length };
    })
    .filter(function (x) {
      return x.ortak > 0;
    });
  var formlar = tablo_("Formlar")
    .kayitlar.map(function (r) { return r.kayit; })
    .filter(function (f) { return String(f.sinav).trim() === kod; })
    .map(function (f) {
      var kul = k.sinavlar[kod] ? k.sinavlar[kod].kullanim.filter(function (u) { return u.form === String(f.form); }) : [];
      return { form: String(f.form), olusturma: tarih_(f.olusturma), kullanim: kul.length, katilimci: kul.reduce(function (a, u) { return a + u.kisi; }, 0) };
    });
  return {
    kod: kod,
    baslik: String(s.baslik),
    alt_baslik: String(s.alt_baslik || ""),
    merkez: String(s.merkez || ""),
    firma: firma,
    konu: String(s.konu || ""),
    durum: String(s.durum || "").toUpperCase(),
    sure_dk: Number(s.sure_dk),
    sorular: sorular,
    firma_gordugu: sorular.filter(function (q) { return q.firma_gordu; }).length,
    onceki: onceki,
    formlar: formlar,
  };
}

/**
 * Taslak sınavı onaylar ve A formunu oluşturur. Engel kuralı: aynı firmaya daha önce kullanılmış
 * bir sınavla birebir aynı soru seti onaylanamaz.
 */
function sinavOnayla(kod) {
  var sr = sinavSatiri_(kod);
  if (!sr) throw new Error("Sınav bulunamadı.");
  if (String(sr.kayit.durum).toUpperCase() !== "TASLAK") throw new Error("Yalnızca taslak sınavlar onaylanabilir.");
  var h = havuz_();
  var sorular = sinavSorulari_(kod, h);
  if (!sorular.length) throw new Error("Sınavda soru yok.");
  sorular.forEach(function (q) {
    if (String(q.durum).toUpperCase() !== "ONAYLI") throw new Error(q.id + " v" + q.surum + " onaylı değil.");
  });
  var d = sinavDetay(kod);
  d.onceki.forEach(function (x) {
    if (x.ortak === sorular.length && x.toplam === sorular.length) throw new Error("Bu soru seti, " + d.firma + " firmasına " + x.kod + " sınavında aynen kullanıldı. En az bir kısım soruyu değiştirin.");
  });
  satirGuncelle_("Sinavlar", sr.satir, { durum: "ONAYLI", onay_tarihi: new Date() });
  if (!formBul_(kod, "A")) {
    var siklar = {};
    sorular.forEach(function (q) {
      siklar[q.id] = varsayilanSiklar_(q);
    });
    satirEkle_("Formlar", { sinav: kod, form: "A", sira: JSON.stringify(sorular.map(function (q) { return q.id; })), siklar: JSON.stringify(siklar), olusturma: new Date() });
  }
  return true;
}

function sinavArsivle(kod) {
  var sr = sinavSatiri_(kod);
  if (!sr) throw new Error("Sınav bulunamadı.");
  satirGuncelle_("Sinavlar", sr.satir, { durum: "ARSIV" });
  return true;
}

/**
 * Tek komutla yeni form: soruların sırası bölüm içinde, şıkların yeri her soruda değişir.
 * Ortak şekilli soru grupları birlikte kalır; bölümlerin sırası korunur.
 */
function formOlustur(kod) {
  var s = sinavBul_(kod);
  if (!s || String(s.durum).toUpperCase() !== "ONAYLI") throw new Error("Yalnızca onaylı sınavlara form eklenebilir.");
  var mevcut = tablo_("Formlar")
    .kayitlar.map(function (r) { return r.kayit; })
    .filter(function (f) { return String(f.sinav).trim() === kod; })
    .map(function (f) { return String(f.form); });
  var harfler = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  var yeni = "";
  for (var i = 0; i < harfler.length; i++) if (mevcut.indexOf(harfler[i]) < 0) { yeni = harfler[i]; break; }
  if (!yeni) throw new Error("En fazla 26 form oluşturulabilir.");
  var sorular = sinavSorulari_(kod);
  var sira = formSirasiUret_(sorular, Math.random);
  var siklar = {};
  sorular.forEach(function (q) {
    var h = varsayilanSiklar_(q).split("");
    siklar[q.id] = q.tur === "sayi" ? h.join("") : karistirRastgele_(h, Math.random).join("");
  });
  satirEkle_("Formlar", { sinav: kod, form: yeni, sira: JSON.stringify(sira), siklar: JSON.stringify(siklar), olusturma: new Date() });
  return yeni;
}

/**
 * Dışarıda hazırlanmış bir formu (ör. elle hazırlanmış kâğıt kitapçık) olduğu gibi kaydeder.
 * sira: soru kimlikleri kitapçık sırasıyla; siklar: {soru_id: "CADB"} (kitapçıktaki a, b, c, d'nin havuzdaki harfleri).
 * Sınavdaki soruların tamamı tam bir kez bulunmalı, şıklar sorunun kendi şıklarının bir sıralaması olmalı.
 */
function formKaydet_(kod, harf, sira, siklar, not) {
  var s = sinavBul_(kod);
  if (!s || String(s.durum).toUpperCase() !== "ONAYLI") throw new Error("Yalnızca onaylı sınavlara form eklenebilir.");
  harf = String(harf).toUpperCase();
  if (formBul_(kod, harf)) throw new Error("Bu form zaten var: " + kod + " Form " + harf);
  var sorular = sinavSorulari_(kod);
  var idx = {};
  sorular.forEach(function (q) { idx[q.id] = q; });
  if (sira.length !== sorular.length) throw new Error("Soru sayısı tutmuyor: " + sira.length + " / " + sorular.length);
  var gorulen = {};
  sira.forEach(function (id) {
    if (!idx[id]) throw new Error("Sınavda olmayan soru: " + id);
    if (gorulen[id]) throw new Error("Tekrarlanan soru: " + id);
    gorulen[id] = true;
    var q = idx[id];
    var asil = varsayilanSiklar_(q).split("").sort().join("");
    var verilen = String(siklar[id] || "");
    if (q.tur !== "sayi" && verilen.split("").sort().join("") !== asil) throw new Error("Şıklar hatalı: " + id + " " + verilen);
  });
  var temiz = {};
  sira.forEach(function (id) { temiz[id] = idx[id].tur === "sayi" ? varsayilanSiklar_(idx[id]) : String(siklar[id]); });
  satirEkle_("Formlar", { sinav: kod, form: harf, sira: JSON.stringify(sira), siklar: JSON.stringify(temiz), olusturma: new Date() });
  return harf;
}

/** Saf fonksiyon: bölüm sırası korunur, bölüm içinde birimler (tek soru ya da grup) karışır. */
function formSirasiUret_(sorular, rnd) {
  var bolumler = [];
  var bolumBirimleri = {};
  sorular.forEach(function (q) {
    var b = q.bolum || "Genel";
    if (!bolumBirimleri[b]) {
      bolumBirimleri[b] = [];
      bolumler.push(b);
    }
    var birimler = bolumBirimleri[b];
    var son = birimler[birimler.length - 1];
    if (q.grup && son && son.grup === q.grup) son.ids.push(q.id);
    else birimler.push({ grup: q.grup || "", ids: [q.id] });
  });
  var sira = [];
  bolumler.forEach(function (b) {
    karistirRastgele_(bolumBirimleri[b], rnd).forEach(function (u) {
      sira = sira.concat(u.ids);
    });
  });
  return sira;
}

function karistirRastgele_(dizi, rnd) {
  var a = dizi.slice();
  for (var j = a.length - 1; j > 0; j--) {
    var r = Math.floor(rnd() * (j + 1));
    var t = a[j];
    a[j] = a[r];
    a[r] = t;
  }
  return a;
}

/** Kâğıt sınav gibi sistem dışı bir kullanımı kaydeder. */
function kullanimEkle(g) {
  if (!sinavBul_(String(g.sinav))) throw new Error("Sınav bulunamadı.");
  satirEkle_("Kullanim", { sinav: String(g.sinav), form: String(g.form || ""), tarih: g.tarih ? new Date(g.tarih) : "", katilimci_sayisi: parseInt(g.katilimci_sayisi, 10) || "", tur: String(g.tur || "KAGIT"), not: temizle_(g.not, 300) });
  return true;
}

/**
 * Tek seferlik geçiş: eski yapıdaki (Sinavlar + Sorular) soruları havuza taşır.
 * harita: [{eski, yeni, merkez, firma, konu, kullanim: {tarih, katilimci_sayisi, tur, not}}]
 * kodlar: [{tur, kod, ad}]
 * Deneme kayıtları (Oturumlar, Davetler, Sonuclar, Detay_*) temizlenir.
 */
function gecisYap_(harita, kodlar) {
  var ss = SpreadsheetApp.getActive();
  if (ss.getSheetByName("Havuz") && tablo_("Havuz").kayitlar.length) throw new Error("Havuz dolu; geçiş daha önce yapılmış.");
  var eskiSorular = tablo_("Sorular").kayitlar.map(function (r) { return r.kayit; });
  var eskiSinavlar = tablo_("Sinavlar").kayitlar.map(function (r) { return r.kayit; });

  ["Kodlar", "Havuz", "Sinav_Sorulari", "Formlar", "Kullanim"].forEach(function (ad) {
    sayfa_(ad);
  });
  kodlar.forEach(function (k) {
    satirEkle_("Kodlar", k);
  });

  var sayac = {};
  var yeniSinavlar = [];
  harita.forEach(function (m) {
    var eski = eskiSinavlar.filter(function (x) { return String(x.kod).trim() === m.eski; })[0];
    if (!eski) throw new Error("Eski sınav yok: " + m.eski);
    var qs = eskiSorular
      .filter(function (q) { return String(q.sinav).trim() === m.eski; })
      .sort(function (a, b) { return Number(a.no) - Number(b.no); });
    var gruplar = {};
    var grupSay = 0;
    var siklar = {};
    var ids = [];
    qs.forEach(function (q) {
      sayac[m.konu] = (sayac[m.konu] || 0) + 1;
      var id = m.konu + "-" + ("000" + sayac[m.konu]).slice(-4);
      var gAnahtar = String(q.grup_gorsel || q.grup_notu || "").trim();
      var grup = "";
      if (gAnahtar) {
        if (!gruplar[gAnahtar]) gruplar[gAnahtar] = m.konu + "-G" + ("00" + ++grupSay).slice(-3);
        grup = gruplar[gAnahtar];
      }
      var satir = {
        soru_id: id, surum: 1, durum: "ONAYLI", konu: m.konu, bolum: q.bolum, zorluk: "", grup: grup,
        grup_notu: grupNotuNumarasiz_(q.grup_notu), grup_gorsel: q.grup_gorsel, soru: q.soru, gorsel: q.gorsel, tur: q.tur || "coktan",
        A: q.A, B: q.B, C: q.C, D: q.D, E: q.E || "", dogru: q.dogru, tolerans: q.tolerans || "", birim: q.birim || "",
        gerekce: "", kaynak: m.yeni + " (" + m.eski + ") soru " + q.no, olusturma: new Date(), onay_tarihi: new Date(), not: "",
      };
      satirEkle_("Havuz", satir);
      ids.push(id);
      siklar[id] = varsayilanSiklar_(satir);
      satirEkle_("Sinav_Sorulari", { sinav: m.yeni, sira: ids.length, soru_id: id, surum: 1 });
    });
    satirEkle_("Formlar", { sinav: m.yeni, form: "A", sira: JSON.stringify(ids), siklar: JSON.stringify(siklar), olusturma: new Date() });
    var aciklama = String(eski.aciklama || "")
      .replace(/soru sayısı \d+/, "soru sayısı {soru_sayisi}")
      .replace(/süreniz \d+ dakikadır/, "süreniz {sure_dk} dakikadır");
    var yeni = {};
    BASLIKLAR.Sinavlar.forEach(function (b) {
      yeni[b] = eski[b] !== undefined ? eski[b] : "";
    });
    yeni.kod = m.yeni;
    yeni.merkez = m.merkez;
    yeni.firma = m.firma;
    yeni.konu = m.konu;
    yeni.durum = "ONAYLI";
    yeni.aktif = "HAYIR";
    yeni.aciklama = aciklama;
    yeni.olusturma = new Date();
    yeni.onay_tarihi = new Date();
    yeni.not = "Geçiş: " + m.eski;
    yeniSinavlar.push(yeni);
    if (m.kullanim) {
      var u = m.kullanim;
      satirEkle_("Kullanim", { sinav: m.yeni, form: "A", tarih: u.tarih ? new Date(u.tarih) : "", katilimci_sayisi: u.katilimci_sayisi || "", tur: u.tur || "KAGIT", not: u.not || "" });
    }
  });

  // Sinavlar sekmesini yeni başlıklarla yeniden yaz.
  var sh = sayfa_("Sinavlar");
  sh.clear();
  sh.getRange(1, 1, 1, BASLIKLAR.Sinavlar.length).setValues([BASLIKLAR.Sinavlar]).setFontWeight("bold");
  yeniSinavlar.forEach(function (y) {
    satirEkle_("Sinavlar", y);
  });
  // Deneme kayıtlarını temizle, başlıkları yenile.
  ["Oturumlar", "Davetler", "Sonuclar"].forEach(function (ad) {
    var x = sayfa_(ad);
    x.clear();
    x.getRange(1, 1, 1, BASLIKLAR[ad].length).setValues([BASLIKLAR[ad]]).setFontWeight("bold");
  });
  ss.getSheets().forEach(function (x) {
    if (/^Detay_/.test(x.getName())) ss.deleteSheet(x);
  });
  var eskiSh = ss.getSheetByName("Sorular");
  if (eskiSh) ss.deleteSheet(eskiSh);
  return { soru: Object.keys(sayac).reduce(function (a, k) { return a + sayac[k]; }, 0), sinav: yeniSinavlar.length };
}


// Yönetim paneli sayfası (google/panel.html'den derlenir; elle düzenlemeyin).
var PANEL_HTML = /*PANEL_HTML*/ "<!doctype html>\n<html lang=\"tr\">\n<head>\n<meta charset=\"utf-8\">\n<base target=\"_top\">\n<style>\n:root{--bg:#f3f5f7;--panel:#fff;--text:#16202a;--muted:#64717e;--line:#dde3e9;--soft:#f7f9fb;--accent:#1457d9;--accent-soft:#eef3fd;--good:#1f8a4c;--good-soft:#e9f6ee;--bad:#b42318;--bad-soft:#fdecea;--warn:#a86700;--warn-soft:#fdf3df;--font:system-ui,-apple-system,\"Segoe UI\",Roboto,Arial,sans-serif}\n*{box-sizing:border-box}\nbody{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 var(--font)}\n[hidden]{display:none!important}\n.tabs{display:flex;gap:4px;background:var(--panel);border-bottom:1px solid var(--line);padding:0 16px;position:sticky;top:0;z-index:5}\n.tabs button{background:none;border:0;border-bottom:2px solid transparent;padding:12px 12px 10px;font:600 14px var(--font);color:var(--muted);cursor:pointer}\n.tabs button[aria-selected=true]{color:var(--accent);border-bottom-color:var(--accent)}\n.tabs .spacer{flex:1}\n.tabs .refresh{color:var(--muted);font-weight:500}\nmain{padding:16px}\n.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;margin-bottom:14px}\n.ph{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 14px;border-bottom:1px solid var(--line)}\n.ph h2{margin:0;font-size:15px}\n.pb{padding:14px}\n.grid2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px;align-items:start}\n.fields{display:grid;grid-template-columns:1fr 1fr;gap:12px}\n.field{display:block}\n.field.wide{grid-column:1 / -1}\n.flabel{display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:4px}\ninput,select{width:100%;height:36px;padding:0 10px;border:1px solid #cdd5dd;border-radius:7px;font:14px var(--font);color:var(--text);background:#fff}\nbutton.btn{font:600 14px var(--font);border-radius:7px;cursor:pointer;height:36px;padding:0 14px;border:1px solid #cdd5dd;background:#fff;color:var(--text)}\nbutton.primary{background:var(--accent);border-color:var(--accent);color:#fff}\nbutton.small{height:28px;padding:0 10px;font-size:12px}\nbutton:disabled{opacity:.5;cursor:default}\n.hint{font-size:12px;color:var(--muted);margin:6px 0 0}\n.error{color:var(--bad);font-size:13px;margin:8px 0 0}\n.codebox{text-align:center}\n.code{font:700 44px/1.1 ui-monospace,Consolas,monospace;letter-spacing:6px;margin:6px 0}\n.qr{display:flex;justify-content:center;margin:10px 0}\n.qr img,.qr canvas{width:220px;height:220px}\n.linkrow{display:flex;gap:8px;margin-top:8px}\n.linkrow input{font-size:12px}\ntable{width:100%;border-collapse:collapse;font-size:13px}\nth,td{padding:7px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle}\nthead th{font-size:12px;color:var(--muted);background:var(--soft);font-weight:600;white-space:nowrap}\ntd.num,th.num{text-align:right;font-variant-numeric:tabular-nums}\n.badge{display:inline-block;font-size:11px;font-weight:700;border-radius:999px;padding:2px 8px}\n.b-acik{background:var(--good-soft);color:var(--good)}\n.b-kapali{background:#eef1f4;color:#596672}\n.b-bitti{background:var(--warn-soft);color:var(--warn)}\n.kpis{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px;margin-bottom:14px}\n.kpi{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 12px}\n.kpi span{display:block;font-size:12px;color:var(--muted)}\n.kpi b{font-size:22px;font-variant-numeric:tabular-nums}\n.hist{display:grid;grid-template-columns:repeat(10,1fr);gap:6px;align-items:end;height:160px;padding-top:10px}\n.hist .col{display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:100%}\n.hist .bar{width:100%;background:var(--accent);border-radius:4px 4px 0 0;min-height:1px}\n.hist .v{font-size:11px;color:var(--muted);margin-bottom:2px}\n.hist .lbl{font-size:10px;color:var(--muted);margin-top:4px;white-space:nowrap}\n.hbar{display:grid;grid-template-columns:minmax(140px,240px) 1fr 52px;gap:10px;align-items:center;margin:6px 0;font-size:13px}\n.track{height:12px;background:#e7ebef;border-radius:99px;overflow:hidden}\n.track div{height:100%;border-radius:99px}\n.lo{background:var(--bad)}.mid{background:#e3a008}.hi{background:var(--good)}\n.mini{display:inline-block;width:70px;height:8px;background:#e7ebef;border-radius:99px;overflow:hidden;vertical-align:middle;margin-right:6px}\n.mini i{display:block;height:100%}\n.scroll{max-height:360px;overflow:auto}\n.empty{color:var(--muted);text-align:center;padding:24px}\n.overlay{position:fixed;inset:0;background:#fff;z-index:20;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;text-align:center}\n.overlay .code{font-size:clamp(32px,9vh,72px)}\n.overlay .qr{margin:4px 0}\n.overlay .qr img,.overlay .qr canvas{width:var(--qr,300px);height:var(--qr,300px)}\n.ovbtns{position:absolute;top:12px;right:12px;display:flex;gap:8px}\n.overlay p{margin:0;color:var(--muted);font-size:18px}\n.overlay h1{margin:0;font-size:20px}\n.close{position:absolute;top:12px;right:12px}\n.toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}\n.toolbar input,.toolbar select{width:auto;min-width:120px}\n.b-taslak{background:var(--warn-soft);color:var(--warn)}\n.b-onayli{background:var(--good-soft);color:var(--good)}\n.b-arsiv,.b-eski{background:#eef1f4;color:#596672}\n.seen{color:var(--bad);font-weight:600}\n.muted{color:var(--muted)}\n.stats{display:flex;flex-wrap:wrap;gap:14px;font-size:13px;margin:6px 0}\n.stats b{font-variant-numeric:tabular-nums}\ntr.sel td{background:var(--accent-soft)}\ntd.chk{width:28px}\n.warnbox{background:var(--warn-soft);color:#6b4a00;border-radius:8px;padding:8px 12px;font-size:13px;margin:8px 0}\n.okbox{background:var(--good-soft);color:var(--good);border-radius:8px;padding:8px 12px;font-size:13px;margin:8px 0}\n.pvlink{white-space:nowrap;background:none;border:0;padding:0;font:inherit;font-weight:700;color:var(--accent);cursor:pointer;text-decoration:underline;text-underline-offset:2px}\n.btn.small{white-space:nowrap}\n.sekil{display:inline-block;font-size:11px;font-weight:600;padding:1px 7px;border-radius:999px;background:var(--accent-soft);color:var(--accent);white-space:nowrap}\n.pv{position:fixed;inset:0;background:rgba(20,28,36,.45);z-index:30;display:flex;align-items:flex-start;justify-content:center;padding:24px;overflow:auto}\n.pv[hidden]{display:none}\n.pv .kart{background:#fff;border-radius:12px;max-width:860px;width:100%;padding:20px 24px;box-shadow:0 10px 40px rgba(0,0,0,.2)}\n.pv .ust{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:8px}\n.pv h3{margin:0;font-size:18px}\n.pv .meta{font-size:13px;color:var(--muted);margin-bottom:12px}\n.pv .gnot{background:#f5f7f9;border-radius:8px;padding:10px 12px;margin:10px 0;font-size:14px;white-space:pre-wrap}\n.pv .metin{font-size:15px;line-height:1.5;white-space:pre-wrap;margin:10px 0}\n.pv img{display:block;max-width:100%;max-height:440px;margin:10px auto;border:1px solid var(--line);border-radius:6px}\n.pv .eksik{color:var(--bad);font-size:13px;margin:8px 0}\n.pv ol{list-style:none;padding:0;margin:12px 0}\n.pv li{padding:8px 12px;border:1px solid var(--line);border-radius:8px;margin:6px 0;font-size:14px}\n.pv li.dogru{border-color:var(--good);background:var(--good-soft)}\n.pv li b{margin-right:8px}\n.pv .alt{font-size:13px;color:var(--muted);margin-top:10px}\n.loading{position:fixed;inset:0;background:rgba(243,245,247,.6);display:flex;align-items:center;justify-content:center;z-index:30;font-weight:600}\n</style>\n</head>\n<body>\n<nav class=\"tabs\" role=\"tablist\">\n  <button data-t=\"yeni\" aria-selected=\"true\">Yeni oturum</button>\n  <button data-t=\"liste\" aria-selected=\"false\">Oturumlar</button>\n  <button data-t=\"rapor\" aria-selected=\"false\">Rapor</button>\n  <button data-t=\"sinavlar\" aria-selected=\"false\">Sınavlar</button>\n  <button data-t=\"havuz\" aria-selected=\"false\">Soru havuzu</button>\n  <span class=\"spacer\"></span>\n  <button class=\"refresh\" id=\"refresh\">Yenile</button>\n</nav>\n<main>\n  <!-- Yeni oturum -->\n  <section id=\"t-yeni\">\n    <div class=\"grid2\">\n      <form class=\"panel\" id=\"form\">\n        <div class=\"ph\"><h2>Oturum bilgileri</h2></div>\n        <div class=\"pb\">\n          <div class=\"fields\">\n            <label class=\"field wide\"><span class=\"flabel\">Sınav</span><select id=\"fSinav\" required></select></label>\n            <label class=\"field\"><span class=\"flabel\">Firma</span><input id=\"fFirma\" maxlength=\"120\" placeholder=\"Katılımcıların firması\"></label>\n            <label class=\"field\"><span class=\"flabel\">Eğitim merkezi</span><input id=\"fMerkez\" maxlength=\"120\"></label>\n            <label class=\"field\"><span class=\"flabel\">Kişi sayısı</span><input id=\"fKisi\" type=\"number\" min=\"1\" max=\"1000\" required></label>\n            <label class=\"field\"><span class=\"flabel\">Form</span><select id=\"fForm\"></select></label>\n            <label class=\"field\"><span class=\"flabel\">Girişler açılsın</span><input id=\"fBas\" type=\"datetime-local\" required></label>\n            <label class=\"field\"><span class=\"flabel\">Girişler kapansın</span><input id=\"fBit\" type=\"datetime-local\" required></label>\n            <label class=\"field wide\"><span class=\"flabel\">Not (yalnızca sizin için)</span><input id=\"fNot\" maxlength=\"300\"></label>\n          </div>\n          <p class=\"hint\">Kapanış saati yalnızca yeni girişleri durdurur; o saate kadar başlayan katılımcı kendi süresi dolana kadar devam eder. Kişi sayısına ulaşılınca yeni giriş kabul edilmez.</p>\n          <p class=\"error\" id=\"formErr\" hidden></p>\n          <div style=\"margin-top:12px\"><button class=\"btn primary\" type=\"submit\" id=\"createBtn\">Oturum oluştur</button></div>\n        </div>\n      </form>\n      <div class=\"panel\" id=\"result\" hidden>\n        <div class=\"ph\"><h2>Giriş kodu</h2><button class=\"btn small\" id=\"fullBtn\">Tam ekran göster</button></div>\n        <div class=\"pb codebox\">\n          <div class=\"hint\" id=\"rSinav\"></div>\n          <div class=\"code\" id=\"rCode\"></div>\n          <div class=\"qr\" id=\"rQr\"></div>\n          <div class=\"linkrow\"><input id=\"rLink\" readonly><button class=\"btn\" id=\"copyBtn\">Kopyala</button></div>\n          <p class=\"hint\">Bağlantıyı katılımcılara gönderin ya da karekodu sınıfta gösterin. Herkes aynı kodla girer, ancak her katılımcının sınavı ve sonucu ayrıdır.</p>\n        </div>\n      </div>\n    </div>\n  </section>\n\n  <!-- Oturumlar -->\n  <section id=\"t-liste\" hidden>\n    <div class=\"panel\">\n      <div class=\"ph\"><h2>Oturumlar</h2></div>\n      <div class=\"pb\" style=\"padding:0\">\n        <div class=\"scroll\" style=\"max-height:640px\">\n          <table>\n            <thead><tr><th>Kod</th><th>Sınav</th><th>Firma</th><th>Eğitim merkezi</th><th>Giriş aralığı</th><th class=\"num\">Kişi</th><th class=\"num\">Devam</th><th class=\"num\">Bitti</th><th>Durum</th><th></th></tr></thead>\n            <tbody id=\"listBody\"></tbody>\n          </table>\n        </div>\n      </div>\n    </div>\n  </section>\n\n  <!-- Rapor -->\n  <section id=\"t-rapor\" hidden>\n    <div class=\"panel\"><div class=\"pb\" style=\"display:flex;gap:10px;align-items:center\">\n      <span class=\"flabel\" style=\"margin:0\">Oturum</span>\n      <select id=\"rpSel\" style=\"max-width:520px\"></select>\n      <button class=\"btn\" id=\"rpLoad\">Göster</button>\n      <span class=\"spacer\" style=\"flex:1\"></span>\n      <button class=\"btn primary\" id=\"rpFile\">Rapor dosyası oluştur</button>\n    </div>\n    <div class=\"pb\" id=\"rpFileBox\" hidden style=\"padding-top:0\">\n      <p class=\"hint\" id=\"rpFileMsg\" style=\"margin:0\"></p>\n    </div></div>\n    <div id=\"rpBody\"></div>\n  </section>\n  <!-- Sınavlar -->\n  <section id=\"t-sinavlar\" hidden>\n    <div id=\"snListe\">\n      <div class=\"panel\">\n        <div class=\"ph\"><h2>Sınavlar</h2><button class=\"btn primary small\" id=\"snYeni\">Yeni sınav hazırla</button></div>\n        <div class=\"scroll\" style=\"max-height:640px\"><table>\n          <thead><tr><th>Kod</th><th>Başlık</th><th>Durum</th><th class=\"num\">Soru</th><th>Formlar</th><th></th></tr></thead>\n          <tbody id=\"snBody\"></tbody>\n        </table></div>\n      </div>\n    </div>\n    <div id=\"snDetay\" hidden></div>\n    <div id=\"snHazir\" hidden>\n      <div class=\"panel\">\n        <div class=\"ph\"><h2>Yeni sınav hazırla</h2><button class=\"btn small\" id=\"hzGeri\">Sınavlara dön</button></div>\n        <div class=\"pb\">\n          <div class=\"toolbar\">\n            <select id=\"hzMerkez\"></select><select id=\"hzFirma\"></select><select id=\"hzKonu\"></select>\n            <button class=\"btn\" id=\"hzGetir\">Soruları getir</button>\n          </div>\n          <div class=\"toolbar\" style=\"margin-top:10px\">\n            <span class=\"muted\" style=\"font-size:12px\">Listede olmayan merkez, firma ya da konu için kod ekle:</span>\n            <select id=\"kdTur\" style=\"min-width:90px\"><option>FIRMA</option><option>MERKEZ</option><option>KONU</option></select>\n            <input id=\"kdKod\" placeholder=\"KOD\" maxlength=\"6\" style=\"min-width:70px;width:80px\"><input id=\"kdAd\" placeholder=\"Tam ad\" style=\"min-width:160px\">\n            <button class=\"btn small\" id=\"kdEkle\">Ekle</button>\n          </div>\n          <p class=\"error\" id=\"hzErr\" hidden></p>\n        </div>\n      </div>\n      <div id=\"hzGovde\" hidden>\n        <div class=\"panel\"><div class=\"pb\">\n          <div class=\"fields\">\n            <label class=\"field\"><span class=\"flabel\">Sınav kodu</span><input id=\"hzKod\" readonly></label>\n            <label class=\"field\"><span class=\"flabel\">Süre (dakika)</span><input id=\"hzSure\" type=\"number\" min=\"1\" max=\"600\"></label>\n            <label class=\"field\"><span class=\"flabel\">Başlık</span><input id=\"hzBaslik\" maxlength=\"200\"></label>\n            <label class=\"field\"><span class=\"flabel\">Alt başlık</span><input id=\"hzAlt\" maxlength=\"200\"></label>\n            <label class=\"field wide\"><span class=\"flabel\">Talimat, KVKK ve diğer ayarlar şuradan kopyalansın</span><select id=\"hzSablon\"></select></label>\n          </div>\n          <div class=\"toolbar\" style=\"margin-top:12px\">\n            <span class=\"flabel\" style=\"margin:0\">Öneri:</span>\n            <input id=\"hzN\" type=\"number\" min=\"1\" placeholder=\"Toplam soru\" style=\"width:120px;min-width:0\">\n            <button class=\"btn\" id=\"hzOner\">Öner</button>\n            <span class=\"muted\" style=\"font-size:12px\">Bölümlere orantılı dağıtır; bu firmanın görmediği ve az kullanılan soruları öne alır, ortak şekilli grupları bölmez.</span>\n          </div>\n          <div class=\"stats\" id=\"hzOzet\"></div>\n          <div id=\"hzUyari\"></div>\n          <button class=\"btn primary\" id=\"hzKaydet\">Taslak olarak kaydet</button>\n        </div></div>\n        <div class=\"panel\"><div class=\"scroll\" style=\"max-height:520px\"><table>\n          <thead><tr><th class=\"chk\"></th><th>Soru</th><th>Bölüm</th><th>Zorluk</th><th>Şekil</th><th class=\"num\">Ölçülen doğru</th><th class=\"num\">Kullanım</th><th>Bu firma gördü</th><th>Son kullanım</th><th>Metin</th></tr></thead>\n          <tbody id=\"hzBody\"></tbody>\n        </table></div></div>\n      </div>\n    </div>\n  </section>\n\n  <!-- Soru havuzu -->\n  <section id=\"t-havuz\" hidden>\n    <div class=\"panel\"><div class=\"pb toolbar\">\n      <select id=\"hvKonu\"></select>\n      <select id=\"hvDurum\"><option value=\"\">Tüm durumlar</option><option>ONAYLI</option><option>TASLAK</option><option>ESKI</option><option>EMEKLI</option></select>\n      <select id=\"hvFirma\"></select>\n      <select id=\"hvSekil\"><option value=\"\">Şekil: tümü</option><option value=\"var\">Şekilli sorular</option><option value=\"yok\">Yalnız metin</option></select>\n      <select id=\"hvKul\"><option value=\"\">Kullanım: tümü</option><option value=\"hic\">Hiç kullanılmamış</option><option value=\"6ay\">Son 6 ayda kullanılmamış</option></select>\n      <input id=\"hvAra\" placeholder=\"Ara: kod ya da metin\" style=\"min-width:200px\">\n      <span class=\"spacer\" style=\"flex:1\"></span>\n      <span class=\"muted\" id=\"hvSay\" style=\"font-size:12px\"></span>\n    </div>\n    <p class=\"hint\" style=\"margin:0 14px 10px\">Yeni soru ve taslak metinleri E-Tablodaki Havuz sekmesine eklenir; burada onaylanır. Onaylı bir soruyu değiştirmek için \"Yeni sürüm\" ile düzenlenebilir bir kopya açılır, eski sürüm korunur.</p>\n    </div>\n    <div class=\"panel\"><div class=\"scroll\" style=\"max-height:600px\"><table>\n      <thead><tr><th>Soru</th><th>Sürüm</th><th>Durum</th><th>Bölüm</th><th>Zorluk</th><th>Şekil</th><th>Metin</th><th class=\"num\">Sınav</th><th class=\"num\">Oturum</th><th class=\"num\">Kişi</th><th>Firmalar</th><th>Son kullanım</th><th class=\"num\">Ölçülen doğru</th><th></th></tr></thead>\n      <tbody id=\"hvBody\"></tbody>\n    </table></div></div>\n  </section>\n</main>\n\n<div class=\"pv\" id=\"pv\" hidden><div class=\"kart\" id=\"pvKart\"></div></div>\n<div class=\"overlay\" id=\"overlay\" hidden>\n  <div class=\"ovbtns\"><button class=\"btn\" id=\"ovTab\">Projeksiyon için yeni sekmede aç</button><button class=\"btn\" id=\"ovClose\">Kapat</button></div>\n  <h1 id=\"ovTitle\"></h1>\n  <div class=\"qr\" id=\"ovQr\"></div>\n  <p>Karekodu okutun ya da adrese gidip kodu girin</p>\n  <div class=\"code\" id=\"ovCode\"></div>\n  <p id=\"ovLink\"></p>\n</div>\n<div class=\"loading\" id=\"loading\" hidden>Yükleniyor…</div>\n\n<script src=\"https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js\"></script>\n<script>\n(function () {\n  \"use strict\";\n  var $ = function (id) { return document.getElementById(id); };\n  var veri = null;\n  var sonKod = \"\";\n\n  function sunucu(fn, args) {\n    return new Promise(function (ok, hata) {\n      var r = google.script.run.withSuccessHandler(ok).withFailureHandler(function (e) { hata(e && e.message ? e.message : String(e)); });\n      r[fn].apply(r, args || []);\n    });\n  }\n  function yukleniyor(v) { $(\"loading\").hidden = !v; }\n  function esc(s) { return String(s == null ? \"\" : s).replace(/[&<>\"']/g, function (c) { return { \"&\": \"&amp;\", \"<\": \"&lt;\", \">\": \"&gt;\", '\"': \"&quot;\", \"'\": \"&#39;\" }[c]; }); }\n  function tarih(iso) {\n    if (!iso) return \"\";\n    var d = new Date(iso);\n    return d.toLocaleString(\"tr-TR\", { day: \"2-digit\", month: \"2-digit\", year: \"numeric\", hour: \"2-digit\", minute: \"2-digit\" });\n  }\n  function saat(iso) { return iso ? new Date(iso).toLocaleTimeString(\"tr-TR\", { hour: \"2-digit\", minute: \"2-digit\" }) : \"\"; }\n  function yerelGiris(d) {\n    var p = function (n) { return String(n).padStart(2, \"0\"); };\n    return d.getFullYear() + \"-\" + p(d.getMonth() + 1) + \"-\" + p(d.getDate()) + \"T\" + p(d.getHours()) + \":\" + p(d.getMinutes());\n  }\n  function baglanti(kod) { return (veri.sinav_sayfasi || \"\").replace(/\\/?$/, \"/\") + \"?o=\" + kod; }\n  function sinavAdi(kod) {\n    var s = (veri.sinavlar || []).filter(function (x) { return x.kod === kod; })[0];\n    return s ? s.baslik : kod;\n  }\n  function yuzdeSinif(v) { return v == null ? \"\" : v < 50 ? \"lo\" : v < 70 ? \"mid\" : \"hi\"; }\n  function yuzde(v) { return v == null ? \"-\" : \"%\" + String(v).replace(\".\", \",\"); }\n  function sayi(v) { return v == null ? \"-\" : String(v).replace(\".\", \",\"); }\n\n  function qrCiz(el, metin, boyut) {\n    el.textContent = \"\";\n    if (typeof QRCode === \"undefined\") {\n      el.innerHTML = '<p class=\"hint\">Karekod oluşturulamadı (internet bağlantısı gerekli). Bağlantıyı kullanabilirsiniz.</p>';\n      return;\n    }\n    new QRCode(el, { text: metin, width: boyut, height: boyut, correctLevel: QRCode.CorrectLevel.M });\n  }\n\n  // ---------- Sekmeler ----------\n  function sekme(t) {\n    document.querySelectorAll(\".tabs [data-t]\").forEach(function (b) { b.setAttribute(\"aria-selected\", String(b.dataset.t === t)); });\n    [\"yeni\", \"liste\", \"rapor\", \"sinavlar\", \"havuz\"].forEach(function (x) { $(\"t-\" + x).hidden = x !== t; });\n  }\n  document.querySelectorAll(\".tabs [data-t]\").forEach(function (b) { b.addEventListener(\"click\", function () { sekme(b.dataset.t); }); });\n\n  // ---------- Veri ----------\n  function yukle() {\n    yukleniyor(true);\n    return sunucu(\"panelVeri\").then(function (v) {\n      veri = v;\n      formDoldur();\n      listeCiz();\n      sinavlarCiz();\n      raporSecenekleri();\n      yukleniyor(false);\n    }).catch(function (e) { yukleniyor(false); alertHata(e); });\n  }\n  function alertHata(e) { $(\"formErr\").textContent = \"Hata: \" + e; $(\"formErr\").hidden = false; }\n\n  function formDoldur() {\n    var sel = $(\"fSinav\");\n    var secili = sel.value;\n    sel.innerHTML = veri.sinavlar.filter(function (s) { return s.durum === \"ONAYLI\"; }).map(function (s) {\n      return '<option value=\"' + esc(s.kod) + '\">' + esc(s.kod) + \" · \" + esc(s.baslik) + \" (\" + s.soru_sayisi + \" soru, \" + s.sure_dk + \" dk)</option>\";\n    }).join(\"\");\n    if (secili) sel.value = secili;\n    formSecenekleri();\n    if (!$(\"fMerkez\").value && veri.oturumlar.length) $(\"fMerkez\").value = veri.oturumlar[0].egitim_merkezi;\n    if (!$(\"fBas\").value) {\n      var simdi = new Date();\n      simdi.setSeconds(0, 0);\n      $(\"fBas\").value = yerelGiris(simdi);\n      $(\"fBit\").value = yerelGiris(new Date(simdi.getTime() + 2 * 3600 * 1000));\n    }\n  }\n\n  function formSecenekleri() {\n    var s = (veri.sinavlar || []).filter(function (x) { return x.kod === $(\"fSinav\").value; })[0];\n    var fs = s ? s.formlar : [];\n    var secili = $(\"fForm\").value;\n    $(\"fForm\").innerHTML = fs.map(function (f) { return '<option value=\"' + esc(f) + '\">Form ' + esc(f) + \"</option>\"; }).join(\"\");\n    if (fs.indexOf(secili) >= 0) $(\"fForm\").value = secili; else if (fs.length) $(\"fForm\").value = fs[fs.length - 1];\n  }\n  $(\"fSinav\").addEventListener(\"change\", formSecenekleri);\n\n  // ---------- Yeni oturum ----------\n  $(\"form\").addEventListener(\"submit\", function (e) {\n    e.preventDefault();\n    $(\"formErr\").hidden = true;\n    var g = {\n      sinav: $(\"fSinav\").value,\n      firma: $(\"fFirma\").value.trim(),\n      egitim_merkezi: $(\"fMerkez\").value.trim(),\n      kontenjan: $(\"fKisi\").value,\n      form: $(\"fForm\").value,\n      baslangic: new Date($(\"fBas\").value).toISOString(),\n      bitis: new Date($(\"fBit\").value).toISOString(),\n      not: $(\"fNot\").value.trim(),\n    };\n    if (!g.kontenjan) { alertHata(\"Kişi sayısını girin.\"); return; }\n    $(\"createBtn\").disabled = true;\n    sunucu(\"oturumOlustur\", [g]).then(function (kod) {\n      $(\"createBtn\").disabled = false;\n      sonucGoster(kod, g.sinav);\n      return yukle();\n    }).catch(function (err) { $(\"createBtn\").disabled = false; alertHata(err); });\n  });\n\n  function sonucGoster(kod, sinav) {\n    sonKod = kod;\n    $(\"result\").hidden = false;\n    $(\"rCode\").textContent = kod;\n    $(\"rSinav\").textContent = sinavAdi(sinav);\n    $(\"rLink\").value = baglanti(kod);\n    qrCiz($(\"rQr\"), baglanti(kod), 220);\n  }\n  $(\"copyBtn\").addEventListener(\"click\", function () {\n    var i = $(\"rLink\");\n    i.select();\n    var ok = false;\n    try { ok = document.execCommand(\"copy\"); } catch (e) { ok = false; }\n    $(\"copyBtn\").textContent = ok ? \"Kopyalandı\" : \"Seçildi, Ctrl+C\";\n    setTimeout(function () { $(\"copyBtn\").textContent = \"Kopyala\"; }, 2000);\n  });\n  function tamEkran(kod, sinav) {\n    $(\"ovTitle\").textContent = sinavAdi(sinav);\n    $(\"ovCode\").textContent = kod;\n    $(\"ovLink\").textContent = (veri.sinav_sayfasi || \"\").replace(/^https?:\\/\\//, \"\");\n    var boyut = Math.max(160, Math.min(window.innerWidth - 80, window.innerHeight - 270, 420));\n    $(\"overlay\").style.setProperty(\"--qr\", boyut + \"px\");\n    qrCiz($(\"ovQr\"), baglanti(kod), boyut);\n    ovKod = kod;\n    $(\"overlay\").hidden = false;\n  }\n  $(\"fullBtn\").addEventListener(\"click\", function () { tamEkran(sonKod, $(\"fSinav\").value); });\n  $(\"ovClose\").addEventListener(\"click\", function () { $(\"overlay\").hidden = true; });\n  var ovKod = \"\";\n  // Projeksiyon görünümü: sınav sayfasında yalnızca karekodu ve kodu gösteren, tam ekran yapılabilen sekme.\n  $(\"ovTab\").addEventListener(\"click\", function () {\n    window.open((veri.sinav_sayfasi || \"\").replace(/\\/?$/, \"/\") + \"?qr=\" + ovKod, \"_blank\");\n  });\n\n  // ---------- Oturumlar ----------\n  function durumRozet(o) {\n    if (o.durum !== \"ACIK\") return '<span class=\"badge b-kapali\">Kapalı</span>';\n    if (o.bitis && new Date(o.bitis) < new Date()) return '<span class=\"badge b-bitti\">Süresi bitti</span>';\n    if (o.baslangic && new Date(o.baslangic) > new Date()) return '<span class=\"badge b-bitti\">Başlamadı</span>';\n    return '<span class=\"badge b-acik\">Açık</span>';\n  }\n  function listeCiz() {\n    var tb = $(\"listBody\");\n    if (!veri.oturumlar.length) { tb.innerHTML = '<tr><td colspan=\"10\" class=\"empty\">Henüz oturum yok.</td></tr>'; return; }\n    tb.innerHTML = veri.oturumlar.map(function (o) {\n      return \"<tr><td><b>\" + esc(o.kod) + \"</b></td><td>\" + esc(sinavAdi(o.sinav)) + ' <span class=\"muted\">(' + esc(o.sinav) + \", form \" + esc(o.form) + \")</span></td><td>\" + esc(o.firma) + \"</td><td>\" + esc(o.egitim_merkezi) +\n        \"</td><td>\" + esc(tarih(o.baslangic)) + \" - \" + esc(saat(o.bitis)) + '</td><td class=\"num\">' + (o.basladi + o.tamamlandi) + \" / \" + o.kontenjan +\n        '</td><td class=\"num\">' + o.basladi + '</td><td class=\"num\">' + o.tamamlandi + \"</td><td>\" + durumRozet(o) +\n        '</td><td style=\"white-space:nowrap\"><button class=\"btn small\" data-a=\"qr\" data-k=\"' + esc(o.kod) + '\">Karekod</button> ' +\n        '<button class=\"btn small\" data-a=\"rapor\" data-k=\"' + esc(o.kod) + '\">Rapor</button> ' +\n        '<button class=\"btn small\" data-a=\"' + (o.durum === \"ACIK\" ? \"kapat\" : \"ac\") + '\" data-k=\"' + esc(o.kod) + '\">' + (o.durum === \"ACIK\" ? \"Kapat\" : \"Aç\") + \"</button></td></tr>\";\n    }).join(\"\");\n  }\n  $(\"listBody\").addEventListener(\"click\", function (e) {\n    var b = e.target.closest(\"button[data-a]\");\n    if (!b) return;\n    var kod = b.dataset.k;\n    var o = veri.oturumlar.filter(function (x) { return x.kod === kod; })[0];\n    if (b.dataset.a === \"qr\") tamEkran(kod, o.sinav);\n    if (b.dataset.a === \"rapor\") { sekme(\"rapor\"); $(\"rpSel\").value = kod; raporYukle(); }\n    if (b.dataset.a === \"kapat\" || b.dataset.a === \"ac\") {\n      b.disabled = true;\n      sunucu(\"oturumDurumDegistir\", [kod, b.dataset.a === \"ac\"]).then(yukle).catch(alertHata);\n    }\n  });\n\n  // ---------- Rapor ----------\n  function raporSecenekleri() {\n    var sel = $(\"rpSel\");\n    var secili = sel.value;\n    sel.innerHTML = veri.oturumlar.map(function (o) {\n      return '<option value=\"' + esc(o.kod) + '\">' + esc(o.kod) + \" · \" + esc(sinavAdi(o.sinav)) + (o.firma ? \" · \" + esc(o.firma) : \"\") + \" · \" + esc(tarih(o.baslangic)) + \"</option>\";\n    }).join(\"\");\n    if (secili) sel.value = secili;\n  }\n  $(\"rpLoad\").addEventListener(\"click\", raporYukle);\n  $(\"rpFile\").addEventListener(\"click\", function () {\n    var kod = $(\"rpSel\").value;\n    if (!kod) return;\n    $(\"rpFile\").disabled = true;\n    $(\"rpFileBox\").hidden = false;\n    $(\"rpFileMsg\").textContent = \"Rapor dosyası hazırlanıyor…\";\n    sunucu(\"raporDosyasiOlustur\", [kod]).then(function (r) {\n      $(\"rpFile\").disabled = false;\n      $(\"rpFileMsg\").innerHTML = 'Rapor hazır: <a href=\"' + esc(r.url) + '\" target=\"_blank\">' + esc(r.ad) + \"</a>. Dosyayı açıp <b>Dosya &gt; İndir</b> ile PDF ya da Excel olarak alabilir, <b>Paylaş</b> ile firmaya gönderebilirsiniz. Dosyada soru metinleri ve cevap anahtarı yer almaz.\";\n    }).catch(function (e) {\n      $(\"rpFile\").disabled = false;\n      $(\"rpFileMsg\").textContent = \"Rapor oluşturulamadı: \" + e;\n    });\n  });\n\n  function raporYukle() {\n    var kod = $(\"rpSel\").value;\n    if (!kod) { $(\"rpBody\").innerHTML = '<div class=\"panel\"><div class=\"empty\">Önce bir oturum oluşturun.</div></div>'; return; }\n    yukleniyor(true);\n    sunucu(\"oturumRaporu\", [kod]).then(function (r) { yukleniyor(false); raporCiz(r); }).catch(function (e) { yukleniyor(false); $(\"rpBody\").innerHTML = '<p class=\"error\">' + esc(e) + \"</p>\"; });\n  }\n\n  function raporCiz(r) {\n    var h = \"\";\n    h += '<div class=\"kpis\">' +\n      kpi(\"Katılan\", r.katilan) + kpi(\"Devam eden\", r.devam_eden) + kpi(\"Tamamlayan\", r.tamamlayan) +\n      kpi(\"Ortalama puan\", sayi(r.ortalama)) + kpi(\"Medyan\", sayi(r.medyan)) +\n      kpi(\"En düşük / en yüksek\", r.tamamlayan ? sayi(r.en_dusuk) + \" / \" + sayi(r.en_yuksek) : \"-\") + \"</div>\";\n    if (!r.tamamlayan) {\n      h += '<div class=\"panel\"><div class=\"empty\">Bu oturumda henüz sınavını bitiren yok.</div></div>';\n      h += katilimciTablo(r);\n      $(\"rpBody\").innerHTML = h;\n      return;\n    }\n    var max = Math.max.apply(null, r.dagilim.concat([1]));\n    h += '<div class=\"grid2\"><div class=\"panel\"><div class=\"ph\"><h2>Puan dağılımı</h2><span class=\"hint\" style=\"margin:0\">kişi sayısı</span></div><div class=\"pb\"><div class=\"hist\">' +\n      r.dagilim.map(function (v, i) {\n        return '<div class=\"col\"><span class=\"v\">' + (v || \"\") + '</span><div class=\"bar\" style=\"height:' + (v / max * 100) + '%\"></div><span class=\"lbl\">' + (i * 10) + \"-\" + (i === 9 ? 100 : i * 10 + 9) + \"</span></div>\";\n      }).join(\"\") + \"</div></div></div>\";\n    h += '<div class=\"panel\"><div class=\"ph\"><h2>Bölüm bazında başarı</h2><span class=\"hint\" style=\"margin:0\">doğru cevap oranı</span></div><div class=\"pb\">' +\n      r.bolumler.map(function (b) {\n        return '<div class=\"hbar\"><span title=\"' + esc(b.ad) + '\">' + esc(b.ad) + ' <span class=\"hint\">(' + b.soru + ' soru)</span></span><div class=\"track\"><div class=\"' + yuzdeSinif(b.yuzde) + '\" style=\"width:' + (b.yuzde || 0) + '%\"></div></div><b class=\"num\">' + yuzde(b.yuzde) + \"</b></div>\";\n      }).join(\"\") + \"</div></div></div>\";\n\n    var sorular = r.sorular.slice().sort(function (a, b) { return a.dogru_yuzde - b.dogru_yuzde || a.no - b.no; });\n    h += '<div class=\"panel\"><div class=\"ph\"><h2>Soru analizi</h2><span class=\"hint\" style=\"margin:0\">en zordan en kolaya; doğru oranı düşük ve tek bir yanlış şıkta toplanan sorular yeniden gözden geçirilmeye değer</span></div><div class=\"scroll\"><table><thead><tr><th class=\"num\">No</th><th>Bölüm</th><th>Soru</th><th>Doğru oranı</th><th>Doğru</th><th>En sık yanlış</th><th>Seçimler</th></tr></thead><tbody>' +\n      sorular.map(function (q) {\n        var sec = Object.keys(q.secim).sort().map(function (k) { return (k === \"-\" ? \"boş\" : k === \"?\" ? \"bilmiyorum\" : k) + \":\" + q.secim[k]; }).join(\"  \");\n        return '<tr><td class=\"num\">' + q.no + \"</td><td>\" + esc(q.bolum) + '</td><td title=\"' + esc(q.soru) + '\">' + esc(q.soru.length > 70 ? q.soru.slice(0, 70) + \"…\" : q.soru) +\n          '</td><td style=\"white-space:nowrap\"><span class=\"mini\"><i class=\"' + yuzdeSinif(q.dogru_yuzde) + '\" style=\"width:' + (q.dogru_yuzde || 0) + '%\"></i></span>' + yuzde(q.dogru_yuzde) +\n          \"</td><td>\" + esc(q.dogru_cevap) + \"</td><td>\" + (q.en_sik_yanlis ? esc(q.en_sik_yanlis) + \" (\" + q.en_sik_yanlis_sayi + \")\" : \"\") + '</td><td class=\"hint\" style=\"margin:0\">' + esc(sec) + \"</td></tr>\";\n      }).join(\"\") + \"</tbody></table></div></div>\";\n    h += katilimciTablo(r);\n    $(\"rpBody\").innerHTML = h;\n  }\n  function kpi(ad, v) { return '<div class=\"kpi\"><span>' + ad + \"</span><b>\" + v + \"</b></div>\"; }\n  function katilimciTablo(r) {\n    var durumAd = { basladi: \"Devam ediyor\", tamamlandi: \"Bitirdi\" };\n    var k = r.katilimcilar.slice().sort(function (a, b) { return (b.puan == null ? -1 : b.puan) - (a.puan == null ? -1 : a.puan); });\n    return '<div class=\"panel\"><div class=\"ph\"><h2>Katılımcılar</h2><span class=\"hint\" style=\"margin:0\">Ayrıntılı veri: Sonuclar ve Detay sekmeleri</span></div><div class=\"scroll\"><table><thead><tr><th>Ad soyad</th><th>Firma</th><th>Görev</th><th>Başlama</th><th>Durum</th><th class=\"num\">Doğru</th><th class=\"num\">Puan</th></tr></thead><tbody>' +\n      (k.length ? k.map(function (x) {\n        return \"<tr><td>\" + esc(x.ad + \" \" + x.soyad) + \"</td><td>\" + esc(x.firma) + \"</td><td>\" + esc(x.gorev) + \"</td><td>\" + esc(tarih(x.baslama)) + \"</td><td>\" + (durumAd[x.durum] || esc(x.durum)) +\n          '</td><td class=\"num\">' + sayi(x.dogru) + '</td><td class=\"num\">' + sayi(x.puan) + \"</td></tr>\";\n      }).join(\"\") : '<tr><td colspan=\"7\" class=\"empty\">Henüz katılan yok.</td></tr>') + \"</tbody></table></div></div>\";\n  }\n\n\n  // ---------- Ortak yardımcılar ----------\n  function gun(iso) { return iso ? new Date(iso).toLocaleDateString(\"tr-TR\") : \"\"; }\n  function rozet(d) {\n    var c = { ONAYLI: \"b-onayli\", TASLAK: \"b-taslak\", ARSIV: \"b-arsiv\", ESKI: \"b-eski\", EMEKLI: \"b-eski\" }[d] || \"b-kapali\";\n    var ad = { ONAYLI: \"Onaylı\", TASLAK: \"Taslak\", ARSIV: \"Arşiv\", ESKI: \"Eski sürüm\", EMEKLI: \"Emekli\" }[d] || d;\n    return '<span class=\"badge ' + c + '\">' + esc(ad) + \"</span>\";\n  }\n  function kisa(t, n) { t = String(t || \"\"); return t.length > n ? t.slice(0, n) + \"…\" : t; }\n  function secenekler(el, nesne, bos) {\n    el.innerHTML = (bos ? '<option value=\"\">' + esc(bos) + \"</option>\" : \"\") + Object.keys(nesne || {}).sort().map(function (k) {\n      return '<option value=\"' + esc(k) + '\">' + esc(k) + (nesne[k] ? \" · \" + esc(nesne[k]) : \"\") + \"</option>\";\n    }).join(\"\");\n  }\n\n  // ---------- Soru önizleme ----------\n  function pvLink(id, surum) { return '<button type=\"button\" class=\"pvlink\" data-pv=\"' + esc(id) + '\"' + (surum ? ' data-pvs=\"' + surum + '\"' : \"\") + ' title=\"Soruyu şekilleriyle göster\">' + esc(id) + \"</button>\"; }\n  function sekilRozet(n) { return n ? '<span class=\"sekil\">' + n + \" şekil</span>\" : \"\"; }\n  function pvKapat() { $(\"pv\").hidden = true; $(\"pvKart\").innerHTML = \"\"; }\n  document.addEventListener(\"click\", function (e) {\n    var b = e.target.closest(\"[data-pv]\");\n    if (!b) return;\n    e.preventDefault();\n    $(\"pvKart\").innerHTML = '<p class=\"muted\">Soru yükleniyor…</p>';\n    $(\"pv\").hidden = false;\n    sunucu(\"soruOnizle\", [b.dataset.pv, b.dataset.pvs ? Number(b.dataset.pvs) : null]).then(function (q) {\n      var img = function (g) { return g.veri ? '<img src=\"' + g.veri + '\" alt=\"' + esc(g.ad) + '\">' : '<p class=\"eksik\">Şekil bulunamadı: ' + esc(g.ad) + (q.klasor_yok ? \" (görsel klasörü tanımlı değil)\" : \" (Drive klasöründe bu adla dosya yok)\") + \"</p>\"; };\n      var h = '<div class=\"ust\"><div><h3>' + esc(q.id) + \" · v\" + q.surum + \" \" + rozet(q.durum) + \"</h3></div>\" +\n        '<button class=\"btn small\" data-x=\"pvkapat\">Kapat</button></div>' +\n        '<div class=\"meta\">' + esc(q.konu) + \" · \" + esc(q.bolum) + (q.zorluk ? \" · \" + esc(q.zorluk) : \"\") + (q.grup ? \" · ortak şekil grubu \" + esc(q.grup) : \"\") + \"</div>\";\n      if (q.grup_notu || q.grup_gorsel) h += '<div class=\"gnot\">' + esc(q.grup_notu) + (q.grup_gorsel ? img(q.grup_gorsel) : \"\") + \"</div>\";\n      h += '<div class=\"metin\">' + esc(q.soru) + \"</div>\" + q.gorseller.map(img).join(\"\");\n      if (q.tur === \"sayi\") h += '<p><b>Doğru cevap:</b> ' + esc(q.dogru) + \" \" + esc(q.birim) + (q.tolerans ? \" (tolerans ±\" + esc(q.tolerans) + \")\" : \"\") + \"</p>\";\n      else h += \"<ol>\" + q.siklar.map(function (s) { return '<li class=\"' + (s.id === q.dogru ? \"dogru\" : \"\") + '\"><b>' + s.id + \")</b>\" + esc(s.metin) + \"</li>\"; }).join(\"\") + \"</ol>\";\n      if (q.gerekce || q.kaynak) h += '<div class=\"alt\">' + (q.gerekce ? \"Gerekçe: \" + esc(q.gerekce) + \"<br>\" : \"\") + (q.kaynak ? \"Kaynak: \" + esc(q.kaynak) : \"\") + \"</div>\";\n      $(\"pvKart\").innerHTML = h;\n    }).catch(function (err) { $(\"pvKart\").innerHTML = '<p class=\"error\">Hata: ' + esc(String(err)) + '</p><button class=\"btn small\" data-x=\"pvkapat\">Kapat</button>'; });\n  });\n  $(\"pv\").addEventListener(\"click\", function (e) { if (e.target === $(\"pv\") || e.target.closest('[data-x=\"pvkapat\"]')) pvKapat(); });\n  document.addEventListener(\"keydown\", function (e) { if (e.key === \"Escape\" && !$(\"pv\").hidden) pvKapat(); });\n\n  // ---------- Sınavlar ----------\n  function sinavlarCiz() {\n    $(\"snBody\").innerHTML = veri.sinavlar.slice().reverse().map(function (s) {\n      return \"<tr><td><b>\" + esc(s.kod) + \"</b></td><td>\" + esc(s.baslik) + \"</td><td>\" + rozet(s.durum) + '</td><td class=\"num\">' + s.soru_sayisi + \"</td><td>\" + esc(s.formlar.join(\", \")) +\n        '</td><td><button class=\"btn small\" data-sn=\"' + esc(s.kod) + '\">Aç</button></td></tr>';\n    }).join(\"\") || '<tr><td colspan=\"6\" class=\"empty\">Henüz sınav yok.</td></tr>';\n    secenekler($(\"hzMerkez\"), veri.kodlar.MERKEZ);\n    secenekler($(\"hzFirma\"), veri.kodlar.FIRMA);\n    secenekler($(\"hzKonu\"), veri.kodlar.KONU);\n  }\n  function snGoster(v) { $(\"snListe\").hidden = v !== \"liste\"; $(\"snDetay\").hidden = v !== \"detay\"; $(\"snHazir\").hidden = v !== \"hazir\"; }\n  $(\"snBody\").addEventListener(\"click\", function (e) {\n    var b = e.target.closest(\"button[data-sn]\");\n    if (b) sinavAc(b.dataset.sn);\n  });\n\n  function sinavAc(kod) {\n    yukleniyor(true);\n    sunucu(\"sinavDetay\", [kod]).then(function (d) {\n      yukleniyor(false);\n      snGoster(\"detay\");\n      var h = '<div class=\"panel\"><div class=\"ph\"><h2>' + esc(d.kod) + \" · \" + esc(d.baslik) + \" \" + rozet(d.durum) + '</h2><button class=\"btn small\" data-x=\"geri\">Sınavlara dön</button></div><div class=\"pb\">';\n      h += '<div class=\"stats\"><span>Soru: <b>' + d.sorular.length + \"</b></span><span>Süre: <b>\" + d.sure_dk + \" dk</b></span><span>Firma: <b>\" + esc(d.firma) + \"</b></span><span>Bu firmanın daha önce gördüğü soru: <b>\" + d.firma_gordugu + \"</b> (%\" + Math.round(d.firma_gordugu / Math.max(1, d.sorular.length) * 100) + \")</span></div>\";\n      if (d.onceki.length) h += '<div class=\"warnbox\">Bu firmaya daha önce kullanılan sınavlarla ortak sorular: ' + d.onceki.map(function (x) { return esc(x.kod) + \": \" + x.ortak + \"/\" + x.toplam; }).join(\", \") + \"</div>\";\n      h += '<div class=\"toolbar\" style=\"margin:10px 0\">';\n      if (d.durum === \"TASLAK\") h += '<button class=\"btn primary\" data-x=\"onayla\">Sınavı onayla</button>';\n      if (d.durum === \"ONAYLI\") h += '<button class=\"btn primary\" data-x=\"form\">Yeni form oluştur</button>';\n      if (d.durum !== \"ARSIV\") h += '<button class=\"btn\" data-x=\"arsiv\">Arşivle</button>';\n      h += \"</div>\";\n      if (d.formlar.length) {\n        h += '<table style=\"max-width:560px\"><thead><tr><th>Form</th><th>Oluşturma</th><th class=\"num\">Kullanım</th><th class=\"num\">Katılımcı</th></tr></thead><tbody>' +\n          d.formlar.map(function (f) { return \"<tr><td>Form \" + esc(f.form) + \"</td><td>\" + esc(gun(f.olusturma)) + '</td><td class=\"num\">' + f.kullanim + '</td><td class=\"num\">' + f.katilimci + \"</td></tr>\"; }).join(\"\") + \"</tbody></table>\";\n        h += '<p class=\"hint\">Aynı çalışmada sınav tekrarlanacaksa yeni form oluşturun: soruların sırası bölüm içinde ve şıkların yeri değişir, ortak şekilli sorular birlikte kalır. Sorular aynı olduğu için sonuçlar karşılaştırılabilir.</p>';\n      }\n      if (d.durum === \"ONAYLI\") {\n        h += '<div class=\"toolbar\" style=\"margin-top:10px\"><span class=\"flabel\" style=\"margin:0\">Kâğıt sınav kaydı:</span><input type=\"date\" id=\"kgTarih\"><input type=\"number\" id=\"kgKisi\" placeholder=\"Kişi\" min=\"0\" style=\"width:90px;min-width:0\"><input id=\"kgForm\" placeholder=\"Form\" maxlength=\"1\" style=\"width:70px;min-width:0\" value=\"A\"><input id=\"kgNot\" placeholder=\"Not\" style=\"min-width:200px\"><button class=\"btn small\" data-x=\"kagit\">Ekle</button></div>';\n      }\n      h += '<p class=\"error\" id=\"sdErr\" hidden></p></div></div>';\n      h += '<div class=\"panel\"><div class=\"ph\"><h2>Sorular</h2><span class=\"hint\" style=\"margin:0\">kırmızı: bu firma daha önce gördü</span></div><div class=\"scroll\" style=\"max-height:480px\"><table><thead><tr><th class=\"num\">No</th><th>Soru</th><th>Bölüm</th><th>Zorluk</th><th>Şekil</th><th class=\"num\">Ölçülen doğru</th><th class=\"num\">Sınav</th><th>Bu firma gördü</th><th>Metin</th></tr></thead><tbody>' +\n        d.sorular.map(function (q) {\n          return '<tr><td class=\"num\">' + q.no + \"</td><td>\" + pvLink(q.id, q.surum) + ' <span class=\"muted\">v' + q.surum + \"</span></td><td>\" + esc(q.bolum) + \"</td><td>\" + esc(q.zorluk) + \"</td><td>\" + sekilRozet(q.sekil) + '</td><td class=\"num\">' + yuzde(q.kullanim.olculen) +\n            '</td><td class=\"num\">' + q.kullanim.sinavlar.length + \"</td><td\" + (q.firma_gordu ? ' class=\"seen\"' : \"\") + \">\" + (q.firma_gordu ? (q.firma_gordu === \"tarihsiz\" ? \"Evet\" : esc(gun(q.firma_gordu))) : \"\") + '</td><td title=\"' + esc(q.soru) + '\">' + esc(kisa(q.soru, 70)) + \"</td></tr>\";\n        }).join(\"\") + \"</tbody></table></div></div>\";\n      $(\"snDetay\").innerHTML = h;\n      $(\"snDetay\").dataset.kod = d.kod;\n    }).catch(function (e) { yukleniyor(false); alert(\"Hata: \" + e); });\n  }\n  $(\"snDetay\").addEventListener(\"click\", function (e) {\n    var b = e.target.closest(\"button[data-x]\");\n    if (!b) return;\n    var kod = $(\"snDetay\").dataset.kod;\n    var hata = function (err) { $(\"sdErr\").textContent = String(err); $(\"sdErr\").hidden = false; b.disabled = false; };\n    var yenile = function () { return yukle().then(function () { sinavAc(kod); }); };\n    if (b.dataset.x === \"geri\") return snGoster(\"liste\");\n    b.disabled = true;\n    if (b.dataset.x === \"onayla\") sunucu(\"sinavOnayla\", [kod]).then(yenile).catch(hata);\n    if (b.dataset.x === \"form\") sunucu(\"formOlustur\", [kod]).then(yenile).catch(hata);\n    if (b.dataset.x === \"arsiv\") sunucu(\"sinavArsivle\", [kod]).then(yenile).catch(hata);\n    if (b.dataset.x === \"kagit\") sunucu(\"kullanimEkle\", [{ sinav: kod, tarih: $(\"kgTarih\").value, katilimci_sayisi: $(\"kgKisi\").value, form: $(\"kgForm\").value.toUpperCase(), tur: \"KAGIT\", not: $(\"kgNot\").value }]).then(yenile).catch(hata);\n  });\n\n  // ---------- Sınav hazırlama ----------\n  var hz = null; // { kod, adaylar, secili: {id:true}, firma }\n  $(\"snYeni\").addEventListener(\"click\", function () { snGoster(\"hazir\"); $(\"hzGovde\").hidden = true; $(\"hzErr\").hidden = true; });\n  $(\"hzGeri\").addEventListener(\"click\", function () { snGoster(\"liste\"); });\n  $(\"kdEkle\").addEventListener(\"click\", function () {\n    $(\"hzErr\").hidden = true;\n    sunucu(\"kodEkle\", [$(\"kdTur\").value, $(\"kdKod\").value, $(\"kdAd\").value]).then(function () { $(\"kdKod\").value = \"\"; $(\"kdAd\").value = \"\"; return yukle(); })\n      .catch(function (e) { $(\"hzErr\").textContent = String(e); $(\"hzErr\").hidden = false; });\n  });\n  $(\"hzGetir\").addEventListener(\"click\", function () {\n    $(\"hzErr\").hidden = true;\n    yukleniyor(true);\n    sunucu(\"sinavHazirlik\", [$(\"hzMerkez\").value, $(\"hzFirma\").value, $(\"hzKonu\").value]).then(function (r) {\n      yukleniyor(false);\n      hz = { kod: r.kod, adaylar: r.adaylar, secili: {}, firma: $(\"hzFirma\").value };\n      $(\"hzGovde\").hidden = false;\n      $(\"hzKod\").value = r.kod;\n      $(\"hzAlt\").value = r.merkez_ad || \"\";\n      $(\"hzSablon\").innerHTML = veri.sinavlar.slice().reverse().map(function (s) { return '<option value=\"' + esc(s.kod) + '\">' + esc(s.kod) + \" · \" + esc(s.baslik) + \"</option>\"; }).join(\"\");\n      if (r.sablon) $(\"hzSablon\").value = r.sablon;\n      var sb = veri.sinavlar.filter(function (s) { return s.kod === r.sablon; })[0];\n      if (sb) { $(\"hzBaslik\").value = sb.baslik; $(\"hzSure\").value = sb.sure_dk; }\n      hzCiz();\n    }).catch(function (e) { yukleniyor(false); $(\"hzErr\").textContent = String(e); $(\"hzErr\").hidden = false; });\n  });\n  function grupUyeleri(q) { return q.grup ? hz.adaylar.filter(function (x) { return x.grup === q.grup; }) : [q]; }\n  function gordu(q) { return q.kullanim.firmalar.hasOwnProperty(hz.firma); }\n  function hzCiz() {\n    $(\"hzBody\").innerHTML = hz.adaylar.map(function (q) {\n      var g = gordu(q);\n      return '<tr class=\"' + (hz.secili[q.id] ? \"sel\" : \"\") + '\"><td class=\"chk\"><input type=\"checkbox\" data-q=\"' + esc(q.id) + '\"' + (hz.secili[q.id] ? \" checked\" : \"\") + \"></td><td>\" + pvLink(q.id) + (q.grup ? ' <span class=\"muted\">' + esc(q.grup) + \"</span>\" : \"\") +\n        \"</td><td>\" + esc(q.bolum) + \"</td><td>\" + esc(q.zorluk) + \"</td><td>\" + sekilRozet(q.sekil) + '</td><td class=\"num\">' + yuzde(q.kullanim.olculen) + '</td><td class=\"num\">' + q.kullanim.oturum + \"</td><td\" + (g ? ' class=\"seen\"' : \"\") + \">\" +\n        (g ? (q.kullanim.firmalar[hz.firma] ? esc(gun(q.kullanim.firmalar[hz.firma])) : \"Evet\") : \"\") + \"</td><td>\" + esc(gun(q.kullanim.son)) + '</td><td title=\"' + esc(q.soru) + '\">' + esc(kisa(q.soru, 60)) + \"</td></tr>\";\n    }).join(\"\");\n    hzOzet();\n  }\n  function hzOzet() {\n    var sec = hz.adaylar.filter(function (q) { return hz.secili[q.id]; });\n    var bol = {};\n    sec.forEach(function (q) { bol[q.bolum] = (bol[q.bolum] || 0) + 1; });\n    var g = sec.filter(gordu).length;\n    $(\"hzOzet\").innerHTML = \"<span>Seçili: <b>\" + sec.length + \"</b></span>\" + Object.keys(bol).map(function (b) { return \"<span>\" + esc(b) + \": <b>\" + bol[b] + \"</b></span>\"; }).join(\"\") +\n      '<span>Bu firmanın gördüğü: <b class=\"' + (g ? \"seen\" : \"\") + '\">' + g + \"</b>\" + (sec.length ? \" (%\" + Math.round(g / sec.length * 100) + \")\" : \"\") + \"</span>\";\n    var tum = sec.length && g === sec.length;\n    $(\"hzUyari\").innerHTML = tum ? '<div class=\"warnbox\">Seçilen soruların hepsini bu firma daha önce gördü. Havuza yeni sorular ekleyip bir kısmını yenilemeniz önerilir; daha önce verilmiş sınavın birebir aynısı onaylanamaz.</div>' : \"\";\n  }\n  $(\"hzBody\").addEventListener(\"change\", function (e) {\n    var c = e.target.closest(\"input[data-q]\");\n    if (!c) return;\n    var q = hz.adaylar.filter(function (x) { return x.id === c.dataset.q; })[0];\n    grupUyeleri(q).forEach(function (x) { if (c.checked) hz.secili[x.id] = true; else delete hz.secili[x.id]; });\n    hzCiz();\n  });\n  $(\"hzOner\").addEventListener(\"click\", function () {\n    var n = parseInt($(\"hzN\").value, 10);\n    if (!(n > 0)) return;\n    var bolumler = {};\n    hz.adaylar.forEach(function (q) { (bolumler[q.bolum] = bolumler[q.bolum] || []).push(q); });\n    var toplam = hz.adaylar.length;\n    hz.secili = {};\n    // En büyük kalan yöntemi: bölüm hedeflerinin toplamı tam n olur.\n    var adlar = Object.keys(bolumler);\n    var hedefler = {}, kalan = n;\n    adlar.forEach(function (b) { hedefler[b] = Math.floor(n * bolumler[b].length / toplam); kalan -= hedefler[b]; });\n    adlar.slice().sort(function (a, c) { return (n * bolumler[c].length / toplam % 1) - (n * bolumler[a].length / toplam % 1); })\n      .slice(0, Math.max(0, kalan)).forEach(function (b) { hedefler[b]++; });\n    adlar.forEach(function (b) {\n      var hedef = hedefler[b];\n      var birimler = [];\n      var goruldu = {};\n      bolumler[b].forEach(function (q) {\n        var key = q.grup || q.id;\n        if (goruldu[key]) return;\n        goruldu[key] = true;\n        birimler.push(grupUyeleri(q));\n      });\n      birimler.sort(function (a, c) {\n        var ga = a.some(gordu) ? 1 : 0, gc = c.some(gordu) ? 1 : 0;\n        if (ga !== gc) return ga - gc;\n        var ua = a[0].kullanim.oturum, uc = c[0].kullanim.oturum;\n        if (ua !== uc) return ua - uc;\n        return a[0].id < c[0].id ? -1 : 1;\n      });\n      var say = 0;\n      birimler.forEach(function (u) {\n        if (say >= hedef) return;\n        u.forEach(function (q) { hz.secili[q.id] = true; });\n        say += u.length;\n      });\n    });\n    hzCiz();\n  });\n  $(\"hzKaydet\").addEventListener(\"click\", function () {\n    $(\"hzErr\").hidden = true;\n    var ids = hz.adaylar.filter(function (q) { return hz.secili[q.id]; }).map(function (q) { return q.id; });\n    var g = { merkez: $(\"hzMerkez\").value, firma: $(\"hzFirma\").value, konu: $(\"hzKonu\").value, baslik: $(\"hzBaslik\").value, alt_baslik: $(\"hzAlt\").value, sure_dk: $(\"hzSure\").value, sablon: $(\"hzSablon\").value, sorular: ids };\n    $(\"hzKaydet\").disabled = true;\n    sunucu(\"sinavKaydet\", [g]).then(function (kod) {\n      $(\"hzKaydet\").disabled = false;\n      return yukle().then(function () { sinavAc(kod); });\n    }).catch(function (e) { $(\"hzKaydet\").disabled = false; $(\"hzErr\").textContent = String(e); $(\"hzErr\").hidden = false; window.scrollTo(0, 0); });\n  });\n\n  // ---------- Soru havuzu ----------\n  var havuz = [];\n  function havuzYukle() {\n    yukleniyor(true);\n    return sunucu(\"havuzListesi\").then(function (l) {\n      yukleniyor(false);\n      havuz = l;\n      secenekler($(\"hvKonu\"), veri.kodlar.KONU, \"Tüm konular\");\n      secenekler($(\"hvFirma\"), veri.kodlar.FIRMA, \"Firma vurgusu yok\");\n      havuzCiz();\n    }).catch(function (e) { yukleniyor(false); alert(\"Hata: \" + e); });\n  }\n  function havuzCiz() {\n    var sekil = $(\"hvSekil\").value, konu = $(\"hvKonu\").value, durum = $(\"hvDurum\").value, firma = $(\"hvFirma\").value, kul = $(\"hvKul\").value, ara = $(\"hvAra\").value.trim().toLocaleLowerCase(\"tr\");\n    var altiAy = Date.now() - 183 * 864e5;\n    var l = havuz.filter(function (q) {\n      if (konu && q.konu !== konu) return false;\n      if (sekil === \"var\" && !q.sekil) return false;\n      if (sekil === \"yok\" && q.sekil) return false;\n      if (durum && q.durum !== durum) return false;\n      if (kul === \"hic\" && q.kullanim.oturum) return false;\n      if (kul === \"6ay\" && q.kullanim.son && new Date(q.kullanim.son).getTime() > altiAy) return false;\n      if (ara && (q.id + \" \" + q.soru).toLocaleLowerCase(\"tr\").indexOf(ara) < 0) return false;\n      return true;\n    });\n    $(\"hvSay\").textContent = l.length + \" soru\";\n    $(\"hvBody\").innerHTML = l.map(function (q) {\n      var f = Object.keys(q.kullanim.firmalar);\n      var gor = firma && f.indexOf(firma) >= 0;\n      var islem = q.durum === \"TASLAK\" ? '<button class=\"btn small\" data-on=\"' + esc(q.id) + '\" data-v=\"' + q.surum + '\">Onayla</button>' : '<button class=\"btn small\" data-ys=\"' + esc(q.id) + '\">Yeni sürüm</button>';\n      return \"<tr\" + (gor ? ' class=\"sel\"' : \"\") + \"><td>\" + pvLink(q.id, q.surum) + \"</td><td>v\" + q.surum + (q.onayli_surum && q.onayli_surum !== q.surum ? ' <span class=\"muted\">(onaylı v' + q.onayli_surum + \")</span>\" : \"\") + \"</td><td>\" + rozet(q.durum) + \"</td><td>\" + esc(q.bolum) + \"</td><td>\" + esc(q.zorluk) +\n        \"</td><td>\" + sekilRozet(q.sekil) + '</td><td title=\"' + esc(q.soru) + '\">' + esc(kisa(q.soru, 60)) + '</td><td class=\"num\">' + q.kullanim.sinavlar.length + '</td><td class=\"num\">' + q.kullanim.oturum + '</td><td class=\"num\">' + q.kullanim.katilimci + \"</td><td\" + (gor ? ' class=\"seen\"' : \"\") + \">\" + esc(f.join(\", \")) +\n        \"</td><td>\" + esc(gun(q.kullanim.son)) + '</td><td class=\"num\">' + yuzde(q.kullanim.olculen) + \"</td><td>\" + islem + \"</td></tr>\";\n    }).join(\"\") || '<tr><td colspan=\"14\" class=\"empty\">Kayıt yok.</td></tr>';\n  }\n  [\"hvKonu\", \"hvDurum\", \"hvFirma\", \"hvKul\", \"hvSekil\"].forEach(function (id) { $(id).addEventListener(\"change\", havuzCiz); });\n  $(\"hvAra\").addEventListener(\"input\", havuzCiz);\n  $(\"hvBody\").addEventListener(\"click\", function (e) {\n    var b = e.target.closest(\"button\");\n    if (!b) return;\n    b.disabled = true;\n    var p = b.dataset.on ? sunucu(\"soruOnayla\", [b.dataset.on, Number(b.dataset.v)]) : sunucu(\"soruYeniSurum\", [b.dataset.ys]);\n    p.then(function (r) {\n      if (b.dataset.ys) alert(b.dataset.ys + \" için v\" + r + \" taslağı Havuz sekmesine eklendi. Metni orada düzenleyip buradan onaylayın.\");\n      return havuzYukle();\n    }).catch(function (err) { b.disabled = false; alert(\"Hata: \" + err); });\n  });\n  document.querySelector('.tabs [data-t=\"havuz\"]').addEventListener(\"click\", havuzYukle);\n  document.querySelector('.tabs [data-t=\"sinavlar\"]').addEventListener(\"click\", function () { snGoster(\"liste\"); });\n\n  $(\"refresh\").addEventListener(\"click\", function () {\n    yukle().then(function () { if (!$(\"t-rapor\").hidden && $(\"rpSel\").value) raporYukle(); });\n  });\n\n  yukle();\n})();\n</script>\n</body>\n</html>\n";
