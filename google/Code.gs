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
 * Sekmeler: Ayarlar, Sinavlar, Sorular, Oturumlar, Davetler, Sonuclar,
 * ve her sınav için otomatik açılan Detay_<SINAV KODU>.
 *
 * Not: Bu dosya google/panel.html'den derlenir (tools/build.py). Yönetim
 * panelinin sayfası dosyanın sonundaki PANEL_HTML değişkenindedir.
 */

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
    soru_sayisi: sorular_(s.kod).length,
    aciklama: s.aciklama || "",
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
    return sorulariVer_(s, kod, baslama, d.kayit.ara_kayit);
  } finally {
    kilit.releaseLock();
  }
}

function sorulariVer_(s, kod, baslama, araKayitMetni) {
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
    sorular: katilimciSorulari_(s, kod),
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
    satirEkle_("Davetler", {
      kod: kod,
      sinav: s.kod,
      oturum: okod,
      ad: ad,
      soyad: soyad,
      firma: temizle_(k.firma, 120) || temizle_(o.kayit.firma, 120),
      gorev: temizle_(k.gorev, 120),
      durum: "basladi",
      baslama: simdi,
      giris_sayisi: 1,
      kvkk_onay: s.kvkk_metni ? simdi : "",
    });
    return sorulariVer_(s, kod, simdi, "");
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
    var sorular = sorular_(s.kod);
    var temiz = cevaplariTemizle_(cevaplar);
    var p = puanla(sorular, temiz);

    var simdi = new Date();
    var baslama = new Date(d.kayit.baslama);
    var sureSn = Math.round((simdi.getTime() - baslama.getTime()) / 1000);
    var asim = sureSn > Number(s.sure_dk) * 60 + SURE_TOLERANSI_SN;
    var o = d.kayit.oturum ? oturumBul_(d.kayit.oturum) : null;

    satirEkle_("Sonuclar", {
      zaman: simdi,
      sinav: s.kod,
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

function katilimciSorulari_(s, kod) {
  var karistir = evet_(s.sik_karistir);
  var klasor = s.gorsel_klasor_id ? String(s.gorsel_klasor_id).trim() : "";
  return sorular_(s.kod).map(function (q) {
    var secenekler = [];
    if (q.tur !== "sayi") {
      ["A", "B", "C", "D", "E"].forEach(function (h) {
        if (q[h] !== undefined && String(q[h]).trim() !== "") secenekler.push({ id: h, metin: String(q[h]) });
      });
      if (karistir) secenekler = karistir_(secenekler, kod + ":" + q.no);
    }
    return {
      no: q.no,
      bolum: q.bolum || "",
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

function sorular_(sinavKodu) {
  return tablo_("Sorular")
    .kayitlar.map(function (r) {
      return r.kayit;
    })
    .filter(function (q) {
      return String(q.sinav).trim() === String(sinavKodu).trim() && String(q.soru).trim() !== "";
    })
    .sort(function (a, b) {
      return Number(a.no) - Number(b.no);
    });
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
        return "S" + q.no;
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
  Sinavlar: [
    "kod",
    "baslik",
    "alt_baslik",
    "sure_dk",
    "aktif",
    "aciklama",
    "kvkk_metni",
    "firma_sor",
    "gorev_sor",
    "bilmiyorum",
    "sik_karistir",
    "gorsel_klasor_id",
    "hazirlayan",
  ],
  Sorular: ["sinav", "no", "bolum", "grup_notu", "grup_gorsel", "soru", "gorsel", "tur", "A", "B", "C", "D", "E", "dogru", "tolerans", "birim"],
  Oturumlar: ["kod", "sinav", "firma", "egitim_merkezi", "baslangic", "bitis", "kontenjan", "durum", "olusturma", "not"],
  Davetler: [
    "kod",
    "sinav",
    "baglanti",
    "ad",
    "soyad",
    "firma",
    "gorev",
    "son_tarih",
    "durum",
    "baslama",
    "bitis",
    "giris_sayisi",
    "kvkk_onay",
    "son_kayit",
    "ara_kayit",
    "oturum",
    "puan",
  ],
  Sonuclar: [
    "zaman",
    "sinav",
    "davet_kodu",
    "ad",
    "soyad",
    "firma",
    "gorev",
    "baslama",
    "bitis",
    "sure_dk",
    "sure_asimi",
    "dogru",
    "yanlis",
    "bos",
    "bilmiyorum",
    "toplam",
    "puan",
    "bolumler",
    "oturum",
    "egitim_merkezi",
  ],
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
    satirEkle_("Davetler", { kod: kod, sinav: sinavKodu, baglanti: adres.replace(/\/?$/, "/") + "?k=" + kod, durum: "bekliyor" });
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
  var sinavlar = tablo_("Sinavlar").kayitlar.map(function (r) {
    var s = r.kayit;
    return { kod: String(s.kod), baslik: String(s.baslik), alt_baslik: String(s.alt_baslik || ""), sure_dk: Number(s.sure_dk), soru_sayisi: sorular_(s.kod).length };
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
  return { sinavlar: sinavlar, oturumlar: oturumlar, sinav_sayfasi: ayar_("sinav_sayfasi") };
}

/** Yeni oturum ve ortak giriş kodu oluşturur. */
function oturumOlustur(g) {
  var s = sinavBul_(String(g.sinav || ""));
  if (!s) throw new Error("Sınav bulunamadı.");
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
  var sorular = sorular_(o.kayit.sinav);
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
        c = d.ara_kayit ? JSON.parse(d.ara_kayit) : {};
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

// Yönetim paneli sayfası (google/panel.html'den derlenir; elle düzenlemeyin).
var PANEL_HTML = /*PANEL_HTML*/ "<!doctype html>\n<html lang=\"tr\">\n<head>\n<meta charset=\"utf-8\">\n<base target=\"_top\">\n<style>\n:root{--bg:#f3f5f7;--panel:#fff;--text:#16202a;--muted:#64717e;--line:#dde3e9;--soft:#f7f9fb;--accent:#1457d9;--accent-soft:#eef3fd;--good:#1f8a4c;--good-soft:#e9f6ee;--bad:#b42318;--bad-soft:#fdecea;--warn:#a86700;--warn-soft:#fdf3df;--font:system-ui,-apple-system,\"Segoe UI\",Roboto,Arial,sans-serif}\n*{box-sizing:border-box}\nbody{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 var(--font)}\n[hidden]{display:none!important}\n.tabs{display:flex;gap:4px;background:var(--panel);border-bottom:1px solid var(--line);padding:0 16px;position:sticky;top:0;z-index:5}\n.tabs button{background:none;border:0;border-bottom:2px solid transparent;padding:12px 12px 10px;font:600 14px var(--font);color:var(--muted);cursor:pointer}\n.tabs button[aria-selected=true]{color:var(--accent);border-bottom-color:var(--accent)}\n.tabs .spacer{flex:1}\n.tabs .refresh{color:var(--muted);font-weight:500}\nmain{padding:16px}\n.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;margin-bottom:14px}\n.ph{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 14px;border-bottom:1px solid var(--line)}\n.ph h2{margin:0;font-size:15px}\n.pb{padding:14px}\n.grid2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px;align-items:start}\n.fields{display:grid;grid-template-columns:1fr 1fr;gap:12px}\n.field{display:block}\n.field.wide{grid-column:1 / -1}\n.flabel{display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:4px}\ninput,select{width:100%;height:36px;padding:0 10px;border:1px solid #cdd5dd;border-radius:7px;font:14px var(--font);color:var(--text);background:#fff}\nbutton.btn{font:600 14px var(--font);border-radius:7px;cursor:pointer;height:36px;padding:0 14px;border:1px solid #cdd5dd;background:#fff;color:var(--text)}\nbutton.primary{background:var(--accent);border-color:var(--accent);color:#fff}\nbutton.small{height:28px;padding:0 10px;font-size:12px}\nbutton:disabled{opacity:.5;cursor:default}\n.hint{font-size:12px;color:var(--muted);margin:6px 0 0}\n.error{color:var(--bad);font-size:13px;margin:8px 0 0}\n.codebox{text-align:center}\n.code{font:700 44px/1.1 ui-monospace,Consolas,monospace;letter-spacing:6px;margin:6px 0}\n.qr{display:flex;justify-content:center;margin:10px 0}\n.qr img,.qr canvas{width:220px;height:220px}\n.linkrow{display:flex;gap:8px;margin-top:8px}\n.linkrow input{font-size:12px}\ntable{width:100%;border-collapse:collapse;font-size:13px}\nth,td{padding:7px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle}\nthead th{font-size:12px;color:var(--muted);background:var(--soft);font-weight:600;white-space:nowrap}\ntd.num,th.num{text-align:right;font-variant-numeric:tabular-nums}\n.badge{display:inline-block;font-size:11px;font-weight:700;border-radius:999px;padding:2px 8px}\n.b-acik{background:var(--good-soft);color:var(--good)}\n.b-kapali{background:#eef1f4;color:#596672}\n.b-bitti{background:var(--warn-soft);color:var(--warn)}\n.kpis{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px;margin-bottom:14px}\n.kpi{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 12px}\n.kpi span{display:block;font-size:12px;color:var(--muted)}\n.kpi b{font-size:22px;font-variant-numeric:tabular-nums}\n.hist{display:grid;grid-template-columns:repeat(10,1fr);gap:6px;align-items:end;height:160px;padding-top:10px}\n.hist .col{display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:100%}\n.hist .bar{width:100%;background:var(--accent);border-radius:4px 4px 0 0;min-height:1px}\n.hist .v{font-size:11px;color:var(--muted);margin-bottom:2px}\n.hist .lbl{font-size:10px;color:var(--muted);margin-top:4px;white-space:nowrap}\n.hbar{display:grid;grid-template-columns:minmax(140px,240px) 1fr 52px;gap:10px;align-items:center;margin:6px 0;font-size:13px}\n.track{height:12px;background:#e7ebef;border-radius:99px;overflow:hidden}\n.track div{height:100%;border-radius:99px}\n.lo{background:var(--bad)}.mid{background:#e3a008}.hi{background:var(--good)}\n.mini{display:inline-block;width:70px;height:8px;background:#e7ebef;border-radius:99px;overflow:hidden;vertical-align:middle;margin-right:6px}\n.mini i{display:block;height:100%}\n.scroll{max-height:360px;overflow:auto}\n.empty{color:var(--muted);text-align:center;padding:24px}\n.overlay{position:fixed;inset:0;background:#fff;z-index:20;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;text-align:center}\n.overlay .code{font-size:clamp(32px,9vh,72px)}\n.overlay .qr{margin:4px 0}\n.overlay .qr img,.overlay .qr canvas{width:var(--qr,300px);height:var(--qr,300px)}\n.ovbtns{position:absolute;top:12px;right:12px;display:flex;gap:8px}\n.overlay p{margin:0;color:var(--muted);font-size:18px}\n.overlay h1{margin:0;font-size:20px}\n.close{position:absolute;top:12px;right:12px}\n.loading{position:fixed;inset:0;background:rgba(243,245,247,.6);display:flex;align-items:center;justify-content:center;z-index:30;font-weight:600}\n</style>\n</head>\n<body>\n<nav class=\"tabs\" role=\"tablist\">\n  <button data-t=\"yeni\" aria-selected=\"true\">Yeni oturum</button>\n  <button data-t=\"liste\" aria-selected=\"false\">Oturumlar</button>\n  <button data-t=\"rapor\" aria-selected=\"false\">Rapor</button>\n  <span class=\"spacer\"></span>\n  <button class=\"refresh\" id=\"refresh\">Yenile</button>\n</nav>\n<main>\n  <!-- Yeni oturum -->\n  <section id=\"t-yeni\">\n    <div class=\"grid2\">\n      <form class=\"panel\" id=\"form\">\n        <div class=\"ph\"><h2>Oturum bilgileri</h2></div>\n        <div class=\"pb\">\n          <div class=\"fields\">\n            <label class=\"field wide\"><span class=\"flabel\">Sınav</span><select id=\"fSinav\" required></select></label>\n            <label class=\"field\"><span class=\"flabel\">Firma</span><input id=\"fFirma\" maxlength=\"120\" placeholder=\"Katılımcıların firması\"></label>\n            <label class=\"field\"><span class=\"flabel\">Eğitim merkezi</span><input id=\"fMerkez\" maxlength=\"120\"></label>\n            <label class=\"field\"><span class=\"flabel\">Kişi sayısı</span><input id=\"fKisi\" type=\"number\" min=\"1\" max=\"1000\" required></label>\n            <span></span>\n            <label class=\"field\"><span class=\"flabel\">Girişler açılsın</span><input id=\"fBas\" type=\"datetime-local\" required></label>\n            <label class=\"field\"><span class=\"flabel\">Girişler kapansın</span><input id=\"fBit\" type=\"datetime-local\" required></label>\n            <label class=\"field wide\"><span class=\"flabel\">Not (yalnızca sizin için)</span><input id=\"fNot\" maxlength=\"300\"></label>\n          </div>\n          <p class=\"hint\">Kapanış saati yalnızca yeni girişleri durdurur; o saate kadar başlayan katılımcı kendi süresi dolana kadar devam eder. Kişi sayısına ulaşılınca yeni giriş kabul edilmez.</p>\n          <p class=\"error\" id=\"formErr\" hidden></p>\n          <div style=\"margin-top:12px\"><button class=\"btn primary\" type=\"submit\" id=\"createBtn\">Oturum oluştur</button></div>\n        </div>\n      </form>\n      <div class=\"panel\" id=\"result\" hidden>\n        <div class=\"ph\"><h2>Giriş kodu</h2><button class=\"btn small\" id=\"fullBtn\">Tam ekran göster</button></div>\n        <div class=\"pb codebox\">\n          <div class=\"hint\" id=\"rSinav\"></div>\n          <div class=\"code\" id=\"rCode\"></div>\n          <div class=\"qr\" id=\"rQr\"></div>\n          <div class=\"linkrow\"><input id=\"rLink\" readonly><button class=\"btn\" id=\"copyBtn\">Kopyala</button></div>\n          <p class=\"hint\">Bağlantıyı katılımcılara gönderin ya da karekodu sınıfta gösterin. Herkes aynı kodla girer, ancak her katılımcının sınavı ve sonucu ayrıdır.</p>\n        </div>\n      </div>\n    </div>\n  </section>\n\n  <!-- Oturumlar -->\n  <section id=\"t-liste\" hidden>\n    <div class=\"panel\">\n      <div class=\"ph\"><h2>Oturumlar</h2></div>\n      <div class=\"pb\" style=\"padding:0\">\n        <div class=\"scroll\" style=\"max-height:640px\">\n          <table>\n            <thead><tr><th>Kod</th><th>Sınav</th><th>Firma</th><th>Eğitim merkezi</th><th>Giriş aralığı</th><th class=\"num\">Kişi</th><th class=\"num\">Devam</th><th class=\"num\">Bitti</th><th>Durum</th><th></th></tr></thead>\n            <tbody id=\"listBody\"></tbody>\n          </table>\n        </div>\n      </div>\n    </div>\n  </section>\n\n  <!-- Rapor -->\n  <section id=\"t-rapor\" hidden>\n    <div class=\"panel\"><div class=\"pb\" style=\"display:flex;gap:10px;align-items:center\">\n      <span class=\"flabel\" style=\"margin:0\">Oturum</span>\n      <select id=\"rpSel\" style=\"max-width:520px\"></select>\n      <button class=\"btn\" id=\"rpLoad\">Göster</button>\n    </div></div>\n    <div id=\"rpBody\"></div>\n  </section>\n</main>\n\n<div class=\"overlay\" id=\"overlay\" hidden>\n  <div class=\"ovbtns\"><button class=\"btn\" id=\"ovTab\">Projeksiyon için yeni sekmede aç</button><button class=\"btn\" id=\"ovClose\">Kapat</button></div>\n  <h1 id=\"ovTitle\"></h1>\n  <div class=\"qr\" id=\"ovQr\"></div>\n  <p>Karekodu okutun ya da adrese gidip kodu girin</p>\n  <div class=\"code\" id=\"ovCode\"></div>\n  <p id=\"ovLink\"></p>\n</div>\n<div class=\"loading\" id=\"loading\" hidden>Yükleniyor…</div>\n\n<script src=\"https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js\"></script>\n<script>\n(function () {\n  \"use strict\";\n  var $ = function (id) { return document.getElementById(id); };\n  var veri = null;\n  var sonKod = \"\";\n\n  function sunucu(fn, args) {\n    return new Promise(function (ok, hata) {\n      var r = google.script.run.withSuccessHandler(ok).withFailureHandler(function (e) { hata(e && e.message ? e.message : String(e)); });\n      r[fn].apply(r, args || []);\n    });\n  }\n  function yukleniyor(v) { $(\"loading\").hidden = !v; }\n  function esc(s) { return String(s == null ? \"\" : s).replace(/[&<>\"']/g, function (c) { return { \"&\": \"&amp;\", \"<\": \"&lt;\", \">\": \"&gt;\", '\"': \"&quot;\", \"'\": \"&#39;\" }[c]; }); }\n  function tarih(iso) {\n    if (!iso) return \"\";\n    var d = new Date(iso);\n    return d.toLocaleString(\"tr-TR\", { day: \"2-digit\", month: \"2-digit\", year: \"numeric\", hour: \"2-digit\", minute: \"2-digit\" });\n  }\n  function saat(iso) { return iso ? new Date(iso).toLocaleTimeString(\"tr-TR\", { hour: \"2-digit\", minute: \"2-digit\" }) : \"\"; }\n  function yerelGiris(d) {\n    var p = function (n) { return String(n).padStart(2, \"0\"); };\n    return d.getFullYear() + \"-\" + p(d.getMonth() + 1) + \"-\" + p(d.getDate()) + \"T\" + p(d.getHours()) + \":\" + p(d.getMinutes());\n  }\n  function baglanti(kod) { return (veri.sinav_sayfasi || \"\").replace(/\\/?$/, \"/\") + \"?o=\" + kod; }\n  function sinavAdi(kod) {\n    var s = (veri.sinavlar || []).filter(function (x) { return x.kod === kod; })[0];\n    return s ? s.baslik : kod;\n  }\n  function yuzdeSinif(v) { return v == null ? \"\" : v < 50 ? \"lo\" : v < 70 ? \"mid\" : \"hi\"; }\n  function yuzde(v) { return v == null ? \"-\" : \"%\" + String(v).replace(\".\", \",\"); }\n  function sayi(v) { return v == null ? \"-\" : String(v).replace(\".\", \",\"); }\n\n  function qrCiz(el, metin, boyut) {\n    el.textContent = \"\";\n    if (typeof QRCode === \"undefined\") {\n      el.innerHTML = '<p class=\"hint\">Karekod oluşturulamadı (internet bağlantısı gerekli). Bağlantıyı kullanabilirsiniz.</p>';\n      return;\n    }\n    new QRCode(el, { text: metin, width: boyut, height: boyut, correctLevel: QRCode.CorrectLevel.M });\n  }\n\n  // ---------- Sekmeler ----------\n  function sekme(t) {\n    document.querySelectorAll(\".tabs [data-t]\").forEach(function (b) { b.setAttribute(\"aria-selected\", String(b.dataset.t === t)); });\n    [\"yeni\", \"liste\", \"rapor\"].forEach(function (x) { $(\"t-\" + x).hidden = x !== t; });\n  }\n  document.querySelectorAll(\".tabs [data-t]\").forEach(function (b) { b.addEventListener(\"click\", function () { sekme(b.dataset.t); }); });\n\n  // ---------- Veri ----------\n  function yukle() {\n    yukleniyor(true);\n    return sunucu(\"panelVeri\").then(function (v) {\n      veri = v;\n      formDoldur();\n      listeCiz();\n      raporSecenekleri();\n      yukleniyor(false);\n    }).catch(function (e) { yukleniyor(false); alertHata(e); });\n  }\n  function alertHata(e) { $(\"formErr\").textContent = \"Hata: \" + e; $(\"formErr\").hidden = false; }\n\n  function formDoldur() {\n    var sel = $(\"fSinav\");\n    var secili = sel.value;\n    sel.innerHTML = veri.sinavlar.map(function (s) {\n      return '<option value=\"' + esc(s.kod) + '\">' + esc(s.baslik) + \" (\" + esc(s.kod) + \", \" + s.soru_sayisi + \" soru, \" + s.sure_dk + \" dk)</option>\";\n    }).join(\"\");\n    if (secili) sel.value = secili;\n    if (!$(\"fMerkez\").value && veri.oturumlar.length) $(\"fMerkez\").value = veri.oturumlar[0].egitim_merkezi;\n    if (!$(\"fBas\").value) {\n      var simdi = new Date();\n      simdi.setSeconds(0, 0);\n      $(\"fBas\").value = yerelGiris(simdi);\n      $(\"fBit\").value = yerelGiris(new Date(simdi.getTime() + 2 * 3600 * 1000));\n    }\n  }\n\n  // ---------- Yeni oturum ----------\n  $(\"form\").addEventListener(\"submit\", function (e) {\n    e.preventDefault();\n    $(\"formErr\").hidden = true;\n    var g = {\n      sinav: $(\"fSinav\").value,\n      firma: $(\"fFirma\").value.trim(),\n      egitim_merkezi: $(\"fMerkez\").value.trim(),\n      kontenjan: $(\"fKisi\").value,\n      baslangic: new Date($(\"fBas\").value).toISOString(),\n      bitis: new Date($(\"fBit\").value).toISOString(),\n      not: $(\"fNot\").value.trim(),\n    };\n    if (!g.kontenjan) { alertHata(\"Kişi sayısını girin.\"); return; }\n    $(\"createBtn\").disabled = true;\n    sunucu(\"oturumOlustur\", [g]).then(function (kod) {\n      $(\"createBtn\").disabled = false;\n      sonucGoster(kod, g.sinav);\n      return yukle();\n    }).catch(function (err) { $(\"createBtn\").disabled = false; alertHata(err); });\n  });\n\n  function sonucGoster(kod, sinav) {\n    sonKod = kod;\n    $(\"result\").hidden = false;\n    $(\"rCode\").textContent = kod;\n    $(\"rSinav\").textContent = sinavAdi(sinav);\n    $(\"rLink\").value = baglanti(kod);\n    qrCiz($(\"rQr\"), baglanti(kod), 220);\n  }\n  $(\"copyBtn\").addEventListener(\"click\", function () {\n    var i = $(\"rLink\");\n    i.select();\n    var ok = false;\n    try { ok = document.execCommand(\"copy\"); } catch (e) { ok = false; }\n    $(\"copyBtn\").textContent = ok ? \"Kopyalandı\" : \"Seçildi, Ctrl+C\";\n    setTimeout(function () { $(\"copyBtn\").textContent = \"Kopyala\"; }, 2000);\n  });\n  function tamEkran(kod, sinav) {\n    $(\"ovTitle\").textContent = sinavAdi(sinav);\n    $(\"ovCode\").textContent = kod;\n    $(\"ovLink\").textContent = (veri.sinav_sayfasi || \"\").replace(/^https?:\\/\\//, \"\");\n    var boyut = Math.max(160, Math.min(window.innerWidth - 80, window.innerHeight - 270, 420));\n    $(\"overlay\").style.setProperty(\"--qr\", boyut + \"px\");\n    qrCiz($(\"ovQr\"), baglanti(kod), boyut);\n    ovKod = kod;\n    $(\"overlay\").hidden = false;\n  }\n  $(\"fullBtn\").addEventListener(\"click\", function () { tamEkran(sonKod, $(\"fSinav\").value); });\n  $(\"ovClose\").addEventListener(\"click\", function () { $(\"overlay\").hidden = true; });\n  var ovKod = \"\";\n  // Projeksiyon görünümü: sınav sayfasında yalnızca karekodu ve kodu gösteren, tam ekran yapılabilen sekme.\n  $(\"ovTab\").addEventListener(\"click\", function () {\n    window.open((veri.sinav_sayfasi || \"\").replace(/\\/?$/, \"/\") + \"?qr=\" + ovKod, \"_blank\");\n  });\n\n  // ---------- Oturumlar ----------\n  function durumRozet(o) {\n    if (o.durum !== \"ACIK\") return '<span class=\"badge b-kapali\">Kapalı</span>';\n    if (o.bitis && new Date(o.bitis) < new Date()) return '<span class=\"badge b-bitti\">Süresi bitti</span>';\n    if (o.baslangic && new Date(o.baslangic) > new Date()) return '<span class=\"badge b-bitti\">Başlamadı</span>';\n    return '<span class=\"badge b-acik\">Açık</span>';\n  }\n  function listeCiz() {\n    var tb = $(\"listBody\");\n    if (!veri.oturumlar.length) { tb.innerHTML = '<tr><td colspan=\"10\" class=\"empty\">Henüz oturum yok.</td></tr>'; return; }\n    tb.innerHTML = veri.oturumlar.map(function (o) {\n      return \"<tr><td><b>\" + esc(o.kod) + \"</b></td><td>\" + esc(sinavAdi(o.sinav)) + \"</td><td>\" + esc(o.firma) + \"</td><td>\" + esc(o.egitim_merkezi) +\n        \"</td><td>\" + esc(tarih(o.baslangic)) + \" - \" + esc(saat(o.bitis)) + '</td><td class=\"num\">' + (o.basladi + o.tamamlandi) + \" / \" + o.kontenjan +\n        '</td><td class=\"num\">' + o.basladi + '</td><td class=\"num\">' + o.tamamlandi + \"</td><td>\" + durumRozet(o) +\n        '</td><td style=\"white-space:nowrap\"><button class=\"btn small\" data-a=\"qr\" data-k=\"' + esc(o.kod) + '\">Karekod</button> ' +\n        '<button class=\"btn small\" data-a=\"rapor\" data-k=\"' + esc(o.kod) + '\">Rapor</button> ' +\n        '<button class=\"btn small\" data-a=\"' + (o.durum === \"ACIK\" ? \"kapat\" : \"ac\") + '\" data-k=\"' + esc(o.kod) + '\">' + (o.durum === \"ACIK\" ? \"Kapat\" : \"Aç\") + \"</button></td></tr>\";\n    }).join(\"\");\n  }\n  $(\"listBody\").addEventListener(\"click\", function (e) {\n    var b = e.target.closest(\"button[data-a]\");\n    if (!b) return;\n    var kod = b.dataset.k;\n    var o = veri.oturumlar.filter(function (x) { return x.kod === kod; })[0];\n    if (b.dataset.a === \"qr\") tamEkran(kod, o.sinav);\n    if (b.dataset.a === \"rapor\") { sekme(\"rapor\"); $(\"rpSel\").value = kod; raporYukle(); }\n    if (b.dataset.a === \"kapat\" || b.dataset.a === \"ac\") {\n      b.disabled = true;\n      sunucu(\"oturumDurumDegistir\", [kod, b.dataset.a === \"ac\"]).then(yukle).catch(alertHata);\n    }\n  });\n\n  // ---------- Rapor ----------\n  function raporSecenekleri() {\n    var sel = $(\"rpSel\");\n    var secili = sel.value;\n    sel.innerHTML = veri.oturumlar.map(function (o) {\n      return '<option value=\"' + esc(o.kod) + '\">' + esc(o.kod) + \" · \" + esc(sinavAdi(o.sinav)) + (o.firma ? \" · \" + esc(o.firma) : \"\") + \" · \" + esc(tarih(o.baslangic)) + \"</option>\";\n    }).join(\"\");\n    if (secili) sel.value = secili;\n  }\n  $(\"rpLoad\").addEventListener(\"click\", raporYukle);\n\n  function raporYukle() {\n    var kod = $(\"rpSel\").value;\n    if (!kod) { $(\"rpBody\").innerHTML = '<div class=\"panel\"><div class=\"empty\">Önce bir oturum oluşturun.</div></div>'; return; }\n    yukleniyor(true);\n    sunucu(\"oturumRaporu\", [kod]).then(function (r) { yukleniyor(false); raporCiz(r); }).catch(function (e) { yukleniyor(false); $(\"rpBody\").innerHTML = '<p class=\"error\">' + esc(e) + \"</p>\"; });\n  }\n\n  function raporCiz(r) {\n    var h = \"\";\n    h += '<div class=\"kpis\">' +\n      kpi(\"Katılan\", r.katilan) + kpi(\"Devam eden\", r.devam_eden) + kpi(\"Tamamlayan\", r.tamamlayan) +\n      kpi(\"Ortalama puan\", sayi(r.ortalama)) + kpi(\"Medyan\", sayi(r.medyan)) +\n      kpi(\"En düşük / en yüksek\", r.tamamlayan ? sayi(r.en_dusuk) + \" / \" + sayi(r.en_yuksek) : \"-\") + \"</div>\";\n    if (!r.tamamlayan) {\n      h += '<div class=\"panel\"><div class=\"empty\">Bu oturumda henüz sınavını bitiren yok.</div></div>';\n      h += katilimciTablo(r);\n      $(\"rpBody\").innerHTML = h;\n      return;\n    }\n    var max = Math.max.apply(null, r.dagilim.concat([1]));\n    h += '<div class=\"grid2\"><div class=\"panel\"><div class=\"ph\"><h2>Puan dağılımı</h2><span class=\"hint\" style=\"margin:0\">kişi sayısı</span></div><div class=\"pb\"><div class=\"hist\">' +\n      r.dagilim.map(function (v, i) {\n        return '<div class=\"col\"><span class=\"v\">' + (v || \"\") + '</span><div class=\"bar\" style=\"height:' + (v / max * 100) + '%\"></div><span class=\"lbl\">' + (i * 10) + \"-\" + (i === 9 ? 100 : i * 10 + 9) + \"</span></div>\";\n      }).join(\"\") + \"</div></div></div>\";\n    h += '<div class=\"panel\"><div class=\"ph\"><h2>Bölüm bazında başarı</h2><span class=\"hint\" style=\"margin:0\">doğru cevap oranı</span></div><div class=\"pb\">' +\n      r.bolumler.map(function (b) {\n        return '<div class=\"hbar\"><span title=\"' + esc(b.ad) + '\">' + esc(b.ad) + ' <span class=\"hint\">(' + b.soru + ' soru)</span></span><div class=\"track\"><div class=\"' + yuzdeSinif(b.yuzde) + '\" style=\"width:' + (b.yuzde || 0) + '%\"></div></div><b class=\"num\">' + yuzde(b.yuzde) + \"</b></div>\";\n      }).join(\"\") + \"</div></div></div>\";\n\n    var sorular = r.sorular.slice().sort(function (a, b) { return a.dogru_yuzde - b.dogru_yuzde || a.no - b.no; });\n    h += '<div class=\"panel\"><div class=\"ph\"><h2>Soru analizi</h2><span class=\"hint\" style=\"margin:0\">en zordan en kolaya; doğru oranı düşük ve tek bir yanlış şıkta toplanan sorular yeniden gözden geçirilmeye değer</span></div><div class=\"scroll\"><table><thead><tr><th class=\"num\">No</th><th>Bölüm</th><th>Soru</th><th>Doğru oranı</th><th>Doğru</th><th>En sık yanlış</th><th>Seçimler</th></tr></thead><tbody>' +\n      sorular.map(function (q) {\n        var sec = Object.keys(q.secim).sort().map(function (k) { return (k === \"-\" ? \"boş\" : k === \"?\" ? \"bilmiyorum\" : k) + \":\" + q.secim[k]; }).join(\"  \");\n        return '<tr><td class=\"num\">' + q.no + \"</td><td>\" + esc(q.bolum) + '</td><td title=\"' + esc(q.soru) + '\">' + esc(q.soru.length > 70 ? q.soru.slice(0, 70) + \"…\" : q.soru) +\n          '</td><td style=\"white-space:nowrap\"><span class=\"mini\"><i class=\"' + yuzdeSinif(q.dogru_yuzde) + '\" style=\"width:' + (q.dogru_yuzde || 0) + '%\"></i></span>' + yuzde(q.dogru_yuzde) +\n          \"</td><td>\" + esc(q.dogru_cevap) + \"</td><td>\" + (q.en_sik_yanlis ? esc(q.en_sik_yanlis) + \" (\" + q.en_sik_yanlis_sayi + \")\" : \"\") + '</td><td class=\"hint\" style=\"margin:0\">' + esc(sec) + \"</td></tr>\";\n      }).join(\"\") + \"</tbody></table></div></div>\";\n    h += katilimciTablo(r);\n    $(\"rpBody\").innerHTML = h;\n  }\n  function kpi(ad, v) { return '<div class=\"kpi\"><span>' + ad + \"</span><b>\" + v + \"</b></div>\"; }\n  function katilimciTablo(r) {\n    var durumAd = { basladi: \"Devam ediyor\", tamamlandi: \"Bitirdi\" };\n    var k = r.katilimcilar.slice().sort(function (a, b) { return (b.puan == null ? -1 : b.puan) - (a.puan == null ? -1 : a.puan); });\n    return '<div class=\"panel\"><div class=\"ph\"><h2>Katılımcılar</h2><span class=\"hint\" style=\"margin:0\">Ayrıntılı veri: Sonuclar ve Detay sekmeleri</span></div><div class=\"scroll\"><table><thead><tr><th>Ad soyad</th><th>Firma</th><th>Görev</th><th>Başlama</th><th>Durum</th><th class=\"num\">Doğru</th><th class=\"num\">Puan</th></tr></thead><tbody>' +\n      (k.length ? k.map(function (x) {\n        return \"<tr><td>\" + esc(x.ad + \" \" + x.soyad) + \"</td><td>\" + esc(x.firma) + \"</td><td>\" + esc(x.gorev) + \"</td><td>\" + esc(tarih(x.baslama)) + \"</td><td>\" + (durumAd[x.durum] || esc(x.durum)) +\n          '</td><td class=\"num\">' + sayi(x.dogru) + '</td><td class=\"num\">' + sayi(x.puan) + \"</td></tr>\";\n      }).join(\"\") : '<tr><td colspan=\"7\" class=\"empty\">Henüz katılan yok.</td></tr>') + \"</tbody></table></div></div>\";\n  }\n\n  $(\"refresh\").addEventListener(\"click\", function () {\n    yukle().then(function () { if (!$(\"t-rapor\").hidden && $(\"rpSel\").value) raporYukle(); });\n  });\n\n  yukle();\n})();\n</script>\n</body>\n</html>\n";
