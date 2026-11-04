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
var SISTEM_SURUMU = "19414223aa6a"; // tools/build.py hesaplar; elle değiştirilmez.

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
  havuzOnKontrol_();
  var sorular = kitapcikSorulari_(s, form);
  karantinaEngeli_(sorular.map(function (q) { return q.id; }));
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

// ---------------------------------------------------------------------------
// Soru Havuzu belgeleri (Drive: Sınav Sistemi/Soru Havuzu/<KONU - ad>/<NN - bölüm>)
// ---------------------------------------------------------------------------

function tarihGosterim_(ms) {
  if (!ms || ms <= 1) return "";
  return Utilities.formatDate(new Date(ms), SpreadsheetApp.getActive().getSpreadsheetTimeZone() || "Europe/Istanbul", "dd.MM.yyyy");
}

/** Soru belgesinde sorunun altındaki tek satırlık kullanım özeti (yalnızca kayıtlı verilerden). */
function kullanimSatiri_(z) {
  if (!z || !z.sinavlar.length) return "Kullanım: henüz hiçbir sınavda yer almadı.";
  var p = ["Yer aldığı sınavlar: " + z.sinavlar.join(", ")];
  p.push("Sorulduğu kişi: " + (z.katilimci || 0));
  var f = Object.keys(z.firmalar || {});
  if (f.length) p.push("Firmalar: " + f.join(", "));
  var son = tarihGosterim_(z.son);
  p.push("Son kullanım: " + (son || (z.katilimci ? "tarih kayıtlı değil" : "yok")));
  p.push("Ölçülen doğru oranı: " + (z.cevaplayan ? "%" + Math.round((z.dogru / z.cevaplayan) * 100) + " (" + z.cevaplayan + " kişi)" : "veri yok"));
  return "Kullanım: " + p.join(" · ");
}

/** Havuzdaki her sorunun son (eski olmayan) sürümü, konu ve bölüme göre belgelere ayrılmış plan. */
function havuzBelgePlani_(havuz) {
  var h = havuz || havuz_();
  var son = {};
  Object.keys(h).forEach(function (k) {
    var q = h[k];
    if (String(q.durum).toUpperCase() === "ESKI") return;
    if (!son[q.soru_id] || q.surum > son[q.soru_id].surum) son[q.soru_id] = q;
  });
  var kd = kodlar_();
  var konular = {};
  Object.keys(son).sort().forEach(function (id) {
    var q = son[id];
    var konu = String(q.konu || id.split("-")[0]).toUpperCase();
    var k = (konular[konu] = konular[konu] || { konu: konu, bolumler: [], bolumIdx: {} });
    var b = String(q.bolum || "Diğer");
    if (k.bolumIdx[b] === undefined) {
      k.bolumIdx[b] = k.bolumler.length;
      k.bolumler.push({ bolum: b, sorular: [] });
    }
    k.bolumler[k.bolumIdx[b]].sorular.push(q);
  });
  var plan = [];
  Object.keys(konular).sort().forEach(function (konu) {
    var ad = kd.KONU[konu] || konu;
    konular[konu].bolumler.forEach(function (b, i) {
      plan.push({ konu: konu, klasor: konu + " - " + ad, belge: ("0" + (i + 1)).slice(-2) + " - " + b.bolum, bolum: b.bolum, konuAd: ad, sorular: b.sorular });
    });
  });
  return plan;
}

// ---------------------------------------------------------------------------
// Soru Havuzu belgeleri: yazma, okuma, kontrol ve karantina
// ---------------------------------------------------------------------------
//
// Sorular, Drive'da "Soru Havuzu/<KONU - ad>/<NN - bölüm>" belgelerinde durur.
// Sistem belgeleri satır satır okur. Eksiksiz okunamayan ya da onaylıyken
// değişen bir soru karantinaya alınır: yeni sınava, forma ve kitapçığa giremez.
// Her sorunun son eksiksiz okunan hali "_sistem/havuz_durum.json" dosyasında,
// şekilleri "_sistem/Sekiller" klasöründe saklanır. İşlemler Havuz_Gunlugu
// sekmesine, soru bazında son durum Havuz_Izleri sekmesine yazılır.

var IYILESTIRME_ONEK = "İyileştirme notu: ";
var KARANTINA_ONEK = "KARANTİNA: ";
var SORU_BASLIK_RE = /^([A-Z]{2,6}-\d{4})\s*·\s*Sürüm/;
var ESKI_BELGE_ADI = "00 - Eski sürümler";
var HAVUZ_KONTROL_DK = 30;

var BELGE_STIL = {
  baslik: { baslik: "TITLE", boy: 22 },
  alt: { renk: "#555555", boy: 11, sonra: 10 },
  kontrol: { renk: "#666666", boy: 9 },
  kontrol_kirmizi: { renk: "#b42318", boy: 9, kalin: true },
  islem: { renk: "#666666", boy: 9, sonra: 10 },
  grup: { kalin: true, boy: 11, once: 14 },
  grupnot: { italik: true, boy: 11 },
  soru_baslik: { baslik: "HEADING2", boy: 14, once: 14, sonra: 4 },
  karantina: { kalin: true, renk: "#b42318", boy: 10 },
  zorluk: { renk: "#666666", boy: 9 },
  metin: { boy: 11, once: 6, sonra: 6 },
  sik: { girinti: 18, sonra: 2 },
  sayi: { girinti: 18 },
  dogru: { kalin: true, renk: "#1f8a4c", boy: 11, once: 6 },
  gerekce: { renk: "#666666", boy: 9 },
  kaynak: { renk: "#666666", boy: 9 },
  kullanim: { renk: "#666666", boy: 9, italik: true },
  not: { renk: "#666666", boy: 9 },
};

function durumKelimesi_(d) {
  d = String(d || "").toUpperCase();
  return d === "ONAYLI" ? "Onaylı" : d === "ESKI" ? "Eski" : d === "KULLANIM_DISI" ? "Kullanım dışı" : "Taslak";
}

function durumKodu_(kelime) {
  var k = String(kelime || "").trim().toLowerCase().replace(/ı/g, "i").replace(/ş/g, "s").replace(/i̇/g, "i").replace(/\s+/g, " ");
  return { taslak: "TASLAK", onayli: "ONAYLI", "kullanim disi": "KULLANIM_DISI", eski: "ESKI" }[k] || "";
}

function soruBasligi_(q) {
  return q.soru_id + "  ·  Sürüm " + q.surum + "  ·  " + durumKelimesi_(q.durum);
}

function grupBasligiMetni_(kod, uyeler) {
  return "Ortak şekil " + kod + ": " + (uyeler.length > 1 ? uyeler.slice(0, -1).join(", ") + " ve " + uyeler[uyeler.length - 1] : uyeler[0]);
}

function kaynakGosterim_(k) {
  return String(k || "").replace(/ \([^)]*\) soru /, ", soru ");
}

/**
 * Bir sorunun belgedeki satırları (öğe listesi). o.karantina: başlığın altına yazılacak uyarılar;
 * o.kullanim: kullanım satırı; o.notlar: iyileştirme notları.
 */
function soruOgeleri_(q, o) {
  o = o || {};
  var l = [{ s: "soru_baslik", t: soruBasligi_(q) }];
  (o.karantina || []).forEach(function (m) {
    l.push({ s: "karantina", t: KARANTINA_ONEK + m });
  });
  l.push({ s: "zorluk", t: "Zorluk: " + (q.zorluk || "") });
  String(q.soru).split("\n").forEach(function (t) {
    if (String(t).trim()) l.push({ s: "metin", t: t });
  });
  sekilAdlari_(q).forEach(function (ad) {
    l.push({ s: "gorsel", g: ad });
  });
  if (String(q.tur) === "sayi") {
    l.push({ s: "sayi", t: "Cevap türü: sayı" + (q.birim ? " (" + q.birim + ")" : "") });
  } else {
    ["A", "B", "C", "D", "E"].forEach(function (h) {
      if (String(q[h] === undefined ? "" : q[h]).trim() === "") return;
      l.push({ s: "sik", t: h + ")  " + q[h] });
    });
  }
  l.push({ s: "dogru", t: "Doğru cevap: " + q.dogru + (q.tolerans ? " (tolerans ±" + q.tolerans + ")" : "") });
  l.push({ s: "gerekce", t: "Gerekçe: " + (q.gerekce || "") });
  l.push({ s: "kaynak", t: "Kaynak: " + kaynakGosterim_(q.kaynak) });
  if (o.kullanim) l.push({ s: "kullanim", t: o.kullanim });
  (o.notlar || []).forEach(function (n) {
    l.push({ s: "not", t: n });
  });
  return l;
}

/** Ortak şekil başlığı, notu ve şekli. */
function grupOgeleri_(kod, uyeler, not, gorsel) {
  var l = [{ s: "grup", t: grupBasligiMetni_(kod, uyeler) }];
  String(not || "").split("\n").forEach(function (t) {
    if (String(t).trim()) l.push({ s: "grupnot", t: t });
  });
  if (String(gorsel || "").trim()) l.push({ s: "gorsel", g: String(gorsel).trim() });
  return l;
}

/** Bir bölüm belgesinin tamamı: başlık, durum satırları ve sorular (ortak şekiller dahil). */
function havuzBelgeOgeleri_(parca, ozet, notlar, durum) {
  var l = [
    { s: "baslik", t: parca.belge },
    { s: "alt", t: parca.konuAd + " (" + parca.konu + ") · " + parca.sorular.length + " soru" },
  ];
  if (durum && durum.kontrol) l.push({ s: durum.kirmizi ? "kontrol_kirmizi" : "kontrol", t: durum.kontrol });
  if (durum && durum.islem) l.push({ s: "islem", t: durum.islem });
  var uyeler = {};
  parca.sorular.forEach(function (q) {
    var g = String(q.grup || "").trim();
    if (g) (uyeler[g] = uyeler[g] || []).push(q.soru_id);
  });
  var gorulen = {};
  parca.sorular.forEach(function (q) {
    var g = String(q.grup || "").trim();
    if (g && !gorulen[g] && (q.grup_notu || q.grup_gorsel)) {
      gorulen[g] = true;
      l = l.concat(grupOgeleri_(g, uyeler[g], q.grup_notu, q.grup_gorsel));
    }
    l = l.concat(soruOgeleri_(q, { kullanim: ozet ? kullanimSatiri_(ozet[q.soru_id]) : "", notlar: (notlar || {})[q.soru_id] || [] }));
  });
  return l;
}

function belgeParagraf_(body, metin, o) {
  o = o || {};
  var p = o.konum === undefined || o.konum === null ? body.appendParagraph(metin) : body.insertParagraph(o.konum, metin);
  if (o.baslik) p.setHeading(typeof o.baslik === "string" ? DocumentApp.ParagraphHeading[o.baslik] : o.baslik);
  else p.setHeading(DocumentApp.ParagraphHeading.NORMAL);
  if (o.ortala) p.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
  p.setSpacingBefore(o.once || 0);
  p.setSpacingAfter(o.sonra === undefined ? 4 : o.sonra);
  if (o.girinti) {
    p.setIndentStart(o.girinti);
    p.setIndentFirstLine(o.girinti);
  }
  var t = p.editAsText();
  if (metin) {
    t.setBold(!!o.kalin);
    t.setItalic(!!o.italik);
    t.setFontSize(o.boy || 11);
    t.setForegroundColor(o.renk || "#000000");
    if (o.zemin) t.setBackgroundColor(o.zemin);
  }
  return p;
}

/** Şekli (klasördeki dosya adıyla) ortalanmış paragraf olarak ekler. */
function belgeyeGorsel_(body, klasor, ad, genislik, konum) {
  var it = klasor ? klasor.getFilesByName(ad) : null;
  if (!it || !it.hasNext()) {
    belgeParagraf_(body, "Şekil bulunamadı: " + ad, { renk: "#b42318", konum: konum });
    return;
  }
  var p = konum === undefined || konum === null ? body.appendParagraph("") : body.insertParagraph(konum, "");
  p.setHeading(DocumentApp.ParagraphHeading.NORMAL);
  p.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
  p.setSpacingAfter(6);
  var im = p.appendInlineImage(it.next().getBlob());
  var w = im.getWidth(), h = im.getHeight();
  var oran = Math.min(1, Math.min(genislik, SEKIL_EN_GENIS_PX) / w, SEKIL_EN_YUKSEK_PX / h);
  im.setWidth(Math.round(w * oran));
  im.setHeight(Math.round(h * oran));
}

/** Öğe listesini belgeye yazar. konum verilirse o sıradan itibaren araya ekler. Yazılan paragraf sayısını döndürür. */
function ogeleriYaz_(body, ogeler, klasor, konum) {
  var genislik = body.getPageWidth() - body.getMarginLeft() - body.getMarginRight();
  var k = konum === undefined ? null : konum;
  ogeler.forEach(function (oge) {
    if (oge.s === "gorsel") {
      belgeyeGorsel_(body, klasor, oge.g, genislik, k);
    } else {
      var st = {};
      var ana = BELGE_STIL[oge.s] || {};
      Object.keys(ana).forEach(function (x) { st[x] = ana[x]; });
      st.konum = k;
      var p = belgeParagraf_(body, oge.t, st);
      if (oge.s === "sik") p.editAsText().setBold(0, 1, true);
      if (oge.s === "not") p.editAsText().setBold(0, IYILESTIRME_ONEK.length - 2, true);
      if (oge.s === "karantina") p.editAsText().setBold(0, KARANTINA_ONEK.length - 2, true);
    }
    if (k !== null) k++;
  });
  return ogeler.length;
}

/** Sayfa sonunda soruların bölünmemesi için: hangi paragraf yeni bir blok başlatır. */
function havuzBlokKurallari_(grupIlk) {
  return {
    baslar: function (t) {
      var m = SORU_BASLIK_RE.exec(t);
      if (m) return !grupIlk[m[1]];
      return /^Ortak şekil [A-Z]{2,6}-G\d+\s*:/.test(t);
    },
    yapiskan: function (t) {
      return /^Ortak şekil [A-Z]{2,6}-G\d+\s*:/.test(t);
    },
  };
}

/** Bir bölüm belgesini yazar. Aynı adda belge varsa üzerine yazmaz. */
function havuzBelgesiYaz_(parca, klasor, ozet, gKlasor, notlar) {
  if (klasor.getFilesByName(parca.belge).hasNext()) throw new Error("Belge zaten var: " + parca.belge);
  var d = DocumentApp.create(parca.belge);
  try {
    var b = d.getBody();
    b.setMarginTop(50);
    b.setMarginBottom(50);
    b.setMarginLeft(60);
    b.setMarginRight(60);
    ogeleriYaz_(b, havuzBelgeOgeleri_(parca, ozet, notlar, { kontrol: "Kontrol: henüz yapılmadı" }), gKlasor);
    bosIlkParagrafiSil_(b);
    d.saveAndClose();
    var grupIlk = {};
    var gorulen = {};
    parca.sorular.forEach(function (q) {
      var g = String(q.grup || "").trim();
      if (g && !gorulen[g] && (q.grup_notu || q.grup_gorsel)) {
        gorulen[g] = true;
        grupIlk[q.soru_id] = true;
      }
    });
    var kr = havuzBlokKurallari_(grupIlk);
    birlikteTut_(d.getId(), kr.baslar, kr.yapiskan);
    DriveApp.getFileById(d.getId()).moveTo(klasor);
    return d.getId();
  } catch (e) {
    try { DriveApp.getFileById(d.getId()).setTrashed(true); } catch (e2) {}
    throw e;
  }
}

/** Bir konunun bölüm belgelerini oluşturur. yenile: aynı adlı eski belge çöpe atılıp yeniden yazılır (notlar korunur). */
function havuzBelgeleriOlustur_(konu, yenile) {
  var plan = havuzBelgePlani_().filter(function (p) { return !konu || p.konu === konu; });
  var ozet = kullanimOzeti_().soru;
  var gk = havuzGorselKlasoru_();
  var gKlasor = gk ? DriveApp.getFolderById(gk) : null;
  var kok = havuzKokKlasoru_();
  var sonuc = [];
  plan.forEach(function (p) {
    var k = altKlasor_(kok, p.klasor);
    var notlar = {};
    if (yenile) {
      var it = k.getFilesByName(p.belge);
      while (it.hasNext()) {
        var f = it.next();
        var eski = belgeNotlari_(f.getId());
        Object.keys(eski).forEach(function (id) { notlar[id] = (notlar[id] || []).concat(eski[id]); });
        f.setTrashed(true);
      }
    }
    sonuc.push(p.klasor + " / " + p.belge + " (" + p.sorular.length + " soru) " + havuzBelgesiYaz_(p, k, ozet, gKlasor, notlar));
  });
  return sonuc;
}

function havuzKokKlasoru_() {
  var sistem = DriveApp.getFileById(SpreadsheetApp.getActive().getId()).getParents().next();
  return altKlasor_(sistem, "Soru Havuzu");
}

var SISTEM_KLASOR_ADI = "Sistem dosyaları";

/**
 * Sistemin kendi kayıtları (durum dosyası, şekil kopyaları): ana tablonun klasörü / "Sistem dosyaları".
 * Eski yerleşimdeki "Soru Havuzu/_sistem" klasörü bulunursa bir kez buraya taşınır ve yeniden adlandırılır.
 */
function havuzSistemKlasoru_() {
  var kok = DriveApp.getFileById(SpreadsheetApp.getActive().getId()).getParents().next();
  var it = kok.getFoldersByName(SISTEM_KLASOR_ADI);
  if (it.hasNext()) return it.next();
  var eski = havuzKokKlasoru_().getFoldersByName("_sistem");
  if (eski.hasNext()) {
    var f = eski.next();
    f.moveTo(kok);
    f.setName(SISTEM_KLASOR_ADI);
    return f;
  }
  return kok.createFolder(SISTEM_KLASOR_ADI);
}

function havuzSekilKlasoru_() {
  return altKlasor_(havuzSistemKlasoru_(), "Sekiller");
}

// ----- Okuma ---------------------------------------------------------------

function satirMetni_(t) {
  return String(t || "").replace(/\r\n?|\u000b/g, "\n").replace(/\u00a0/g, " ").replace(/[ \t]+$/gm, "").replace(/^\s+|\s+$/g, "");
}

function md5_(baytlar) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, baytlar).map(function (b) {
    return ("0" + (b & 255).toString(16)).slice(-2);
  }).join("");
}

function iz_(metin) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(metin), Utilities.Charset.UTF_8).map(function (b) {
    return ("0" + (b & 255).toString(16)).slice(-2);
  }).join("").slice(0, 32);
}

/**
 * Belgenin gövdesini öğe listesi olarak okur: [{t, tip: "P"|"TABLO"|"LISTE"|"DIGER", gorsel: [{ad, md5, tur}], sorun}].
 * resimler: md5 -> blob (şekil saklamak için).
 */
function belgeOgeleriniOku_(belgeId, resimler) {
  var b = DocumentApp.openById(belgeId).getBody();
  var l = [];
  for (var i = 0; i < b.getNumChildren(); i++) {
    var c = b.getChild(i);
    var tip = c.getType();
    var o = { t: "", tip: "P", gorsel: [], sorun: "" };
    if (tip === DocumentApp.ElementType.PARAGRAPH) {
      var p = c.asParagraph();
      o.t = satirMetni_(p.getText());
      for (var j = 0; j < p.getNumChildren(); j++) {
        var e = p.getChild(j);
        var et = e.getType();
        if (et === DocumentApp.ElementType.INLINE_IMAGE) {
          var blob = e.asInlineImage().getBlob();
          var md5 = md5_(blob.getBytes());
          var ct = String(blob.getContentType() || "image/png");
          var ad = md5 + (ct.indexOf("jpeg") >= 0 ? ".jpeg" : ct.indexOf("gif") >= 0 ? ".gif" : ".png");
          o.gorsel.push({ ad: ad, md5: md5 });
          if (resimler) resimler[ad] = blob;
        } else if (et === DocumentApp.ElementType.INLINE_DRAWING || String(et) === "EQUATION") {
          o.sorun = "Okunamayan çizim ya da denklem nesnesi var (şekil resim olarak eklenmeli).";
        }
      }
      if (p.getPositionedImages && p.getPositionedImages().length) o.sorun = "Metne sarılmış (serbest konumlu) şekil var; şekil satır içi olmalı.";
    } else if (tip === DocumentApp.ElementType.TABLE) {
      o.tip = "TABLO";
    } else if (tip === DocumentApp.ElementType.LIST_ITEM) {
      o.tip = "LISTE";
      o.t = satirMetni_(c.asListItem().getText());
    } else {
      o.tip = "DIGER";
      try { o.t = satirMetni_(c.getText()); } catch (e3) {}
    }
    l.push(o);
  }
  return l;
}

function kisa_(t) {
  t = String(t || "").replace(/\s+/g, " ");
  return t.length > 50 ? t.slice(0, 50) + "…" : t;
}

/**
 * Bir havuz belgesinin öğe listesini çözer. Hiçbir satırı tahmin etmez: beklenmeyen her durum hatadır.
 * b: { konu, bolum, belgeId, belgeAdi, eski: true|false }
 * Dönüş: { sorular: [{kayit, bas, son, hatalar: [], yeni}], belgeHatalari: [], metinIzi }
 */
