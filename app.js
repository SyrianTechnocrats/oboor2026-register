/* صفحة التسجيل — التكنوقراط السوريون
 * كل المحتوى والتصميم والحقول تأتي من config.json. لا حاجة لتعديل هذا الملف عادةً.
 */
(function () {
  "use strict";

  // الحقول الأساسية الثابتة: لا يمكن حذفها ولا تغيير مفتاحها أو نوعها أو إلزاميتها من config.json
  // يمكن فقط تعديل label و columnLabel و placeholder و help و half
  var LOCKED_FIELDS = [
    { key: "firstName", label: "الاسم", type: "text", required: true },
    { key: "lastName", label: "الكنية", type: "text", required: true }
  ];
  var LOCKED_EDITABLE = ["label", "columnLabel", "placeholder", "help", "half"];
  var STORE_KEY = "sto_reg_v1";
  var DEVICE_KEY = "sto_device_id";

  // رموز الدول ISO 3166 (الأسماء العربية تأتي من المتصفح نفسه)
  var COUNTRY_CODES = ("AF AL DZ AD AO AG AR AM AU AT AZ BS BH BD BB BY BE BZ BJ BT BO BA BW BR BN BG BF BI CV KH CM CA CF TD CL CN CO KM CG CD CR CI HR CU CY CZ DK DJ DM DO EC EG SV GQ ER EE SZ ET FJ FI FR GA GM GE DE GH GR GD GT GN GW GY HT HN HK HU IS IN ID IR IQ IE IL IT JM JP JO KZ KE KI XK KW KG LA LV LB LS LR LY LI LT LU MO MG MW MY MV ML MT MH MR MU MX FM MD MC MN ME MA MZ MM NA NR NP NL NZ NI NE NG KP MK NO OM PK PW PS PA PG PY PE PH PL PT PR QA RO RU RW KN LC VC WS SM ST SA SN RS SC SL SG SK SI SB SO ZA KR SS ES LK SD SR SE CH SY TW TJ TZ TH TL TG TO TT TN TR TM TV UG UA AE GB US UY UZ VU VA VE VN YE ZM ZW").split(" ");

  var cfg = null;
  var fields = [];
  var $ = function (id) { return document.getElementById(id); };

  /* ---------- تخزين محلي (localStorage + cookie احتياطاً) ---------- */
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function cookieGet(k) {
    var m = document.cookie.match(new RegExp("(?:^|; )" + k + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : null;
  }
  function cookieSet(k, v) {
    document.cookie = k + "=" + encodeURIComponent(v) + "; max-age=" + 60 * 60 * 24 * 400 + "; path=/; SameSite=Lax";
  }
  function persist(k, v) { lsSet(k, v); cookieSet(k, v); }
  function recall(k) { return lsGet(k) || cookieGet(k); }
  function storeKey() { return STORE_KEY + (cfg.eventId ? "_" + cfg.eventId : ""); }

  function getDeviceId() {
    var id = recall(DEVICE_KEY);
    if (!id) {
      id = (window.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
      persist(DEVICE_KEY, id);
    }
    return id;
  }
  function getRecord() {
    var raw = recall(storeKey());
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }
  function saveRecord(r) { persist(storeKey(), JSON.stringify(r)); }

  /* بصمة تقريبية للجهاز — تُحفظ في الجدول للمراجعة فقط ولا تمنع التسجيل */
  function fingerprint() {
    var parts = [
      navigator.userAgent, navigator.language, screen.width + "x" + screen.height,
      screen.colorDepth, window.devicePixelRatio, navigator.hardwareConcurrency || "",
      Intl.DateTimeFormat().resolvedOptions().timeZone || ""
    ].join("|");
    var h = 2166136261;
    for (var i = 0; i < parts.length; i++) { h ^= parts.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16);
  }

  /* ---------- كشف الهاتف ---------- */
  function isMobile() {
    if (navigator.userAgentData && navigator.userAgentData.mobile === true) return true;
    var ua = navigator.userAgent || "";
    if (/Android|iPhone|iPad|iPod|Mobile|IEMobile|Opera Mini/i.test(ua)) return true;
    if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return true; // iPadOS
    return false;
  }

  /* ---------- أدوات ---------- */
  function fill(tpl, vars) {
    return String(tpl || "").replace(/\{\{(\w+)\}\}/g, function (_, k) { return vars[k] != null ? vars[k] : ""; });
  }
  function t(k) { return (cfg.texts && cfg.texts[k]) || ""; }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function show(id) {
    ["state-loading", "state-form", "state-desktop", "state-pending", "state-done", "state-blocked"].forEach(function (s) {
      $(s).hidden = s !== id;
    });
  }
  function normalizePhone(v) {
    var d = String(v || "").replace(/[٠-٩]/g, function (c) { return "٠١٢٣٤٥٦٧٨٩".indexOf(c); })
      .replace(/[۰-۹]/g, function (c) { return "۰۱۲۳۴۵۶۷۸۹".indexOf(c); })
      .replace(/\D/g, "");
    if (d.indexOf("00") === 0) d = d.slice(2);
    return d;
  }
  function waEnabled() { return normalizePhone(cfg.whatsappNumber).length >= 8; }
  function waUrl(text) {
    return "https://wa.me/" + normalizePhone(cfg.whatsappNumber) + "?text=" + encodeURIComponent(text);
  }
  function colLabel(f) { return f.columnLabel || f.label || f.key; }

  /* خيارات الحقل: نص، أو كائن {label, value, group, specify}، أو "@اسم_قائمة" من cfg.lists */
  function normOptions(opts) {
    if (typeof opts === "string" && opts.charAt(0) === "@") opts = (cfg.lists || {})[opts.slice(1)] || [];
    return (opts || []).map(function (o) {
      return typeof o === "string" ? { label: o, value: o } : Object.assign({ value: o.label }, o);
    });
  }
  function hasSpecify(f) { return normOptions(f.options).some(function (o) { return o.specify; }); }
  function hasGroups(f) { return normOptions(f.options).some(function (o) { return o.group; }); }

  function countryOptions(f) {
    var dn = null;
    try { dn = new Intl.DisplayNames(["ar"], { type: "region" }); } catch (e) {}
    var exclude = f.exclude || [];
    var pinned = f.pinned || [];
    var list = COUNTRY_CODES.filter(function (c) { return exclude.indexOf(c) < 0 && pinned.indexOf(c) < 0; })
      .map(function (c) { return { code: c, label: dn ? dn.of(c) : c }; })
      .sort(function (a, b) { return a.label.localeCompare(b.label, "ar"); });
    var top = pinned.map(function (c) { return { code: c, label: dn ? dn.of(c) : c }; });
    return { top: top, rest: list };
  }

  /* ---------- الإعدادات والتصميم ---------- */
  function mergeFields(list) {
    list = Array.isArray(list) ? list.slice() : [];
    LOCKED_FIELDS.forEach(function (base, i) {
      var idx = -1;
      list.forEach(function (f, j) { if (f && f.key === base.key) idx = j; });
      var merged = Object.assign({}, base, { locked: true });
      if (idx >= 0) {
        LOCKED_EDITABLE.forEach(function (p) { if (list[idx][p] != null) merged[p] = list[idx][p]; });
        list[idx] = merged;
      } else {
        list.splice(i, 0, merged);
      }
    });
    return list.filter(function (f) { return f && f.key; });
  }

  function applyTheme(th) {
    if (!th) return;
    var map = {
      primary: "--primary", accent: "--accent", accentLight: "--accent-light", background: "--bg",
      surface: "--surface", text: "--text", muted: "--muted", border: "--border",
      error: "--error", success: "--success", radius: "--radius"
    };
    var root = document.documentElement.style;
    Object.keys(map).forEach(function (k) { if (th[k]) root.setProperty(map[k], th[k]); });
    if (th.fontFamily) root.setProperty("--font", '"' + th.fontFamily + '", "Segoe UI", Tahoma, "Noto Sans Arabic", sans-serif');
    if (th.fontUrl) $("font-link").href = th.fontUrl;
  }

  function renderBrand() {
    document.title = cfg.pageTitle || document.title;
    if (cfg.logo) $("logo").src = cfg.logo;
    if (cfg.logoAlt) $("logo").alt = cfg.logoAlt;
    if (cfg.eventLogo) {
      $("logo2").src = cfg.eventLogo;
      $("logo2").alt = cfg.eventLogoAlt || "";
      $("logo2").hidden = false;
      $("brand-sep").hidden = false;
      document.querySelector(".brand").classList.add("dual");
    }
    if (cfg.coverImage) { $("cover").src = cfg.coverImage; $("cover").hidden = false; }
    $("eyebrow").textContent = cfg.eyebrow || "";
    $("eyebrow").hidden = !cfg.eyebrow;
    $("heading").textContent = cfg.heading || "";
    $("subheading").textContent = cfg.subheading || "";
    $("submit-label").textContent = t("submit") || "تسجيل";

    var partners = Array.isArray(cfg.partners) ? cfg.partners : [];
    if (partners.length) {
      $("partners-title").textContent = cfg.partnersTitle || "";
      var ul = $("partners-list");
      ul.innerHTML = "";
      partners.forEach(function (p) {
        var li = el("li");
        var img = el("img");
        img.src = p.logo; img.alt = p.name || ""; img.loading = "lazy";
        if (p.url) {
          var a = el("a");
          a.href = p.url; a.target = "_blank"; a.rel = "noopener"; a.title = p.name || "";
          a.appendChild(img); li.appendChild(a);
        } else { li.appendChild(img); }
        ul.appendChild(li);
      });
      $("partners").hidden = false;
    }
  }

  /* ---------- بناء الحقول ---------- */
  function buildField(f, key) {
    var id = "f_" + key;
    var box = el("div", "field");
    box.dataset.key = key;
    if (f.half) box.classList.add("half");
    if (f.attached) box.classList.add("attached");

    var isCheck = f.type === "checkbox" || f.type === "consent";
    if (!isCheck) {
      var label = el(f.type === "radio" || f.type === "checkboxes" ? "span" : "label", "flabel", f.label || key);
      if (f.required) label.appendChild(el("span", "req", "*"));
      if (label.tagName === "LABEL") label.htmlFor = id;
      else label.id = id + "_label";
      box.appendChild(label);
    }

    var input;
    var opts = normOptions(f.options);
    if (f.type === "select" || f.type === "country") {
      input = el("select");
      var ph = el("option", null, f.placeholder || "اختر…");
      ph.value = ""; ph.disabled = true; ph.selected = true;
      input.appendChild(ph);
      if (f.type === "country") {
        var c = countryOptions(f);
        c.top.forEach(function (o) { var op = el("option", null, o.label); op.value = o.label; input.appendChild(op); });
        if (c.top.length) { var sep = el("option", null, "──────────"); sep.disabled = true; input.appendChild(sep); }
        c.rest.forEach(function (o) { var op = el("option", null, o.label); op.value = o.label; input.appendChild(op); });
      } else {
        opts.forEach(function (o, i) { var op = el("option", null, o.label); op.value = String(i); input.appendChild(op); });
      }
    } else if (f.type === "radio" || f.type === "checkboxes") {
      input = el("div", "choices");
      input.setAttribute("role", f.type === "radio" ? "radiogroup" : "group");
      input.setAttribute("aria-labelledby", id + "_label");
      opts.forEach(function (o, i) {
        var l = el("label", "choice");
        var r = el("input");
        r.type = f.type === "radio" ? "radio" : "checkbox";
        r.name = id; r.value = String(i); r.id = id + "_" + i;
        l.appendChild(r); l.appendChild(el("span", null, o.label));
        input.appendChild(l);
      });
    } else if (isCheck) {
      input = el("label", "check" + (f.type === "consent" ? " consent" : ""));
      var cb = el("input"); cb.type = "checkbox"; cb.id = id; cb.name = key;
      var txt = el("span", null, f.label || key);
      if (f.required) txt.appendChild(el("span", "req", "*"));
      input.appendChild(cb); input.appendChild(txt);
    } else if (f.type === "textarea") {
      input = el("textarea");
    } else {
      input = el("input");
      input.type = ["text", "tel", "email", "number", "date"].indexOf(f.type) >= 0 ? f.type : "text";
      if (f.type === "tel") { input.inputMode = "tel"; input.autocomplete = "tel"; }
      if (key === "firstName") input.autocomplete = "given-name";
      if (key === "lastName") input.autocomplete = "family-name";
      if (f.type === "email") { input.autocomplete = "email"; input.inputMode = "email"; }
    }
    if (!isCheck && f.type !== "radio" && f.type !== "checkboxes") {
      input.id = id; input.name = key;
      if (f.placeholder && f.type !== "select" && f.type !== "country") input.placeholder = f.placeholder;
      if (f.value != null && f.type !== "select") input.value = f.value;
      if (f.readonly) input.readOnly = true;
      if (f.maxLength) input.maxLength = f.maxLength;
    }
    box.appendChild(input);

    if (f.type === "consent" && f.linkUrl) {
      var a = el("a", "consent-link", f.linkText || f.linkUrl);
      a.href = f.linkUrl; a.target = "_blank"; a.rel = "noopener";
      box.appendChild(a);
    }

    // «أخرى (يرجى التحديد)»
    if (opts.some(function (o) { return o.specify; })) {
      var other = el("input", "other-input");
      other.type = "text"; other.id = id + "_other"; other.hidden = true;
      other.placeholder = f.otherPlaceholder || t("otherPlaceholder") || "يرجى التحديد";
      other.setAttribute("aria-label", other.placeholder);
      box.appendChild(other);
      box.addEventListener("change", function (e) {
        if (e.target === other) return;
        var sel = selectedOptions(f, key);
        var need = sel.some(function (o) { return o.specify; });
        other.hidden = !need;
        if (need && e.target.type !== "checkbox") other.focus();
      });
    }

    if (f.help) box.appendChild(el("span", "help", f.help));
    var err = el("span", "err"); err.hidden = true; err.setAttribute("role", "alert");
    box.appendChild(err);

    // مسح رسالة الخطأ عند التعديل
    box.addEventListener("input", function () { setError(key, ""); });
    box.addEventListener("change", function () { setError(key, ""); });
    return box;
  }

  function renderFields() {
    var wrap = $("fields");
    wrap.innerHTML = "";
    fields.forEach(function (f) {
      if (f.type === "hidden") return;
      if (f.type === "conditional") {
        var slot = el("div", "cond-slot");
        slot.id = "cond_" + f.key;
        slot.hidden = true;
        wrap.appendChild(slot);
        return;
      }
      wrap.appendChild(buildField(f, f.key));
    });
    // ربط الأسئلة الشرطية
    fields.filter(function (f) { return f.type === "conditional"; }).forEach(function (f) {
      var src = fieldByKey(f.on);
      if (!src) return;
      var box = document.querySelector('.field[data-key="' + f.on + '"]');
      if (box) box.addEventListener("change", function () { updateConditional(f); });
    });
  }

  function fieldByKey(k) {
    for (var i = 0; i < fields.length; i++) if (fields[i].key === k) return fields[i];
    return null;
  }

  function activeRule(f) {
    var src = fieldByKey(f.on);
    if (!src) return null;
    var sel = selectedOptions(src, src.key)[0];
    if (!sel) return null;
    var tag = sel.group || sel.value;
    for (var i = 0; i < (f.rules || []).length; i++) {
      var r = f.rules[i];
      var whenList = r.when || r.groups || [];
      if (whenList.indexOf(tag) >= 0 || whenList.indexOf("*") >= 0) return r;
    }
    return null;
  }

  function updateConditional(f) {
    var slot = $("cond_" + f.key);
    var r = activeRule(f);
    var current = slot.dataset.rule || "";
    var next = r ? String(f.rules.indexOf(r)) : "";
    if (current === next) return;
    slot.dataset.rule = next;
    slot.innerHTML = "";
    if (!r) { slot.hidden = true; return; }
    var key = r.key || f.key;
    var def = Object.assign({ required: f.required }, r);
    slot.appendChild(buildField(def, key));
    slot.hidden = false;
  }

  /* ---------- قراءة القيم والتحقق ---------- */
  function selectedOptions(f, key) {
    var opts = normOptions(f.options);
    var id = "f_" + key;
    if (f.type === "select") {
      var s = $(id);
      return s && s.value !== "" ? [opts[Number(s.value)]] : [];
    }
    if (f.type === "radio" || f.type === "checkboxes") {
      return Array.prototype.slice.call(document.querySelectorAll('input[name="' + id + '"]:checked'))
        .map(function (i) { return opts[Number(i.value)]; });
    }
    return [];
  }

  // يعيد {value, other, group, error}
  function readField(f, key) {
    var id = "f_" + key;
    var res = { value: "", other: "", group: "", error: "" };
    var type = f.type || "text";

    if (type === "hidden") { res.value = f.value != null ? String(f.value) : ""; return res; }
    if (f.readonly) { res.value = f.value != null ? String(f.value) : ""; return res; }

    if (type === "checkbox" || type === "consent") {
      var cb = $(id);
      var on = !!(cb && cb.checked);
      if (type === "consent") {
        res.value = on ? (f.trueValue || "موافق") : "";
        if (f.required && !on) res.error = t("consentError") || t("requiredError");
      } else {
        res.value = on ? (f.trueValue || "نعم") : (f.falseValue || "لا");
        if (f.required && !on) res.error = t("requiredError");
      }
      return res;
    }

    if (type === "select" || type === "radio" || type === "checkboxes") {
      var sel = selectedOptions(f, key);
      res.value = sel.map(function (o) { return o.value; }).join("، ");
      res.group = sel.map(function (o) { return o.group || ""; }).filter(Boolean)[0] || "";
      if (f.required && !sel.length) res.error = t("requiredError");
      if (sel.some(function (o) { return o.specify; })) {
        var oi = $(id + "_other");
        res.other = oi ? oi.value.trim() : "";
        if (!res.other && !res.error) res.error = t("specifyError") || t("requiredError");
      }
      return res;
    }

    var e = $(id);
    var v = e ? String(e.value || "").trim() : "";
    res.value = v;
    if (f.required && !v) res.error = t("requiredError");
    else if (v && type === "tel") {
      var d = normalizePhone(v);
      if (d.length < 8 || d.length > 15) res.error = t("phoneError");
    } else if (v && type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) res.error = t("emailError");
    return res;
  }

  function setError(key, msg) {
    var box = document.querySelector('.field[data-key="' + key + '"]');
    if (!box) return;
    var err = box.querySelector(".err");
    err.textContent = msg || ""; err.hidden = !msg;
    box.classList.toggle("invalid", !!msg);
  }

  /* يجمع كل القيم كأعمدة ثابتة للجدول.
     out = [{key, label, value, inMessage, msgValue}] */
  function collect() {
    var out = [], firstBad = null, values = {};

    function push(f, key, r, label) {
      var groupLabels = cfg.groups || {};
      var mainVal = r.value;
      out.push({
        key: key, label: label, value: mainVal, inMessage: f.inMessage !== false,
        msgValue: r.other ? mainVal + " — " + r.other : mainVal
      });
      values[key] = r.other ? mainVal + " — " + r.other : mainVal;
      if (hasSpecify(f)) out.push({ key: key + "Other", label: label + " (تحديد)", value: r.other, inMessage: false });
      if (hasGroups(f)) {
        out.push({ key: key + "Group", label: f.groupColumnLabel || "الفئة", value: groupLabels[r.group] || r.group, inMessage: false });
        values[key + "Group"] = r.group;
      }
    }

    fields.forEach(function (f) {
      if (f.type === "conditional") {
        var r = activeRule(f);
        // كل مفاتيح القواعد تأخذ عموداً ثابتاً حتى لو كانت فارغة
        var seen = {};
        (f.rules || []).forEach(function (rule) {
          var k = rule.key || f.key;
          if (seen[k]) return;
          seen[k] = true;
          var def = Object.assign({ required: f.required }, rule);
          var colName = rule.columnLabel || (k === f.key ? colLabel(f) : rule.label);
          var isActive = r && (r.key || f.key) === k;
          var res = isActive ? readField(Object.assign({}, def, r), k) : { value: "", other: "", group: "", error: "" };
          var anySpecify = (f.rules || []).some(function (x) { return (x.key || f.key) === k && hasSpecify(x); });
          var shape = Object.assign({}, def, { inMessage: f.inMessage, options: anySpecify ? [{ label: "x", specify: true }] : [] });
          if (isActive) shape.inMessage = f.inMessage;
          push(shape, k, res, colName);
          if (isActive) {
            out[out.length - (anySpecify ? 2 : 1)].msgLabel = r.messageLabel || r.columnLabel || r.label;
            if (res.error) { setError(k, res.error); if (!firstBad) firstBad = k; }
            else setError(k, "");
          }
        });
        return;
      }
      var res = readField(f, f.key);
      push(f, f.key, res, colLabel(f));
      setError(f.key, res.error);
      if (res.error && !firstBad) firstBad = f.key;
    });

    if (firstBad) {
      var box = document.querySelector('.field[data-key="' + firstBad + '"]');
      if (box) {
        box.scrollIntoView({ behavior: "smooth", block: "center" });
        var inp = box.querySelector("input:not([hidden]), select, textarea");
        if (inp) inp.focus({ preventScroll: true });
      }
      return null;
    }
    return { out: out, values: values };
  }

  function buildMessage(data, id) {
    var lines = data.out.filter(function (o) { return o.inMessage && o.value; })
      .map(function (o) { return (o.msgLabel || o.label) + ": " + (o.msgValue || o.value); });
    var vars = Object.assign({}, data.values, { id: id || "", fields: lines.join("\n") });
    return fill(cfg.whatsappMessage || "{{fields}}", vars);
  }

  /* ---------- الخادم (Google Apps Script) ---------- */
  function apiEndpoint() {
    var base = String(cfg.apiUrl || "").replace(/\/+$/, "");
    return base ? base + "/api/register" : "";
  }
  function postToServer(payload) {
    if (!apiEndpoint()) {
      return new Promise(function (res) {
        setTimeout(function () { res({ ok: true, id: "TEST-" + Math.floor(Math.random() * 9000 + 1000), emailSent: false }); }, 600);
      });
    }
    return fetch(apiEndpoint(), {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload)
    }).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: "server" }; });
    });
  }

  /* ---------- الحالات ---------- */
  function showPending(rec) {
    $("pending-title").textContent = fill(t("pendingWhatsappTitle"), rec);
    $("pending-body").textContent = t("pendingWhatsappBody");
    $("pending-id").textContent = rec.id ? "رقم التسجيل: " + rec.id : "";
    $("wa-btn").textContent = t("openWhatsapp");
    $("wa-btn").onclick = function () { openWhatsappOnce(rec); };
    show("state-pending");
  }

  function showDone(rec) {
    $("done-title").textContent = fill(t("doneTitle"), rec);
    var body = waEnabled() ? t("doneBody") : (t("doneBodyNoWhatsapp") || t("doneBody"));
    if (rec.email && rec.emailSent !== false) body += " " + fill(t("emailNote"), rec);
    $("done-body").textContent = body;
    $("done-id").textContent = rec.id ? "رقم التسجيل: " + rec.id : "";
    show("state-done");
  }

  function blockedText(reason) {
    if (reason === "phone") return t("duplicatePhone");
    if (reason === "email") return t("duplicateEmail");
    return t("duplicateDevice");
  }
  function showBlocked(reason) {
    $("blocked-body").textContent = blockedText(reason);
    show("state-blocked");
  }

  function openWhatsappOnce(rec) {
    var current = getRecord() || rec;
    if (current.waOpened || !waEnabled()) { showDone(current); return; }
    current.waOpened = true;
    current.waOpenedAt = new Date().toISOString();
    saveRecord(current);
    showDone(current);
    window.location.href = waUrl(current.message);
  }

  function showDesktop() {
    $("desktop-title").textContent = t("desktopTitle");
    $("desktop-body").textContent = t("desktopBody");
    var url = location.href.split("#")[0];
    $("page-url").textContent = url;
    if (window.qrcode) {
      var q = qrcode(0, "M");
      q.addData(url); q.make();
      $("qr").innerHTML = q.createSvgTag({ cellSize: 6, margin: 0, scalable: true });
    } else {
      $("qr").hidden = true;
    }
    show("state-desktop");
  }

  function resetButton() {
    var btn = $("submit-btn");
    btn.disabled = false;
    btn.innerHTML = '<span class="btn-label" id="submit-label">' + (t("submit") || "تسجيل") + "</span>";
  }

  function onSubmit(e) {
    e.preventDefault();
    if (getRecord()) { route(); return; }
    var data = collect();
    if (!data) return;

    var btn = $("submit-btn");
    var errBox = $("form-error");
    errBox.hidden = true;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" aria-hidden="true"></span><span>' + t("saving") + "</span>";

    var v = data.values;
    var payload = {
      eventId: cfg.eventId || "",
      deviceId: getDeviceId(),
      fingerprint: fingerprint(),
      userAgent: navigator.userAgent,
      phoneNormalized: v.phone ? normalizePhone(v.phone) : "",
      fields: data.out.map(function (o) { return { key: o.key, label: o.label, value: o.value || "" }; })
    };

    postToServer(payload).then(function (res) {
      if (res && res.ok) {
        var rec = {
          id: res.id, firstName: v.firstName, lastName: v.lastName, email: v.email || "",
          emailSent: res.emailSent, savedAt: new Date().toISOString(), waOpened: false
        };
        rec.message = buildMessage(data, res.id);
        saveRecord(rec);
        if (waEnabled()) openWhatsappOnce(rec);
        else { rec.waOpened = true; saveRecord(rec); showDone(rec); }
        return;
      }
      if (res && res.duplicate) {
        saveRecord({ id: res.id || "", firstName: v.firstName, waOpened: true, blocked: res.reason });
        showBlocked(res.reason);
        return;
      }
      throw new Error((res && res.error) || "server");
    }).catch(function (err) {
      errBox.textContent = err && err.message === "rate" ? (t("rateError") || t("networkError")) : t("networkError");
      errBox.hidden = false;
      resetButton();
    });
  }

  function route() {
    var rec = getRecord();
    if (rec) {
      if (rec.blocked) { showBlocked(rec.blocked); return; }
      if (!rec.waOpened) { showPending(rec); return; }
      showDone(rec);
      return;
    }
    if (!cfg.allowDesktop && !isMobile()) { showDesktop(); return; }
    show("state-form");
  }

  /* ---------- التشغيل ---------- */
  function start(config) {
    cfg = config;
    cfg.texts = cfg.texts || {};
    applyTheme(cfg.theme);
    fields = mergeFields(cfg.fields);
    renderBrand();
    renderFields();
    if (!apiEndpoint()) { $("demo-banner").textContent = t("demoBanner"); $("demo-banner").hidden = false; }
    $("form").addEventListener("submit", onSubmit);
    getDeviceId();
    route();
  }

  fetch("config.json?v=" + Date.now(), { cache: "no-store" })
    .then(function (r) { if (!r.ok) throw new Error("config"); return r.json(); })
    .then(start)
    .catch(function () {
      $("state-loading").innerHTML = '<p class="lead" style="text-align:center">تعذّر تحميل إعدادات الصفحة (config.json).</p>';
    });
})();
