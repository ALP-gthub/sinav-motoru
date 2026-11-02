/**
 * Sınav motoru: Google Apps Script arka ucu.
 *
 * Bu dosya, sınav sorularının, cevap anahtarının ve sonuçların durduğu
 * Google E-Tablo'ya bağlıdır (Uzantılar > Apps Script). Web uygulaması olarak
 * yayınlanır ve sınav sayfası yalnızca bu adresle konuşur.
 *
 * Gizlilik kuralları:
 *  - Sorular yalnızca geçerli, kişiye özel bir davet koduyla verilir.
 *  - Cevap anahtarı hiçbir zaman tarayıcıya gönderilmez; puanlama burada yapılır.
 *  - Katılımcıya puan gösterilmez; sonuçlar yalnızca bu tabloya yazılır.
 *
 * Sekmeler: Ayarlar, Sinavlar, Sorular, Davetler, Sonuclar,
 * ve her sınav için otomatik açılan Detay_<SINAV KODU>.
 */

var SURE_TOLERANSI_SN = 120; // Bağlantı gecikmesi için gönderimde tanınan ek süre.

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
  var kod = String(istek.kod || "").trim();
  if (!/^[a-f0-9]{16,32}$/.test(kod)) return { ok: false, hata: "gecersiz_kod" };
  switch (istek.islem) {
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
// İşlemler
// ---------------------------------------------------------------------------

/** Davet kodunu doğrular; soru göndermeden sınavın genel bilgilerini verir. */
function bilgi_(kod) {
  var d = davetBul_(kod);
  if (!d) return { ok: false, hata: "gecersiz_kod" };
  var s = sinavBul_(d.kayit.sinav);
  if (!s || !evet_(s.aktif)) return { ok: false, hata: "sinav_kapali" };
  if (d.kayit.durum === "tamamlandi") return { ok: false, hata: "tamamlandi" };
  if (d.kayit.son_tarih && new Date(d.kayit.son_tarih).getTime() < Date.now()) return { ok: false, hata: "suresi_doldu" };
  return {
    ok: true,
    sinav: {
      baslik: s.baslik,
      alt_baslik: s.alt_baslik || "",
      hazirlayan: s.hazirlayan || "",
      sure_dk: Number(s.sure_dk),
      soru_sayisi: sorular_(s.kod).length,
      aciklama: s.aciklama || "",
      kvkk: s.kvkk_metni || "",
      firma_sor: evet_(s.firma_sor),
      gorev_sor: evet_(s.gorev_sor),
    },
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
    if (!s || !evet_(s.aktif)) return { ok: false, hata: "sinav_kapali" };
    if (d.kayit.durum === "tamamlandi") return { ok: false, hata: "tamamlandi" };
    if (d.kayit.son_tarih && new Date(d.kayit.son_tarih).getTime() < Date.now()) return { ok: false, hata: "suresi_doldu" };

    var simdi = new Date();
    var guncelle = {};
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
    var kalan = Math.round(Number(s.sure_dk) * 60 - (simdi.getTime() - baslama.getTime()) / 1000);
    if (kalan <= 0) return { ok: false, hata: "sure_bitti" };

    var araKayit = {};
    try {
      araKayit = d.kayit.ara_kayit ? JSON.parse(d.kayit.ara_kayit) : {};
    } catch (e) {
      araKayit = {};
    }

    return {
      ok: true,
      kalan_sn: kalan,
      bilmiyorum: evet_(s.bilmiyorum),
      sorular: katilimciSorulari_(s, kod),
      cevaplar: araKayit,
    };
  } finally {
    kilit.releaseLock();
  }
}

/** Ara kayıt: tarayıcı kapanırsa cevaplar kaybolmasın. */
function kaydet_(kod, cevaplar) {
  var d = davetBul_(kod);
  if (!d || d.kayit.durum !== "basladi") return { ok: false, hata: "kayit_yok" };
  var temiz = cevaplariTemizle_(cevaplar);
  satirGuncelle_("Davetler", d.satir, { ara_kayit: JSON.stringify(temiz), son_kayit: new Date() });
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

    var sonuclar = sayfa_("Sonuclar");
    sonuclar.appendRow([
      simdi,
      s.kod,
      kod,
      d.kayit.ad,
      d.kayit.soyad,
      d.kayit.firma,
      d.kayit.gorev,
      baslama,
      simdi,
      Math.round(sureSn / 6) / 10,
      asim ? "EVET" : "",
      p.dogru,
      p.yanlis,
      p.bos,
      p.bilmiyorum,
      p.toplam,
      p.puan,
      p.bolumMetni,
    ]);
    detayYaz_(s.kod, sorular, d.kayit, p, simdi);
    satirGuncelle_("Davetler", d.satir, { durum: "tamamlandi", bitis: simdi, ara_kayit: JSON.stringify(temiz) });
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
 * cevaplar: { "<no>": "A" | "B" | "C" | "D" | "?" (bilmiyorum) | "<sayı>" }
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

/** Davet koduna bağlı, her açılışta aynı kalan karıştırma. */
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

function sayfa_(ad) {
  var sh = SpreadsheetApp.getActive().getSheetByName(ad);
  if (!sh) throw new Error("Sekme bulunamadı: " + ad);
  return sh;
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

function satirGuncelle_(ad, satir, alanlar) {
  var sh = sayfa_(ad);
  var basliklar = sh
    .getRange(1, 1, 1, sh.getLastColumn())
    .getValues()[0]
    .map(function (b) {
      return String(b).trim();
    });
  Object.keys(alanlar).forEach(function (k) {
    var j = basliklar.indexOf(k);
    if (j < 0) throw new Error(ad + " sekmesinde sütun yok: " + k);
    sh.getRange(satir, j + 1).setValue(alanlar[k]);
  });
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
    var baslik = ustBasliklar
      .concat(p.bolumSira)
      .concat(
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
// Tablo menüsü: kurulum ve davet bağlantıları
// ---------------------------------------------------------------------------

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Sınav")
    .addItem("Davet bağlantıları oluştur", "davetOlustur")
    .addItem("Eksik sekmeleri oluştur", "kurulum")
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
  ],
};

function kurulum() {
  var ss = SpreadsheetApp.getActive();
  Object.keys(BASLIKLAR).forEach(function (ad) {
    var sh = ss.getSheetByName(ad) || ss.insertSheet(ad);
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, BASLIKLAR[ad].length).setValues([BASLIKLAR[ad]]).setFontWeight("bold");
      sh.setFrozenRows(1);
    }
  });
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
  var sh = sayfa_("Davetler");
  var basliklar = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var satirlar = [];
  for (var i = 0; i < n; i++) {
    var kod = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, "").slice(0, 24);
    var o = { kod: kod, sinav: sinavKodu, baglanti: adres.replace(/\/?$/, "/") + "?k=" + kod, durum: "bekliyor" };
    satirlar.push(
      basliklar.map(function (b) {
        return o[b] !== undefined ? o[b] : "";
      })
    );
  }
  sh.getRange(sh.getLastRow() + 1, 1, n, basliklar.length).setValues(satirlar);
  ui.alert(n + " davet bağlantısı Davetler sekmesine eklendi. Her bağlantıyı yalnızca bir kişiye gönderin.");
}

function ayar_(anahtar) {
  var t = tablo_("Ayarlar");
  for (var i = 0; i < t.kayitlar.length; i++) {
    if (String(t.kayitlar[i].kayit.anahtar).trim() === anahtar) return String(t.kayitlar[i].kayit.deger).trim();
  }
  return "";
}

// Node.js testleri için (Apps Script'te etkisi yoktur).
if (typeof module !== "undefined") {
  module.exports = { puanla: puanla, karistir_: karistir_, cevaplariTemizle_: cevaplariTemizle_, isle_: isle_, BASLIKLAR: BASLIKLAR };
}