function havuzBelgesiniCoz_(ogeler, b) {
  var sonuc = { sorular: [], belgeHatalari: [], gruplar: {} };
  var izParcalari = [];
  var sistemSatiri = function (t) {
    return /^Kontrol:/.test(t) || /^Son işlem:/.test(t) || t.indexOf(KARANTINA_ONEK) === 0 || /^Kullanım:/.test(t);
  };
  ogeler.forEach(function (o, i) {
    if (o.tip === "P" && sistemSatiri(o.t)) return;
    if (i < 2 && o.tip === "P" && !o.gorsel.length) return; // belge başlığı ve alt başlık
    izParcalari.push(o.tip + "|" + o.t + "|" + o.gorsel.map(function (g) { return g.md5; }).join(","));
  });
  sonuc.metinIzi = iz_(izParcalari.join("\n"));

  var baslikMi = function (o) {
    return o.tip === "P" && (/^[A-Z]{2,6}-\d{4}\b/.test(o.t) || /^YEN[İI](\s|·|$)/.test(o.t));
  };
  var grupMu = function (o) {
    return o.tip === "P" && /^Ortak şekil\b/.test(o.t);
  };

  // Blokları ayır.
  var bloklar = [];
  var on = [];
  var aktif = null;
  ogeler.forEach(function (o, i) {
    if (baslikMi(o) || grupMu(o)) {
      aktif = { tur: baslikMi(o) ? "soru" : "grup", bas: i, ogeler: [] };
      bloklar.push(aktif);
    }
    if (aktif) aktif.ogeler.push({ o: o, i: i });
    else on.push({ o: o, i: i });
  });
  on.forEach(function (x, j) {
    var o = x.o;
    if (j < 2 || (o.tip === "P" && !o.t && !o.gorsel.length) || (o.tip === "P" && sistemSatiri(o.t))) return;
    sonuc.belgeHatalari.push("Belgenin başında tanınmayan satır: \"" + kisa_(o.t) + "\"");
  });

  var bekleyenGrup = null;
  bloklar.forEach(function (bl) {
    var satirlar = bl.ogeler.filter(function (x) {
      return !(x.o.tip === "P" && !x.o.t && !x.o.gorsel.length && !x.o.sorun);
    });
    bl.son = bl.ogeler[bl.ogeler.length - 1].i;
    if (bl.tur === "grup") {
      var g = { hatalar: [], not: [], gorseller: [], bas: bl.bas, son: bl.son };
      var m = /^Ortak şekil\s+([A-Z]{2,6})-G(\d+)\s*:\s*(.+)$/.exec(satirlar[0].o.t);
      if (!m) {
        g.hatalar.push("Ortak şekil başlığı okunamadı: \"" + kisa_(satirlar[0].o.t) + "\"");
        g.uyeler = [];
      } else {
        g.kod = m[1] + "-G" + m[2];
        g.uyeler = m[3].split(/\s*,\s*|\s+ve\s+/).map(function (x) { return x.trim(); }).filter(String);
        if (m[1] !== b.konu) g.hatalar.push("Ortak şekil kodu bu konunun değil: " + g.kod);
        g.uyeler.forEach(function (u) {
          if (!/^[A-Z]{2,6}-\d{4}$/.test(u)) g.hatalar.push("Ortak şekil başlığında geçersiz soru kodu: " + u);
        });
      }
      satirlar.slice(1).forEach(function (x) {
        var o = x.o;
        if (o.tip !== "P") g.hatalar.push("Ortak şekil bölümünde tablo ya da liste var.");
        else if (o.sorun) g.hatalar.push(o.sorun);
        else if (o.gorsel.length && o.t) g.hatalar.push("Ortak şekil ile aynı satırda metin var.");
        else if (o.gorsel.length) g.gorseller = g.gorseller.concat(o.gorsel);
        else if (g.gorseller.length) g.hatalar.push("Ortak şeklin altında metin var: \"" + kisa_(o.t) + "\"");
        else g.not.push(o.t);
      });
      if (g.gorseller.length > 1) g.hatalar.push("Ortak şekil bölümünde birden fazla resim var.");
      if (!g.gorseller.length && !g.not.length) g.hatalar.push("Ortak şekil bölümünde not ya da şekil yok.");
      g.kalan = g.uyeler.slice();
      if (g.kod) {
        if (sonuc.gruplar[g.kod]) g.hatalar.push("Aynı ortak şekil kodu belgede iki kez var: " + g.kod);
        sonuc.gruplar[g.kod] = g;
      }
      if (bekleyenGrup && bekleyenGrup.kalan.length) bekleyenGrup.hatalar.push("Grubun şu soruları başlığın hemen altında değil: " + bekleyenGrup.kalan.join(", "));
      if (!g.kod) {
        g.bozuk = true;
        sonuc.belgeHatalari.push(g.hatalar.join(" "));
      }
      bekleyenGrup = g;
      return;
    }
    var s = soruBloguCoz_(satirlar, b);
    s.bas = bl.bas;
    s.son = bl.son;
    var id = s.kayit.soru_id;
    if (bekleyenGrup && bekleyenGrup.bozuk) {
      s.hatalar.push("Hemen üstündeki ortak şekil başlığı okunamadı; sorunun gruba ait olup olmadığı bilinemiyor.");
      bekleyenGrup.bozuk = false;
    }
    if (bekleyenGrup && bekleyenGrup.kalan.length) {
      if (id && bekleyenGrup.kalan[0] === id) {
        bekleyenGrup.kalan.shift();
        s.grupKodu = bekleyenGrup.kod;
      } else {
        bekleyenGrup.hatalar.push("Grubun soruları başlığın hemen altında ve sırayla olmalı (beklenen " + bekleyenGrup.kalan[0] + ", bulunan " + (id || "okunamayan başlık") + ").");
        bekleyenGrup.kalan = [];
      }
    }
    sonuc.sorular.push(s);
  });
  if (bekleyenGrup && bekleyenGrup.kalan.length) bekleyenGrup.hatalar.push("Grubun şu soruları başlığın hemen altında değil: " + bekleyenGrup.kalan.join(", "));

  // Ortak şekil bilgilerini üyelere işle; grup hatası tüm üyeleri etkiler.
  Object.keys(sonuc.gruplar).forEach(function (kod) {
    var g = sonuc.gruplar[kod];
    sonuc.sorular.forEach(function (s) {
      var uye = g.uyeler.indexOf(s.kayit.soru_id) >= 0;
      if (!uye && s.grupKodu !== kod) return;
      if (g.hatalar.length) s.hatalar = s.hatalar.concat(g.hatalar.map(function (h) { return "Ortak şekil " + kod + ": " + h; }));
      if (s.grupKodu !== kod) s.hatalar.push("Ortak şekil " + kod + " başlığında adı geçiyor ama grubun altında değil.");
      s.kayit.grup = kod;
      s.kayit.grup_notu = g.not.join("\n");
      s.kayit.grup_gorsel = g.gorseller.length ? g.gorseller[0].ad : "";
      s.grupGorselMd5 = g.gorseller.length ? g.gorseller[0].md5 : "";
    });
  });
  // Grup başlığı olmayan grup kodu (ör. başlık bozuk) ya da kodu okunamayan grup: arkasındaki sorular etkilenir.
  sonuc.sorular.forEach(function (s) {
    if (!s.kayit.grup) {
      s.kayit.grup = "";
      s.kayit.grup_notu = "";
      s.kayit.grup_gorsel = "";
    }
  });
  return sonuc;
}

/** Tek bir soru bloğunu sırayla ve katı biçimde çözer. */
function soruBloguCoz_(satirlar, b) {
  var hatalar = [];
  var k = { soru_id: "", surum: 0, durum: "", konu: b.konu, bolum: b.bolum, zorluk: "", soru: "", gorsel: "", tur: "coktan", A: "", B: "", C: "", D: "", E: "", dogru: "", tolerans: "", birim: "", gerekce: "", kaynak: "", notlar: [] };
  var s = { kayit: k, hatalar: hatalar, yeni: false, gorselMd5: [], baslik: satirlar[0].o.t };
  var bas = satirlar[0].o.t;
  var m = /^(?:([A-Z]{2,6})-(\d{4})|(YEN[İI]))\s*·\s*(?:Sürüm\s*(\d+)\s*·\s*)?(.+)$/.exec(bas);
  if (!m) {
    var kod = /^([A-Z]{2,6}-\d{4})/.exec(bas);
    if (kod) k.soru_id = kod[1];
    hatalar.push("Başlık okunamadı: \"" + kisa_(bas) + "\" (biçim: " + (k.soru_id || "ELK-0001") + "  ·  Sürüm 1  ·  Onaylı)");
  } else {
    if (m[3]) {
      s.yeni = true;
      k.surum = 1;
    } else {
      k.soru_id = m[1] + "-" + m[2];
      if (!m[4]) hatalar.push("Başlıkta sürüm yok.");
      k.surum = Number(m[4]) || 0;
      if (m[1] !== b.konu) hatalar.push("Soru kodu bu konu klasörünün değil (" + m[1] + " ≠ " + b.konu + ").");
    }
    k.durum = durumKodu_(m[5]);
    if (!k.durum) hatalar.push("Başlıktaki durum tanınmadı: \"" + m[5] + "\" (Taslak, Onaylı, Kullanım dışı)");
    else if (b.eski && k.durum !== "ESKI") hatalar.push("Eski sürümler belgesinde durum \"Eski\" olmalı.");
    else if (!b.eski && k.durum === "ESKI") hatalar.push("\"Eski\" durumu yalnızca Eski sürümler belgesinde kullanılır.");
  }
  var l = satirlar.slice(1).filter(function (x) {
    return !(x.o.tip === "P" && x.o.t.indexOf(KARANTINA_ONEK) === 0);
  });
  var p = 0;
  var bak = function () { return l[p] ? l[p].o : null; };
  var hataSatir = function (o, ne) {
    hatalar.push(ne + ": \"" + kisa_(o.t || (o.gorsel.length ? "[şekil]" : "")) + "\"");
  };
  var tamam = function () { return hatalar.length > 0; };
  // Tablo, liste ve okunamayan nesneler blokta hiçbir yerde olamaz.
  l.forEach(function (x) {
    if (x.o.tip === "TABLO") hatalar.push("Soru içinde tablo var; sistem tabloyu okuyamaz.");
    else if (x.o.tip === "LISTE") hatalar.push("Soru içinde madde işaretli satır var: \"" + kisa_(x.o.t) + "\"");
    else if (x.o.tip === "DIGER") hatalar.push("Soru içinde tanınmayan öğe var.");
    else if (x.o.sorun) hatalar.push(x.o.sorun);
  });
  if (hatalar.length) return s;

  var o = bak();
  if (!o || !/^Zorluk\s*:/.test(o.t) || o.gorsel.length) {
    hatalar.push("\"Zorluk:\" satırı başlığın hemen altında olmalı.");
    return s;
  }
  k.zorluk = o.t.replace(/^Zorluk\s*:\s*/, "");
  p++;
  var metin = [];
  var sikMi = function (x) { return x && /^[A-E]\)/.test(x.t) && !x.gorsel.length; };
  var cevapSatiri = function (x) { return x && (/^Doğru cevap\s*:/.test(x.t) || /^Cevap türü\s*:/.test(x.t)); };
  while ((o = bak()) && !sikMi(o) && !cevapSatiri(o)) {
    if (o.gorsel.length) {
      if (o.t) return hataSatir(o, "Şekil ile aynı satırda metin var"), s;
      o.gorsel.forEach(function (g) {
        s.gorselMd5.push(g.md5);
        k.gorsel = k.gorsel ? k.gorsel + "," + g.ad : g.ad;
      });
    } else {
      if (/^(Gerekçe|Kaynak|Zorluk)\s*:/.test(o.t)) return hataSatir(o, "Şıklardan önce beklenmeyen satır"), s;
      if (s.gorselMd5.length) return hataSatir(o, "Şeklin altında soru metni var; soru metni şeklin üstünde olmalı"), s;
      metin.push(o.t);
    }
    p++;
  }
  if (!metin.length) hatalar.push("Soru metni yok.");
  k.soru = metin.join("\n");
  if (!o) {
    hatalar.push("Şıklar ve \"Doğru cevap:\" satırı yok.");
    return s;
  }
  var harfler = "ABCDE";
  if (/^Cevap türü\s*:/.test(o.t)) {
    var ct = /^Cevap türü\s*:\s*sayı(?:\s*\((.+)\))?$/.exec(o.t);
    if (!ct) return hataSatir(o, "Cevap türü satırı okunamadı"), s;
    k.tur = "sayi";
    k.birim = ct[1] || "";
    p++;
  } else {
    var n = 0;
    while ((o = bak()) && sikMi(o)) {
      var sm = /^([A-E])\)\s*(.*)$/.exec(o.t);
      if (sm[1] !== harfler[n]) return hataSatir(o, "Şıklar A'dan başlayıp sırayla gitmeli; beklenen " + harfler[n] + ")"), s;
      if (!sm[2].trim()) return hataSatir(o, "Boş şık"), s;
      k[sm[1]] = sm[2].trim();
      n++;
      p++;
    }
    if (o && /^(Gerekçe|Kaynak)\s*:/.test(o.t)) return hatalar.push("\"Doğru cevap:\" satırı şıkların hemen altında olmalı."), s;
    if (o && !cevapSatiri(o)) return hataSatir(o, "Şıklardan sonra beklenmeyen satır (bir şık iki satıra bölünmüş olabilir)"), s;
    if (n < 2) hatalar.push("En az iki şık olmalı.");
  }
  o = bak();
  if (!o || !/^Doğru cevap\s*:/.test(o.t)) {
    hatalar.push("\"Doğru cevap:\" satırı şıkların hemen altında olmalı.");
    return s;
  }
  var dv = o.t.replace(/^Doğru cevap\s*:\s*/, "");
  if (k.tur === "sayi") {
    var dm = /^(-?\d+(?:[.,]\d+)?)(?:\s*\(tolerans\s*±\s*(\d+(?:[.,]\d+)?)\))?$/.exec(dv);
    if (!dm) hataSatir(o, "Sayısal doğru cevap okunamadı");
    else {
      k.dogru = dm[1];
      k.tolerans = dm[2] || "";
    }
  } else if (!/^[A-E]$/.test(dv)) {
    hataSatir(o, "Doğru cevap tek bir şık harfi olmalı");
  } else if (!k[dv]) {
    hatalar.push("Doğru cevap " + dv + " şıklarda yok.");
  } else k.dogru = dv;
  p++;
  o = bak();
  if (!o || !/^Gerekçe\s*:/.test(o.t)) {
    hatalar.push("\"Gerekçe:\" satırı \"Doğru cevap:\" satırının altında olmalı (boş bırakılabilir).");
    return s;
  }
  k.gerekce = o.t.replace(/^Gerekçe\s*:\s*/, "");
  p++;
  o = bak();
  if (!o || !/^Kaynak\s*:/.test(o.t)) {
    hatalar.push("\"Kaynak:\" satırı \"Gerekçe:\" satırının altında olmalı (boş bırakılabilir).");
    return s;
  }
  k.kaynak = o.t.replace(/^Kaynak\s*:\s*/, "");
  p++;
  while ((o = bak())) {
    if (/^Kullanım:/.test(o.t)) {
      p++;
      continue;
    }
    if (o.t.indexOf(IYILESTIRME_ONEK) === 0 || /^İyileştirme notu\s*:/.test(o.t)) {
      k.notlar.push(o.t);
      p++;
      continue;
    }
    return hataSatir(o, "Sorunun sonunda tanınmayan satır"), s;
  }
  return s;
}

/** Sınava giren içerik (değişirse onaylı soru için karar gerekir). */
function icerikIzi_(k, s) {
  var siklar = ["A", "B", "C", "D", "E"].map(function (h) { return h + "=" + String(k[h] || ""); }).join("|");
  return iz_([k.soru, (s.gorselMd5 || []).join(","), k.tur, k.birim, siklar, k.dogru, k.tolerans, k.grup ? "grup" : "", k.grup_notu, s.grupGorselMd5 || ""].join("\u0001"));
}

/** Sınava girmeyen bilgiler (zorluk, gerekçe, kaynak, notlar). */
function bilgiIzi_(k) {
  return iz_([k.zorluk, k.gerekce, k.kaynak, (k.notlar || []).join("\n")].join("\u0001"));
}

// ----- Notlar --------------------------------------------------------------

function notParagrafiBicimle_(p) {
  var t = p.editAsText();
  t.setFontSize(9);
  t.setForegroundColor("#666666");
  t.setItalic(false);
  t.setBold(false);
  t.setBold(0, IYILESTIRME_ONEK.length - 2, true);
  return p;
}

/** Paragraf metinlerinden soru kodu bazında iyileştirme notları: { "PLC-0019": ["İyileştirme notu: ..."] }. */
function notlariAyikla_(metinler) {
  var notlar = {};
  var id = "";
  metinler.forEach(function (t) {
    var m = SORU_BASLIK_RE.exec(t);
    if (m) id = m[1];
    else if (/^Ortak şekil /.test(t)) id = "";
    else if (id && t.indexOf(IYILESTIRME_ONEK) === 0) (notlar[id] = notlar[id] || []).push(t);
  });
  return notlar;
}

function belgeNotlari_(belgeId) {
  return notlariAyikla_(belgeOgeleriniOku_(belgeId).map(function (o) { return o.t; }));
}

/**
 * Soru Havuzu belgesinde sorunun altına (kullanım satırından sonra) iyileştirme notu ekler.
 * Soru değişmez; not yalnızca ileride açılacak yeni sürüm için hatırlatmadır. Aynı not iki kez eklenmez.
 */
function iyilestirmeNotuEkle_(soruId, metin) {
  var yazi = IYILESTIRME_ONEK + String(metin).trim();
  var konular = havuzKokKlasoru_().getFolders();
  while (konular.hasNext()) {
    var dosyalar = konular.next().getFilesByType(MimeType.GOOGLE_DOCS);
    while (dosyalar.hasNext()) {
      var f = dosyalar.next();
      var d = DocumentApp.openById(f.getId());
      var b = d.getBody();
      var n = b.getNumChildren();
      var metin_ = function (i) {
        var c = b.getChild(i);
        return c.getType() === DocumentApp.ElementType.PARAGRAPH ? c.asParagraph().getText() : "";
      };
      var bas = -1;
      for (var i = 0; i < n; i++) {
        var m = SORU_BASLIK_RE.exec(metin_(i));
        if (m && m[1] === soruId) { bas = i; break; }
      }
      if (bas < 0) continue;
      var son = n - 1;
      for (var j = bas + 1; j < n; j++) {
        var t = metin_(j);
        if (SORU_BASLIK_RE.test(t) || /^Ortak şekil /.test(t)) { son = j - 1; break; }
        if (t === yazi) return "Zaten var: " + soruId + " (" + f.getName() + ")";
      }
      while (son > bas && metin_(son) === "") son--;
      var p = b.insertParagraph(son + 1, yazi);
      p.setHeading(DocumentApp.ParagraphHeading.NORMAL);
      p.setSpacingBefore(0);
      p.setSpacingAfter(4);
      p.setIndentStart(0);
      p.setIndentFirstLine(0);
      notParagrafiBicimle_(p);
      d.saveAndClose();
      notlariBagla_(f.getId());
      return "Eklendi: " + soruId + " (" + f.getName() + ")";
    }
  }
  throw new Error("Soru Havuzu belgelerinde bulunamadı: " + soruId);
}

/** Notun sorudan ayrı sayfaya düşmemesi için nottan önceki paragrafı sonrakiyle birlikte tutar. */
function notlariBagla_(belgeId) {
  if (typeof Docs === "undefined") return 0;
  var ps = (Docs.Documents.get(belgeId).body.content || []).filter(function (e) { return e.paragraph; });
  var metin = function (e) {
    return (e.paragraph.elements || []).map(function (x) { return x.textRun ? x.textRun.content : ""; }).join("");
  };
  var istekler = [];
  ps.forEach(function (e, i) {
    if (ps[i + 1] && metin(ps[i + 1]).indexOf(IYILESTIRME_ONEK) === 0) {
      istekler.push({ updateParagraphStyle: { range: { startIndex: e.startIndex, endIndex: e.endIndex }, paragraphStyle: { keepWithNext: true, keepLinesTogether: true }, fields: "keepWithNext,keepLinesTogether" } });
    }
  });
  if (istekler.length) Docs.Documents.batchUpdate({ requests: istekler }, belgeId);
  return istekler.length;
}

// ----- Durum dosyası, iz ve günlük -----------------------------------------

var DURUM_ONBELLEK_ = null;

function havuzDurumDosyasi_() {
  var k = havuzSistemKlasoru_();
  var it = k.getFilesByName("havuz_durum.json");
  return it.hasNext() ? it.next() : null;
}

function havuzDurumOku_() {
  if (DURUM_ONBELLEK_) return DURUM_ONBELLEK_;
  var f = havuzDurumDosyasi_();
  var d = f ? JSON.parse(f.getBlob().getDataAsString("UTF-8")) : null;
  if (!d || !d.v) d = { v: 1, belgeler: {}, sorular: {}, karantina: {}, kullanim: {}, sonKontrol: 0 };
  DURUM_ONBELLEK_ = d;
  return d;
}

function havuzDurumYaz_(d) {
  var metin = JSON.stringify(d);
  var f = havuzDurumDosyasi_();
  if (f) f.setContent(metin);
  else havuzSistemKlasoru_().createFile("havuz_durum.json", metin, "application/json");
  DURUM_ONBELLEK_ = d;
}

function gunlukYaz_(kayitlar) {
  if (!kayitlar.length) return;
  var sh = sayfa_("Havuz_Gunlugu");
  var b = basliklar_(sh);
  var satirlar = kayitlar.map(function (g) {
    return b.map(function (x) { return g[x] !== undefined ? g[x] : ""; });
  });
  sh.getRange(sh.getLastRow() + 1, 1, satirlar.length, b.length).setValues(satirlar);
}

