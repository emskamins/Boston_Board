import React, { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'react';
import { ref, onValue, set, onDisconnect, serverTimestamp } from "firebase/database";
import { db } from './firebase';

/* =====================================================================
   CONSTANTS
   ===================================================================== */
const CACHE_PREFIX = 'shulBoardCacheV23';     // Hebcal cache (keyed by zip + candle minutes)
const FB_CACHE_PREFIX = 'shulBoardFb:';       // Firebase snapshot cache (per path)
const DAY_NAMES = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "שבת"];
const BROWSER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const ALLOWED_FONTS = ['Heebo', 'Rubik', 'Frank Ruhl Libre'];
const ALLOWED_THEMES = ['dark', 'light', 'marble', 'wood'];
const EMPTY_OBJ = {};

try { localStorage.removeItem('shulBoardCacheV22'); } catch (e) { /* ignore */ }

/* =====================================================================
   DATE / TIME HELPERS (all calculated in the SHUL's time zone)
   ===================================================================== */
const pad = (n) => String(n).padStart(2, '0');

const tzParts = (date, tz) => {
  const opts = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' };
  let fmt;
  try { fmt = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: tz }); }
  catch (e) { fmt = new Intl.DateTimeFormat('en-US', opts); }
  const p = {};
  fmt.formatToParts(date).forEach(x => { if (x.type !== 'literal') p[x.type] = parseInt(x.value, 10); });
  if (p.hour === 24) p.hour = 0;
  return p;
};

const dateKeyInTz = (date, tz) => { const p = tzParts(date, tz); return `${p.year}-${pad(p.month)}-${pad(p.day)}`; };
const keyToUTC = (key) => { const [y, m, d] = key.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const addDays = (key, n) => new Date(keyToUTC(key) + n * 86400000).toISOString().slice(0, 10);
const dowOfKey = (key) => new Date(keyToUTC(key)).getUTCDay();

// Wall-clock time in the shul's zone -> real instant
const zonedToInstant = (key, hh, mm, tz) => {
  const [y, m, d] = key.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const offsetAt = (t) => {
    const p = tzParts(new Date(t), tz);
    return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - t) / 60000) * 60000;
  };
  let ts = guess - offsetAt(guess);
  const off2 = offsetAt(ts);
  if (guess - off2 !== ts) ts = guess - off2;
  return new Date(ts);
};

const formatTime12 = (dateObj, tz) => {
  if (!dateObj || isNaN(dateObj.getTime())) return "";
  const opts = { hour: 'numeric', minute: '2-digit', hour12: true };
  try { return dateObj.toLocaleTimeString('en-US', { ...opts, timeZone: tz }); }
  catch (e) { return dateObj.toLocaleTimeString('en-US', opts); }
};

const formatDayTime = (dateObj, tz) => {
  if (!dateObj || isNaN(dateObj.getTime())) return "";
  const key = dateKeyInTz(dateObj, tz);
  const [, m, d] = key.split('-').map(Number);
  return `יום ${DAY_NAMES[dowOfKey(key)]} ${d}/${m} ${formatTime12(dateObj, tz)}`;
};

const parseTimeStrToMinutes = (timeStr) => {
  if (!timeStr) return 9999;
  const match = String(timeStr).match(/(\d+):(\d+)\s*(AM|PM|am|pm)?/);
  if (!match) return 9999;
  let [, h, m, ampm] = match;
  h = parseInt(h, 10);
  m = parseInt(m, 10);
  if (ampm) {
    if (ampm.toLowerCase() === 'pm' && h < 12) h += 12;
    if (ampm.toLowerCase() === 'am' && h === 12) h = 0;
  }
  return h * 60 + m;
};

const roundTime = (dateObj, mode) => {
  const step = 300000; // 5 minutes
  const t = dateObj.getTime();
  if (mode === 'down') return new Date(Math.floor(t / step) * step);
  if (mode === 'up') return new Date(Math.ceil(t / step) * step);
  if (mode === 'nearest') return new Date(Math.round(t / step) * step);
  return dateObj; // 'none'
};

