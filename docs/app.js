// Sınav sayfası. Bu dosyada soru, cevap ya da sınava özel metin yoktur:
// hepsi, kişiye özel davet kodu doğrulandıktan sonra Google Apps Script'ten gelir.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const API = window.SINAV_API;
  const kod = new URLSearchParams(location.search).get("k") || "";
  const yerelAnahtar = "sinav:" + kod;

  const HATALAR = {
    gecersiz_kod: "Bu bağlantı geçerli değil. Lütfen size gönderilen bağlantıyı eksiksiz açın.",
    sinav_kapali: "Bu sınav şu anda erişime kapalı.",
    tamamlandi: "Bu bağlantıyla sınav daha önce tamamlandı. Her bağlantı yalnızca bir kez kullanılabilir.",
    suresi_doldu: "Bu bağlantının geçerlilik süresi dolmuş.",
    sure_bitti: "Sınav süreniz dolmuş.",
    eksik_bilgi: "Lütfen adınızı ve soyadınızı yazın.",
    kvkk_onayi_yok: "Devam etmek için aydınlatma metnini onaylamanız gerekiyor.",
    ag: "Sunucuya ulaşılamadı. İnternet bağlantınızı kontrol edip tekrar deneyin.",
  };

  let sinav = null;
  let sorular = [];
  let cevaplar = {};
  let aktif = 0;
  let bitis = 0; // süre bitiş zamanı (ms)
  let sayac = null;
  let gonderiliyor = false;
  let kayitZamanlayici = null;

  // ---------- Sunucu ----------
  async function cagir(islem, veri, deneme) {
    try {
      const r = await fetch(API, { method: "POST", body: JSON.stringify(Object.assign({ islem, kod }, veri || {})) });
      return await r.json();
    } catch (e) {
      if ((deneme || 0) < 2) {
        await new Promise((res) => setTimeout(res, 1500));
        return cagir(islem, veri, (deneme || 0) + 1);
      }
      return { ok: false, hata: "ag" };
    }
  }

  // ---------- Görünümler ----------
  function goster(id) {
    ["vMessage", "vStart", "vExam", "vDone"].forEach((v) => ($(v).hidden = v !== id));
    window.scrollTo(0, 0);
  }
  function mesaj(metin) {
    $("message").textContent = metin;
    goster("vMessage");
  }
  function hataMetni(h) {
    return HATALAR[h] || "Beklenmeyen bir sorun oluştu. Lütfen sınav görevlisine haber verin.";
  }

  // Tablodaki çok satırlı metni paragraf ve liste olarak gösterir (HTML kabul etmez).
  function metinYaz(kap, metin) {
    kap.textContent = "";
    let liste = null;
    String(metin || "")
      .split(/\r?\n/)
      .forEach((satir) => {
        const s = satir.trim();
        if (!s) {
          liste = null;
          return;
        }
        const m = s.match(/^(\d+[.)]|[-•])\s+(.*)$/);
        if (m) {
          if (!liste) {
            liste = document.createElement(/^\d/.test(m[1]) ? "ol" : "ul");
            kap.appendChild(liste);
          }
          const li = document.createElement("li");
          li.textContent = m[2];
          liste.appendChild(li);
        } else {
          liste = null;
          const p = document.createElement("p");
          p.textContent = s;
          kap.appendChild(p);
        }
      });
  }

  // ---------- Giriş ----------
  async function baslangic() {
    if (!API || API.indexOf("script.google.com") < 0 && API.indexOf("localhost") < 0) {
      mesaj("Sınav sayfası henüz yapılandırılmamış.");
      return;
    }
    if (!/^[a-f0-9]{16,32}$/.test(kod)) {
      mesaj(HATALAR.gecersiz_kod);
      return;
    }
    const b = await cagir("bilgi");
    if (!b.ok) {
      mesaj(hataMetni(b.hata));
      return;
    }
    sinav = b.sinav;
    $("examTitle").textContent = sinav.baslik;
    $("examSub").textContent = sinav.alt_baslik;
    document.title = sinav.baslik;
    $("fCount").textContent = sinav.soru_sayisi;
    $("fTime").textContent = sinav.sure_dk + " dakika";
    metinYaz($("instructions"), sinav.aciklama);
    if (sinav.hazirlayan) {
      $("author").textContent = "Hazırlayan: " + sinav.hazirlayan;
      $("author").hidden = false;
    }
    $("wFirma").hidden = !sinav.firma_sor;
    $("wGorev").hidden = !sinav.gorev_sor;
    if (sinav.kvkk) {
      $("wKvkk").hidden = false;
      metinYaz($("kvkkText"), sinav.kvkk);
    }
    $("pAd").value = b.onceden.ad;
    $("pSoyad").value = b.onceden.soyad;
    $("pFirma").value = b.onceden.firma;
    $("pGorev").value = b.onceden.gorev;
    if (b.basladi) {
      // Daha önce başlamış: kimlik alanları kilitli, devam düğmesi.
      ["pAd", "pSoyad", "pFirma", "pGorev"].forEach((id) => ($(id).disabled = true));
      $("wKvkk").hidden = true;
      $("startBtn").textContent = "Sınava devam et";
      $("startHint").textContent = "Sınavınız daha önce başlamış. Süre kaldığı yerden işlemeye devam ediyor.";
    }
    goster("vStart");
  }

  async function basla(e) {
    e.preventDefault();
    const err = $("startError");
    err.hidden = true;
    const k = {
      ad: $("pAd").value.trim(),
      soyad: $("pSoyad").value.trim(),
      firma: $("pFirma").value.trim(),
      gorev: $("pGorev").value.trim(),
      kvkk: $("pKvkk").checked,
    };
    if (!$("pAd").disabled) {
      if (!k.ad || !k.soyad) return hataGoster("eksik_bilgi");
      if (sinav.kvkk && !k.kvkk) return hataGoster("kvkk_onayi_yok");
    }
    $("startBtn").disabled = true;
    $("startBtn").textContent = "Sorular yükleniyor…";
    const r = await cagir("basla", { katilimci: k });
    $("startBtn").disabled = false;
    $("startBtn").textContent = "Sınava başla";
    if (!r.ok) {
      if (["tamamlandi", "sure_bitti", "sinav_kapali", "gecersiz_kod"].includes(r.hata)) return mesaj(hataMetni(r.hata));
      return hataGoster(r.hata);
    }
    sorular = r.sorular;
    // Sunucudaki ara kayıt ile bu tarayıcıdaki kayıttan yenisi kullanılır.
    let yerel = {};
    try {
      yerel = JSON.parse(localStorage.getItem(yerelAnahtar) || "{}");
    } catch (x) {
      yerel = {};
    }
    cevaplar = Object.assign({}, r.cevaplar || {}, yerel.cevaplar || {});
    aktif = Math.min(Number(yerel.aktif) || 0, sorular.length - 1);
    bitis = Date.now() + r.kalan_sn * 1000;
    $("lgDk").hidden = !r.bilmiyorum;
    sinav.bilmiyorum = r.bilmiyorum;
    navCiz();
    soruCiz();
    sayacBaslat();
    goster("vExam");

    function hataGoster(h) {
      err.textContent = hataMetni(h);
      err.hidden = false;
    }
  }

  // ---------- Sınav ----------
  function navCiz() {
    const nav = $("qnav");
    nav.textContent = "";
    sorular.forEach((q, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = q.no;
      b.setAttribute("role", "listitem");
      b.setAttribute("aria-label", "Soru " + q.no);
      b.addEventListener("click", () => git(i));
      nav.appendChild(b);
    });
    navGuncelle();
  }

  function navGuncelle() {
    const btn = $("qnav").children;
    let n = 0;
    sorular.forEach((q, i) => {
      const c = cevaplar[q.no];
      btn[i].className = (c === "?" ? "dk" : c ? "ans" : "") + (i === aktif ? " cur" : "");
      if (c) n++;
    });
    $("answeredCount").textContent = n + " / " + sorular.length;
  }

  function soruCiz() {
    const q = sorular[aktif];
    $("qHead").textContent = "Soru " + q.no;
    $("qSection").textContent = q.bolum;
    $("qGroup").hidden = !(q.grup_notu || q.grup_gorsel);
    $("qGroupNote").textContent = q.grup_notu;
    const gi = $("qGroupImg");
    gi.hidden = !q.grup_gorsel;
    if (q.grup_gorsel) gi.src = q.grup_gorsel;
    $("qText").textContent = q.soru;
    const imgs = $("qImgs");
    imgs.textContent = "";
    q.gorseller.forEach((src) => {
      if (!src) return;
      const im = document.createElement("img");
      im.src = src;
      im.alt = "Soru " + q.no + " şekli";
      imgs.appendChild(im);
    });

    const ops = $("qOptions");
    ops.textContent = "";
    const sec = cevaplar[q.no];
    $("qNumeric").hidden = q.tur !== "sayi";
    ops.hidden = q.tur === "sayi";
    if (q.tur === "sayi") {
      $("qNumInput").value = sec && sec !== "?" ? sec : "";
      $("qUnit").textContent = q.birim || "";
    } else {
      const harf = "ABCDE";
      const liste = q.secenekler.slice();
      liste.forEach((o, i) => ops.appendChild(secenek(harf[i] + ")", o.metin, o.id, sec === o.id)));
      if (sinav.bilmiyorum) ops.appendChild(secenek("", "Bilmiyorum", "?", sec === "?", true));
    }
    $("prevBtn").disabled = aktif === 0;
    $("nextBtn").textContent = aktif === sorular.length - 1 ? "Bitir" : "Sonraki";
    navGuncelle();
  }

  function secenek(etiket, metin, id, secili, dk) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "opt" + (secili ? " sel" : "") + (dk ? " dkopt" : "");
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(secili));
    const l = document.createElement("span");
    l.className = "olabel";
    l.textContent = etiket;
    const t = document.createElement("span");
    t.className = "otext";
    t.textContent = metin;
    if (etiket) b.appendChild(l);
    b.appendChild(t);
    b.addEventListener("click", () => {
      cevapla(id);
      soruCiz();
    });
    return b;
  }

  function cevapla(v) {
    const q = sorular[aktif];
    if (v === null || v === "") delete cevaplar[q.no];
    else cevaplar[q.no] = v;
    yerelKaydet();
    sunucuyaKaydet();
  }

  function git(i) {
    aktif = Math.max(0, Math.min(sorular.length - 1, i));
    yerelKaydet();
    soruCiz();
    const panel = document.querySelector(".qpanel");
    if (panel.getBoundingClientRect().top < 80) panel.scrollIntoView({ block: "start" });
  }

  function yerelKaydet() {
    try {
      localStorage.setItem(yerelAnahtar, JSON.stringify({ cevaplar, aktif }));
    } catch (e) {
      /* tarayıcı belleği kapalıysa yalnızca sunucu kaydı kullanılır */
    }
  }

  function sunucuyaKaydet() {
    $("saveState").textContent = "Kaydediliyor…";
    clearTimeout(kayitZamanlayici);
    kayitZamanlayici = setTimeout(async () => {
      const r = await cagir("kaydet", { cevaplar });
      $("saveState").textContent = r.ok ? "Cevaplarınız kaydedildi." : "Kaydedilemedi; bağlantı gelince tekrar denenecek.";
    }, 1200);
  }

  // ---------- Süre ----------
  function sayacBaslat() {
    $("timer").hidden = false;
    clearInterval(sayac);
    const tik = () => {
      const kalan = Math.max(0, Math.round((bitis - Date.now()) / 1000));
      const dk = Math.floor(kalan / 60);
      const sn = kalan % 60;
      $("timeLeft").textContent = String(dk).padStart(2, "0") + ":" + String(sn).padStart(2, "0");
      $("timer").classList.toggle("low", kalan <= 300);
      if (kalan === 0) {
        clearInterval(sayac);
        gonder(true);
      }
    };
    tik();
    sayac = setInterval(tik, 1000);
  }

  // ---------- Bitirme ----------
  function bitirSor() {
    const bos = sorular.filter((q) => !cevaplar[q.no]).length;
    $("confirmText").textContent =
      bos > 0
        ? bos + " soru boş. Bitirdikten sonra cevaplarınızı değiştiremezsiniz."
        : "Tüm soruları cevapladınız. Bitirdikten sonra cevaplarınızı değiştiremezsiniz.";
    const d = $("confirm");
    d.returnValue = "";
    d.showModal();
  }

  async function gonder(sureDoldu) {
    if (gonderiliyor) return;
    gonderiliyor = true;
    clearTimeout(kayitZamanlayici);
    mesaj(sureDoldu ? "Süreniz doldu. Cevaplarınız gönderiliyor…" : "Cevaplarınız gönderiliyor…");
    $("timer").hidden = true;
    let r = await cagir("bitir", { cevaplar });
    for (let i = 0; !r.ok && r.hata === "ag" && i < 5; i++) {
      $("message").textContent = "Bağlantı bekleniyor, cevaplarınız gönderilmeye çalışılıyor…";
      await new Promise((res) => setTimeout(res, 4000));
      r = await cagir("bitir", { cevaplar });
    }
    if (r.ok) {
      try {
        localStorage.removeItem(yerelAnahtar);
      } catch (e) {
        /* yok say */
      }
      clearInterval(sayac);
      goster("vDone");
    } else {
      gonderiliyor = false;
      mesaj("Cevaplarınız gönderilemedi. Lütfen bu sayfayı kapatmadan sınav görevlisine haber verin. Cevaplarınız bu tarayıcıda saklanıyor; aynı bağlantıyı yeniden açarak tekrar gönderebilirsiniz.");
    }
  }

  // ---------- Olaylar ----------
  $("startForm").addEventListener("submit", basla);
  $("prevBtn").addEventListener("click", () => git(aktif - 1));
  $("nextBtn").addEventListener("click", () => (aktif === sorular.length - 1 ? bitirSor() : git(aktif + 1)));
  $("clearBtn").addEventListener("click", () => {
    cevapla(null);
    soruCiz();
  });
  $("finishBtn").addEventListener("click", bitirSor);
  $("qNumInput").addEventListener("input", (e) => {
    const v = e.target.value.trim();
    cevapla(/^-?\d+([.,]\d+)?$/.test(v) ? v : null);
    navGuncelle();
  });
  $("confirm").addEventListener("close", () => {
    if ($("confirm").returnValue === "yes") gonder(false);
  });
  document.addEventListener("keydown", (e) => {
    if ($("vExam").hidden || $("confirm").open || e.target.tagName === "INPUT") return;
    if (e.key === "ArrowRight") git(aktif + 1);
    if (e.key === "ArrowLeft") git(aktif - 1);
  });
  window.addEventListener("beforeunload", (e) => {
    if (!$("vExam").hidden && !gonderiliyor) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  baslangic();
})();