function izleriYaz_(d) {
  var sh = sayfa_("Havuz_Izleri");
  var b = BASLIKLAR.Havuz_Izleri;
  var satirlar = [];
  Object.keys(d.sorular).sort().forEach(function (key) {
    var x = d.sorular[key];
    var kr = d.karantina[x.kayit.soru_id + "@" + x.kayit.surum] || d.karantina[x.kayit.soru_id];
    satirlar.push([x.kayit.soru_id, x.kayit.surum, x.kayit.durum, kr ? "KARANTİNA" : "TAMAM", kr ? kr.sorun : "", x.belgeAdi || "", x.kayit.bolum, x.icerik, tarihGosterimSaat_(x.okuma)]);
  });
  Object.keys(d.karantina).sort().forEach(function (key) {
    var kr = d.karantina[key];
    if (kr.id && d.sorular[kr.id + "@" + kr.surum]) return;
    if (kr.id && !kr.surum && Object.keys(d.sorular).some(function (s) { return s.indexOf(kr.id + "@") === 0; })) return;
    satirlar.push([kr.id || "?", kr.surum || "", "", "KARANTİNA", kr.sorun, kr.belgeAdi || "", "", "", tarihGosterimSaat_(kr.ilk)]);
  });
  sh.clear();
  sh.getRange(1, 1, 1, b.length).setValues([b]);
  if (satirlar.length) sh.getRange(2, 1, satirlar.length, b.length).setValues(satirlar);
}

function tarihGosterimSaat_(ms) {
  if (!ms) return "";
  return Utilities.formatDate(new Date(ms), SpreadsheetApp.getActive().getSpreadsheetTimeZone() || "Europe/Istanbul", "dd.MM.yyyy HH:mm");
}

// ----- Kontrol -------------------------------------------------------------

/** Havuz belgelerinin listesi: [{id, ad, konu, konuAd, klasor, bolum, eski, guncelleme, dosya}] */
function havuzBelgeListesi_() {
  var kd = kodlar_();
  var l = [];
  var hatalar = [];
  var it = havuzKokKlasoru_().getFolders();
  while (it.hasNext()) {
    var k = it.next();
    var ad = k.getName();
    if (ad === "_sistem") continue;
    var m = /^([A-Z]{2,6}) - (.+)$/.exec(ad);
    if (!m || kd.KONU[m[1]] === undefined) {
      hatalar.push("Konu klasörü tanınmadı: " + ad);
      continue;
    }
    var dosyalar = k.getFilesByType(MimeType.GOOGLE_DOCS);
    while (dosyalar.hasNext()) {
      var f = dosyalar.next();
      var fa = f.getName();
      var bm = /^(\d{2}) - (.+)$/.exec(fa);
      if (!bm) {
        hatalar.push("Belge adı \"NN - bölüm\" biçiminde değil: " + ad + " / " + fa);
        continue;
      }
      l.push({ id: f.getId(), ad: fa, konu: m[1], konuAd: kd.KONU[m[1]], klasor: ad, bolum: bm[2], eski: fa === ESKI_BELGE_ADI, guncelleme: f.getLastUpdated().getTime(), dosya: f });
    }
  }
  return { belgeler: l, hatalar: hatalar };
}

/**
 * Havuz belgelerini kontrol eder. Değişmeyen belgeler yeniden okunmaz (o.hepsi ile hepsi okunur).
 * Karantina, günlük, iz sekmesi, belge içi uyarılar ve e-posta burada güncellenir.
 * o: { hepsi, ilk (ilk kayıt: tüm sorular kabul edilir), eposta (varsayılan true) }
 */
function havuzKontrol_(o) {
  o = o || {};
  var kilit = LockService.getScriptLock();
  kilit.waitLock(60000);
  try {
    return havuzKontrolIc_(o);
  } finally {
    kilit.releaseLock();
  }
}

function havuzKontrolIc_(o) {
  var simdi = new Date().getTime();
  var d = havuzDurumOku_();
  var ilk = !!o.ilk || !Object.keys(d.sorular).length;
  var liste = havuzBelgeListesi_();
  var gunluk = [];
  var log = function (belge, id, surum, islem, aciklama) {
    var b = typeof belge === "object" && belge ? belge : { ad: belge || "", id: "" };
    gunluk.push({ tarih: new Date(simdi), belge: b.ad || "", _bid: b.id || "", soru_id: id || "", surum: surum || "", islem: islem, aciklama: aciklama || "" });
  };
  (o.ekGunluk || []).forEach(function (g) { log(g.belge, g.id, g.surum, g.islem, g.aciklama); });
  var okunan = {};
  var saf = {};
  var resimler = {};
  var degisenBelge = {};
  liste.belgeler.forEach(function (b) {
    var onceki = d.belgeler[b.id];
    if (!o.hepsi && onceki && onceki.guncelleme === b.guncelleme && onceki.cozum) {
      okunan[b.id] = kopya_(onceki.cozum);
      saf[b.id] = onceki.cozum;
      return;
    }
    var ogeler = belgeOgeleriniOku_(b.id, resimler);
    var cz = havuzBelgesiniCoz_(ogeler, { konu: b.konu, bolum: b.eski ? "" : b.bolum, belgeId: b.id, belgeAdi: b.ad, eski: b.eski });
    saf[b.id] = kopya_(cz);
    okunan[b.id] = cz;
    if (!(onceki && onceki.cozum && onceki.cozum.metinIzi === cz.metinIzi && !o.hepsi)) degisenBelge[b.id] = true;
  });

  // Sistemin kendi yeniden yazdığı şekiller (JPEG her eklemede yeniden sıkıştırılır): asıl şekille eşle.
  var es = d.sekilEs || {};
  var takma = function (ad) { return es[ad] || ad; };
  var md5Ad = function (ad) { return String(ad).replace(/\.[a-z]+$/, ""); };
  Object.keys(okunan).forEach(function (bid) {
    okunan[bid].sorular.forEach(function (s) {
      var k = s.kayit;
      var adlar = sekilAdlari_(k).map(takma);
      k.gorsel = adlar.join(",");
      s.gorselMd5 = adlar.map(md5Ad);
      if (k.grup_gorsel) {
        k.grup_gorsel = takma(k.grup_gorsel);
        s.grupGorselMd5 = md5Ad(k.grup_gorsel);
      }
    });
  });

  // Yeni sorulara kod ver (YENİ başlığı).
  var enBuyuk = {};
  var say = function (id) {
    var m = /^([A-Z]{2,6})-(\d{4})$/.exec(id || "");
    if (m) enBuyuk[m[1]] = Math.max(enBuyuk[m[1]] || 0, Number(m[2]));
  };
  Object.keys(d.sorular).forEach(function (k) { say(d.sorular[k].kayit.soru_id); });
  Object.keys(okunan).forEach(function (bid) { okunan[bid].sorular.forEach(function (s) { say(s.kayit.soru_id); }); });
  var kodVerilecek = [];
  liste.belgeler.forEach(function (b) {
    okunan[b.id].sorular.forEach(function (s) {
      if (!s.yeni) return;
      if (s.hatalar.length) return;
      if (b.eski) {
        s.hatalar.push("Eski sürümler belgesine yeni soru eklenemez.");
        return;
      }
      enBuyuk[b.konu] = (enBuyuk[b.konu] || 0) + 1;
      s.kayit.soru_id = b.konu + "-" + ("000" + enBuyuk[b.konu]).slice(-4);
      kodVerilecek.push({ belge: b, s: s });
    });
  });

  // Kayıtlar: anahtar -> [{belge, s}]
  var bulunan = {};
  var kimlikler = {};
  liste.belgeler.forEach(function (b) {
    okunan[b.id].sorular.forEach(function (s) {
      var id = s.kayit.soru_id;
      if (!id) return;
      var key = id + "@" + s.kayit.surum;
      (bulunan[key] = bulunan[key] || []).push({ belge: b, s: s });
      if (!b.eski) (kimlikler[id] = kimlikler[id] || []).push({ belge: b, s: s });
    });
  });
  Object.keys(bulunan).forEach(function (key) {
    if (bulunan[key].length > 1) bulunan[key].forEach(function (x) {
      x.s.hatalar.push("Aynı soru kodu ve sürüm başka bir yerde de var (" + bulunan[key].map(function (y) { return y.belge.ad; }).join(", ") + ").");
    });
  });
  Object.keys(kimlikler).forEach(function (id) {
    if (kimlikler[id].length > 1) kimlikler[id].forEach(function (x) {
      x.s.hatalar.push("Bu soru bölüm belgelerinde birden fazla kez var; eski sürümler yalnızca \"" + ESKI_BELGE_ADI + "\" belgesinde durmalı.");
    });
  });

  // Karşılaştırma ve karantina
  var yeniKarantina = {};
  var karantinaEkle = function (key, x, s) {
    if (s && s.baslik) x.baslik = s.baslik;
    if (yeniKarantina[key] && yeniKarantina[key].sorun !== x.sorun && yeniKarantina[key].baslik === x.baslik) x.sorun = yeniKarantina[key].sorun + " " + x.sorun;
    yeniKarantina[key] = x;
  };
  var gorulenAnahtar = {};
  liste.belgeler.forEach(function (b) {
    okunan[b.id].sorular.forEach(function (s, sira) {
      var k = s.kayit;
      if (!k.soru_id || !k.surum) {
        if (k.soru_id) Object.keys(d.sorular).forEach(function (x) { if (x.indexOf(k.soru_id + "@") === 0 && !b.eski) gorulenAnahtar[x] = true; });
        karantinaEkle("?" + b.id + ":" + s.bas, { id: k.soru_id || "", surum: k.surum || "", belge: b.id, belgeAdi: b.ad, sorun: s.hatalar.join(" ") || "Başlık okunamadı.", ilk: simdi }, s);
        return;
      }
      var key = k.soru_id + "@" + k.surum;
      gorulenAnahtar[key] = true;
      if (s.hatalar.length) {
        karantinaEkle(key, { id: k.soru_id, surum: k.surum, belge: b.id, belgeAdi: b.ad, sorun: s.hatalar.join(" "), ilk: simdi }, s);
        return;
      }
      var icerik = icerikIzi_(k, s);
      var bilgi = bilgiIzi_(k);
      var onceki = d.sorular[key];
      if (b.eski) k.bolum = onceki ? onceki.kayit.bolum : "";
      var kayitYeni = { kayit: kayitTemiz_(k), icerik: icerik, bilgi: bilgi, belge: b.id, belgeAdi: b.ad, okuma: simdi, gorselMd5: s.gorselMd5, grupGorselMd5: s.grupGorselMd5 || "" };
      if (ilk) {
        d.sorular[key] = kayitYeni;
        if (!onceki) log(b, k.soru_id, k.surum, "İlk kayıt", durumKelimesi_(k.durum));
        return;
      }
      if (!onceki) {
        var dahaOnce = Object.keys(d.sorular).filter(function (x) { return x.indexOf(k.soru_id + "@") === 0; });
        if (dahaOnce.length && !b.eski) {
          if (o.yeniSurum && o.yeniSurum[k.soru_id] === k.surum) {
            d.sorular[key] = kayitYeni;
            log(b, k.soru_id, k.surum, "Yeni sürüm açıldı", durumKelimesi_(k.durum));
          } else {
            karantinaEkle(key, { id: k.soru_id, surum: k.surum, belge: b.id, belgeAdi: b.ad, sorun: "Sürüm numarası elle değiştirilmiş görünüyor. Yeni sürüm panelden açılır.", ilk: simdi }, s);
          }
          return;
        }
        if (b.eski && !(o.eskiye && o.eskiye[key])) {
          karantinaEkle(key, { id: k.soru_id, surum: k.surum, belge: b.id, belgeAdi: b.ad, sorun: "Eski sürümler belgesine elle eklenmiş kayıt; bu belgeye yalnızca sistem yazar.", ilk: simdi }, s);
          return;
        }
        d.sorular[key] = kayitYeni;
        log(b, k.soru_id, k.surum, b.eski ? "Eski sürüme alındı" : "Yeni soru eklendi", durumKelimesi_(k.durum));
        return;
      }
      var korunan = onceki.kayit.durum === "ONAYLI" || onceki.kayit.durum === "ESKI" || onceki.kayit.durum === "KULLANIM_DISI";
      var izinli = o.duzeltme && o.duzeltme[key];
      if (onceki.icerik !== icerik && korunan && !izinli) {
        karantinaEkle(key, {
          id: k.soru_id, surum: k.surum, belge: b.id, belgeAdi: b.ad, ilk: simdi, karar: onceki.kayit.durum !== "ESKI",
          sorun: onceki.kayit.durum === "ESKI" ? "Eski sürüm kaydı değişmiş; bu kayıtlar değiştirilmemeli. Panelden geri alın." : "Onaylı soru değişmiş. Panelden karar verin: yeni sürüm, anlamı değişmedi ya da geri al.",
        }, s);
        return;
      }
      if (onceki.kayit.durum !== k.durum) {
        var gecis = onceki.kayit.durum + ">" + k.durum;
        var izin = { "TASLAK>ONAYLI": "Onaylandı", "ONAYLI>KULLANIM_DISI": "Kullanım dışı bırakıldı", "KULLANIM_DISI>ONAYLI": "Yeniden kullanıma alındı", "TASLAK>KULLANIM_DISI": "Kullanım dışı bırakıldı", "ONAYLI>ESKI": "Eski sürüme alındı" }[gecis];
        if (!izin) {
          karantinaEkle(key, { id: k.soru_id, surum: k.surum, belge: b.id, belgeAdi: b.ad, ilk: simdi, sorun: "Durum " + durumKelimesi_(onceki.kayit.durum) + " iken " + durumKelimesi_(k.durum) + " yapılamaz." + (onceki.kayit.durum === "ONAYLI" ? " Değişiklik için panelden yeni sürüm açın." : "") }, s);
          return;
        }
        log(b, k.soru_id, k.surum, izin, durumKelimesi_(onceki.kayit.durum) + " → " + durumKelimesi_(k.durum));
      }
      if (onceki.icerik !== icerik) log(b, k.soru_id, k.surum, izinli ? "Anlamı değişmeden düzeltildi" : "Taslak güncellendi", "");
      if (onceki.bilgi !== bilgi) {
        var nOnce = (onceki.kayit.notlar || []).length;
        var nSimdi = (k.notlar || []).length;
        if (nOnce !== nSimdi) log(b, k.soru_id, k.surum, nSimdi > nOnce ? "İyileştirme notu eklendi" : "İyileştirme notu silindi", nOnce + " → " + nSimdi);
        else log(b, k.soru_id, k.surum, "Bilgi güncellendi", "Zorluk, gerekçe, kaynak ya da not");
      }
      if (onceki.belge !== b.id) log(b, k.soru_id, k.surum, "Taşındı", (onceki.belgeAdi || "") + " → " + b.ad);
      d.sorular[key] = kayitYeni;
    });
  });

  // Belge düzeyindeki sorunlar (soruya bağlanamayan satırlar)
  liste.belgeler.forEach(function (b) {
    (okunan[b.id].belgeHatalari || []).forEach(function (h, i) {
      karantinaEkle("!" + b.id + ":" + iz_(h).slice(0, 8), { id: "", surum: "", belge: b.id, belgeAdi: b.ad, sorun: h, ilk: simdi });
    });
  });

  // Kaybolan sorular (yalnızca tüm belgeler okunabildiyse)
  Object.keys(d.sorular).forEach(function (key) {
    if (gorulenAnahtar[key]) return;
    var x = d.sorular[key];
    karantinaEkle(key, { id: x.kayit.soru_id, surum: x.kayit.surum, belge: x.belge, belgeAdi: x.belgeAdi, ilk: simdi, sorun: "Soru hiçbir havuz belgesinde bulunamadı (silinmiş ya da başlığı bozulmuş olabilir)." });
  });

  // Karantina girişleri ve çıkışları
  var eskiKarantina = d.karantina || {};
  var yeniGiren = [];
  Object.keys(yeniKarantina).forEach(function (key) {
    var x = yeniKarantina[key];
    if (eskiKarantina[key] && eskiKarantina[key].sorun === x.sorun) {
      x.ilk = eskiKarantina[key].ilk;
      return;
    }
    yeniGiren.push(x);
    log({ ad: x.belgeAdi, id: x.belge }, x.id, x.surum, "Karantinaya alındı", x.sorun);
  });
  Object.keys(eskiKarantina).forEach(function (key) {
    if (!yeniKarantina[key]) {
      var x = eskiKarantina[key];
      log({ ad: x.belgeAdi, id: x.belge }, x.id, x.surum, "Karantinadan çıktı", "");
    }
  });
  d.karantina = yeniKarantina;

  // Şekilleri sakla
  var sekilKlasoru = null;
  Object.keys(resimler).forEach(function (ad) {
    var kullaniliyor = Object.keys(d.sorular).some(function (key) {
      var x = d.sorular[key].kayit;
      return sekilAdlari_(x).indexOf(ad) >= 0 || x.grup_gorsel === ad;
    });
    if (!kullaniliyor) return;
    sekilKlasoru = sekilKlasoru || havuzSekilKlasoru_();
    if (!sekilKlasoru.getFilesByName(ad).hasNext()) sekilKlasoru.createFile(resimler[ad].copyBlob().setName(ad));
  });

  // Kullanım satırları (yalnızca bölüm belgelerindeki eksiksiz okunan sorular için)
  var beklenenKullanim = {};
  try {
    beklenenKullanim = kullanimMetinleri_(d);
  } catch (e) {
    log("", "", "", "Kullanım satırları güncellenemedi", String(e && e.message ? e.message : e));
  }
  d.kullanim = d.kullanim || {};

  // Belgelere yazılacaklar: kod verilen başlıklar, karantina satırları, kullanım ve durum satırları
  var belgeGunlugu = {};
  gunluk.forEach(function (g) {
    if (g._bid) belgeGunlugu[g._bid] = g;
  });
  var yazilan = 0;
  liste.belgeler.forEach(function (b) {
    var kr = Object.keys(d.karantina).map(function (k) { return d.karantina[k]; }).filter(function (x) { return x.belge === b.id; });
    var krIzi = kr.map(function (x) { return x.id + "@" + x.surum + ":" + x.sorun; }).sort().join("|");
    var onceki = d.belgeler[b.id] || {};
    var basliklar = kodVerilecek.filter(function (x) { return x.belge.id === b.id; });
    var kullanimYaz = {};
    if (!b.eski) okunan[b.id].sorular.forEach(function (s) {
      var id = s.kayit.soru_id;
      if (!id || s.hatalar.length || beklenenKullanim[id] === undefined) return;
      if (d.kullanim[id] !== beklenenKullanim[id]) kullanimYaz[id] = beklenenKullanim[id];
    });
    var bg = belgeGunlugu[b.id];
    if (bg) onceki.sonIslem = { tarih: new Date(simdi).toISOString(), soru_id: bg.soru_id, islem: bg.islem };
    var yazilacak = degisenBelge[b.id] || basliklar.length || onceki.krIzi !== krIzi || bg || Object.keys(kullanimYaz).length || o.hepsi;
    var cz = saf[b.id];
    if (yazilacak) {
      var sayi = okunan[b.id].sorular.length;
      var kontrolMetni = "Kontrol: " + tarihGosterimSaat_(simdi) + " · " + sayi + " soru · " + (kr.length ? kr.length + " kayıt karantinada: " + kr.map(function (x) { return x.id || "belge uyarısı"; }).join(", ") : "tümü eksiksiz okundu");
      var si = onceki.sonIslem;
      var islemMetni = si ? "Son işlem: " + tarihGosterimSaat_(new Date(si.tarih).getTime()) + " · " + (si.soru_id ? si.soru_id + " " : "") + si.islem : "";
      belgeSistemSatirlariniYaz_(b, okunan[b.id], kr, basliklar, kontrolMetni, islemMetni, !!kr.length, kullanimYaz);
      Object.keys(kullanimYaz).forEach(function (id) { d.kullanim[id] = kullanimYaz[id]; });
      // Sistem satırları paragraf sıralarını değiştirdiği için çözüm yeniden okunur (içerik izi değişmez).
      cz = havuzBelgesiniCoz_(belgeOgeleriniOku_(b.id), { konu: b.konu, bolum: b.eski ? "" : b.bolum, belgeId: b.id, belgeAdi: b.ad, eski: b.eski });
      yazilan++;
    }
    d.belgeler[b.id] = { ad: b.ad, klasor: b.klasor, konu: b.konu, bolum: b.bolum, eski: b.eski, guncelleme: yazilacak ? DriveApp.getFileById(b.id).getLastUpdated().getTime() : b.guncelleme, cozum: cz, krIzi: krIzi, sonIslem: onceki.sonIslem || null, okuma: yazilacak || degisenBelge[b.id] ? simdi : onceki.okuma };
  });
  Object.keys(d.belgeler).forEach(function (bid) {
    if (!liste.belgeler.some(function (b) { return b.id === bid; })) {
      log(d.belgeler[bid].ad, "", "", "Belge bulunamadı", d.belgeler[bid].klasor + " / " + d.belgeler[bid].ad);
      delete d.belgeler[bid];
    }
  });
  liste.hatalar.forEach(function (h) {
    if ((d.klasorHatalari || []).indexOf(h) < 0) log("", "", "", "Klasör uyarısı", h);
  });
  d.klasorHatalari = liste.hatalar;
  kilavuzKontrol_(d, log, o);
  d.sonKontrol = simdi;

  havuzDurumYaz_(d);
  gunlukYaz_(gunluk);
  if (gunluk.length || yazilan || o.hepsi) izleriYaz_(d);
  if (yeniGiren.length && o.eposta !== false) {
    var kHata = karantinaEpostasi_(yeniGiren);
    if (kHata) gunlukYaz_([{ tarih: new Date(simdi), belge: "", soru_id: "", surum: "", islem: "E-posta gönderilemedi", aciklama: "Karantina uyarısı: " + kHata }]);
  }
  return { okunan: Object.keys(degisenBelge).length, yazilan: yazilan, belge: liste.belgeler.length, soru: Object.keys(d.sorular).length, karantina: Object.keys(d.karantina).length, yeniKarantina: yeniGiren.length, islem: gunluk.length, klasorHatalari: liste.hatalar };
}

function kopya_(x) {
  return JSON.parse(JSON.stringify(x));
}