const safeUrl = (u) => (typeof u === 'string' && /^https:\/\/[^'"()<>{}\\\s]+$/.test(u.trim())) ? u.trim() : '';

/* =====================================================================
   HEBREW TEXT HELPERS
   ===================================================================== */
const toHebNum = (n) => {
  const ones = ['', 'א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט'];
  const tens = ['', 'י', 'כ', 'ל', 'מ', 'נ', 'ס', 'ע', 'פ', 'צ'];
  const hundreds = ['', 'ק', 'ר', 'ש', 'ת'];
  let out = hundreds[Math.floor(n / 100)] || '';
  const x = n % 100;
  if (x === 15) return out + 'טו';
  if (x === 16) return out + 'טז';
  return out + tens[Math.floor(x / 10)] + ones[x % 10];
};

const HAFTARAH_BOOKS = {
  "Genesis": "בראשית", "Exodus": "שמות", "Leviticus": "ויקרא", "Numbers": "במדבר", "Deuteronomy": "דברים",
  "Joshua": "יהושע", "Judges": "שופטים",
  "1 Samuel": "שמואל א׳", "2 Samuel": "שמואל ב׳", "I Samuel": "שמואל א׳", "II Samuel": "שמואל ב׳",
  "1 Kings": "מלכים א׳", "2 Kings": "מלכים ב׳", "I Kings": "מלכים א׳", "II Kings": "מלכים ב׳",
  "Isaiah": "ישעיהו", "Jeremiah": "ירמיהו", "Ezekiel": "יחזקאל",
  "Hosea": "הושע", "Joel": "יואל", "Amos": "עמוס", "Obadiah": "עובדיה",
  "Jonah": "יונה", "Micah": "מיכה", "Nahum": "נחום", "Habakkuk": "חבקוק",
  "Zephaniah": "צפניה", "Haggai": "חגי", "Zechariah": "זכריה", "Malachi": "מלאכי"
};
const HAFTARAH_KEYS = Object.keys(HAFTARAH_BOOKS).sort((a, b) => b.length - a.length);

const translateHaftarah = (engStr) => {
  if (!engStr) return "";
  let s = String(engStr).split('|')[0].trim(); // drop notes like "| Chanukah Day 1 (on Shabbat)"
  // Longest names first so "II Kings" is never mangled by "I Kings"
  HAFTARAH_KEYS.forEach(book => {
    const re = new RegExp(`(^|[^A-Za-z0-9])${book.replace(/ /g, '\\s')}(?=[^A-Za-z]|$)`, 'g');
    s = s.replace(re, (m0, pre) => pre + HAFTARAH_BOOKS[book]);
  });
  s = s.replace(/\d+/g, (num) => toHebNum(parseInt(num, 10)));
  return s.replace(/;\s*/g, ', ');
};

/* =====================================================================
   MOLAD / KIDDUSH LEVANA (calculated locally - Hebcal's zmanim API
   does not return Kiddush Levana times)
   ===================================================================== */
const PARTS_PER_DAY = 25920;
const PARTS_PER_MONTH = 765433;                       // 29d 12h 793p
const MOLAD_EPOCH_PARTS = -1373427 * PARTS_PER_DAY - 876; // BaHaRaD
const RD_UNIX_EPOCH = 719163;
const JERUSALEM_LMT_MS = (35.2354 / 360) * 86400000;  // Jerusalem mean time offset from UTC

const rdOfKey = (key) => Math.floor(keyToUTC(key) / 86400000) + RD_UNIX_EPOCH;
const moladIndexNear = (key) => Math.round((rdOfKey(key) * PARTS_PER_DAY - MOLAD_EPOCH_PARTS) / PARTS_PER_MONTH);

const moladInfo = (n) => {
  const p = MOLAD_EPOCH_PARTS + n * PARTS_PER_MONTH;
  const day = Math.floor(p / PARTS_PER_DAY);
  const r = p - day * PARTS_PER_DAY;
  const hour = Math.floor(r / 1080);
  const minute = Math.floor((r % 1080) / 18);
  const chalakim = (r % 1080) % 18;
  const dow = ((day % 7) + 7) % 7;
  const instant = new Date((p / PARTS_PER_DAY - RD_UNIX_EPOCH) * 86400000 - JERUSALEM_LMT_MS);
  return { dow, hour, minute, chalakim, instant };
};

const moladText = (m) => {
  const h12 = m.hour % 12 || 12;
  const period = m.hour < 5 ? 'לפנות בוקר' : m.hour < 12 ? 'בבוקר' : m.hour < 17 ? 'אחה״צ' : 'בערב';
  return `המולד: יום ${DAY_NAMES[m.dow]}, ${h12}:${pad(m.minute)} ${period} ו־${m.chalakim} חלקים`;
};

const kiddushLevanaWindow = (n, startDays, endOpinion) => {
  const m = moladInfo(n);
  const start = new Date(m.instant.getTime() + startDays * 86400000);
  const endMs = endOpinion === 'between_moldos'
    ? (PARTS_PER_MONTH / 2 / PARTS_PER_DAY) * 86400000   // 14d 18h 22m 1⅔p (Mechaber)
    : 15 * 86400000;                                     // 15 days (Rema)
  return { molad: m, start, end: new Date(m.instant.getTime() + endMs) };
};

/* =====================================================================
   HEBCAL EVENT HELPERS
   ===================================================================== */
const evKey = (e) => (e.date || '').slice(0, 10); // timed events have "YYYY-MM-DDTHH:MM..."
const chanukahCandles = (e) => {
  const m = (e.title || '').match(/Chanukah:\s*(\d)\s*Candle/i);
  return m ? parseInt(m[1], 10) : 0;
};
const isChanukahEighthDay = (e) => /Chanukah:\s*8th Day/i.test(e.title || '');
const isCholHamoed = (e) => /CH['’]{2}M|Chol\s?Ha?moed/i.test(e.title || '') || /חוה״מ|חול המועד/.test(e.hebrew || '');
const isYomKippur = (e) => /^Yom Kippur$/i.test(e.title || '');
// Only the holiday item - Hebcal's "Fast begins/ends" zmanim items also carry subcat 'fast'
// Tish'a B'Av is subcat 'major' in Hebcal, so it is matched by title (straight or curly apostrophes)
const isTishaBav = (e) => /^Tish.a B.Av/i.test(e.title || '');
const isFastEvent = (e) => (e.category === 'holiday' && (e.subcat === 'fast' || isTishaBav(e))) || isYomKippur(e);

/* =====================================================================
   FIREBASE HOOK - live listener + localStorage snapshot so the board
   still shows minyanim after rebooting with no internet
   ===================================================================== */
const useFbNode = (path, fallback) => {
  const cacheKey = FB_CACHE_PREFIX + path;
  const [state, setState] = useState(() => {
    try {
      const raw = localStorage.getItem(cacheKey);
      if (raw !== null) return { value: JSON.parse(raw) ?? fallback, loaded: true };
    } catch (e) { /* ignore */ }
    return { value: fallback, loaded: false };
  });
  useEffect(() => {
    const unsub = onValue(ref(db, path), (snap) => {
      const v = snap.val();
      setState({ value: v ?? fallback, loaded: true });
      try { localStorage.setItem(cacheKey, JSON.stringify(v ?? null)); } catch (e) { /* ignore */ }
    }, () => { /* permission/network error: keep cached value */ });
    return () => unsub();
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
};

const toList = (obj) => (obj && typeof obj === 'object') ? Object.keys(obj).map(id => ({ id, ...obj[id] })) : [];

/* =====================================================================
   BOARD CALCULATION (pure function, recalculated every minute)
   ===================================================================== */
function computeBoard({ hebcal, now, tz, settings, dynamicRules }) {
  const out = { ready: false };
  if (!hebcal) return out;
  out.ready = true;

  const times = hebcal.times || {};
  const byDate = {};
  (hebcal.events || []).forEach(e => { const k = evKey(e); (byDate[k] = byDate[k] || []).push(e); });
  const evs = (k) => byDate[k] || [];
  const T = (k, name) => { const iso = times[k] && times[k][name]; return iso ? new Date(iso) : null; };
  const fmt = (d) => formatTime12(d, tz);

  const candleMins = Number(settings.candleMinutes) > 0 ? Number(settings.candleMinutes) : 18;
  const klStartDays = Number(settings.klStartDays) === 7 ? 7 : 3;
  const klEndOpinion = settings.klEndOpinion === 'between_moldos' ? 'between_moldos' : '15days';

  // Civil date drives the zmanim; halachic date (rolls at Shkia) drives date, inserts, fasts
  const civilKey = dateKeyInTz(now, tz);
  const tomorrowKey = addDays(civilKey, 1);
  const sunsetToday = T(civilKey, 'sunset');
  const tzeisToday = T(civilKey, 'tzeit7083deg');
  const afterShkia = sunsetToday ? now >= sunsetToday : false;
  const afterTzeis = tzeisToday ? now >= tzeisToday : false;
  const hKey = afterShkia ? tomorrowKey : civilKey;
  out.civilKey = civilKey;
  out.hasToday = !!times[civilKey];

  /* ---------- Today's zmanim (civil day, so tonight's Tzeis stays correct) ---------- */
  if (times[civilKey]) {
    out.zmanim = {
      alos: fmt(T(civilKey, 'alotHaShachar')),
      netz: fmt(T(civilKey, 'sunrise')),
      szksMGA: fmt(T(civilKey, 'sofZmanShmaMGA')),
      szksGRA: fmt(T(civilKey, 'sofZmanShma')),
      chatzos: fmt(T(civilKey, 'chatzot')),
      minchaG: fmt(T(civilKey, 'minchaGedola')),
      minchaK: fmt(T(civilKey, 'minchaKetana')),
      shkia: fmt(sunsetToday),
      tzeis: fmt(tzeisToday)
    };
  }

  /* ---------- Daily info ---------- */
  const hEvs = evs(hKey);
  out.hDate = (hEvs.find(e => e.category === 'hebdate' || e.category === 'hebrew') || {}).hebrew || '';
  out.daf = (evs(civilKey).find(e => e.category === 'dafyomi') || {}).hebrew || ''; // Daf follows the civil day
  const omerKey = settings.omerRollover === 'shkia' ? hKey : (afterTzeis ? tomorrowKey : civilKey);
  out.omer = (evs(omerKey).find(e => e.category === 'omer') || {}).hebrew || '';

  const inserts = [];
  if (hEvs.some(e => e.category === 'roshchodesh')) inserts.push("יעלה ויבוא (ראש חודש)");
  if (hEvs.some(isCholHamoed)) inserts.push("יעלה ויבוא (חול המועד)");
  if (hEvs.some(e => chanukahCandles(e) >= 2 || isChanukahEighthDay(e))) inserts.push("על הניסים (חנוכה)");
  if (hEvs.some(e => /^Purim$/i.test(e.title || ''))) inserts.push("על הניסים (פורים)");
  out.inserts = inserts;

  // Chanukah: Hebcal dates "N Candles" on the civil date of the evening you light
  out.chanukahTonight = evs(civilKey).reduce((n, e) => Math.max(n, chanukahCandles(e)), 0);

  /* ---------- Fasts ---------- */
  const findZman = (keys, re) => {
    for (const k of keys) {
      const z = evs(k).find(e => e.category === 'zmanim' && re.test(e.title_orig || e.title || ''));
      if (z) return new Date(z.date);
    }
    return null;
  };
  const fastFor = (k) => {
    const ev = evs(k).find(isFastEvent);
    if (!ev) return null;
    const prev = addDays(k, -1);
    let start, end;
    if (isYomKippur(ev)) {
      const c = evs(prev).find(e => e.category === 'candles');
      start = c ? new Date(c.date) : T(prev, 'sunset');
      const h = evs(k).find(e => e.category === 'havdalah');
      end = h ? new Date(h.date) : T(k, 'tzeit85deg');
    } else {
      const major = isTishaBav(ev);
      start = findZman(major ? [prev, k] : [k], /Fast begins/i) || (major ? T(prev, 'sunset') : T(k, 'alotHaShachar'));
      end = findZman([k], /Fast ends/i) || T(k, 'tzeit85deg') || T(k, 'tzeit7083deg');
    }
    return { name: ev.hebrew || ev.title, start, end, startsEvening: !!start && dateKeyInTz(start, tz) !== k };
  };
  const fastNow = fastFor(hKey);
  if (fastNow && !(fastNow.end && now > fastNow.end)) {
    out.fast = { ...fastNow, mode: 'today' };
  } else if (hKey === civilKey) {
    const fastTomorrow = fastFor(tomorrowKey);
    const chatzot = T(civilKey, 'chatzot');
    if (fastTomorrow && chatzot && now >= chatzot) out.fast = { ...fastTomorrow, mode: 'erev' };
  }
  if (out.fast) { out.fast.startStr = fmt(out.fast.start); out.fast.endStr = fmt(out.fast.end); }

  /* ---------- Shabbos / Yom Tov period ---------- */
  const isHoly = (k) => dowOfKey(k) === 6 || evs(k).some(e => e.yomtov === true);
  const endOfHoly = (k) => {
    const h = evs(k).find(e => e.category === 'havdalah');
    return h ? new Date(h.date) : (T(k, 'tzeit85deg') || T(k, 'tzeit7083deg'));
  };

  let holyMode = false;
  if (isHoly(civilKey)) {
    const end = endOfHoly(civilKey);
    holyMode = isHoly(tomorrowKey) || !end || now < end;
  } else if (isHoly(tomorrowKey)) {
    const chatzot = T(civilKey, 'chatzot');
    holyMode = !chatzot || now >= chatzot;
  }
  out.holyMode = holyMode;

  let pStart = null;
  if (isHoly(civilKey) && holyMode) {
    pStart = civilKey;
    for (let i = 0; i < 3 && isHoly(addDays(pStart, -1)); i++) pStart = addDays(pStart, -1);
  } else {
    for (let i = 1; i <= 14; i++) { const k = addDays(civilKey, i); if (isHoly(k)) { pStart = k; break; } }
  }

  if (pStart) {
    let pEnd = pStart;
    for (let i = 0; i < 3 && isHoly(addDays(pEnd, 1)); i++) pEnd = addDays(pEnd, 1);
    const erevKey = addDays(pStart, -1);
    const pKeys = [];
    for (let k = pStart; k <= pEnd; k = addDays(k, 1)) pKeys.push(k);
    const shabbosKey = pKeys.find(k => dowOfKey(k) === 6) || null;

    // Titles
    const parshaEv = shabbosKey ? evs(shabbosKey).find(e => e.category === 'parashat') : null;
    const specials = [];
    pKeys.forEach(k => evs(k).forEach(e => {
      let name = null;
      if (e.category === 'roshchodesh') name = e.hebrew;
      else if (e.category === 'holiday' && !/^Erev\s/i.test(e.title || '') && e.subcat !== 'fast') {
        name = (chanukahCandles(e) || isChanukahEighthDay(e)) ? 'חנוכה' : e.hebrew;
      }
      if (name && !specials.includes(name)) specials.push(name);
    }));
    const yomTovEv = pKeys.map(k => evs(k).find(e => e.yomtov === true)).find(Boolean);
    const title = parshaEv ? parshaEv.hebrew : (specials.shift() || '');
    const haftarahEng = (parshaEv && parshaEv.leyning && parshaEv.leyning.haftarah)
      || (yomTovEv && yomTovEv.leyning && yomTovEv.leyning.haftarah) || '';

    // Candle lighting - Hebcal's own events (correct for 2nd night Yom Tov, Yom Tov into Shabbos)
    const candles = [];
    for (let k = erevKey; k < pEnd; k = addDays(k, 1)) {
      evs(k).filter(e => e.category === 'candles').forEach(e => candles.push({ key: k, time: new Date(e.date) }));
    }
    if (candles.length === 0 && T(erevKey, 'sunset')) {
      candles.push({ key: erevKey, time: new Date(T(erevKey, 'sunset').getTime() - candleMins * 60000) });
    }

    const lastShkia = T(pEnd, 'sunset');
    out.period = {
      isShabbos: !!shabbosKey,
      lastIsShabbos: dowOfKey(pEnd) === 6,
      title,
      specials,
      haftarah: translateHaftarah(haftarahEng),
      plag: fmt(T(erevKey, 'plagHaMincha')),
      candles: candles.map(c => ({
        label: candles.length > 1 ? `הדלקת נרות (${c.key === erevKey && dowOfKey(c.key) !== 6 ? 'ערב' : 'יום ' + DAY_NAMES[dowOfKey(c.key)]})` : 'הדלקת נרות',
        time: fmt(c.time)
      })),
      shkia: fmt(lastShkia),
      tzeis: fmt(T(pEnd, 'tzeit7083deg')),
      m60: lastShkia ? fmt(new Date(lastShkia.getTime() + 60 * 60000)) : '',
      m72: lastShkia ? fmt(new Date(lastShkia.getTime() + 72 * 60000)) : ''
    };

    // Dynamic minyanim
    const firstCandle = candles.find(c => c.key === erevKey);
    const anchors = {
      friday_candle: firstCandle ? firstCandle.time : null,
      friday_shkia: T(erevKey, 'sunset'),
      shabbos_shkia: T(shabbosKey || pStart, 'sunset'),
      shabbos_tzeis: T(pEnd, 'tzeit7083deg')
    };
    out.dynamicMinyanim = (dynamicRules || []).map(rule => {
      const base = anchors[rule.base];
      const offset = Number(rule.offset);
      if (!base || !Number.isFinite(offset)) return null;
      const mode = rule.round || (rule.base === 'shabbos_tzeis' ? 'none' : 'down');
      return {
        id: rule.id,
        label: rule.label,
        time: fmt(roundTime(new Date(base.getTime() + offset * 60000), mode)),
        day: String(rule.base).startsWith('friday') ? 'erev' : 'yom'
      };
    }).filter(Boolean);

    // Shabbos Mevorchim (last Shabbos before Rosh Chodesh; never before Tishrei)
    if (shabbosKey) {
      let rcKey = null;
      for (let i = 1; i <= 7; i++) {
        const k = addDays(shabbosKey, i);
        if (evs(k).some(e => e.category === 'roshchodesh')) { rcKey = k; break; }
      }
      if (rcKey) {
        const rcDays = [rcKey];
        if (evs(addDays(rcKey, 1)).some(e => e.category === 'roshchodesh')) rcDays.push(addDays(rcKey, 1));
        const rcEv = evs(rcKey).find(e => e.category === 'roshchodesh');
        const month = ((rcEv && rcEv.hebrew) || '').replace(/^ראש חודש\s*/, '');
        const kl = kiddushLevanaWindow(moladIndexNear(rcDays[rcDays.length - 1]), klStartDays, klEndOpinion);
        out.mevorchim = {
          title: `שבת מברכים חודש ${month}`,
          rcDays: `ראש חודש: יום ${rcDays.map(k => DAY_NAMES[dowOfKey(k)]).join(' ו')}`,
          molad: moladText(kl.molad),
          klStart: formatDayTime(kl.start, tz),
          klEnd: formatDayTime(kl.end, tz)
        };
      }
    }
  }

  /* ---------- Kiddush Levana reminder during the window ---------- */
  const n0 = moladIndexNear(civilKey);
  for (const n of [n0 - 1, n0]) {
    const kl = kiddushLevanaWindow(n, klStartDays, klEndOpinion);
    if (now >= kl.start && now <= kl.end) { out.klActiveEnd = formatDayTime(kl.end, tz); break; }
  }

  return out;
}

/* =====================================================================
   APP
   ===================================================================== */
const App = () => {
  const [realTime, setRealTime] = useState(new Date());
  const [hebcal, setHebcal] = useState(null);
  const [fetchError, setFetchError] = useState(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const settingsNode = useFbNode('settings', EMPTY_OBJ);
  const settings = settingsNode.value || EMPTY_OBJ;
  const tickerNode = useFbNode('ticker', null);
  const manualNode = useFbNode('manual_minyanim', null);
  const shabbosNode = useFbNode('shabbos_minyanim', null);
  const rulesNode = useFbNode('dynamic_rules', null);
  const seasonalNode = useFbNode('seasonal_tefillah', EMPTY_OBJ);
  const overridesNode = useFbNode('overrides', EMPTY_OBJ);

  /* ---------- Clock: tick exactly on each minute boundary ---------- */
  useEffect(() => {
    let id;
    const schedule = () => {
      id = setTimeout(() => { setRealTime(new Date()); schedule(); }, 60000 - (Date.now() % 60000) + 50);
    };
    schedule();
    return () => clearTimeout(id);
  }, []);

  /* ---------- Settings ---------- */
  const zip = String(settings.zipCode || '10001').trim();
  const candleMins = Number(settings.candleMinutes) > 0 ? Number(settings.candleMinutes) : 18;
  const cacheKey = `${CACHE_PREFIX}:${zip}:${candleMins}`;
  const tz = (hebcal && hebcal.tzid) || BROWSER_TZ;
  const theme = ALLOWED_THEMES.includes(settings.theme) ? settings.theme : 'dark';
  const fontFamily = ALLOWED_FONTS.includes(settings.font) ? settings.font : 'Heebo';
  const mainBg = safeUrl(settings.mainBg);
  const panelBg = safeUrl(settings.panelBg);
  const logoUrl = safeUrl(settings.logoUrl);
  const shulName = settings.shulName || 'בית כנסת אוהל משה';
  const shulSubtitle = settings.shulSubtitle ?? 'קהילת קודש';

  /* ---------- Simulation (date + time, clock keeps running, auto-expires) ---------- */
  const sim = settings.simulation;
  const simActive = !!(sim && sim.date && (!sim.expiresAt || realTime.getTime() < sim.expiresAt));
  let activeNow = realTime;
  if (simActive) {
    const [hh, mm] = String(sim.time || '12:00').split(':').map(Number);
    const base = zonedToInstant(sim.date, hh || 0, mm || 0, tz);
    const elapsed = Math.max(0, realTime.getTime() - (sim.setAt || realTime.getTime()));
    activeNow = new Date(base.getTime() + elapsed);
  }
  const civilKey = dateKeyInTz(activeNow, tz);

  /* ---------- Hebcal: load cache for this location, then fetch ---------- */
  useEffect(() => {
    try {
      const raw = localStorage.getItem(cacheKey);
      setHebcal(raw ? JSON.parse(raw) : null);
    } catch (e) { setHebcal(null); }
  }, [cacheKey]);

  useEffect(() => {
    if (!settingsNode.loaded) return;   // don't fetch with the default zip before Firebase answers
    let cancelled = false;
    const start = addDays(civilKey, -3);
    const end = addDays(civilKey, 35);
    const z = encodeURIComponent(zip);
    const eventsUrl = `https://www.hebcal.com/hebcal?v=1&cfg=json&zip=${z}&start=${start}&end=${end}&maj=on&min=on&mf=on&ss=on&nx=on&F=on&o=on&d=on&c=on&b=${candleMins}&M=on&s=on&leyning=on&a=on`;
    const zmanimUrl = `https://www.hebcal.com/zmanim?cfg=json&zip=${z}&start=${start}&end=${end}`;

    (async () => {
      try {
        const [eRes, zRes] = await Promise.all([fetch(eventsUrl), fetch(zmanimUrl)]);
        if (!eRes.ok || !zRes.ok) throw new Error(`Hebcal HTTP ${eRes.status}/${zRes.status}`);
        const [eData, zData] = await Promise.all([eRes.json(), zRes.json()]);
        if (eData.error || zData.error) throw new Error(eData.error || zData.error);

        const timesByDate = {};
        Object.entries(zData.times || {}).forEach(([zman, byDate]) => {
          if (byDate && typeof byDate === 'object') {
            Object.entries(byDate).forEach(([d, iso]) => {
              if (!timesByDate[d]) timesByDate[d] = {};
              timesByDate[d][zman] = iso;
            });
          }
        });

        const payload = {
          timestamp: Date.now(), zip, candleMins, start, end,
          tzid: (zData.location && zData.location.tzid) || (eData.location && eData.location.tzid) || null,
          locationName: (zData.location && zData.location.name) || '',
          times: timesByDate,
          events: eData.items || []
        };
        if (cancelled) return;
        try { localStorage.setItem(cacheKey, JSON.stringify(payload)); } catch (e) { /* storage full */ }
        setHebcal(payload);
        setFetchError(null);
      } catch (err) {
        if (!cancelled) setFetchError(err.message || String(err)); // cached data (if any) stays on screen
      }
    })();
    return () => { cancelled = true; };
  }, [cacheKey, civilKey, refreshTick, settingsNode.loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // Retry every 15 minutes while offline, and refresh data older than 6 hours
  useEffect(() => {
    const id = setInterval(() => {
      const stale = !hebcal || Date.now() - (hebcal.timestamp || 0) > 6 * 3600000;
      if (fetchError || stale) setRefreshTick(t => t + 1);
    }, 15 * 60000);
    return () => clearInterval(id);
  }, [fetchError, hebcal]);

  /* ---------- Derived board data ---------- */
  const dynamicRules = useMemo(() => toList(rulesNode.value), [rulesNode.value]);
  const board = useMemo(
    () => computeBoard({ hebcal, now: activeNow, tz, settings, dynamicRules }),
    [hebcal, activeNow.getTime(), tz, settings, dynamicRules] // eslint-disable-line react-hooks/exhaustive-deps
  );

  /* ---------- Heartbeat to Admin ---------- */
  let tvStatus = 'OK', tvMessage = 'Rendering normally';
  if (!hebcal) { tvStatus = 'ERROR'; tvMessage = fetchError ? `No zmanim data: ${fetchError}` : 'Loading zmanim...'; }
  else if (!board.hasToday) { tvStatus = 'ERROR'; tvMessage = `No zmanim cached for ${civilKey}${fetchError ? ` (${fetchError})` : ''}`; }
  else if (fetchError) { tvStatus = 'WARNING'; tvMessage = `Offline - showing cached data from ${new Date(hebcal.timestamp).toLocaleString()} (${fetchError})`; }
  else if (simActive) { tvStatus = 'SIMULATION'; tvMessage = `Simulating ${sim.date} ${sim.time || ''}`; }

  const beatRef = useRef({});
  beatRef.current = { status: tvStatus, message: tvMessage, activeDate: civilKey, location: (hebcal && hebcal.locationName) || zip };
  const sendBeat = useCallback(() => {
    set(ref(db, 'system_logs/tv_status'), {
      ...beatRef.current,
      lastUpdate: serverTimestamp(),
      tvClock: Date.now()
    }).catch(() => { /* offline - will retry */ });
  }, []);

  useEffect(() => {
    const unsub = onValue(ref(db, '.info/connected'), (snap) => {
      if (snap.val() === true) {
        onDisconnect(ref(db, 'system_logs/tv_status')).update({ status: 'OFFLINE', message: 'TV lost its connection to Firebase' });
        sendBeat();
      }
    });
    return () => unsub();
  }, [sendBeat]);

  useEffect(() => {
    sendBeat();
    const id = setInterval(sendBeat, 5 * 60000);
    return () => clearInterval(id);
  }, [sendBeat, tvStatus, tvMessage, civilKey]);

  /* ---------- Ticker ---------- */
  const tickerMessages = useMemo(() => {
    const d = tickerNode.value;
    if (!d) return ["אין הודעות חדשות"];
    return typeof d === 'string' ? [d] : Object.values(d);
  }, [tickerNode.value]);
  const tickerRef = useRef(null);
  const [tickerDuration, setTickerDuration] = useState(25);
  useLayoutEffect(() => {
    const measure = () => {
      const el = tickerRef.current;
      if (!el) return;
      const pxPerSec = Math.max(60, window.innerHeight * 0.12);
      setTickerDuration(Math.max(10, (el.scrollWidth + window.innerWidth) / pxPerSec));
    };
    measure();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [tickerMessages, fontFamily]);

  /* ---------- Minyan lists ---------- */
  const displayWeekdayMinyanim = toList(manualNode.value)
    .sort((a, b) => parseTimeStrToMinutes(a.time) - parseTimeStrToMinutes(b.time));

  const dayRank = (d) => (d === 'erev' ? 0 : 1);
  const displayShabbosMinyanim = [
    ...toList(shabbosNode.value).map(m => ({ ...m, day: m.day === 'erev' ? 'erev' : 'yom' })),
    ...(board.dynamicMinyanim || [])
  ].sort((a, b) => (dayRank(a.day) - dayRank(b.day)) || (parseTimeStrToMinutes(a.time) - parseTimeStrToMinutes(b.time)));
  const hasBothDays = displayShabbosMinyanim.some(m => m.day === 'erev') && displayShabbosMinyanim.some(m => m.day === 'yom');
  const isShabbosPeriod = !board.period || board.period.isShabbos;

  /* ---------- Overrides (ignored after their expiry date) ---------- */
  const rawOverrides = overridesNode.value || EMPTY_OBJ;
  const overrides = (!rawOverrides.expires || civilKey <= rawOverrides.expires) ? rawOverrides : EMPTY_OBJ;
  const period = board.period || null;
  const displayParsha = overrides.parsha || (period ? period.title : '');
  const displayDaf = overrides.daf || board.daf;
  const displayOmer = overrides.omer || board.omer;
  const displayHaftarah = overrides.haftarah || (period ? period.haftarah : '');
  const candleRows = period ? period.candles.map((c, i) => (i === 0 && overrides.candles ? { ...c, time: overrides.candles } : c)) : [];

  const seasonal = seasonalNode.value || EMPTY_OBJ;
  const finalInsertions = [...(board.inserts || [])];
  if (seasonal.mashivHaruach) finalInsertions.push("משיב הרוח ומוריד הגשם");
  if (seasonal.vtenTal) finalInsertions.push("ותן טל ומטר לברכה");

  const motzeiLabel = period && period.lastIsShabbos ? 'מוצאי שבת' : 'מוצאי יו״ט';

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Frank+Ruhl+Libre:wght@400;700;900&family=Heebo:wght@400;700;900&family=Rubik:wght@400;700;900&display=swap');

        * { box-sizing: border-box; margin: 0; padding: 0; }

        body {
          margin: 0; padding: 0; overflow: hidden;
          font-family: '${fontFamily}', sans-serif;
          background-color: #000;
        }

        .dark-mode { --bg-main: #000000; --bg-panel: #111111; --bg-center: #0a0a0a; --bg-row: #1a1a1a; --text-main: #ffffff; --text-sec: #aaaaaa; --text-row: #dddddd; --border: #333333; --border-panel: #222222; --accent: #f1c40f; --ticker-bg: #0d47a1; }
        .light-mode { --bg-main: #e9ecef; --bg-panel: #ffffff; --bg-center: #f8f9fa; --bg-row: #f1f3f5; --text-main: #212529; --text-sec: #495057; --text-row: #343a40; --border: #ced4da; --border-panel: #dee2e6; --accent: #d35400; --ticker-bg: #1565c0; }
        .marble-mode { --bg-main: #f9f9f9; --bg-panel: #ffffff; --bg-center: #fafafa; --bg-row: #fdfdfd; --text-main: #2c3e50; --text-sec: #7f8c8d; --text-row: #34495e; --border: #d4af37; --border-panel: #e8e8e8; --accent: #b8860b; --ticker-bg: #1a252f; }
        .marble-mode.board-container { background: radial-gradient(circle at center, #ffffff 0%, #f4f4f9 100%); }
        .marble-mode .panel { box-shadow: 0 4px 15px rgba(212, 175, 55, 0.15); border: 2px solid var(--border); }
        .marble-mode .header { background: linear-gradient(to right, #ffffff, #f9f9f9); border-bottom: 4px solid var(--border); }
        .wood-mode { --bg-main: #4e342e; --bg-panel: #fdf5e6; --bg-center: #fffaf0; --bg-row: #f4ebd8; --text-main: #3e2723; --text-sec: #5d4037; --text-row: #4e342e; --border: #8d6e63; --border-panel: #d7ccc8; --accent: #2e7d32; --ticker-bg: #3e2723; }
        .wood-mode .panel { border: 4px solid #795548; box-shadow: 0 10px 20px rgba(0,0,0,0.3); border-radius: 12px; }
        .wood-mode .header { background-color: #3e2723; border-bottom: 4px solid #8d6e63; }
        .wood-mode .header h1, .wood-mode .header h2 { color: #fffaf0; }
        .wood-mode .header p { color: #d7ccc8; }

        .board-container { width: 100vw; height: 100vh; display: flex; flex-direction: column; direction: rtl; background-color: var(--bg-main); color: var(--text-main); transition: all 0.3s ease; position: relative; }
        .sim-banner { position: absolute; top: 0; left: 0; width: 100%; background: #d32f2f; color: #fff; text-align: center; padding: 5px; font-weight: bold; font-size: 2vh; direction: ltr; z-index: 100; }
        .header { display: flex; justify-content: space-between; align-items: center; padding: 2vh 4vw; background-color: var(--bg-panel); border-bottom: 4px solid var(--border); height: 15vh; }
        .shul-brand { display: flex; align-items: center; gap: 1.5vw; }
        .shul-brand img { height: 10vh; max-width: 20vw; object-fit: contain; }
        .shul-brand h1 { font-size: 4vh; font-weight: 900; }
        .shul-brand p { font-size: 2vh; color: var(--text-sec); }
        .clock-section { text-align: left; }
        .clock-section h2 { font-size: 6vh; font-weight: 900; direction: ltr; }
        .clock-section p { font-size: 2.5vh; color: var(--text-sec); }
        .main-grid { display: grid; grid-template-columns: 1fr 2fr 1fr; gap: 2vw; padding: 3vh 4vw; height: 75vh; }

        .panel { background-color: var(--bg-panel); border-radius: 16px; padding: 3vh 2vw; border: 1px solid var(--border-panel); overflow-y: hidden; display: flex; flex-direction: column; }
        .panel-header { font-size: 3.5vh; margin-bottom: 1.5vh; color: var(--accent); text-align: center; border-bottom: 2px solid var(--border); padding-bottom: 1vh; flex-shrink: 0; }

        .minyan-row { display: flex; justify-content: space-between; align-items: center; font-size: 2.6vh; margin-bottom: 1vh; background-color: var(--bg-row); padding: 1vh 2vw; border-radius: 8px; }
        .minyan-row .time { direction: ltr; font-weight: 900; color: var(--text-main); }
        .minyan-group { font-size: 2vh; color: var(--text-sec); margin: 0.6vh 0 0.6vh; padding-right: 0.5vw; font-weight: 700; }

        .compact-row { display: flex; justify-content: space-between; align-items: center; font-size: 1.9vh; margin-bottom: 0.6vh; background-color: var(--bg-row); padding: 0.8vh 1vw; border-radius: 6px; }
        .compact-row .val { direction: ltr; font-weight: 700; color: var(--text-main); }

        .ticker-wrap { height: 10vh; background-color: var(--ticker-bg); color: #fff; overflow: hidden; white-space: nowrap; position: relative; }
        .ticker { position: absolute; left: 0; top: 50%; display: inline-block; white-space: nowrap; direction: rtl; font-size: 4vh; font-weight: 700; animation-name: ticker-scroll-rtl; animation-timing-function: linear; animation-iteration-count: infinite; }
        .ticker-item { margin: 0 4vw; }
        /* Hebrew reads right-to-left, so text travels left -> right and the start of each message appears first */
        @keyframes ticker-scroll-rtl { from { transform: translate(-100%, -50%); } to { transform: translate(100vw, -50%); } }

        @keyframes flame-flicker {
          0%, 100% { transform: translateX(-50%) scale(1); opacity: 0.85; }
          50% { transform: translateX(-50%) scale(1.1) translateY(-2px); opacity: 1; }
        }
        @media (prefers-reduced-motion: reduce) { .ticker { animation-duration: 0s !important; transform: translate(0, -50%); } }
      `}</style>

      {mainBg && (
        <style>{`
          .board-container {
            background-image: url('${mainBg}') !important;
            background-size: cover !important;
            background-position: center !important;
          }
        `}</style>
      )}
      {panelBg && (
        <style>{`
          .panel {
            background-image: url('${panelBg}') !important;
            background-size: cover !important;
            background-position: center !important;
          }
        `}</style>
      )}

      <div className={`board-container ${theme}-mode`}>
        {simActive && (
          <div className="sim-banner">
            ⚠️ SIMULATION MODE: {civilKey} {formatTime12(activeNow, tz)} (auto-off {new Date(sim.expiresAt).toLocaleString()}) ⚠️
          </div>
        )}
        <header className="header" style={{ marginTop: simActive ? '3vh' : '0' }}>
          <div className="shul-brand">
            {logoUrl && <img src={logoUrl} alt="" />}
            <div><h1>{shulName}</h1>{shulSubtitle && <p>{shulSubtitle}</p>}</div>
          </div>
          <div className="clock-section"><h2>{formatTime12(activeNow, tz)}</h2><p>{board.hDate}</p></div>
        </header>

        <main className="main-grid" style={{ height: simActive ? '72vh' : '75vh' }}>
          {/* ===== LEFT: TODAY ===== */}
          <div className="panel" style={{ padding: '2vh 1vw' }}>
            <div className="panel-header">זמנים להיום</div>

            {board.fast && (
              <div style={{ backgroundColor: '#311b92', padding: '1vh', borderRadius: '6px', textAlign: 'center', marginBottom: '1.5vh', border: '1px solid #5e35b1' }}>
                <h4 style={{ color: '#b39ddb', fontSize: '1.5vh', margin: '0 0 0.3vh 0' }}>{board.fast.mode === 'erev' ? 'צום מחר' : 'זמני צום'}</h4>
                <div style={{ color: '#fff', fontSize: '2.4vh', fontWeight: 'bold', marginBottom: '0.5vh' }}>{board.fast.name}</div>
                <div style={{ display: 'flex', justifyContent: 'space-around', color: '#fff', fontSize: '1.8vh' }}>
                  {board.fast.startStr && (
                    <div>
                      <span>{board.fast.mode === 'erev' ? (board.fast.startsEvening ? 'תחילה (הערב):' : 'תחילה (מחר):') : 'תחילה:'}</span>{' '}
                      <span style={{ fontWeight: 'bold', direction: 'ltr', display: 'inline-block' }}>{board.fast.startStr}</span>
                    </div>
                  )}
                  {board.fast.endStr && (
                    <div><span>סיום:</span> <span style={{ fontWeight: 'bold', direction: 'ltr', display: 'inline-block' }}>{board.fast.endStr}</span></div>
                  )}
                </div>
              </div>
            )}

            {board.chanukahTonight > 0 && (
              <div style={{ backgroundColor: 'var(--bg-row)', padding: '1.5vh', borderRadius: '6px', textAlign: 'center', marginBottom: '1.5vh', border: '1px solid var(--accent)' }}>
                <h4 style={{ color: 'var(--accent)', fontSize: '2vh', margin: '0 0 1.5vh 0', fontWeight: '900' }}>
                  {board.chanukahTonight === 1 ? "חנוכה - הערב נר ראשון" : `חנוכה - הערב ${['', '', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ז׳', 'ח׳'][board.chanukahTonight]} נרות`}
                </h4>
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'flex-end', gap: '0.8vw', height: '4.5vh', paddingBottom: '0.5vh' }}>
                  {[8, 7, 6, 5, 0, 4, 3, 2, 1].map((dayTh, idx) => {
                    const isShamash = idx === 4;
                    const isLit = isShamash || (dayTh <= board.chanukahTonight && dayTh !== 0);
                    return (
                      <div key={idx} style={{ width: '1.2vw', height: isShamash ? '4.5vh' : '3vh', backgroundColor: isLit ? 'var(--accent)' : 'var(--border)', borderRadius: '2px', position: 'relative' }}>
                        {isLit && (
                          <div style={{ position: 'absolute', top: '-2vh', left: '50%', transform: 'translateX(-50%)', width: '0.8vw', height: '1.5vh', backgroundColor: '#ffb300', borderRadius: '50% 50% 20% 20%', boxShadow: '0 0 10px #ffb300, 0 0 15px #ff8f00', animation: `flame-flicker ${1.5 + ((idx * 0.37) % 1)}s infinite alternate` }} />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {finalInsertions.length > 0 && (
              <div style={{ backgroundColor: '#c62828', padding: '1vh', borderRadius: '6px', textAlign: 'center', marginBottom: '1.5vh' }}>
                <h4 style={{ color: '#ffcdd2', fontSize: '1.6vh', margin: '0 0 0.2vh 0' }}>תזכורת תפילה</h4>
                {finalInsertions.map((ins, i) => (<div key={i} style={{ color: '#fff', fontSize: '2.2vh', fontWeight: 'bold' }}>{ins}</div>))}
              </div>
            )}

            {board.zmanim ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2vh', flex: 1 }}>
                <div className="compact-row"><span>עלות השחר</span><span className="val">{board.zmanim.alos}</span></div>
                <div className="compact-row"><span>נץ החמה</span><span className="val">{board.zmanim.netz}</span></div>
                <div className="compact-row" style={{ color: 'var(--accent)' }}><span>סוזק"ש (מג"א)</span><span className="val" style={{ color: 'inherit' }}>{board.zmanim.szksMGA}</span></div>
                <div className="compact-row" style={{ color: 'var(--accent)' }}><span>סוזק"ש (גר"א)</span><span className="val" style={{ color: 'inherit' }}>{board.zmanim.szksGRA}</span></div>
                <div className="compact-row"><span>חצות</span><span className="val">{board.zmanim.chatzos}</span></div>
                <div className="compact-row"><span>מנחה גדולה</span><span className="val">{board.zmanim.minchaG}</span></div>
                <div className="compact-row"><span>מנחה קטנה</span><span className="val">{board.zmanim.minchaK}</span></div>
                <div className="compact-row"><span>שקיעה</span><span className="val">{board.zmanim.shkia}</span></div>
                <div className="compact-row"><span>צאת הכוכבים</span><span className="val">{board.zmanim.tzeis}</span></div>
              </div>
            ) : (
              <div style={{ textAlign: 'center', marginTop: '5vh', color: 'var(--text-sec)' }}>
                {fetchError ? 'אין חיבור לשרת הזמנים - מנסה שוב...' : 'טוען זמנים...'}
              </div>
            )}
          </div>

          {/* ===== CENTER: MINYANIM ===== */}
          <div className="panel" style={{ backgroundColor: 'var(--bg-center)' }}>
            {!board.holyMode && (
              <>
                <div className="panel-header" style={{ fontSize: '4vh', paddingBottom: '0.5vh', marginBottom: '1vh' }}>ימי החול</div>
                <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
                  {displayWeekdayMinyanim.length === 0 ? (
                    <div style={{ textAlign: 'center', color: 'var(--text-sec)', marginTop: '2vh' }}>אין זמני תפילה מוגדרים</div>
                  ) : (
                    displayWeekdayMinyanim.map((minyan) => (
                      <div key={minyan.id} className="minyan-row">
                        <span>{minyan.label ? minyan.label.trim() : ""}</span>
                        <span className="time">{minyan.time}</span>
                      </div>
                    ))
                  )}
                </div>
              </>
            )}

            {board.holyMode && (
              <>
                <div className="panel-header" style={{ fontSize: '4vh', paddingBottom: '0.5vh', marginBottom: '1vh' }}>{isShabbosPeriod ? 'שבת קודש' : 'יום טוב'}</div>
                <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
                  {displayShabbosMinyanim.length === 0 ? (
                    <div style={{ textAlign: 'center', color: 'var(--text-sec)', marginTop: '2vh' }}>אין זמני תפילה מוגדרים</div>
                  ) : (
                    displayShabbosMinyanim.map((minyan, idx) => {
                      const showGroup = hasBothDays && (idx === 0 || displayShabbosMinyanim[idx - 1].day !== minyan.day);
                      const groupLabel = minyan.day === 'erev' ? (isShabbosPeriod ? 'ליל שבת' : 'ערב יום טוב') : (isShabbosPeriod ? 'יום שבת' : 'יום טוב');
                      return (
                        <React.Fragment key={minyan.id || `dyn-${idx}`}>
                          {showGroup && <div className="minyan-group">{groupLabel}</div>}
                          <div className="minyan-row">
                            <span>{minyan.label ? minyan.label.trim() : ""}</span>
                            <span className="time">{minyan.time}</span>
                          </div>
                        </React.Fragment>
                      );
                    })
                  )}
                </div>
              </>
            )}
          </div>

          {/* ===== RIGHT: SHABBOS / YOM TOV ===== */}
          <div className="panel" style={{ padding: '2vh 1vw' }}>
            {(displayDaf || displayOmer) && (
              <div style={{ marginBottom: '1vh' }}>
                {displayDaf && <div className="compact-row"><span>דף היומי:</span><span style={{ fontWeight: 'bold', color: theme === 'light' ? '#1565c0' : '#64b5f6' }}>{displayDaf}</span></div>}
                {displayOmer && <div className="compact-row"><span>ספירת העומר:</span><span style={{ fontWeight: 'bold', color: theme === 'light' ? '#e65100' : '#ffb74d' }}>{displayOmer}</span></div>}
              </div>
            )}
            <div style={{ backgroundColor: 'var(--border-panel)', textAlign: 'center', padding: '1vh', borderRadius: '6px', marginBottom: '1vh' }}>
              <div style={{ fontSize: '2.4vh', fontWeight: 'bold', color: 'var(--accent)' }}>{displayParsha || (board.ready ? '' : 'טוען...')}</div>
              {period && period.specials.length > 0 && <div style={{ fontSize: '1.8vh', color: 'var(--text-main)', marginTop: '0.3vh' }}>{period.specials.join(' | ')}</div>}
            </div>
            {period && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2vh', flex: 1 }}>
                {period.plag && <div className="compact-row"><span>פלג המנחה:</span><span className="val">{period.plag}</span></div>}
                {candleRows.map((c, i) => (
                  <div key={i} className="compact-row"><span>{c.label}:</span><span className="val">{c.time}</span></div>
                ))}
                {displayHaftarah && <div className="compact-row"><span>הפטרה:</span><span className="val" style={{ fontSize: '1.7vh', direction: 'rtl' }}>{displayHaftarah}</span></div>}
                {period.shkia && <div className="compact-row" style={{ marginTop: '0.5vh', borderTop: '1px solid var(--border)', paddingTop: '1vh', borderRadius: '0' }}><span>שקיעה:</span><span className="val">{period.shkia}</span></div>}
                {period.tzeis && <div className="compact-row"><span>צאת הכוכבים:</span><span className="val">{period.tzeis}</span></div>}
                {period.m60 && <div className="compact-row"><span>{motzeiLabel} (60׳):</span><span className="val">{period.m60}</span></div>}
                {period.m72 && <div className="compact-row"><span>צאת (72 דק׳ משקיעה):</span><span className="val">{period.m72}</span></div>}
                {!board.mevorchim && board.klActiveEnd && <div className="compact-row"><span>סוף זמן קידוש לבנה:</span><span className="val" style={{ direction: 'rtl' }}>{board.klActiveEnd}</span></div>}
              </div>
            )}
            {board.mevorchim && (
              <div style={{ marginTop: '1vh', border: '1px solid var(--accent)', borderRadius: '6px', overflow: 'hidden' }}>
                <div style={{ backgroundColor: 'var(--accent)', color: '#000', padding: '0.6vh', textAlign: 'center', fontWeight: 'bold', fontSize: '1.8vh' }}>{board.mevorchim.title}</div>
                <div style={{ backgroundColor: 'var(--bg-row)', color: 'var(--text-main)', padding: '0.4vh', textAlign: 'center', fontSize: '1.6vh' }}>{board.mevorchim.rcDays}</div>
                <div style={{ backgroundColor: 'var(--bg-row)', color: 'var(--text-main)', padding: '0.4vh', textAlign: 'center', fontSize: '1.6vh', borderBottom: '1px solid var(--border)' }}>{board.mevorchim.molad}</div>
                <div style={{ backgroundColor: 'var(--bg-panel)', color: 'var(--text-main)', padding: '0.6vh 1vw', fontSize: '1.6vh' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px dotted var(--border)', paddingBottom: '0.3vh', marginBottom: '0.3vh' }}><span>קידוש לבנה (תחילה):</span><span style={{ fontWeight: 'bold' }}>{board.mevorchim.klStart}</span></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>קידוש לבנה (סוף):</span><span style={{ fontWeight: 'bold' }}>{board.mevorchim.klEnd}</span></div>
                </div>
              </div>
            )}
          </div>
        </main>

        <footer className="ticker-wrap">
          <div className="ticker" ref={tickerRef} style={{ animationDuration: `${tickerDuration}s` }}>
            {tickerMessages.map((msg, idx) => (<span key={idx} className="ticker-item">• {msg} </span>))}
          </div>
        </footer>
      </div>
    </>
  );
};

export default App;