/** Bölüm belgelerindeki her sorunun beklenen kullanım satırı: { id: "Kullanım: ..." } */
function kullanimMetinleri_(d) {
  var m = {};
  Object.keys(d.sorular).forEach(function (key) {
    var x = d.sorular[key];
    var k = kopya_(x.kayit);
    k.surum = Number(k.surum) || 1;
    m[key] = k;
  });
  var ozet = kullanimOzeti_(m).soru;
  var l = {};
  Object.keys(m).forEach(function (key) {
    l[m[key].soru_id] = kullanimSatiri_(ozet[m[key].soru_id]);
  });
  return l;
}

function kayitTemiz_(k) {
  var o = {};
  ["soru_id", "surum", "durum", "konu", "bolum", "zorluk", "grup", "grup_notu", "grup_gorsel", "soru", "gorsel", "tur", "A", "B", "C", "D", "E", "dogru", "tolerans", "birim", "gerekce", "kaynak", "notlar"].forEach(function (x) {
    o[x] = k[x] === undefined ? "" : k[x];
  });
  return o;
}

/** Belgedeki sistem satırlarını (kontrol, son işlem, karantina uyarıları, yeni kodlar) günceller. */
function belgeSistemSatirlariniYaz_(b, cz, kr, basliklar, kontrolMetni, islemMetni, kirmizi, kullanimYaz) {
  var doc = DocumentApp.openById(b.id);
  var body = doc.getBody();
  var metin = function (i) {
    var c = body.getChild(i);
    return c.getType() === DocumentApp.ElementType.PARAGRAPH ? c.asParagraph().getText() : "";
  };
  // Eski sistem satırlarını sil (sondan başa).
  for (var i = body.getNumChildren() - 1; i >= 0; i--) {
    var t = metin(i);
    if (t.indexOf(KARANTINA_ONEK) === 0 || (i < 6 && (/^Kontrol:/.test(t) || /^Son işlem:/.test(t)))) {
      if (i === body.getNumChildren() - 1) body.appendParagraph("");
      body.getChild(i).removeFromParent();
    }
  }
  // Yeni kod verilen başlıklar.
  basliklar.forEach(function (x) {
    for (var j = 0; j < body.getNumChildren(); j++) {
      var tt = metin(j);
      if (/^YEN[İI](\s|·|$)/.test(tt)) {
        var p = body.getChild(j).asParagraph();
        p.setText(soruBasligi_(x.s.kayit));
        p.setHeading(DocumentApp.ParagraphHeading.HEADING2);
        break;
      }
    }
  });
  // Kullanım satırları
  Object.keys(kullanimYaz || {}).forEach(function (id) {
    var bas = -1;
    for (var j = 0; j < body.getNumChildren(); j++) {
      var m = SORU_BASLIK_RE.exec(metin(j));
      if (m && m[1] === id) { bas = j; break; }
    }
    if (bas < 0) return;
    var kaynakSira = -1;
    for (var j2 = bas + 1; j2 < body.getNumChildren(); j2++) {
      var t2 = metin(j2);
      if (SORU_BASLIK_RE.test(t2) || /^Ortak şekil /.test(t2)) break;
      if (/^Kullanım:/.test(t2)) {
        body.getChild(j2).asParagraph().setText(kullanimYaz[id]);
        var tx = body.getChild(j2).asParagraph().editAsText();
        tx.setFontSize(9);
        tx.setForegroundColor("#666666");
        tx.setItalic(true);
        tx.setBold(false);
        return;
      }
      if (/^Kaynak\s*:/.test(t2)) kaynakSira = j2;
    }
    if (kaynakSira >= 0) ogeleriYaz_(body, [{ s: "kullanim", t: kullanimYaz[id] }], null, kaynakSira + 1);
  });
  // Karantina satırları, sorunlu başlıkların hemen altına (sondan başa, sıralar kaymasın diye).
  var hedefler = [];
  kr.forEach(function (x) {
    if (!x.baslik) return;
    for (var j = 0; j < body.getNumChildren(); j++) {
      if (satirMetni_(metin(j)) === x.baslik) hedefler.push({ i: j, t: KARANTINA_ONEK + x.sorun + " (" + tarihGosterimSaat_(x.ilk) + ")" });
    }
  });
  hedefler.sort(function (a, c) { return c.i - a.i; }).forEach(function (h) {
    ogeleriYaz_(body, [{ s: "karantina", t: h.t }], null, h.i + 1);
  });
  // Belge başındaki durum satırları: başlık ve alt başlıktan sonra.
  var konum = Math.min(2, body.getNumChildren());
  var ogeler = [{ s: kirmizi ? "kontrol_kirmizi" : "kontrol", t: kontrolMetni }];
  if (islemMetni) ogeler.push({ s: "islem", t: islemMetni });
  ogeleriYaz_(body, ogeler, null, konum);
  // Alt başlıktaki soru sayısı
  var alt = metin(1);
  if (/ · \d+ soru$/.test(alt)) {
    var yeniAlt = alt.replace(/ · \d+ soru$/, " · " + cz.sorular.length + " soru");
    if (yeniAlt !== alt) body.getChild(1).asParagraph().setText(yeniAlt);
  }
  doc.saveAndClose();
}

/**
 * Uyarı e-postalarının gideceği adres: ana tablonun sahibi. Drive izniyle okunur
 * (Session.getEffectiveUser ayrı bir izin ister; o izin verilmemiş olabilir).
 */
function sahipEposta_() {
  try {
    var sahip = DriveApp.getFileById(SpreadsheetApp.getActive().getId()).getOwner();
    return sahip ? String(sahip.getEmail() || "") : "";
  } catch (e) {
    return "";
  }
}

/**
 * E-postayı gönderir; gönderilemezse (ör. e-posta izni verilmemiş) hata fırlatmaz, nedenini döndürür.
 * Böylece bir e-posta sorunu otomatik kontrolün kendisini durdurmaz.
 */
function epostaGonder_(m) {
  if (!m.to) return "Alıcı adresi bulunamadı.";
  try {
    MailApp.sendEmail(m);
    return "";
  } catch (e) {
    return String(e && e.message ? e.message : e).split("\n")[0];
  }
}

function karantinaEpostasi_(liste) {
  var kime = sahipEposta_();
  var satirlar = liste.map(function (x) {
    return "- " + (x.id ? x.id + (x.surum ? " (Sürüm " + x.surum + ")" : "") : "Başlığı okunamayan soru") + ", " + (x.belgeAdi || "") + "\n  " + x.sorun + (x.belge ? "\n  https://docs.google.com/document/d/" + x.belge + "/edit" : "");
  });
  return epostaGonder_({
    to: kime,
    subject: "Soru Havuzu: " + liste.length + " soru karantinaya alındı",
    body: "Aşağıdaki sorular eksiksiz okunamadığı ya da onaylıyken değiştiği için karantinaya alındı. Düzeltilene kadar yeni sınava, forma ve kitapçığa giremezler.\n\n" + satirlar.join("\n\n") + "\n\nSorun giderildiğinde bir sonraki kontrolde karantinadan kendiliğinden çıkarlar.",
  });
}

/** Zamanlı tetikleyicinin çağırdığı işlev. */
function havuzZamanliKontrol() {
  if (String(ayar_("havuz_kaynagi") || "").toUpperCase() !== "BELGE") return;
  havuzKontrol_({});
}

/** Menü: 30 dakikada bir otomatik kontrolü kurar (bir kez). */
function havuzOtomatikKontrolKur() {
  var var_ = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === "havuzZamanliKontrol"; });
  if (!var_) ScriptApp.newTrigger("havuzZamanliKontrol").timeBased().everyMinutes(HAVUZ_KONTROL_DK).create();
  return var_ ? "Otomatik kontrol zaten kurulu." : "Otomatik kontrol kuruldu: " + HAVUZ_KONTROL_DK + " dakikada bir.";
}

/** Panel ve menü: şimdi kontrol et. */
function havuzKontrolEt(hepsi) {
  return havuzKontrol_({ hepsi: !!hepsi });
}

/** İşlemlerden hemen önce: değişen belgeleri kontrol et (belge kaynağı açıksa). */
function havuzOnKontrol_() {
  if (!havuzBelgeKaynagi_()) return null;
  return havuzKontrol_({});
}

function havuzBelgeKaynagi_() {
  return String(ayar_("havuz_kaynagi") || "").toUpperCase() === "BELGE";
}

function karantinadaMi_(d, id, surum) {
  return !!(d.karantina[id + "@" + surum]);
}

/** Karantinadaki soru kodları: { "ELK-0036": "sorun" } (sürümden bağımsız). */
function karantinaKimlikleri_() {
  if (!havuzBelgeKaynagi_()) return {};
  var d = havuzDurumOku_();
  var m = {};
  Object.keys(d.karantina).forEach(function (k) {
    var x = d.karantina[k];
    if (x.id) m[x.id] = x.sorun;
  });
  return m;
}

/** Verilen soruların hiçbiri karantinada değilse sessiz döner; değilse açıklayıcı hata verir. */
function karantinaEngeli_(idler) {
  var kr = karantinaKimlikleri_();
  var engel = idler.filter(function (id) { return kr[id]; });
  if (engel.length) throw new Error("Karantinadaki soru var, işlem yapılmadı: " + engel.map(function (id) { return id + " (" + kr[id] + ")"; }).join("; "));
}

// ----- Onaylı soru değiştiğinde karar --------------------------------------

/**
 * Panel: onaylı bir sorunun değişmesi üzerine karar.
 * karar: "yeni_surum" (eski hal Eski sürümler belgesine taşınır, değişen hal yeni sürüm olarak onaylanır),
 *        "duzeltme" (anlamı değişmedi; sürüm aynı kalır), "geri_al" (belgedeki blok son onaylı haliyle yeniden yazılır).
 */
function havuzKarari(id, surum, karar) {
  var kilit = LockService.getScriptLock();
  kilit.waitLock(60000);
  try {
    var d = havuzDurumOku_();
    var key = id + "@" + Number(surum);
    var kr = d.karantina[key];
    var onceki = d.sorular[key];
    if (!kr || !onceki) throw new Error("Bu soru için bekleyen bir karar yok.");
    if (karar !== "geri_al" && !kr.karar) throw new Error("Bu soru için yalnızca geri alma yapılabilir.");
    var b = d.belgeler[kr.belge];
    if (!b) throw new Error("Sorunun belgesi bulunamadı.");
    var s = null;
    b.cozum.sorular.forEach(function (x) {
      if (x.kayit.soru_id === id && Number(x.kayit.surum) === Number(surum)) s = x;
    });
    if (karar === "duzeltme") {
      var o = { duzeltme: {} };
      o.duzeltme[key] = true;
      return havuzKontrolIc_(o);
    }
    if (karar === "geri_al") {
      if (!s) throw new Error("Soru belgede bulunamadı; geri alınamıyor.");
      soruBlogunuYenidenYaz_(kr.belge, s, onceki);
      sekilEsle_(d, kr.belge, onceki.kayit, false);
      return havuzKontrolIc_({});
    }
    if (karar === "yeni_surum") {
      if (!s || s.hatalar.length) throw new Error("Değişen hal eksiksiz okunamıyor; önce belgedeki sorunu giderin.");
      var yeni = Number(surum) + 1;
      Object.keys(d.sorular).forEach(function (k2) {
        if (k2.indexOf(id + "@") === 0) yeni = Math.max(yeni, Number(d.sorular[k2].kayit.surum) + 1);
      });
      var eskiId = eskiSurumeYaz_(b, onceki);
      sekilEsle_(d, eskiId, onceki.kayit, true);
      // Bölüm belgesindeki başlığı yeni sürüm ve onaylı olarak değiştir.
      var doc = DocumentApp.openById(kr.belge);
      var body = doc.getBody();
      for (var i = 0; i < body.getNumChildren(); i++) {
        var c = body.getChild(i);
        if (c.getType() !== DocumentApp.ElementType.PARAGRAPH) continue;
        var m = SORU_BASLIK_RE.exec(c.asParagraph().getText());
        if (m && m[1] === id) {
          c.asParagraph().setText(soruBasligi_({ soru_id: id, surum: yeni, durum: "ONAYLI" }));
          c.asParagraph().setHeading(DocumentApp.ParagraphHeading.HEADING2);
          break;
        }
      }
      doc.saveAndClose();
      onceki.kayit.durum = "ESKI";
      var eskiKey = key;
      var o2 = { yeniSurum: {}, eskiye: {}, ekGunluk: [{ belge: { ad: ESKI_BELGE_ADI, id: "" }, id: id, surum: Number(surum), islem: "Eski sürüme alındı", aciklama: "Yerine Sürüm " + yeni + " açıldı" }] };
      o2.yeniSurum[id] = yeni;
      o2.eskiye[eskiKey] = true;
      // Eski kayıt artık Eski sürümler belgesinde; içerik izi aynı kalır.
      d.sorular[eskiKey].kayit.durum = "ESKI";
      return havuzKontrolIc_(o2);
    }
    throw new Error("Bilinmeyen karar.");
  } finally {
    kilit.releaseLock();
  }
}

/** Son onaylı hali konunun "00 - Eski sürümler" belgesinin sonuna "Eski" olarak ekler. */
function eskiSurumeYaz_(b, onceki) {
  var konuKlasoru = altKlasor_(havuzKokKlasoru_(), b.klasor);
  var it = konuKlasoru.getFilesByName(ESKI_BELGE_ADI);
  var doc;
  if (it.hasNext()) doc = DocumentApp.openById(it.next().getId());
  else {
    doc = DocumentApp.create(ESKI_BELGE_ADI);
    var bd = doc.getBody();
    bd.setMarginTop(50);
    bd.setMarginBottom(50);
    bd.setMarginLeft(60);
    bd.setMarginRight(60);
    ogeleriYaz_(bd, [{ s: "baslik", t: ESKI_BELGE_ADI }, { s: "alt", t: kodlar_().KONU[b.konu] + " (" + b.konu + ") · eski sürümler; bu belgeye yalnızca sistem yazar" }]);
    bosIlkParagrafiSil_(bd);
    doc.saveAndClose();
    DriveApp.getFileById(doc.getId()).moveTo(konuKlasoru);
    doc = DocumentApp.openById(doc.getId());
  }
  var q = JSON.parse(JSON.stringify(onceki.kayit));
  q.durum = "ESKI";
  var l = [];
  if (q.grup) l = l.concat(grupOgeleri_(q.grup, [q.soru_id], q.grup_notu, q.grup_gorsel));
  l = l.concat(soruOgeleri_(q, { notlar: q.notlar || [] }));
  ogeleriYaz_(doc.getBody(), l, havuzSekilKlasoru_());
  doc.saveAndClose();
  return doc.getId();
}

/**
 * Sistem bir soruyu şekilleriyle yeniden yazdığında, belgeden okunan şekil kimliklerini asıl kimliklerle eşler.
 * Yalnızca sistemin kendi yazdığı blok için çağrılır; kullanıcının değiştirdiği şekil eşlenmez.
 */
function sekilEsle_(d, belgeId, q, eski) {
  var cz = havuzBelgesiniCoz_(belgeOgeleriniOku_(belgeId), { konu: q.konu, bolum: "", belgeId: belgeId, belgeAdi: "", eski: eski });
  var s = null;
  cz.sorular.forEach(function (x) {
    if (x.kayit.soru_id === q.soru_id && Number(x.kayit.surum) === Number(q.surum)) s = x;
  });
  if (!s) return;
  d.sekilEs = d.sekilEs || {};
  var okunan = sekilAdlari_(s.kayit);
  sekilAdlari_(q).forEach(function (ad, i) {
    if (okunan[i] && okunan[i] !== ad) d.sekilEs[okunan[i]] = ad;
  });
  if (q.grup_gorsel && s.kayit.grup_gorsel && s.kayit.grup_gorsel !== q.grup_gorsel) d.sekilEs[s.kayit.grup_gorsel] = q.grup_gorsel;
}

/** Belgedeki bir soru bloğunu son onaylı haliyle yeniden yazar (geri al). */
function soruBlogunuYenidenYaz_(belgeId, s, onceki) {
  var doc = DocumentApp.openById(belgeId);
  var body = doc.getBody();
  for (var i = s.son; i >= s.bas; i--) {
    if (i === body.getNumChildren() - 1) body.appendParagraph("");
    body.getChild(i).removeFromParent();
  }
  var q = onceki.kayit;
  ogeleriYaz_(body, soruOgeleri_(q, { notlar: q.notlar || [] }), havuzSekilKlasoru_(), s.bas);
  doc.saveAndClose();
}

// ----- Belgelerden okunan havuz --------------------------------------------

/** Durum dosyasındaki son eksiksiz okunan kayıtlar: { "PLC-0042@2": kayıt } (havuz_ ile aynı biçim). */
function belgeHavuzu_() {
  var d = havuzDurumOku_();
  var m = {};
  var kr = {};
  Object.keys(d.karantina).forEach(function (key) {
    var x = d.karantina[key];
    if (x.id) kr[x.id] = kr[x.id] || x.sorun;
  });
  Object.keys(d.sorular).forEach(function (key) {
    var x = d.sorular[key];
    var k = JSON.parse(JSON.stringify(x.kayit));
    k.surum = Number(k.surum) || 1;
    k._belge = x.belge;
    k._belgeAdi = x.belgeAdi;
    k.karantina = kr[k.soru_id] || "";
    m[key] = k;
  });
  return m;
}

/**
 * Geçiş doğrulaması: belgelerden okunan havuz ile E-Tablodaki Havuz sekmesini alan alan karşılaştırır.
 * Dönüş: { esit, fark: [ "ELK-0031@1 A: ..." ], sayi }
 */
function havuzBelgeKarsilastir_() {
  var t = {};
  tablo_("Havuz").kayitlar.forEach(function (r) {
    var k = r.kayit;
    if (String(k.soru_id).trim()) t[String(k.soru_id).trim() + "@" + (Number(k.surum) || 1)] = k;
  });
  var b = belgeHavuzu_();
  var fark = [];
  var alanlar = ["durum", "konu", "bolum", "zorluk", "grup", "grup_notu", "soru", "tur", "A", "B", "C", "D", "E", "dogru", "tolerans", "birim", "gerekce"];
  Object.keys(t).forEach(function (key) {
    var x = t[key];
    var y = b[key];
    if (!y) return fark.push(key + ": belgelerde yok");
    alanlar.forEach(function (a) {
      var v1 = satirMetni_(String(x[a] === undefined || x[a] === null ? "" : x[a]));
      var v2 = satirMetni_(String(y[a] === undefined || y[a] === null ? "" : y[a]));
      if (a === "durum") v1 = v1.toUpperCase();
      if (a === "grup_notu" && !String(x.grup || "").trim()) v1 = "";
      if (v1 !== v2) fark.push(key + " " + a + ": tablo \"" + kisa_(v1) + "\" / belge \"" + kisa_(v2) + "\"");
    });
    if (kaynakGosterim_(x.kaynak) !== String(y.kaynak)) fark.push(key + " kaynak: tablo \"" + kisa_(kaynakGosterim_(x.kaynak)) + "\" / belge \"" + kisa_(y.kaynak) + "\"");
    if (sekilAdlari_(x).length !== sekilAdlari_(y).length) fark.push(key + " şekil sayısı: tablo " + sekilAdlari_(x).length + " / belge " + sekilAdlari_(y).length);
    if (!!String(x.grup_gorsel || "").trim() !== !!String(y.grup_gorsel || "").trim()) fark.push(key + " ortak şekil: tablo " + (x.grup_gorsel ? "var" : "yok") + " / belge " + (y.grup_gorsel ? "var" : "yok"));
  });
  Object.keys(b).forEach(function (key) {
    if (!t[key]) fark.push(key + ": tabloda yok");
  });
  return { esit: !fark.length, fark: fark, tablo: Object.keys(t).length, belge: Object.keys(b).length, karantina: Object.keys(havuzDurumOku_().karantina).length };
}

/** Panel: karantina listesi, son işlemler ve son kontrol zamanı. */
function havuzDurumu() {
  if (!havuzBelgeKaynagi_()) return { acik: false };
  var d = havuzDurumOku_();
  var kr = Object.keys(d.karantina).sort().map(function (k) {
    var x = d.karantina[k];
    return { id: x.id, surum: x.surum, belge: x.belge, belgeAdi: x.belgeAdi, sorun: x.sorun, ilk: tarihGosterimSaat_(x.ilk), karar: !!x.karar };
  });
  var g = tablo_("Havuz_Gunlugu").kayitlar.slice(-300).reverse().map(function (r) {
    var k = r.kayit;
    return { tarih: tarihGosterimSaat_(new Date(k.tarih).getTime()), belge: String(k.belge), soru_id: String(k.soru_id), surum: String(k.surum), islem: String(k.islem), aciklama: String(k.aciklama) };
  });
  return { acik: true, sonKontrol: tarihGosterimSaat_(d.sonKontrol), karantina: kr, gunluk: g, belgeler: Object.keys(d.belgeler).map(function (k) { return { id: k, ad: d.belgeler[k].ad, klasor: d.belgeler[k].klasor }; }) };
}

function sekilKlasorId_() {
  var d = havuzDurumOku_();
  if (!d.sekilKlasoru) d.sekilKlasoru = havuzSekilKlasoru_().getId();
  return d.sekilKlasoru;
}

/** Belge kaynağında: başlıktaki durum kelimesini değiştirir (ör. Taslak -> Onaylı) ve kontrol eder. */
function belgedeDurumDegistir_(id, surum, durum) {
  var d = havuzDurumOku_();
  var x = d.sorular[id + "@" + Number(surum)];
  if (!x) throw new Error("Soru bulunamadı.");
  if (d.karantina[id + "@" + Number(surum)]) throw new Error("Soru karantinada; önce belgedeki sorunu giderin.");
  var doc = DocumentApp.openById(x.belge);
  var body = doc.getBody();
  var bulundu = false;
  for (var i = 0; i < body.getNumChildren() && !bulundu; i++) {
    var c = body.getChild(i);
    if (c.getType() !== DocumentApp.ElementType.PARAGRAPH) continue;
    var m = SORU_BASLIK_RE.exec(c.asParagraph().getText());
    if (m && m[1] === id) {
      c.asParagraph().setText(soruBasligi_({ soru_id: id, surum: Number(surum), durum: durum }));
      c.asParagraph().setHeading(DocumentApp.ParagraphHeading.HEADING2);
      bulundu = true;
    }
  }
  doc.saveAndClose();
  if (!bulundu) throw new Error("Soru belgede bulunamadı.");
  havuzKontrol_({});
  return true;
}

function havuzMenuKontrol() {
  var r = havuzKontrol_({});
  // Bildirim kutusu yerine köşe bildirimi: kullanıcı kapatmasa da işlem bekletmeden biter.
  SpreadsheetApp.getActive().toast(r.belge + " belge, " + r.soru + " soru. Karantinada: " + r.karantina + ". Yeni işlem kaydı: " + r.islem + ".", "Soru havuzu kontrolü", 15);
}

function havuzMenuOtomatik() {
  SpreadsheetApp.getUi().alert(havuzOtomatikKontrolKur());
}

/**
 * Geçiş 1: belgeleri ilk kez okur (tüm sorular kabul edilir, e-posta gönderilmez) ve E-Tablodaki
 * Havuz sekmesiyle karşılaştırır. Kaynak değişmez.
 */
function havuzGecisDogrula_() {
  var r = havuzKontrol_({ hepsi: true, ilk: true, eposta: false });
  var k = havuzBelgeKarsilastir_();
  return { kontrol: r, karsilastirma: k };
}

/** Geçiş 2: karşılaştırma birebir ve karantina boşsa soruların kaynağını belgelere çevirir. */
function havuzKaynaginiBelgeYap_() {
  var k = havuzBelgeKarsilastir_();
  if (!k.esit || k.karantina) throw new Error("Geçiş yapılmadı: " + (k.karantina ? k.karantina + " karantina kaydı var. " : "") + k.fark.slice(0, 5).join("; "));
  ayarYaz_("havuz_kaynagi", "BELGE");
  return "Soruların kaynağı artık Soru Havuzu belgeleri.";
}

// ----- Kullanım kılavuzu ile sistem sürümünün uyumu ------------------------

var KILAVUZ_ADI = "Sınav Sistemi - Kullanım Kılavuzu";
var KILAVUZ_SURUM_RE = /^Sistem sürümü: ([0-9a-f]{12})\b/;

function kilavuzBelgesi_() {
  var kok = DriveApp.getFileById(SpreadsheetApp.getActive().getId()).getParents().next();
  var it = kok.getFilesByName(KILAVUZ_ADI);
  return it.hasNext() ? it.next() : null;
}

/** Kılavuzun başındaki "Sistem sürümü: ..." satırı ile koddaki SISTEM_SURUMU karşılaştırması. */
function kilavuzDurumu_() {
  var f = kilavuzBelgesi_();
  if (!f) return { sistem: SISTEM_SURUMU, kilavuz: "", uyumlu: false, bulunamadi: true, belge: "" };
  var b = DocumentApp.openById(f.getId()).getBody();
  var surum = "";
  for (var i = 0; i < Math.min(8, b.getNumChildren()); i++) {
    var c = b.getChild(i);
    var m = c.getType() === DocumentApp.ElementType.PARAGRAPH ? KILAVUZ_SURUM_RE.exec(c.asParagraph().getText()) : null;
    if (m) { surum = m[1]; break; }
  }
  return { sistem: SISTEM_SURUMU, kilavuz: surum, uyumlu: !!SISTEM_SURUMU && surum === SISTEM_SURUMU, bulunamadi: false, belge: f.getId() };
}

/** Otomatik kontrolün parçası: uyumsuzlukta bir kez e-posta ve işlem kaydı; uyum sağlanınca kayıt. */
function kilavuzKontrol_(d, log, o) {
  var k;
  try { k = kilavuzDurumu_(); } catch (e) { return; }
  d.kilavuz = k;
  if (k.uyumlu) {
    if (d.kilavuzUyari) log({ ad: KILAVUZ_ADI, id: "" }, "", "", "Kılavuz güncel", "Sistem sürümü " + k.sistem);
    d.kilavuzUyari = "";
    return;
  }
  var anahtar = (k.bulunamadi ? "yok:" : "") + k.sistem + "/" + k.kilavuz;
  if (d.kilavuzUyari === anahtar) return;
  if (o.eposta === false) return; // ilk kurulum gibi sessiz çalışmalarda uyarı bir sonraki kontrole kalır
  d.kilavuzUyari = anahtar;
  var ne = k.bulunamadi ? "Kullanım kılavuzu bulunamadı (Sınav Sistemi klasöründe \"" + KILAVUZ_ADI + "\" belgesi olmalı)." : "Sistem sürümü " + k.sistem + ", kılavuz " + (k.kilavuz ? k.kilavuz + " sürümüne göre" : "sürüm satırı içermiyor") + ".";
  log({ ad: KILAVUZ_ADI, id: "" }, "", "", "Kılavuz güncellenmeli", ne);
  var hata = epostaGonder_({
    to: sahipEposta_(),
    subject: "Sınav sistemi: kullanım kılavuzu güncellenmeli",
    body: "Sistemde değişiklik yapıldı ve kullanım kılavuzu henüz bu değişikliğe göre gözden geçirilmedi.\n\n" + ne + "\n\n" +
      (k.belge ? "Kılavuz: https://docs.google.com/document/d/" + k.belge + "/edit\n\n" : "") +
      "Kılavuzu gözden geçirip gerekli güncellemeyi yaptıktan sonra yönetim panelinin üstündeki \"Kılavuzu gözden geçirdim, güncel\" düğmesine basın. Uyarı o zamana kadar panelde görünür.",
  });
  if (hata) log({ ad: KILAVUZ_ADI, id: "" }, "", "", "E-posta gönderilemedi", "Kılavuz uyarısı: " + hata);
}

/** Panel: kılavuzun bu sistem sürümüne göre gözden geçirildiğini kaydeder ve sürüm satırını günceller. */
function kilavuzOnayla() {
  var kilit = LockService.getScriptLock();
  kilit.waitLock(60000);
  try {
    if (!SISTEM_SURUMU) throw new Error("Sistem sürümü tanımlı değil.");
    var f = kilavuzBelgesi_();
    if (!f) throw new Error("Kullanım kılavuzu bulunamadı.");
    var doc = DocumentApp.openById(f.getId());
    var b = doc.getBody();
    var yazi = "Sistem sürümü: " + SISTEM_SURUMU + " (bu kılavuz bu sürüme göre günceldir)";
    var bulundu = false;
    for (var i = 0; i < Math.min(8, b.getNumChildren()) && !bulundu; i++) {
      var c = b.getChild(i);
      if (c.getType() === DocumentApp.ElementType.PARAGRAPH && /^Sistem sürümü: /.test(c.asParagraph().getText())) {
        c.asParagraph().setText(yazi);
        bulundu = true;
      }
    }
    if (!bulundu) ogeleriYaz_(b, [{ s: "kontrol", t: yazi }], null, Math.min(2, b.getNumChildren()));
    doc.saveAndClose();
    var d = havuzDurumOku_();
    gunlukYaz_([{ tarih: new Date(), belge: KILAVUZ_ADI, soru_id: "", surum: "", islem: "Kılavuz gözden geçirildi", aciklama: "Sistem sürümü " + SISTEM_SURUMU + " için güncel olarak işaretlendi (" + sahipEposta_() + ")" }]);
    d.kilavuzUyari = "";
    d.kilavuz = kilavuzDurumu_();
    havuzDurumYaz_(d);
    return d.kilavuz;
  } finally {
    kilit.releaseLock();
  }
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
  if (havuzBelgeKaynagi_()) return belgeHavuzu_();
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
  if (havuzBelgeKaynagi_()) return sekilKlasorId_();
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
    .addSeparator()
    .addItem("Soru havuzunu şimdi kontrol et", "havuzMenuKontrol")
    .addItem("Otomatik havuz kontrolünü kur (30 dk)", "havuzMenuOtomatik")
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
  Havuz_Izleri: ["soru_id", "surum", "durum", "kontrol", "sorun", "belge", "bolum", "icerik_izi", "son_okuma"],
  Havuz_Gunlugu: ["tarih", "belge", "soru_id", "surum", "islem", "aciklama"],
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

var AYAR_ONBELLEK_ = null;

function ayar_(anahtar) {
  if (!AYAR_ONBELLEK_) {
    AYAR_ONBELLEK_ = {};
    tablo_("Ayarlar").kayitlar.forEach(function (r) {
      var a = String(r.kayit.anahtar).trim();
      if (a && AYAR_ONBELLEK_[a] === undefined) AYAR_ONBELLEK_[a] = String(r.kayit.deger).trim();
    });
  }
  return AYAR_ONBELLEK_[anahtar] === undefined ? "" : AYAR_ONBELLEK_[anahtar];
}

function ayarYaz_(anahtar, deger) {
  var t = tablo_("Ayarlar");
  var satir = 0;
  t.kayitlar.forEach(function (r) {
    if (!satir && String(r.kayit.anahtar).trim() === anahtar) satir = r.satir;
  });
  if (satir) satirGuncelle_("Ayarlar", satir, { deger: deger });
  else satirEkle_("Ayarlar", { anahtar: anahtar, deger: deger });
  AYAR_ONBELLEK_ = null;
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
  var kilavuz = null;
  try { kilavuz = kilavuzDurumu_(); } catch (e) {}
  return { sinavlar: sinavlar, oturumlar: oturumlar, sinav_sayfasi: ayar_("sinav_sayfasi"), kodlar: kodlar_(), kilavuz: kilavuz };
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
        karantina: String(q.karantina || ""),
        belge: String(q._belge || ""),
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
  if (havuzBelgeKaynagi_()) return sekilKlasorId_();
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
  if (havuzBelgeKaynagi_()) return belgedeDurumDegistir_(id, surum, "ONAYLI");
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
  if (havuzBelgeKaynagi_()) throw new Error("Sorular Soru Havuzu belgelerinde düzenlenir. Onaylı soruyu belgede değiştirin; sistem değişikliği yakalayıp karar için panelde gösterir.");
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
    return q.onayli_surum !== null && !q.karantina && (!konu || q.konu.toUpperCase() === konu);
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
    havuzOnKontrol_();
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
    karantinaEngeli_(ids);
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
  havuzOnKontrol_();
  var h = havuz_();
  var sorular = sinavSorulari_(kod, h);
  if (!sorular.length) throw new Error("Sınavda soru yok.");
  karantinaEngeli_(sorular.map(function (q) { return q.id; }));
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
  havuzOnKontrol_();
  var sorular = sinavSorulari_(kod);
  karantinaEngeli_(sorular.map(function (q) { return q.id; }));
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
  havuzOnKontrol_();
  var sorular = sinavSorulari_(kod);
  karantinaEngeli_(sorular.map(function (q) { return q.id; }));
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
var PANEL_HTML = /*PANEL_HTML*/ "<!doctype html>\n<html lang=\"tr\">\n<head>\n<meta charset=\"utf-8\">\n<base target=\"_top\">\n<style>\n:root{--bg:#f3f5f7;--panel:#fff;--text:#16202a;--muted:#64717e;--line:#dde3e9;--soft:#f7f9fb;--accent:#1457d9;--accent-soft:#eef3fd;--good:#1f8a4c;--good-soft:#e9f6ee;--bad:#b42318;--bad-soft:#fdecea;--warn:#a86700;--warn-soft:#fdf3df;--font:system-ui,-apple-system,\"Segoe UI\",Roboto,Arial,sans-serif}\n*{box-sizing:border-box}\nbody{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 var(--font)}\n[hidden]{display:none!important}\n.tabs{display:flex;gap:4px;background:var(--panel);border-bottom:1px solid var(--line);padding:0 16px;position:sticky;top:0;z-index:5}\n.tabs button{background:none;border:0;border-bottom:2px solid transparent;padding:12px 12px 10px;font:600 14px var(--font);color:var(--muted);cursor:pointer}\n.tabs button[aria-selected=true]{color:var(--accent);border-bottom-color:var(--accent)}\n.tabs .spacer{flex:1}\n.tabs .refresh{color:var(--muted);font-weight:500}\nmain{padding:16px}\n.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;margin-bottom:14px}\n.ph{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 14px;border-bottom:1px solid var(--line)}\n.ph h2{margin:0;font-size:15px}\n.pb{padding:14px}\n.grid2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px;align-items:start}\n.fields{display:grid;grid-template-columns:1fr 1fr;gap:12px}\n.field{display:block}\n.field.wide{grid-column:1 / -1}\n.flabel{display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:4px}\ninput,select{width:100%;height:36px;padding:0 10px;border:1px solid #cdd5dd;border-radius:7px;font:14px var(--font);color:var(--text);background:#fff}\nbutton.btn{font:600 14px var(--font);border-radius:7px;cursor:pointer;height:36px;padding:0 14px;border:1px solid #cdd5dd;background:#fff;color:var(--text)}\nbutton.primary{background:var(--accent);border-color:var(--accent);color:#fff}\nbutton.small{height:28px;padding:0 10px;font-size:12px}\nbutton:disabled{opacity:.5;cursor:default}\n.hint{font-size:12px;color:var(--muted);margin:6px 0 0}\n.error{color:var(--bad);font-size:13px;margin:8px 0 0}\n.codebox{text-align:center}\n.code{font:700 44px/1.1 ui-monospace,Consolas,monospace;letter-spacing:6px;margin:6px 0}\n.qr{display:flex;justify-content:center;margin:10px 0}\n.qr img,.qr canvas{width:220px;height:220px}\n.linkrow{display:flex;gap:8px;margin-top:8px}\n.linkrow input{font-size:12px}\ntable{width:100%;border-collapse:collapse;font-size:13px}\nth,td{padding:7px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle}\nthead th{font-size:12px;color:var(--muted);background:var(--soft);font-weight:600;white-space:nowrap}\ntd.num,th.num{text-align:right;font-variant-numeric:tabular-nums}\n.badge{display:inline-block;font-size:11px;font-weight:700;border-radius:999px;padding:2px 8px}\n.b-karantina{background:var(--bad-soft);color:var(--bad)}\n.krbox{background:var(--bad-soft);border:1px solid #f3c1bb;border-radius:10px;padding:10px 14px;margin:0 14px 12px}\n.krbox h3{margin:0 0 6px;font-size:14px;color:var(--bad)}\n.kr{border-top:1px solid #f3c1bb;padding:8px 0;font-size:13px}\n.kr:first-of-type{border-top:0}\n.kr .ne{color:#5c1d16;margin:2px 0 6px}\n.kr .btns{display:flex;gap:6px;flex-wrap:wrap}\n.okbox{background:var(--good-soft);color:#14532d;border-radius:8px;padding:8px 12px;font-size:13px;margin:0 14px 12px}\ndetails.gunluk{margin:0 14px 12px}\ndetails.gunluk summary{cursor:pointer;font-weight:600;font-size:13px;padding:4px 0}\n.b-acik{background:var(--good-soft);color:var(--good)}\n.b-kapali{background:#eef1f4;color:#596672}\n.b-bitti{background:var(--warn-soft);color:var(--warn)}\n.kpis{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px;margin-bottom:14px}\n.kpi{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 12px}\n.kpi span{display:block;font-size:12px;color:var(--muted)}\n.kpi b{font-size:22px;font-variant-numeric:tabular-nums}\n.hist{display:grid;grid-template-columns:repeat(10,1fr);gap:6px;align-items:end;height:160px;padding-top:10px}\n.hist .col{display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:100%}\n.hist .bar{width:100%;background:var(--accent);border-radius:4px 4px 0 0;min-height:1px}\n.hist .v{font-size:11px;color:var(--muted);margin-bottom:2px}\n.hist .lbl{font-size:10px;color:var(--muted);margin-top:4px;white-space:nowrap}\n.hbar{display:grid;grid-template-columns:minmax(140px,240px) 1fr 52px;gap:10px;align-items:center;margin:6px 0;font-size:13px}\n.track{height:12px;background:#e7ebef;border-radius:99px;overflow:hidden}\n.track div{height:100%;border-radius:99px}\n.lo{background:var(--bad)}.mid{background:#e3a008}.hi{background:var(--good)}\n.mini{display:inline-block;width:70px;height:8px;background:#e7ebef;border-radius:99px;overflow:hidden;vertical-align:middle;margin-right:6px}\n.mini i{display:block;height:100%}\n.scroll{max-height:360px;overflow:auto}\n.empty{color:var(--muted);text-align:center;padding:24px}\n.overlay{position:fixed;inset:0;background:#fff;z-index:20;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;text-align:center}\n.overlay .code{font-size:clamp(32px,9vh,72px)}\n.overlay .qr{margin:4px 0}\n.overlay .qr img,.overlay .qr canvas{width:var(--qr,300px);height:var(--qr,300px)}\n.ovbtns{position:absolute;top:12px;right:12px;display:flex;gap:8px}\n.overlay p{margin:0;color:var(--muted);font-size:18px}\n.overlay h1{margin:0;font-size:20px}\n.close{position:absolute;top:12px;right:12px}\n.toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}\n.toolbar input,.toolbar select{width:auto;min-width:120px}\n.b-taslak{background:var(--warn-soft);color:var(--warn)}\n.b-onayli{background:var(--good-soft);color:var(--good)}\n.b-arsiv,.b-eski{background:#eef1f4;color:#596672}\n.seen{color:var(--bad);font-weight:600}\n.muted{color:var(--muted)}\n.stats{display:flex;flex-wrap:wrap;gap:14px;font-size:13px;margin:6px 0}\n.stats b{font-variant-numeric:tabular-nums}\ntr.sel td{background:var(--accent-soft)}\ntd.chk{width:28px}\n.warnbox{background:var(--warn-soft);color:#6b4a00;border-radius:8px;padding:8px 12px;font-size:13px;margin:8px 0}\n.okbox{background:var(--good-soft);color:var(--good);border-radius:8px;padding:8px 12px;font-size:13px;margin:8px 0}\n.pvlink{white-space:nowrap;background:none;border:0;padding:0;font:inherit;font-weight:700;color:var(--accent);cursor:pointer;text-decoration:underline;text-underline-offset:2px}\n.btn.small{white-space:nowrap}\n.sekil{display:inline-block;font-size:11px;font-weight:600;padding:1px 7px;border-radius:999px;background:var(--accent-soft);color:var(--accent);white-space:nowrap}\n.pv{position:fixed;inset:0;background:rgba(20,28,36,.45);z-index:30;display:flex;align-items:flex-start;justify-content:center;padding:24px;overflow:auto}\n.pv[hidden]{display:none}\n.pv .kart{background:#fff;border-radius:12px;max-width:860px;width:100%;padding:20px 24px;box-shadow:0 10px 40px rgba(0,0,0,.2)}\n.pv .ust{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:8px}\n.pv h3{margin:0;font-size:18px}\n.pv .meta{font-size:13px;color:var(--muted);margin-bottom:12px}\n.pv .gnot{background:#f5f7f9;border-radius:8px;padding:10px 12px;margin:10px 0;font-size:14px;white-space:pre-wrap}\n.pv .metin{font-size:15px;line-height:1.5;white-space:pre-wrap;margin:10px 0}\n.pv img{display:block;max-width:100%;max-height:440px;margin:10px auto;border:1px solid var(--line);border-radius:6px}\n.pv .eksik{color:var(--bad);font-size:13px;margin:8px 0}\n.pv ol{list-style:none;padding:0;margin:12px 0}\n.pv li{padding:8px 12px;border:1px solid var(--line);border-radius:8px;margin:6px 0;font-size:14px}\n.pv li.dogru{border-color:var(--good);background:var(--good-soft)}\n.pv li b{margin-right:8px}\n.pv .alt{font-size:13px;color:var(--muted);margin-top:10px}\n.loading{position:fixed;inset:0;background:rgba(243,245,247,.6);display:flex;align-items:center;justify-content:center;z-index:30;font-weight:600}\n</style>\n</head>\n<body>\n<nav class=\"tabs\" role=\"tablist\">\n  <button data-t=\"yeni\" aria-selected=\"true\">Yeni oturum</button>\n  <button data-t=\"liste\" aria-selected=\"false\">Oturumlar</button>\n  <button data-t=\"rapor\" aria-selected=\"false\">Rapor</button>\n  <button data-t=\"sinavlar\" aria-selected=\"false\">Sınavlar</button>\n  <button data-t=\"havuz\" aria-selected=\"false\">Soru havuzu</button>\n  <span class=\"spacer\"></span>\n  <button class=\"refresh\" id=\"refresh\">Yenile</button>\n</nav>\n<main>\n  <div class=\"warnbox\" id=\"kvUyari\" hidden style=\"display:flex;gap:12px;align-items:center;margin:0 0 14px\"><span id=\"kvMetin\" style=\"flex:1\"></span><button class=\"btn small\" id=\"kvOnay\">Kılavuzu gözden geçirdim, güncel</button></div>\n  <!-- Yeni oturum -->\n  <section id=\"t-yeni\">\n    <div class=\"grid2\">\n      <form class=\"panel\" id=\"form\">\n        <div class=\"ph\"><h2>Oturum bilgileri</h2></div>\n        <div class=\"pb\">\n          <div class=\"fields\">\n            <label class=\"field wide\"><span class=\"flabel\">Sınav</span><select id=\"fSinav\" required></select></label>\n            <label class=\"field\"><span class=\"flabel\">Firma</span><input id=\"fFirma\" maxlength=\"120\" placeholder=\"Katılımcıların firması\"></label>\n            <label class=\"field\"><span class=\"flabel\">Eğitim merkezi</span><input id=\"fMerkez\" maxlength=\"120\"></label>\n            <label class=\"field\"><span class=\"flabel\">Kişi sayısı</span><input id=\"fKisi\" type=\"number\" min=\"1\" max=\"1000\" required></label>\n            <label class=\"field\"><span class=\"flabel\">Form</span><select id=\"fForm\"></select></label>\n            <label class=\"field\"><span class=\"flabel\">Girişler açılsın</span><input id=\"fBas\" type=\"datetime-local\" required></label>\n            <label class=\"field\"><span class=\"flabel\">Girişler kapansın</span><input id=\"fBit\" type=\"datetime-local\" required></label>\n            <label class=\"field wide\"><span class=\"flabel\">Not (yalnızca sizin için)</span><input id=\"fNot\" maxlength=\"300\"></label>\n          </div>\n          <p class=\"hint\">Kapanış saati yalnızca yeni girişleri durdurur; o saate kadar başlayan katılımcı kendi süresi dolana kadar devam eder. Kişi sayısına ulaşılınca yeni giriş kabul edilmez.</p>\n          <p class=\"error\" id=\"formErr\" hidden></p>\n          <div style=\"margin-top:12px\"><button class=\"btn primary\" type=\"submit\" id=\"createBtn\">Oturum oluştur</button></div>\n        </div>\n      </form>\n      <div class=\"panel\" id=\"result\" hidden>\n        <div class=\"ph\"><h2>Giriş kodu</h2><button class=\"btn small\" id=\"fullBtn\">Tam ekran göster</button></div>\n        <div class=\"pb codebox\">\n          <div class=\"hint\" id=\"rSinav\"></div>\n          <div class=\"code\" id=\"rCode\"></div>\n          <div class=\"qr\" id=\"rQr\"></div>\n          <div class=\"linkrow\"><input id=\"rLink\" readonly><button class=\"btn\" id=\"copyBtn\">Kopyala</button></div>\n          <p class=\"hint\">Bağlantıyı katılımcılara gönderin ya da karekodu sınıfta gösterin. Herkes aynı kodla girer, ancak her katılımcının sınavı ve sonucu ayrıdır.</p>\n        </div>\n      </div>\n    </div>\n  </section>\n\n  <!-- Oturumlar -->\n  <section id=\"t-liste\" hidden>\n    <div class=\"panel\">\n      <div class=\"ph\"><h2>Oturumlar</h2></div>\n      <div class=\"pb\" style=\"padding:0\">\n        <div class=\"scroll\" style=\"max-height:640px\">\n          <table>\n            <thead><tr><th>Kod</th><th>Sınav</th><th>Firma</th><th>Eğitim merkezi</th><th>Giriş aralığı</th><th class=\"num\">Kişi</th><th class=\"num\">Devam</th><th class=\"num\">Bitti</th><th>Durum</th><th></th></tr></thead>\n            <tbody id=\"listBody\"></tbody>\n          </table>\n        </div>\n      </div>\n    </div>\n  </section>\n\n  <!-- Rapor -->\n  <section id=\"t-rapor\" hidden>\n    <div class=\"panel\"><div class=\"pb\" style=\"display:flex;gap:10px;align-items:center\">\n      <span class=\"flabel\" style=\"margin:0\">Oturum</span>\n      <select id=\"rpSel\" style=\"max-width:520px\"></select>\n      <button class=\"btn\" id=\"rpLoad\">Göster</button>\n      <span class=\"spacer\" style=\"flex:1\"></span>\n      <button class=\"btn primary\" id=\"rpFile\">Rapor dosyası oluştur</button>\n    </div>\n    <div class=\"pb\" id=\"rpFileBox\" hidden style=\"padding-top:0\">\n      <p class=\"hint\" id=\"rpFileMsg\" style=\"margin:0\"></p>\n    </div></div>\n    <div id=\"rpBody\"></div>\n  </section>\n  <!-- Sınavlar -->\n  <section id=\"t-sinavlar\" hidden>\n    <div id=\"snListe\">\n      <div class=\"panel\">\n        <div class=\"ph\"><h2>Sınavlar</h2><button class=\"btn primary small\" id=\"snYeni\">Yeni sınav hazırla</button></div>\n        <div class=\"scroll\" style=\"max-height:640px\"><table>\n          <thead><tr><th>Kod</th><th>Başlık</th><th>Durum</th><th class=\"num\">Soru</th><th>Formlar</th><th></th></tr></thead>\n          <tbody id=\"snBody\"></tbody>\n        </table></div>\n      </div>\n    </div>\n    <div id=\"snDetay\" hidden></div>\n    <div id=\"snHazir\" hidden>\n      <div class=\"panel\">\n        <div class=\"ph\"><h2>Yeni sınav hazırla</h2><button class=\"btn small\" id=\"hzGeri\">Sınavlara dön</button></div>\n        <div class=\"pb\">\n          <div class=\"toolbar\">\n            <select id=\"hzMerkez\"></select><select id=\"hzFirma\"></select><select id=\"hzKonu\"></select>\n            <button class=\"btn\" id=\"hzGetir\">Soruları getir</button>\n          </div>\n          <div class=\"toolbar\" style=\"margin-top:10px\">\n            <span class=\"muted\" style=\"font-size:12px\">Listede olmayan merkez, firma ya da konu için kod ekle:</span>\n            <select id=\"kdTur\" style=\"min-width:90px\"><option>FIRMA</option><option>MERKEZ</option><option>KONU</option></select>\n            <input id=\"kdKod\" placeholder=\"KOD\" maxlength=\"6\" style=\"min-width:70px;width:80px\"><input id=\"kdAd\" placeholder=\"Tam ad\" style=\"min-width:160px\">\n            <button class=\"btn small\" id=\"kdEkle\">Ekle</button>\n          </div>\n          <p class=\"error\" id=\"hzErr\" hidden></p>\n        </div>\n      </div>\n      <div id=\"hzGovde\" hidden>\n        <div class=\"panel\"><div class=\"pb\">\n          <div class=\"fields\">\n            <label class=\"field\"><span class=\"flabel\">Sınav kodu</span><input id=\"hzKod\" readonly></label>\n            <label class=\"field\"><span class=\"flabel\">Süre (dakika)</span><input id=\"hzSure\" type=\"number\" min=\"1\" max=\"600\"></label>\n            <label class=\"field\"><span class=\"flabel\">Başlık</span><input id=\"hzBaslik\" maxlength=\"200\"></label>\n            <label class=\"field\"><span class=\"flabel\">Alt başlık</span><input id=\"hzAlt\" maxlength=\"200\"></label>\n            <label class=\"field wide\"><span class=\"flabel\">Talimat, KVKK ve diğer ayarlar şuradan kopyalansın</span><select id=\"hzSablon\"></select></label>\n          </div>\n          <div class=\"toolbar\" style=\"margin-top:12px\">\n            <span class=\"flabel\" style=\"margin:0\">Öneri:</span>\n            <input id=\"hzN\" type=\"number\" min=\"1\" placeholder=\"Toplam soru\" style=\"width:120px;min-width:0\">\n            <button class=\"btn\" id=\"hzOner\">Öner</button>\n            <span class=\"muted\" style=\"font-size:12px\">Bölümlere orantılı dağıtır; bu firmanın görmediği ve az kullanılan soruları öne alır, ortak şekilli grupları bölmez.</span>\n          </div>\n          <div class=\"stats\" id=\"hzOzet\"></div>\n          <div id=\"hzUyari\"></div>\n          <button class=\"btn primary\" id=\"hzKaydet\">Taslak olarak kaydet</button>\n        </div></div>\n        <div class=\"panel\"><div class=\"scroll\" style=\"max-height:520px\"><table>\n          <thead><tr><th class=\"chk\"></th><th>Soru</th><th>Bölüm</th><th>Zorluk</th><th>Şekil</th><th class=\"num\">Ölçülen doğru</th><th class=\"num\">Kullanım</th><th>Bu firma gördü</th><th>Son kullanım</th><th>Metin</th></tr></thead>\n          <tbody id=\"hzBody\"></tbody>\n        </table></div></div>\n      </div>\n    </div>\n  </section>\n\n  <!-- Soru havuzu -->\n  <section id=\"t-havuz\" hidden>\n    <div class=\"panel\"><div class=\"pb toolbar\">\n      <select id=\"hvKonu\"></select>\n      <select id=\"hvDurum\"><option value=\"\">Tüm durumlar</option><option>ONAYLI</option><option>TASLAK</option><option>ESKI</option><option value=\"KULLANIM_DISI\">Kullanım dışı</option><option value=\"KARANTINA\">Karantinada</option></select>\n      <select id=\"hvFirma\"></select>\n      <select id=\"hvSekil\"><option value=\"\">Şekil: tümü</option><option value=\"var\">Şekilli sorular</option><option value=\"yok\">Yalnız metin</option></select>\n      <select id=\"hvKul\"><option value=\"\">Kullanım: tümü</option><option value=\"hic\">Hiç kullanılmamış</option><option value=\"6ay\">Son 6 ayda kullanılmamış</option></select>\n      <input id=\"hvAra\" placeholder=\"Ara: kod ya da metin\" style=\"min-width:200px\">\n      <span class=\"spacer\" style=\"flex:1\"></span>\n      <span class=\"muted\" id=\"hvSay\" style=\"font-size:12px\"></span>\n    </div>\n    <p class=\"hint\" style=\"margin:0 14px 10px\" id=\"hvIpucu\">Yeni soru ve taslak metinleri E-Tablodaki Havuz sekmesine eklenir; burada onaylanır. Onaylı bir soruyu değiştirmek için \"Yeni sürüm\" ile düzenlenebilir bir kopya açılır, eski sürüm korunur.</p>\n    <div id=\"hvKontrol\" hidden>\n      <div class=\"pb toolbar\" style=\"padding-top:0\">\n        <span class=\"muted\" id=\"hvSonKontrol\" style=\"font-size:12px\"></span>\n        <span class=\"spacer\" style=\"flex:1\"></span>\n        <button class=\"btn small\" id=\"hvKontrolEt\">Şimdi kontrol et</button>\n      </div>\n      <div id=\"hvKarantina\"></div>\n      <details class=\"gunluk\"><summary>İşlem kaydı</summary>\n        <div class=\"toolbar\" style=\"margin:6px 0\"><input id=\"hvGunlukAra\" placeholder=\"Süz: soru kodu, belge ya da işlem\" style=\"min-width:260px\"></div>\n        <div class=\"scroll\" style=\"max-height:300px\"><table><thead><tr><th>Tarih</th><th>Belge</th><th>Soru</th><th>Sürüm</th><th>İşlem</th><th>Açıklama</th></tr></thead><tbody id=\"hvGunluk\"></tbody></table></div>\n      </details>\n    </div>\n    </div>\n    <div class=\"panel\"><div class=\"scroll\" style=\"max-height:600px\"><table>\n      <thead><tr><th>Soru</th><th>Sürüm</th><th>Durum</th><th>Bölüm</th><th>Zorluk</th><th>Şekil</th><th>Metin</th><th class=\"num\">Sınav</th><th class=\"num\">Oturum</th><th class=\"num\">Kişi</th><th>Firmalar</th><th>Son kullanım</th><th class=\"num\">Ölçülen doğru</th><th></th></tr></thead>\n      <tbody id=\"hvBody\"></tbody>\n    </table></div></div>\n  </section>\n</main>\n\n<div class=\"pv\" id=\"pv\" hidden><div class=\"kart\" id=\"pvKart\"></div></div>\n<div class=\"overlay\" id=\"overlay\" hidden>\n  <div class=\"ovbtns\"><button class=\"btn\" id=\"ovTab\">Projeksiyon için yeni sekmede aç</button><button class=\"btn\" id=\"ovClose\">Kapat</button></div>\n  <h1 id=\"ovTitle\"></h1>\n  <div class=\"qr\" id=\"ovQr\"></div>\n  <p>Karekodu okutun ya da adrese gidip kodu girin</p>\n  <div class=\"code\" id=\"ovCode\"></div>\n  <p id=\"ovLink\"></p>\n</div>\n<div class=\"loading\" id=\"loading\" hidden>Yükleniyor…</div>\n\n<script src=\"https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js\"></script>\n<script>\n(function () {\n  \"use strict\";\n  var $ = function (id) { return document.getElementById(id); };\n  var veri = null;\n  var sonKod = \"\";\n\n  function sunucu(fn, args) {\n    return new Promise(function (ok, hata) {\n      var r = google.script.run.withSuccessHandler(ok).withFailureHandler(function (e) { hata(e && e.message ? e.message : String(e)); });\n      r[fn].apply(r, args || []);\n    });\n  }\n  function yukleniyor(v) { $(\"loading\").hidden = !v; }\n  function esc(s) { return String(s == null ? \"\" : s).replace(/[&<>\"']/g, function (c) { return { \"&\": \"&amp;\", \"<\": \"&lt;\", \">\": \"&gt;\", '\"': \"&quot;\", \"'\": \"&#39;\" }[c]; }); }\n  function tarih(iso) {\n    if (!iso) return \"\";\n    var d = new Date(iso);\n    return d.toLocaleString(\"tr-TR\", { day: \"2-digit\", month: \"2-digit\", year: \"numeric\", hour: \"2-digit\", minute: \"2-digit\" });\n  }\n  function saat(iso) { return iso ? new Date(iso).toLocaleTimeString(\"tr-TR\", { hour: \"2-digit\", minute: \"2-digit\" }) : \"\"; }\n  function yerelGiris(d) {\n    var p = function (n) { return String(n).padStart(2, \"0\"); };\n    return d.getFullYear() + \"-\" + p(d.getMonth() + 1) + \"-\" + p(d.getDate()) + \"T\" + p(d.getHours()) + \":\" + p(d.getMinutes());\n  }\n  function baglanti(kod) { return (veri.sinav_sayfasi || \"\").replace(/\\/?$/, \"/\") + \"?o=\" + kod; }\n  function sinavAdi(kod) {\n    var s = (veri.sinavlar || []).filter(function (x) { return x.kod === kod; })[0];\n    return s ? s.baslik : kod;\n  }\n  function yuzdeSinif(v) { return v == null ? \"\" : v < 50 ? \"lo\" : v < 70 ? \"mid\" : \"hi\"; }\n  function yuzde(v) { return v == null ? \"-\" : \"%\" + String(v).replace(\".\", \",\"); }\n  function sayi(v) { return v == null ? \"-\" : String(v).replace(\".\", \",\"); }\n\n  function qrCiz(el, metin, boyut) {\n    el.textContent = \"\";\n    if (typeof QRCode === \"undefined\") {\n      el.innerHTML = '<p class=\"hint\">Karekod oluşturulamadı (internet bağlantısı gerekli). Bağlantıyı kullanabilirsiniz.</p>';\n      return;\n    }\n    new QRCode(el, { text: metin, width: boyut, height: boyut, correctLevel: QRCode.CorrectLevel.M });\n  }\n\n  // ---------- Sekmeler ----------\n  function sekme(t) {\n    document.querySelectorAll(\".tabs [data-t]\").forEach(function (b) { b.setAttribute(\"aria-selected\", String(b.dataset.t === t)); });\n    [\"yeni\", \"liste\", \"rapor\", \"sinavlar\", \"havuz\"].forEach(function (x) { $(\"t-\" + x).hidden = x !== t; });\n  }\n  document.querySelectorAll(\".tabs [data-t]\").forEach(function (b) { b.addEventListener(\"click\", function () { sekme(b.dataset.t); }); });\n\n  // ---------- Veri ----------\n  function yukle() {\n    yukleniyor(true);\n    return sunucu(\"panelVeri\").then(function (v) {\n      veri = v;\n      kilavuzCiz(v.kilavuz);\n      formDoldur();\n      listeCiz();\n      sinavlarCiz();\n      raporSecenekleri();\n      yukleniyor(false);\n    }).catch(function (e) { yukleniyor(false); alertHata(e); });\n  }\n  function kilavuzCiz(k) {\n    $(\"kvUyari\").hidden = !k || k.uyumlu;\n    if (!k || k.uyumlu) return;\n    $(\"kvMetin\").innerHTML = k.bulunamadi\n      ? \"<b>Kullanım kılavuzu bulunamadı.</b> Sınav Sistemi klasöründe \\\"Sınav Sistemi - Kullanım Kılavuzu\\\" belgesi olmalı.\"\n      : \"<b>Sistem değişti, kullanım kılavuzu güncellenmeli.</b> Sistem sürümü \" + esc(k.sistem) + \", kılavuz \" + (k.kilavuz ? esc(k.kilavuz) + \" sürümüne göre\" : \"sürüm satırı içermiyor\") + '. <a href=\"https://docs.google.com/document/d/' + encodeURIComponent(k.belge) + '/edit\" target=\"_blank\">Kılavuzu aç</a>';\n    $(\"kvOnay\").hidden = !!k.bulunamadi;\n  }\n  $(\"kvOnay\").addEventListener(\"click\", function () {\n    if (!confirm(\"Kılavuzu bu sistem sürümüne göre gözden geçirdiğinizi ve güncel olduğunu onaylıyor musunuz? Bu işlem tarihiyle işlem kaydına yazılır.\")) return;\n    var b = this;\n    b.disabled = true;\n    sunucu(\"kilavuzOnayla\").then(function (k) { b.disabled = false; kilavuzCiz(k); }).catch(function (e) { b.disabled = false; alert(\"Hata: \" + e); });\n  });\n  function alertHata(e) { $(\"formErr\").textContent = \"Hata: \" + e; $(\"formErr\").hidden = false; }\n\n  function formDoldur() {\n    var sel = $(\"fSinav\");\n    var secili = sel.value;\n    sel.innerHTML = veri.sinavlar.filter(function (s) { return s.durum === \"ONAYLI\"; }).map(function (s) {\n      return '<option value=\"' + esc(s.kod) + '\">' + esc(s.kod) + \" · \" + esc(s.baslik) + \" (\" + s.soru_sayisi + \" soru, \" + s.sure_dk + \" dk)</option>\";\n    }).join(\"\");\n    if (secili) sel.value = secili;\n    formSecenekleri();\n    if (!$(\"fMerkez\").value && veri.oturumlar.length) $(\"fMerkez\").value = veri.oturumlar[0].egitim_merkezi;\n    if (!$(\"fBas\").value) {\n      var simdi = new Date();\n      simdi.setSeconds(0, 0);\n      $(\"fBas\").value = yerelGiris(simdi);\n      $(\"fBit\").value = yerelGiris(new Date(simdi.getTime() + 2 * 3600 * 1000));\n    }\n  }\n\n  function formSecenekleri() {\n    var s = (veri.sinavlar || []).filter(function (x) { return x.kod === $(\"fSinav\").value; })[0];\n    var fs = s ? s.formlar : [];\n    var secili = $(\"fForm\").value;\n    $(\"fForm\").innerHTML = fs.map(function (f) { return '<option value=\"' + esc(f) + '\">Form ' + esc(f) + \"</option>\"; }).join(\"\");\n    if (fs.indexOf(secili) >= 0) $(\"fForm\").value = secili; else if (fs.length) $(\"fForm\").value = fs[fs.length - 1];\n  }\n  $(\"fSinav\").addEventListener(\"change\", formSecenekleri);\n\n  // ---------- Yeni oturum ----------\n  $(\"form\").addEventListener(\"submit\", function (e) {\n    e.preventDefault();\n    $(\"formErr\").hidden = true;\n    var g = {\n      sinav: $(\"fSinav\").value,\n      firma: $(\"fFirma\").value.trim(),\n      egitim_merkezi: $(\"fMerkez\").value.trim(),\n      kontenjan: $(\"fKisi\").value,\n      form: $(\"fForm\").value,\n      baslangic: new Date($(\"fBas\").value).toISOString(),\n      bitis: new Date($(\"fBit\").value).toISOString(),\n      not: $(\"fNot\").value.trim(),\n    };\n    if (!g.kontenjan) { alertHata(\"Kişi sayısını girin.\"); return; }\n    $(\"createBtn\").disabled = true;\n    sunucu(\"oturumOlustur\", [g]).then(function (kod) {\n      $(\"createBtn\").disabled = false;\n      sonucGoster(kod, g.sinav);\n      return yukle();\n    }).catch(function (err) { $(\"createBtn\").disabled = false; alertHata(err); });\n  });\n\n  function sonucGoster(kod, sinav) {\n    sonKod = kod;\n    $(\"result\").hidden = false;\n    $(\"rCode\").textContent = kod;\n    $(\"rSinav\").textContent = sinavAdi(sinav);\n    $(\"rLink\").value = baglanti(kod);\n    qrCiz($(\"rQr\"), baglanti(kod), 220);\n  }\n  $(\"copyBtn\").addEventListener(\"click\", function () {\n    var i = $(\"rLink\");\n    i.select();\n    var ok = false;\n    try { ok = document.execCommand(\"copy\"); } catch (e) { ok = false; }\n    $(\"copyBtn\").textContent = ok ? \"Kopyalandı\" : \"Seçildi, Ctrl+C\";\n    setTimeout(function () { $(\"copyBtn\").textContent = \"Kopyala\"; }, 2000);\n  });\n  function tamEkran(kod, sinav) {\n    $(\"ovTitle\").textContent = sinavAdi(sinav);\n    $(\"ovCode\").textContent = kod;\n    $(\"ovLink\").textContent = (veri.sinav_sayfasi || \"\").replace(/^https?:\\/\\//, \"\");\n    var boyut = Math.max(160, Math.min(window.innerWidth - 80, window.innerHeight - 270, 420));\n    $(\"overlay\").style.setProperty(\"--qr\", boyut + \"px\");\n    qrCiz($(\"ovQr\"), baglanti(kod), boyut);\n    ovKod = kod;\n    $(\"overlay\").hidden = false;\n  }\n  $(\"fullBtn\").addEventListener(\"click\", function () { tamEkran(sonKod, $(\"fSinav\").value); });\n  $(\"ovClose\").addEventListener(\"click\", function () { $(\"overlay\").hidden = true; });\n  var ovKod = \"\";\n  // Projeksiyon görünümü: sınav sayfasında yalnızca karekodu ve kodu gösteren, tam ekran yapılabilen sekme.\n  $(\"ovTab\").addEventListener(\"click\", function () {\n    window.open((veri.sinav_sayfasi || \"\").replace(/\\/?$/, \"/\") + \"?qr=\" + ovKod, \"_blank\");\n  });\n\n  // ---------- Oturumlar ----------\n  function durumRozet(o) {\n    if (o.durum !== \"ACIK\") return '<span class=\"badge b-kapali\">Kapalı</span>';\n    if (o.bitis && new Date(o.bitis) < new Date()) return '<span class=\"badge b-bitti\">Süresi bitti</span>';\n    if (o.baslangic && new Date(o.baslangic) > new Date()) return '<span class=\"badge b-bitti\">Başlamadı</span>';\n    return '<span class=\"badge b-acik\">Açık</span>';\n  }\n  function listeCiz() {\n    var tb = $(\"listBody\");\n    if (!veri.oturumlar.length) { tb.innerHTML = '<tr><td colspan=\"10\" class=\"empty\">Henüz oturum yok.</td></tr>'; return; }\n    tb.innerHTML = veri.oturumlar.map(function (o) {\n      return \"<tr><td><b>\" + esc(o.kod) + \"</b></td><td>\" + esc(sinavAdi(o.sinav)) + ' <span class=\"muted\">(' + esc(o.sinav) + \", form \" + esc(o.form) + \")</span></td><td>\" + esc(o.firma) + \"</td><td>\" + esc(o.egitim_merkezi) +\n        \"</td><td>\" + esc(tarih(o.baslangic)) + \" - \" + esc(saat(o.bitis)) + '</td><td class=\"num\">' + (o.basladi + o.tamamlandi) + \" / \" + o.kontenjan +\n        '</td><td class=\"num\">' + o.basladi + '</td><td class=\"num\">' + o.tamamlandi + \"</td><td>\" + durumRozet(o) +\n        '</td><td style=\"white-space:nowrap\"><button class=\"btn small\" data-a=\"qr\" data-k=\"' + esc(o.kod) + '\">Karekod</button> ' +\n        '<button class=\"btn small\" data-a=\"rapor\" data-k=\"' + esc(o.kod) + '\">Rapor</button> ' +\n        '<button class=\"btn small\" data-a=\"' + (o.durum === \"ACIK\" ? \"kapat\" : \"ac\") + '\" data-k=\"' + esc(o.kod) + '\">' + (o.durum === \"ACIK\" ? \"Kapat\" : \"Aç\") + \"</button></td></tr>\";\n    }).join(\"\");\n  }\n  $(\"listBody\").addEventListener(\"click\", function (e) {\n    var b = e.target.closest(\"button[data-a]\");\n    if (!b) return;\n    var kod = b.dataset.k;\n    var o = veri.oturumlar.filter(function (x) { return x.kod === kod; })[0];\n    if (b.dataset.a === \"qr\") tamEkran(kod, o.sinav);\n    if (b.dataset.a === \"rapor\") { sekme(\"rapor\"); $(\"rpSel\").value = kod; raporYukle(); }\n    if (b.dataset.a === \"kapat\" || b.dataset.a === \"ac\") {\n      b.disabled = true;\n      sunucu(\"oturumDurumDegistir\", [kod, b.dataset.a === \"ac\"]).then(yukle).catch(alertHata);\n    }\n  });\n\n  // ---------- Rapor ----------\n  function raporSecenekleri() {\n    var sel = $(\"rpSel\");\n    var secili = sel.value;\n    sel.innerHTML = veri.oturumlar.map(function (o) {\n      return '<option value=\"' + esc(o.kod) + '\">' + esc(o.kod) + \" · \" + esc(sinavAdi(o.sinav)) + (o.firma ? \" · \" + esc(o.firma) : \"\") + \" · \" + esc(tarih(o.baslangic)) + \"</option>\";\n    }).join(\"\");\n    if (secili) sel.value = secili;\n  }\n  $(\"rpLoad\").addEventListener(\"click\", raporYukle);\n  $(\"rpFile\").addEventListener(\"click\", function () {\n    var kod = $(\"rpSel\").value;\n    if (!kod) return;\n    $(\"rpFile\").disabled = true;\n    $(\"rpFileBox\").hidden = false;\n    $(\"rpFileMsg\").textContent = \"Rapor dosyası hazırlanıyor…\";\n    sunucu(\"raporDosyasiOlustur\", [kod]).then(function (r) {\n      $(\"rpFile\").disabled = false;\n      $(\"rpFileMsg\").innerHTML = 'Rapor hazır: <a href=\"' + esc(r.url) + '\" target=\"_blank\">' + esc(r.ad) + \"</a>. Dosyayı açıp <b>Dosya &gt; İndir</b> ile PDF ya da Excel olarak alabilir, <b>Paylaş</b> ile firmaya gönderebilirsiniz. Dosyada soru metinleri ve cevap anahtarı yer almaz.\";\n    }).catch(function (e) {\n      $(\"rpFile\").disabled = false;\n      $(\"rpFileMsg\").textContent = \"Rapor oluşturulamadı: \" + e;\n    });\n  });\n\n  function raporYukle() {\n    var kod = $(\"rpSel\").value;\n    if (!kod) { $(\"rpBody\").innerHTML = '<div class=\"panel\"><div class=\"empty\">Önce bir oturum oluşturun.</div></div>'; return; }\n    yukleniyor(true);\n    sunucu(\"oturumRaporu\", [kod]).then(function (r) { yukleniyor(false); raporCiz(r); }).catch(function (e) { yukleniyor(false); $(\"rpBody\").innerHTML = '<p class=\"error\">' + esc(e) + \"</p>\"; });\n  }\n\n  function raporCiz(r) {\n    var h = \"\";\n    h += '<div class=\"kpis\">' +\n      kpi(\"Katılan\", r.katilan) + kpi(\"Devam eden\", r.devam_eden) + kpi(\"Tamamlayan\", r.tamamlayan) +\n      kpi(\"Ortalama puan\", sayi(r.ortalama)) + kpi(\"Medyan\", sayi(r.medyan)) +\n      kpi(\"En düşük / en yüksek\", r.tamamlayan ? sayi(r.en_dusuk) + \" / \" + sayi(r.en_yuksek) : \"-\") + \"</div>\";\n    if (!r.tamamlayan) {\n      h += '<div class=\"panel\"><div class=\"empty\">Bu oturumda henüz sınavını bitiren yok.</div></div>';\n      h += katilimciTablo(r);\n      $(\"rpBody\").innerHTML = h;\n      return;\n    }\n    var max = Math.max.apply(null, r.dagilim.concat([1]));\n    h += '<div class=\"grid2\"><div class=\"panel\"><div class=\"ph\"><h2>Puan dağılımı</h2><span class=\"hint\" style=\"margin:0\">kişi sayısı</span></div><div class=\"pb\"><div class=\"hist\">' +\n      r.dagilim.map(function (v, i) {\n        return '<div class=\"col\"><span class=\"v\">' + (v || \"\") + '</span><div class=\"bar\" style=\"height:' + (v / max * 100) + '%\"></div><span class=\"lbl\">' + (i * 10) + \"-\" + (i === 9 ? 100 : i * 10 + 9) + \"</span></div>\";\n      }).join(\"\") + \"</div></div></div>\";\n    h += '<div class=\"panel\"><div class=\"ph\"><h2>Bölüm bazında başarı</h2><span class=\"hint\" style=\"margin:0\">doğru cevap oranı</span></div><div class=\"pb\">' +\n      r.bolumler.map(function (b) {\n        return '<div class=\"hbar\"><span title=\"' + esc(b.ad) + '\">' + esc(b.ad) + ' <span class=\"hint\">(' + b.soru + ' soru)</span></span><div class=\"track\"><div class=\"' + yuzdeSinif(b.yuzde) + '\" style=\"width:' + (b.yuzde || 0) + '%\"></div></div><b class=\"num\">' + yuzde(b.yuzde) + \"</b></div>\";\n      }).join(\"\") + \"</div></div></div>\";\n\n    var sorular = r.sorular.slice().sort(function (a, b) { return a.dogru_yuzde - b.dogru_yuzde || a.no - b.no; });\n    h += '<div class=\"panel\"><div class=\"ph\"><h2>Soru analizi</h2><span class=\"hint\" style=\"margin:0\">en zordan en kolaya; doğru oranı düşük ve tek bir yanlış şıkta toplanan sorular yeniden gözden geçirilmeye değer</span></div><div class=\"scroll\"><table><thead><tr><th class=\"num\">No</th><th>Bölüm</th><th>Soru</th><th>Doğru oranı</th><th>Doğru</th><th>En sık yanlış</th><th>Seçimler</th></tr></thead><tbody>' +\n      sorular.map(function (q) {\n        var sec = Object.keys(q.secim).sort().map(function (k) { return (k === \"-\" ? \"boş\" : k === \"?\" ? \"bilmiyorum\" : k) + \":\" + q.secim[k]; }).join(\"  \");\n        return '<tr><td class=\"num\">' + q.no + \"</td><td>\" + esc(q.bolum) + '</td><td title=\"' + esc(q.soru) + '\">' + esc(q.soru.length > 70 ? q.soru.slice(0, 70) + \"…\" : q.soru) +\n          '</td><td style=\"white-space:nowrap\"><span class=\"mini\"><i class=\"' + yuzdeSinif(q.dogru_yuzde) + '\" style=\"width:' + (q.dogru_yuzde || 0) + '%\"></i></span>' + yuzde(q.dogru_yuzde) +\n          \"</td><td>\" + esc(q.dogru_cevap) + \"</td><td>\" + (q.en_sik_yanlis ? esc(q.en_sik_yanlis) + \" (\" + q.en_sik_yanlis_sayi + \")\" : \"\") + '</td><td class=\"hint\" style=\"margin:0\">' + esc(sec) + \"</td></tr>\";\n      }).join(\"\") + \"</tbody></table></div></div>\";\n    h += katilimciTablo(r);\n    $(\"rpBody\").innerHTML = h;\n  }\n  function kpi(ad, v) { return '<div class=\"kpi\"><span>' + ad + \"</span><b>\" + v + \"</b></div>\"; }\n  function katilimciTablo(r) {\n    var durumAd = { basladi: \"Devam ediyor\", tamamlandi: \"Bitirdi\" };\n    var k = r.katilimcilar.slice().sort(function (a, b) { return (b.puan == null ? -1 : b.puan) - (a.puan == null ? -1 : a.puan); });\n    return '<div class=\"panel\"><div class=\"ph\"><h2>Katılımcılar</h2><span class=\"hint\" style=\"margin:0\">Ayrıntılı veri: Sonuclar ve Detay sekmeleri</span></div><div class=\"scroll\"><table><thead><tr><th>Ad soyad</th><th>Firma</th><th>Görev</th><th>Başlama</th><th>Durum</th><th class=\"num\">Doğru</th><th class=\"num\">Puan</th></tr></thead><tbody>' +\n      (k.length ? k.map(function (x) {\n        return \"<tr><td>\" + esc(x.ad + \" \" + x.soyad) + \"</td><td>\" + esc(x.firma) + \"</td><td>\" + esc(x.gorev) + \"</td><td>\" + esc(tarih(x.baslama)) + \"</td><td>\" + (durumAd[x.durum] || esc(x.durum)) +\n          '</td><td class=\"num\">' + sayi(x.dogru) + '</td><td class=\"num\">' + sayi(x.puan) + \"</td></tr>\";\n      }).join(\"\") : '<tr><td colspan=\"7\" class=\"empty\">Henüz katılan yok.</td></tr>') + \"</tbody></table></div></div>\";\n  }\n\n\n  // ---------- Ortak yardımcılar ----------\n  function gun(iso) { return iso ? new Date(iso).toLocaleDateString(\"tr-TR\") : \"\"; }\n  function rozet(d) {\n    var c = { ONAYLI: \"b-onayli\", TASLAK: \"b-taslak\", ARSIV: \"b-arsiv\", ESKI: \"b-eski\", EMEKLI: \"b-eski\" }[d] || \"b-kapali\";\n    var ad = { ONAYLI: \"Onaylı\", TASLAK: \"Taslak\", ARSIV: \"Arşiv\", ESKI: \"Eski sürüm\", EMEKLI: \"Emekli\", KULLANIM_DISI: \"Kullanım dışı\" }[d] || d;\n    return '<span class=\"badge ' + c + '\">' + esc(ad) + \"</span>\";\n  }\n  function kisa(t, n) { t = String(t || \"\"); return t.length > n ? t.slice(0, n) + \"…\" : t; }\n  function secenekler(el, nesne, bos) {\n    el.innerHTML = (bos ? '<option value=\"\">' + esc(bos) + \"</option>\" : \"\") + Object.keys(nesne || {}).sort().map(function (k) {\n      return '<option value=\"' + esc(k) + '\">' + esc(k) + (nesne[k] ? \" · \" + esc(nesne[k]) : \"\") + \"</option>\";\n    }).join(\"\");\n  }\n\n  // ---------- Soru önizleme ----------\n  function pvLink(id, surum) { return '<button type=\"button\" class=\"pvlink\" data-pv=\"' + esc(id) + '\"' + (surum ? ' data-pvs=\"' + surum + '\"' : \"\") + ' title=\"Soruyu şekilleriyle göster\">' + esc(id) + \"</button>\"; }\n  function sekilRozet(n) { return n ? '<span class=\"sekil\">' + n + \" şekil</span>\" : \"\"; }\n  function pvKapat() { $(\"pv\").hidden = true; $(\"pvKart\").innerHTML = \"\"; }\n  document.addEventListener(\"click\", function (e) {\n    var b = e.target.closest(\"[data-pv]\");\n    if (!b) return;\n    e.preventDefault();\n    $(\"pvKart\").innerHTML = '<p class=\"muted\">Soru yükleniyor…</p>';\n    $(\"pv\").hidden = false;\n    sunucu(\"soruOnizle\", [b.dataset.pv, b.dataset.pvs ? Number(b.dataset.pvs) : null]).then(function (q) {\n      var img = function (g) { return g.veri ? '<img src=\"' + g.veri + '\" alt=\"' + esc(g.ad) + '\">' : '<p class=\"eksik\">Şekil bulunamadı: ' + esc(g.ad) + (q.klasor_yok ? \" (görsel klasörü tanımlı değil)\" : \" (Drive klasöründe bu adla dosya yok)\") + \"</p>\"; };\n      var h = '<div class=\"ust\"><div><h3>' + esc(q.id) + \" · v\" + q.surum + \" \" + rozet(q.durum) + \"</h3></div>\" +\n        '<button class=\"btn small\" data-x=\"pvkapat\">Kapat</button></div>' +\n        '<div class=\"meta\">' + esc(q.konu) + \" · \" + esc(q.bolum) + (q.zorluk ? \" · \" + esc(q.zorluk) : \"\") + (q.grup ? \" · ortak şekil grubu \" + esc(q.grup) : \"\") + \"</div>\";\n      if (q.grup_notu || q.grup_gorsel) h += '<div class=\"gnot\">' + esc(q.grup_notu) + (q.grup_gorsel ? img(q.grup_gorsel) : \"\") + \"</div>\";\n      h += '<div class=\"metin\">' + esc(q.soru) + \"</div>\" + q.gorseller.map(img).join(\"\");\n      if (q.tur === \"sayi\") h += '<p><b>Doğru cevap:</b> ' + esc(q.dogru) + \" \" + esc(q.birim) + (q.tolerans ? \" (tolerans ±\" + esc(q.tolerans) + \")\" : \"\") + \"</p>\";\n      else h += \"<ol>\" + q.siklar.map(function (s) { return '<li class=\"' + (s.id === q.dogru ? \"dogru\" : \"\") + '\"><b>' + s.id + \")</b>\" + esc(s.metin) + \"</li>\"; }).join(\"\") + \"</ol>\";\n      if (q.gerekce || q.kaynak) h += '<div class=\"alt\">' + (q.gerekce ? \"Gerekçe: \" + esc(q.gerekce) + \"<br>\" : \"\") + (q.kaynak ? \"Kaynak: \" + esc(q.kaynak) : \"\") + \"</div>\";\n      $(\"pvKart\").innerHTML = h;\n    }).catch(function (err) { $(\"pvKart\").innerHTML = '<p class=\"error\">Hata: ' + esc(String(err)) + '</p><button class=\"btn small\" data-x=\"pvkapat\">Kapat</button>'; });\n  });\n  $(\"pv\").addEventListener(\"click\", function (e) { if (e.target === $(\"pv\") || e.target.closest('[data-x=\"pvkapat\"]')) pvKapat(); });\n  document.addEventListener(\"keydown\", function (e) { if (e.key === \"Escape\" && !$(\"pv\").hidden) pvKapat(); });\n\n  // ---------- Sınavlar ----------\n  function sinavlarCiz() {\n    $(\"snBody\").innerHTML = veri.sinavlar.slice().reverse().map(function (s) {\n      return \"<tr><td><b>\" + esc(s.kod) + \"</b></td><td>\" + esc(s.baslik) + \"</td><td>\" + rozet(s.durum) + '</td><td class=\"num\">' + s.soru_sayisi + \"</td><td>\" + esc(s.formlar.join(\", \")) +\n        '</td><td><button class=\"btn small\" data-sn=\"' + esc(s.kod) + '\">Aç</button></td></tr>';\n    }).join(\"\") || '<tr><td colspan=\"6\" class=\"empty\">Henüz sınav yok.</td></tr>';\n    secenekler($(\"hzMerkez\"), veri.kodlar.MERKEZ);\n    secenekler($(\"hzFirma\"), veri.kodlar.FIRMA);\n    secenekler($(\"hzKonu\"), veri.kodlar.KONU);\n  }\n  function snGoster(v) { $(\"snListe\").hidden = v !== \"liste\"; $(\"snDetay\").hidden = v !== \"detay\"; $(\"snHazir\").hidden = v !== \"hazir\"; }\n  $(\"snBody\").addEventListener(\"click\", function (e) {\n    var b = e.target.closest(\"button[data-sn]\");\n    if (b) sinavAc(b.dataset.sn);\n  });\n\n  function sinavAc(kod) {\n    yukleniyor(true);\n    sunucu(\"sinavDetay\", [kod]).then(function (d) {\n      yukleniyor(false);\n      snGoster(\"detay\");\n      var h = '<div class=\"panel\"><div class=\"ph\"><h2>' + esc(d.kod) + \" · \" + esc(d.baslik) + \" \" + rozet(d.durum) + '</h2><button class=\"btn small\" data-x=\"geri\">Sınavlara dön</button></div><div class=\"pb\">';\n      h += '<div class=\"stats\"><span>Soru: <b>' + d.sorular.length + \"</b></span><span>Süre: <b>\" + d.sure_dk + \" dk</b></span><span>Firma: <b>\" + esc(d.firma) + \"</b></span><span>Bu firmanın daha önce gördüğü soru: <b>\" + d.firma_gordugu + \"</b> (%\" + Math.round(d.firma_gordugu / Math.max(1, d.sorular.length) * 100) + \")</span></div>\";\n      if (d.onceki.length) h += '<div class=\"warnbox\">Bu firmaya daha önce kullanılan sınavlarla ortak sorular: ' + d.onceki.map(function (x) { return esc(x.kod) + \": \" + x.ortak + \"/\" + x.toplam; }).join(\", \") + \"</div>\";\n      h += '<div class=\"toolbar\" style=\"margin:10px 0\">';\n      if (d.durum === \"TASLAK\") h += '<button class=\"btn primary\" data-x=\"onayla\">Sınavı onayla</button>';\n      if (d.durum === \"ONAYLI\") h += '<button class=\"btn primary\" data-x=\"form\">Yeni form oluştur</button>';\n      if (d.durum !== \"ARSIV\") h += '<button class=\"btn\" data-x=\"arsiv\">Arşivle</button>';\n      h += \"</div>\";\n      if (d.formlar.length) {\n        h += '<table style=\"max-width:560px\"><thead><tr><th>Form</th><th>Oluşturma</th><th class=\"num\">Kullanım</th><th class=\"num\">Katılımcı</th></tr></thead><tbody>' +\n          d.formlar.map(function (f) { return \"<tr><td>Form \" + esc(f.form) + \"</td><td>\" + esc(gun(f.olusturma)) + '</td><td class=\"num\">' + f.kullanim + '</td><td class=\"num\">' + f.katilimci + \"</td></tr>\"; }).join(\"\") + \"</tbody></table>\";\n        h += '<p class=\"hint\">Aynı çalışmada sınav tekrarlanacaksa yeni form oluşturun: soruların sırası bölüm içinde ve şıkların yeri değişir, ortak şekilli sorular birlikte kalır. Sorular aynı olduğu için sonuçlar karşılaştırılabilir.</p>';\n      }\n      if (d.durum === \"ONAYLI\") {\n        h += '<div class=\"toolbar\" style=\"margin-top:10px\"><span class=\"flabel\" style=\"margin:0\">Kâğıt sınav kaydı:</span><input type=\"date\" id=\"kgTarih\"><input type=\"number\" id=\"kgKisi\" placeholder=\"Kişi\" min=\"0\" style=\"width:90px;min-width:0\"><input id=\"kgForm\" placeholder=\"Form\" maxlength=\"1\" style=\"width:70px;min-width:0\" value=\"A\"><input id=\"kgNot\" placeholder=\"Not\" style=\"min-width:200px\"><button class=\"btn small\" data-x=\"kagit\">Ekle</button></div>';\n      }\n      h += '<p class=\"error\" id=\"sdErr\" hidden></p></div></div>';\n      h += '<div class=\"panel\"><div class=\"ph\"><h2>Sorular</h2><span class=\"hint\" style=\"margin:0\">kırmızı: bu firma daha önce gördü</span></div><div class=\"scroll\" style=\"max-height:480px\"><table><thead><tr><th class=\"num\">No</th><th>Soru</th><th>Bölüm</th><th>Zorluk</th><th>Şekil</th><th class=\"num\">Ölçülen doğru</th><th class=\"num\">Sınav</th><th>Bu firma gördü</th><th>Metin</th></tr></thead><tbody>' +\n        d.sorular.map(function (q) {\n          return '<tr><td class=\"num\">' + q.no + \"</td><td>\" + pvLink(q.id, q.surum) + ' <span class=\"muted\">v' + q.surum + \"</span></td><td>\" + esc(q.bolum) + \"</td><td>\" + esc(q.zorluk) + \"</td><td>\" + sekilRozet(q.sekil) + '</td><td class=\"num\">' + yuzde(q.kullanim.olculen) +\n            '</td><td class=\"num\">' + q.kullanim.sinavlar.length + \"</td><td\" + (q.firma_gordu ? ' class=\"seen\"' : \"\") + \">\" + (q.firma_gordu ? (q.firma_gordu === \"tarihsiz\" ? \"Evet\" : esc(gun(q.firma_gordu))) : \"\") + '</td><td title=\"' + esc(q.soru) + '\">' + esc(kisa(q.soru, 70)) + \"</td></tr>\";\n        }).join(\"\") + \"</tbody></table></div></div>\";\n      $(\"snDetay\").innerHTML = h;\n      $(\"snDetay\").dataset.kod = d.kod;\n    }).catch(function (e) { yukleniyor(false); alert(\"Hata: \" + e); });\n  }\n  $(\"snDetay\").addEventListener(\"click\", function (e) {\n    var b = e.target.closest(\"button[data-x]\");\n    if (!b) return;\n    var kod = $(\"snDetay\").dataset.kod;\n    var hata = function (err) { $(\"sdErr\").textContent = String(err); $(\"sdErr\").hidden = false; b.disabled = false; };\n    var yenile = function () { return yukle().then(function () { sinavAc(kod); }); };\n    if (b.dataset.x === \"geri\") return snGoster(\"liste\");\n    b.disabled = true;\n    if (b.dataset.x === \"onayla\") sunucu(\"sinavOnayla\", [kod]).then(yenile).catch(hata);\n    if (b.dataset.x === \"form\") sunucu(\"formOlustur\", [kod]).then(yenile).catch(hata);\n    if (b.dataset.x === \"arsiv\") sunucu(\"sinavArsivle\", [kod]).then(yenile).catch(hata);\n    if (b.dataset.x === \"kagit\") sunucu(\"kullanimEkle\", [{ sinav: kod, tarih: $(\"kgTarih\").value, katilimci_sayisi: $(\"kgKisi\").value, form: $(\"kgForm\").value.toUpperCase(), tur: \"KAGIT\", not: $(\"kgNot\").value }]).then(yenile).catch(hata);\n  });\n\n  // ---------- Sınav hazırlama ----------\n  var hz = null; // { kod, adaylar, secili: {id:true}, firma }\n  $(\"snYeni\").addEventListener(\"click\", function () { snGoster(\"hazir\"); $(\"hzGovde\").hidden = true; $(\"hzErr\").hidden = true; });\n  $(\"hzGeri\").addEventListener(\"click\", function () { snGoster(\"liste\"); });\n  $(\"kdEkle\").addEventListener(\"click\", function () {\n    $(\"hzErr\").hidden = true;\n    sunucu(\"kodEkle\", [$(\"kdTur\").value, $(\"kdKod\").value, $(\"kdAd\").value]).then(function () { $(\"kdKod\").value = \"\"; $(\"kdAd\").value = \"\"; return yukle(); })\n      .catch(function (e) { $(\"hzErr\").textContent = String(e); $(\"hzErr\").hidden = false; });\n  });\n  $(\"hzGetir\").addEventListener(\"click\", function () {\n    $(\"hzErr\").hidden = true;\n    yukleniyor(true);\n    sunucu(\"sinavHazirlik\", [$(\"hzMerkez\").value, $(\"hzFirma\").value, $(\"hzKonu\").value]).then(function (r) {\n      yukleniyor(false);\n      hz = { kod: r.kod, adaylar: r.adaylar, secili: {}, firma: $(\"hzFirma\").value };\n      $(\"hzGovde\").hidden = false;\n      $(\"hzKod\").value = r.kod;\n      $(\"hzAlt\").value = r.merkez_ad || \"\";\n      $(\"hzSablon\").innerHTML = veri.sinavlar.slice().reverse().map(function (s) { return '<option value=\"' + esc(s.kod) + '\">' + esc(s.kod) + \" · \" + esc(s.baslik) + \"</option>\"; }).join(\"\");\n      if (r.sablon) $(\"hzSablon\").value = r.sablon;\n      var sb = veri.sinavlar.filter(function (s) { return s.kod === r.sablon; })[0];\n      if (sb) { $(\"hzBaslik\").value = sb.baslik; $(\"hzSure\").value = sb.sure_dk; }\n      hzCiz();\n    }).catch(function (e) { yukleniyor(false); $(\"hzErr\").textContent = String(e); $(\"hzErr\").hidden = false; });\n  });\n  function grupUyeleri(q) { return q.grup ? hz.adaylar.filter(function (x) { return x.grup === q.grup; }) : [q]; }\n  function gordu(q) { return q.kullanim.firmalar.hasOwnProperty(hz.firma); }\n  function hzCiz() {\n    $(\"hzBody\").innerHTML = hz.adaylar.map(function (q) {\n      var g = gordu(q);\n      return '<tr class=\"' + (hz.secili[q.id] ? \"sel\" : \"\") + '\"><td class=\"chk\"><input type=\"checkbox\" data-q=\"' + esc(q.id) + '\"' + (hz.secili[q.id] ? \" checked\" : \"\") + \"></td><td>\" + pvLink(q.id) + (q.grup ? ' <span class=\"muted\">' + esc(q.grup) + \"</span>\" : \"\") +\n        \"</td><td>\" + esc(q.bolum) + \"</td><td>\" + esc(q.zorluk) + \"</td><td>\" + sekilRozet(q.sekil) + '</td><td class=\"num\">' + yuzde(q.kullanim.olculen) + '</td><td class=\"num\">' + q.kullanim.oturum + \"</td><td\" + (g ? ' class=\"seen\"' : \"\") + \">\" +\n        (g ? (q.kullanim.firmalar[hz.firma] ? esc(gun(q.kullanim.firmalar[hz.firma])) : \"Evet\") : \"\") + \"</td><td>\" + esc(gun(q.kullanim.son)) + '</td><td title=\"' + esc(q.soru) + '\">' + esc(kisa(q.soru, 60)) + \"</td></tr>\";\n    }).join(\"\");\n    hzOzet();\n  }\n  function hzOzet() {\n    var sec = hz.adaylar.filter(function (q) { return hz.secili[q.id]; });\n    var bol = {};\n    sec.forEach(function (q) { bol[q.bolum] = (bol[q.bolum] || 0) + 1; });\n    var g = sec.filter(gordu).length;\n    $(\"hzOzet\").innerHTML = \"<span>Seçili: <b>\" + sec.length + \"</b></span>\" + Object.keys(bol).map(function (b) { return \"<span>\" + esc(b) + \": <b>\" + bol[b] + \"</b></span>\"; }).join(\"\") +\n      '<span>Bu firmanın gördüğü: <b class=\"' + (g ? \"seen\" : \"\") + '\">' + g + \"</b>\" + (sec.length ? \" (%\" + Math.round(g / sec.length * 100) + \")\" : \"\") + \"</span>\";\n    var tum = sec.length && g === sec.length;\n    $(\"hzUyari\").innerHTML = tum ? '<div class=\"warnbox\">Seçilen soruların hepsini bu firma daha önce gördü. Havuza yeni sorular ekleyip bir kısmını yenilemeniz önerilir; daha önce verilmiş sınavın birebir aynısı onaylanamaz.</div>' : \"\";\n  }\n  $(\"hzBody\").addEventListener(\"change\", function (e) {\n    var c = e.target.closest(\"input[data-q]\");\n    if (!c) return;\n    var q = hz.adaylar.filter(function (x) { return x.id === c.dataset.q; })[0];\n    grupUyeleri(q).forEach(function (x) { if (c.checked) hz.secili[x.id] = true; else delete hz.secili[x.id]; });\n    hzCiz();\n  });\n  $(\"hzOner\").addEventListener(\"click\", function () {\n    var n = parseInt($(\"hzN\").value, 10);\n    if (!(n > 0)) return;\n    var bolumler = {};\n    hz.adaylar.forEach(function (q) { (bolumler[q.bolum] = bolumler[q.bolum] || []).push(q); });\n    var toplam = hz.adaylar.length;\n    hz.secili = {};\n    // En büyük kalan yöntemi: bölüm hedeflerinin toplamı tam n olur.\n    var adlar = Object.keys(bolumler);\n    var hedefler = {}, kalan = n;\n    adlar.forEach(function (b) { hedefler[b] = Math.floor(n * bolumler[b].length / toplam); kalan -= hedefler[b]; });\n    adlar.slice().sort(function (a, c) { return (n * bolumler[c].length / toplam % 1) - (n * bolumler[a].length / toplam % 1); })\n      .slice(0, Math.max(0, kalan)).forEach(function (b) { hedefler[b]++; });\n    adlar.forEach(function (b) {\n      var hedef = hedefler[b];\n      var birimler = [];\n      var goruldu = {};\n      bolumler[b].forEach(function (q) {\n        var key = q.grup || q.id;\n        if (goruldu[key]) return;\n        goruldu[key] = true;\n        birimler.push(grupUyeleri(q));\n      });\n      birimler.sort(function (a, c) {\n        var ga = a.some(gordu) ? 1 : 0, gc = c.some(gordu) ? 1 : 0;\n        if (ga !== gc) return ga - gc;\n        var ua = a[0].kullanim.oturum, uc = c[0].kullanim.oturum;\n        if (ua !== uc) return ua - uc;\n        return a[0].id < c[0].id ? -1 : 1;\n      });\n      var say = 0;\n      birimler.forEach(function (u) {\n        if (say >= hedef) return;\n        u.forEach(function (q) { hz.secili[q.id] = true; });\n        say += u.length;\n      });\n    });\n    hzCiz();\n  });\n  $(\"hzKaydet\").addEventListener(\"click\", function () {\n    $(\"hzErr\").hidden = true;\n    var ids = hz.adaylar.filter(function (q) { return hz.secili[q.id]; }).map(function (q) { return q.id; });\n    var g = { merkez: $(\"hzMerkez\").value, firma: $(\"hzFirma\").value, konu: $(\"hzKonu\").value, baslik: $(\"hzBaslik\").value, alt_baslik: $(\"hzAlt\").value, sure_dk: $(\"hzSure\").value, sablon: $(\"hzSablon\").value, sorular: ids };\n    $(\"hzKaydet\").disabled = true;\n    sunucu(\"sinavKaydet\", [g]).then(function (kod) {\n      $(\"hzKaydet\").disabled = false;\n      return yukle().then(function () { sinavAc(kod); });\n    }).catch(function (e) { $(\"hzKaydet\").disabled = false; $(\"hzErr\").textContent = String(e); $(\"hzErr\").hidden = false; window.scrollTo(0, 0); });\n  });\n\n  // ---------- Soru havuzu ----------\n  var havuz = [];\n  var hvDurumVeri = null;\n  function belgeLink(id, ad) {\n    return id ? '<a href=\"https://docs.google.com/document/d/' + encodeURIComponent(id) + '/edit\" target=\"_blank\">' + esc(ad || \"belge\") + \"</a>\" : esc(ad || \"\");\n  }\n  function hvDurumCiz() {\n    var d = hvDurumVeri;\n    $(\"hvKontrol\").hidden = !d || !d.acik;\n    if (!d || !d.acik) return;\n    $(\"hvIpucu\").textContent = \"Sorular Drive'daki Soru Havuzu belgelerinde düzenlenir. Sistem belgeleri 30 dakikada bir ve her sınav, form ya da kitapçık işleminden hemen önce kontrol eder. Eksiksiz okunamayan ya da onaylıyken değişen soru karantinaya alınır ve düzelene kadar kullanılmaz.\";\n    $(\"hvSonKontrol\").textContent = \"Son kontrol: \" + (d.sonKontrol || \"henüz yok\");\n    if (!d.karantina.length) {\n      $(\"hvKarantina\").innerHTML = '<div class=\"okbox\">Karantinada soru yok. Tüm sorular eksiksiz okundu.</div>';\n    } else {\n      $(\"hvKarantina\").innerHTML = '<div class=\"krbox\"><h3>' + d.karantina.length + \" kayıt karantinada</h3>\" + d.karantina.map(function (x) {\n        var b = \"\";\n        if (x.karar) b = '<button class=\"btn small\" data-karar=\"yeni_surum\" data-id=\"' + esc(x.id) + '\" data-v=\"' + esc(x.surum) + '\">Yeni sürüm olarak kaydet</button><button class=\"btn small\" data-karar=\"duzeltme\" data-id=\"' + esc(x.id) + '\" data-v=\"' + esc(x.surum) + '\">Anlamı değişmedi</button><button class=\"btn small\" data-karar=\"geri_al\" data-id=\"' + esc(x.id) + '\" data-v=\"' + esc(x.surum) + '\">Geri al</button>';\n        else if (/Eski sürüm kaydı değişmiş/.test(x.sorun)) b = '<button class=\"btn small\" data-karar=\"geri_al\" data-id=\"' + esc(x.id) + '\" data-v=\"' + esc(x.surum) + '\">Geri al</button>';\n        return '<div class=\"kr\"><b>' + esc(x.id ? x.id + (x.surum ? \" (Sürüm \" + x.surum + \")\" : \"\") : \"Belge uyarısı\") + \"</b> · \" + belgeLink(x.belge, x.belgeAdi) + ' <span class=\"muted\">· ' + esc(x.ilk) + '</span><div class=\"ne\">' + esc(x.sorun) + '</div><div class=\"btns\">' + b + \"</div></div>\";\n      }).join(\"\") + \"</div>\";\n    }\n    gunlukCiz();\n  }\n  function gunlukCiz() {\n    var d = hvDurumVeri;\n    if (!d || !d.acik) return;\n    var a = $(\"hvGunlukAra\").value.trim().toLocaleLowerCase(\"tr\");\n    var l = d.gunluk.filter(function (g) { return !a || (g.belge + \" \" + g.soru_id + \" \" + g.islem + \" \" + g.aciklama).toLocaleLowerCase(\"tr\").indexOf(a) >= 0; });\n    $(\"hvGunluk\").innerHTML = l.map(function (g) {\n      return \"<tr><td>\" + esc(g.tarih) + \"</td><td>\" + esc(g.belge) + \"</td><td>\" + esc(g.soru_id) + \"</td><td>\" + esc(g.surum) + \"</td><td>\" + esc(g.islem) + \"</td><td>\" + esc(g.aciklama) + \"</td></tr>\";\n    }).join(\"\") || '<tr><td colspan=\"6\" class=\"empty\">Kayıt yok.</td></tr>';\n  }\n  $(\"hvGunlukAra\").addEventListener(\"input\", gunlukCiz);\n  $(\"hvKontrolEt\").addEventListener(\"click\", function () {\n    var b = this;\n    b.disabled = true;\n    sunucu(\"havuzKontrolEt\", [false]).then(function () { b.disabled = false; return havuzYukle(); }).catch(function (e) { b.disabled = false; alert(\"Hata: \" + e); });\n  });\n  $(\"hvKarantina\").addEventListener(\"click\", function (e) {\n    var b = e.target.closest(\"button[data-karar]\");\n    if (!b) return;\n    var ne = { yeni_surum: \"Değişen hal yeni sürüm olarak onaylanacak; önceki sürüm Eski sürümler belgesine taşınacak.\", duzeltme: \"Değişiklik aynı sürümde kabul edilecek (anlamı değişmedi).\", geri_al: \"Belgedeki soru, son onaylı haliyle yeniden yazılacak; yapılan değişiklik kaybolacak.\" }[b.dataset.karar];\n    if (!confirm(b.dataset.id + \": \" + ne + \" Devam edilsin mi?\")) return;\n    b.disabled = true;\n    sunucu(\"havuzKarari\", [b.dataset.id, Number(b.dataset.v), b.dataset.karar]).then(function () { return havuzYukle(); }).catch(function (err) { b.disabled = false; alert(\"Hata: \" + err); });\n  });\n  function havuzYukle() {\n    yukleniyor(true);\n    return Promise.all([sunucu(\"havuzListesi\"), sunucu(\"havuzDurumu\")]).then(function (rr) {\n      var l = rr[0];\n      hvDurumVeri = rr[1];\n      yukleniyor(false);\n      havuz = l;\n      hvDurumCiz();\n      secenekler($(\"hvKonu\"), veri.kodlar.KONU, \"Tüm konular\");\n      secenekler($(\"hvFirma\"), veri.kodlar.FIRMA, \"Firma vurgusu yok\");\n      havuzCiz();\n    }).catch(function (e) { yukleniyor(false); alert(\"Hata: \" + e); });\n  }\n  function havuzCiz() {\n    var sekil = $(\"hvSekil\").value, konu = $(\"hvKonu\").value, durum = $(\"hvDurum\").value, firma = $(\"hvFirma\").value, kul = $(\"hvKul\").value, ara = $(\"hvAra\").value.trim().toLocaleLowerCase(\"tr\");\n    var altiAy = Date.now() - 183 * 864e5;\n    var l = havuz.filter(function (q) {\n      if (konu && q.konu !== konu) return false;\n      if (sekil === \"var\" && !q.sekil) return false;\n      if (sekil === \"yok\" && q.sekil) return false;\n      if (durum === \"KARANTINA\" ? !q.karantina : durum && q.durum !== durum) return false;\n      if (kul === \"hic\" && q.kullanim.oturum) return false;\n      if (kul === \"6ay\" && q.kullanim.son && new Date(q.kullanim.son).getTime() > altiAy) return false;\n      if (ara && (q.id + \" \" + q.soru).toLocaleLowerCase(\"tr\").indexOf(ara) < 0) return false;\n      return true;\n    });\n    $(\"hvSay\").textContent = l.length + \" soru\";\n    $(\"hvBody\").innerHTML = l.map(function (q) {\n      var f = Object.keys(q.kullanim.firmalar);\n      var gor = firma && f.indexOf(firma) >= 0;\n      var belgeli = hvDurumVeri && hvDurumVeri.acik;\n      var islem = q.karantina ? \"\" : q.durum === \"TASLAK\" ? '<button class=\"btn small\" data-on=\"' + esc(q.id) + '\" data-v=\"' + q.surum + '\">Onayla</button>' : belgeli ? \"\" : '<button class=\"btn small\" data-ys=\"' + esc(q.id) + '\">Yeni sürüm</button>';\n      if (belgeli && q.belge) islem += (islem ? \" \" : \"\") + belgeLink(q.belge, \"Belgeyi aç\");\n      return \"<tr\" + (gor ? ' class=\"sel\"' : \"\") + \"><td>\" + pvLink(q.id, q.surum) + \"</td><td>v\" + q.surum + (q.onayli_surum && q.onayli_surum !== q.surum ? ' <span class=\"muted\">(onaylı v' + q.onayli_surum + \")</span>\" : \"\") + \"</td><td>\" + rozet(q.durum) + (q.karantina ? ' <span class=\"badge b-karantina\" title=\"' + esc(q.karantina) + '\">Karantina</span>' : \"\") + \"</td><td>\" + esc(q.bolum) + \"</td><td>\" + esc(q.zorluk) +\n        \"</td><td>\" + sekilRozet(q.sekil) + '</td><td title=\"' + esc(q.soru) + '\">' + esc(kisa(q.soru, 60)) + '</td><td class=\"num\">' + q.kullanim.sinavlar.length + '</td><td class=\"num\">' + q.kullanim.oturum + '</td><td class=\"num\">' + q.kullanim.katilimci + \"</td><td\" + (gor ? ' class=\"seen\"' : \"\") + \">\" + esc(f.join(\", \")) +\n        \"</td><td>\" + esc(gun(q.kullanim.son)) + '</td><td class=\"num\">' + yuzde(q.kullanim.olculen) + \"</td><td>\" + islem + \"</td></tr>\";\n    }).join(\"\") || '<tr><td colspan=\"14\" class=\"empty\">Kayıt yok.</td></tr>';\n  }\n  [\"hvKonu\", \"hvDurum\", \"hvFirma\", \"hvKul\", \"hvSekil\"].forEach(function (id) { $(id).addEventListener(\"change\", havuzCiz); });\n  $(\"hvAra\").addEventListener(\"input\", havuzCiz);\n  $(\"hvBody\").addEventListener(\"click\", function (e) {\n    var b = e.target.closest(\"button\");\n    if (!b) return;\n    b.disabled = true;\n    var p = b.dataset.on ? sunucu(\"soruOnayla\", [b.dataset.on, Number(b.dataset.v)]) : sunucu(\"soruYeniSurum\", [b.dataset.ys]);\n    p.then(function (r) {\n      if (b.dataset.ys) alert(b.dataset.ys + \" için v\" + r + \" taslağı Havuz sekmesine eklendi. Metni orada düzenleyip buradan onaylayın.\");\n      return havuzYukle();\n    }).catch(function (err) { b.disabled = false; alert(\"Hata: \" + err); });\n  });\n  document.querySelector('.tabs [data-t=\"havuz\"]').addEventListener(\"click\", havuzYukle);\n  document.querySelector('.tabs [data-t=\"sinavlar\"]').addEventListener(\"click\", function () { snGoster(\"liste\"); });\n\n  $(\"refresh\").addEventListener(\"click\", function () {\n    yukle().then(function () { if (!$(\"t-rapor\").hidden && $(\"rpSel\").value) raporYukle(); });\n  });\n\n  yukle();\n})();\n</script>\n</body>\n</html>\n";
