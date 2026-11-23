import React, { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'react';
import { ref, onValue, set, onDisconnect, serverTimestamp } from "firebase/database";
import { db } from './firebase';
import { HebrewCalendar, Location, Zmanim, HDate, months } from '@hebcal/core';
import '@hebcal/learning'; // registers Daf Yomi with @hebcal/core
import { eventToClassicApiObject } from '@hebcal/rest-api';

/* =====================================================================
   CONSTANTS
   ===================================================================== */
const LOC_CACHE_PREFIX = 'shulBoardLocation:'; // legacy zip -> coordinates lookup (one time)
const FB_CACHE_PREFIX = 'shulBoardFb:';       // Firebase snapshot cache (per path)
const DAY_NAMES = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "שבת"];
const BROWSER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const ALLOWED_FONTS = ['Heebo', 'Rubik', 'Frank Ruhl Libre'];
const ALLOWED_THEMES = ['dark', 'light', 'marble', 'wood'];
const EMPTY_OBJ = {};

// Old Hebcal API caches are no longer needed - the calendar is calculated on the device
try { Object.keys(localStorage).filter(k => k.startsWith('shulBoardCacheV2')).forEach(k => localStorage.removeItem(k)); } catch (e) { /* ignore */ }

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
  // e.g. "3:06PM 11/24" (time first, then month/day)
  return `${formatTime12(dateObj, tz).replace(/\s+/g, '')} ${m}/${d}`;
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
   LOCAL CALENDAR ENGINE (@hebcal/core - no internet needed)
   Produces the same shape the Hebcal web API returned, so the board
   logic below is unchanged.
   ===================================================================== */
// End-of-window zmanim round earlier, start-of-window zmanim round later
const ZMAN_ROUNDING = {
  alotHaShachar: 'up', sunrise: 'up', sofZmanShma: 'down', sofZmanShmaMGA: 'down',
  chatzot: 'nearest', minchaGedola: 'up', minchaKetana: 'up', plagHaMincha: 'up',
  sunset: 'down', tzeit7083deg: 'up', tzeit85deg: 'up'
};

const roundToMinute = (d, mode) => {
  if (!d || isNaN(d.getTime())) return null;
  const t = d.getTime(), step = 60000;
  if (mode === 'down') return new Date(Math.floor(t / step) * step);
  if (mode === 'up') return new Date(Math.ceil(t / step) * step);
  return new Date(Math.round(t / step) * step);
};

const localDateOfKey = (key) => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d, 12, 0, 0); };

const validLocation = (loc) => !!loc
  && Number.isFinite(Number(loc.latitude)) && Number.isFinite(Number(loc.longitude))
  && typeof loc.tzid === 'string' && loc.tzid.length > 0;

function buildCalendar({ loc, il, candleMins, startKey, endKey }) {
  const location = new Location(Number(loc.latitude), Number(loc.longitude), il, loc.tzid, loc.name || '');
  const options = {
    start: localDateOfKey(startKey),
    end: localDateOfKey(endKey),
    location,
    il,
    candlelighting: true,
    candleLightingMins: candleMins,
    havdalahDeg: 8.5,
    sedrot: true,
    omer: true,
    addHebrewDates: true,
    dailyLearning: { dafYomi: true },
    ashkenazi: true,
    noModern: true
  };
  const events = HebrewCalendar.calendar(options).map(ev => eventToClassicApiObject(ev, options, true));

  const times = {};
  for (let k = startKey; k <= endKey; k = addDays(k, 1)) {
    const z = new Zmanim(location, localDateOfKey(k), false);
    const raw = {
      alotHaShachar: z.alotHaShachar(), sunrise: z.sunrise(),
      sofZmanShma: z.sofZmanShma(), sofZmanShmaMGA: z.sofZmanShmaMGA(),
      chatzot: z.chatzot(), minchaGedola: z.minchaGedola(), minchaKetana: z.minchaKetana(),
      plagHaMincha: z.plagHaMincha(), sunset: z.sunset(),
      tzeit7083deg: z.tzeit(7.083), tzeit85deg: z.tzeit(8.5)
    };
    times[k] = {};
    Object.entries(raw).forEach(([name, d]) => {
      const r = roundToMinute(d, ZMAN_ROUNDING[name]);
      if (r) times[k][name] = Zmanim.formatISOWithTimeZone(loc.tzid, r);
    });
  }
  return { tzid: loc.tzid, locationName: loc.name || '', il, times, events, timestamp: Date.now() };
}

/* =====================================================================
   SEASONAL TEFILLAH (automatic)
   ===================================================================== */
const hdOfKey = (key) => new HDate(localDateOfKey(key));
const isCivilLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

// Mashiv HaRuach: Musaf of Shemini Atzeres (22 Tishrei) until Musaf of the 1st day of Pesach
const mashivOn = (key) => {
  const hd = hdOfKey(key), m = hd.getMonth(), d = hd.getDate();
  return (m === months.TISHREI && d >= 22) || m >= months.CHESHVAN || (m === months.NISAN && d < 15);
};

// V'sen Tal U'matar: Israel from Maariv of 7 Cheshvan; Diaspora from Maariv of Dec 4
// (Dec 5 in the year before a civil leap year). Ends with Mincha of Erev Pesach.
// Keys are halachic days, so the first day is the one that begins at that Maariv.
const vtenOn = (key, il) => {
  const hd = hdOfKey(key), m = hd.getMonth(), d = hd.getDate();
  if (il) return (m === months.CHESHVAN && d >= 7) || m >= months.KISLEV || (m === months.NISAN && d < 15);
  const [y, mo] = key.split('-').map(Number);
  if (mo >= 9) return key >= `${y}-12-${isCivilLeap(y + 1) ? '06' : '05'}`;
  return m >= months.TEVET || (m === months.NISAN && d < 15);
};

/* =====================================================================
   NUSACH: seasonal wording and Sefiras HaOmer text
   ===================================================================== */
const NUSACHIM = ['ashkenaz', 'sefard', 'edot'];
const nusachOf = (settings) => (NUSACHIM.includes(settings.nusach) ? settings.nusach : 'ashkenaz');

const MASHIV_TEXT = "משיב הרוח ומוריד הגשם";
const MORID_TEXT = "מוריד הטל";
// Birkas HaShanim: winter / summer wording, and a short name for notes
const BIRKAS_HASHANIM = {
  ashkenaz: { winter: "ותן טל ומטר לברכה", summer: "ותן ברכה", short: "ותן טל ומטר" },
  sefard: { winter: "ברך עלינו (ותן טל ומטר)", summer: "ברכנו", short: "ברך עלינו" },
  edot: { winter: "ברך עלינו", summer: "ברכנו", short: "ברך עלינו" }
};

const omerDayOf = (key) => {
  const hd = hdOfKey(key), m = hd.getMonth(), d = hd.getDate();
  if (m === months.NISAN && d >= 16) return d - 15;
  if (m === months.IYYAR) return 15 + d;
  if (m === months.SIVAN && d <= 5) return 44 + d;
  return 0;
};

const OMER_UNITS = ['', 'אחד', 'שנים', 'שלשה', 'ארבעה', 'חמשה', 'ששה', 'שבעה', 'שמונה', 'תשעה'];
const OMER_FIRST_TEN = ['', 'יום אחד', 'שני ימים', 'שלשה ימים', 'ארבעה ימים', 'חמשה ימים', 'ששה ימים', 'שבעה ימים', 'שמונה ימים', 'תשעה ימים', 'עשרה ימים'];
const OMER_TENS = { 2: 'עשרים', 3: 'שלשים', 4: 'ארבעים' };
const OMER_WEEKS = ['', 'שבוע אחד', 'שני שבועות', 'שלשה שבועות', 'ארבעה שבועות', 'חמשה שבועות', 'ששה שבועות', 'שבעה שבועות'];
const OMER_REMAINDER = ['', 'ויום אחד', 'ושני ימים', 'ושלשה ימים', 'וארבעה ימים', 'וחמשה ימים', 'וששה ימים'];

const omerDays = (n) => {
  if (n <= 10) return OMER_FIRST_TEN[n];
  if (n < 20) return `${OMER_UNITS[n - 10]} עשר יום`;
  const t = Math.floor(n / 10), u = n % 10;
  return u ? `${OMER_UNITS[u]} ו${OMER_TENS[t]} יום` : `${OMER_TENS[t]} יום`;
};

// Ashkenaz: "...שהם שבוע אחד ויום אחד בעומר"; Sefard: same with "לעומר";
// Edot HaMizrach: "היום שמונה ימים לעומר, שהם שבוע אחד ויום אחד"
const omerText = (n, nusach) => {
  if (!n) return '';
  const word = nusach === 'ashkenaz' ? 'בעומר' : 'לעומר';
  const base = `היום ${omerDays(n)}`;
  if (n < 7) return `${base} ${word}`;
  const w = Math.floor(n / 7), r = n % 7;
  const weeks = `שהם ${OMER_WEEKS[w]}${r ? ` ${OMER_REMAINDER[r]}` : ''}`;
  return nusach === 'edot' ? `${base} ${word}, ${weeks}` : `${base} ${weeks} ${word}`;
};

/* =====================================================================
   WEEKDAY DYNAMIC ANCHORS
   ===================================================================== */
const WEEKDAY_ANCHORS = {
  alos: 'alotHaShachar', netz: 'sunrise', chatzos: 'chatzot',
  mincha_gedola: 'minchaGedola', mincha_ketana: 'minchaKetana', plag: 'plagHaMincha',
  shkia: 'sunset', tzeis: 'tzeit7083deg', tzeis85: 'tzeit85deg'
};
const ruleDays = (rule) => {
  const raw = rule.days;
  const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? Object.values(raw) : [0, 1, 2, 3, 4]);
  return list.map(Number).filter(n => n >= 0 && n <= 6);
};

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
function computeBoard({ hebcal, now, tz, settings, dynamicRules, weekdayRules, seasonal, il }) {
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
  const nusach = nusachOf(settings);

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
  out.omer = omerText(omerDayOf(omerKey), nusach);

  const inserts = [];
  if (hEvs.some(e => e.category === 'roshchodesh')) inserts.push("יעלה ויבוא (ראש חודש)");
  if (hEvs.some(isCholHamoed)) inserts.push("יעלה ויבוא (חול המועד)");
  if (hEvs.some(e => chanukahCandles(e) >= 2 || isChanukahEighthDay(e))) inserts.push("על הניסים (חנוכה)");
  if (hEvs.some(e => /^Purim$/i.test(e.title || ''))) inserts.push("על הניסים (פורים)");

  out.inserts = inserts;

  /* ---------- Seasonal tefillah: wording follows the shul's nusach ---------- */
  const W = BIRKAS_HASHANIM[nusach];
  // Ashkenaz in Chutz Laaretz says nothing in the summer (no מוריד הטל)
  const silentSummer = nusach === 'ashkenaz' && !il;
  const seasonalCfg = seasonal || {};
  const hd = hdOfKey(hKey), hm = hd.getMonth(), hdDay = hd.getDate();
  let mashivRow, vtenRow;

  if (seasonalCfg.mode === 'manual') {
    mashivRow = seasonalCfg.mashivHaruach ? { text: MASHIV_TEXT } : (silentSummer ? null : { text: MORID_TEXT });
    vtenRow = { text: seasonalCfg.vtenTal ? W.winter : W.summer };
  } else {
    if (hm === months.TISHREI && hdDay === 22) {
      mashivRow = { text: MASHIV_TEXT, note: 'מתחילים במוסף', highlight: true };
    } else if (hm === months.NISAN && hdDay === 15) {
      mashivRow = silentSummer
        ? { text: 'מפסיקים משיב הרוח', note: 'במוסף', highlight: true }
        : { text: MORID_TEXT, note: 'מתחילים במוסף', highlight: true };
    } else if (mashivOn(hKey)) {
      mashivRow = { text: MASHIV_TEXT };
    } else if (silentSummer) {
      // A gentle reminder for the first month after Pesach, then the row is hidden
      const earlySummer = (hm === months.NISAN && hdDay > 15) || (hm === months.IYYAR && hdDay <= 15);
      mashivRow = earlySummer ? { text: 'אין אומרים מוריד הטל' } : null;
    } else {
      mashivRow = { text: MORID_TEXT };
    }

    const prevKey = addDays(hKey, -1);
    const vtenToday = vtenOn(hKey, il);
    const chatzot = T(civilKey, 'chatzot');
    if (vtenToday && !vtenOn(prevKey, il)) {
      vtenRow = { text: W.winter, note: 'מתחילים במעריב', highlight: true };
    } else if (vtenToday) {
      vtenRow = { text: W.winter };
    } else if (vtenOn(prevKey, il)) {
      vtenRow = { text: W.summer, note: `מפסיקים ${W.short}`, highlight: true };
    } else if (hKey === civilKey && vtenOn(tomorrowKey, il) && chatzot && now >= chatzot) {
      vtenRow = { text: W.summer, note: `הערב במעריב: ${W.short}`, highlight: true };
    } else {
      vtenRow = { text: W.summer };
    }
  }
  out.seasonal = [mashivRow, vtenRow].filter(Boolean);

  /* ---------- Weekday dynamic minyanim ---------- */
  const dow = dowOfKey(civilKey);
  const minuteOfDay = (d) => { const p = tzParts(d, tz); return p.hour * 60 + p.minute; };
  out.weekdayDynamic = (weekdayRules || []).map(rule => {
    const zname = WEEKDAY_ANCHORS[rule.anchor];
    const offset = Number(rule.offset);
    const days = ruleDays(rule);
    if (!zname || !Number.isFinite(offset) || !days.includes(dow)) return null;
    let base = null;
    if (rule.weekly === 'earliest' || rule.weekly === 'latest') {
      // Same time every day this week, based on the earliest/latest anchor among the rule's days
      const weekStart = addDays(civilKey, -dow);
      const mins = days.map(d => T(addDays(weekStart, d), zname)).filter(Boolean).map(minuteOfDay);
      if (mins.length) {
        const pick = rule.weekly === 'earliest' ? Math.min(...mins) : Math.max(...mins);
        base = zonedToInstant(civilKey, Math.floor(pick / 60), pick % 60, tz);
      }
    } else {
      base = T(civilKey, zname);
    }
    if (!base) return null;
    const mode = rule.round || (offset <= 0 ? 'down' : 'up');
    return { id: `w-${rule.id}`, label: rule.label, time: fmt(roundTime(new Date(base.getTime() + offset * 60000), mode)) };
  }).filter(Boolean);

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
    const pickHaftarah = (lp) => (lp ? ((nusach === 'edot' && lp.haftarah_sephardic) || lp.haftarah) : null);
    const haftarahEng = pickHaftarah(parshaEv && parshaEv.leyning) || pickHaftarah(yomTovEv && yomTovEv.leyning) || '';

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
   AUTO-FIT: shrinks a panel's contents just enough that nothing is cut
   off when extra boxes (fast, Chanukah, reminders) appear
   ===================================================================== */
const useFitToPanel = (fitKey) => {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const panel = el.parentElement;
    const fit = () => {
      let z = 1;
      el.style.zoom = '1';
      while (panel.scrollHeight > panel.clientHeight + 1 && z > 0.6) {
        z = Math.round((z - 0.04) * 100) / 100;
        el.style.zoom = String(z);
      }
    };
    fit();
    let cancelled = false;
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (!cancelled) fit(); });
    window.addEventListener('resize', fit);
    return () => { cancelled = true; window.removeEventListener('resize', fit); };
  }, [fitKey]);
  return ref;
};

/* =====================================================================
   APP
   ===================================================================== */
const App = () => {
  const [realTime, setRealTime] = useState(new Date());
  const [locError, setLocError] = useState(null);
  const [locRetry, setLocRetry] = useState(0);

  const settingsNode = useFbNode('settings', EMPTY_OBJ);
  const settings = settingsNode.value || EMPTY_OBJ;
  const tickerNode = useFbNode('ticker', null);
  const manualNode = useFbNode('manual_minyanim', null);
  const shabbosNode = useFbNode('shabbos_minyanim', null);
  const rulesNode = useFbNode('dynamic_rules', null);
  const weekdayRulesNode = useFbNode('weekday_rules', null);
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
  const candleMins = Number(settings.candleMinutes) > 0 ? Number(settings.candleMinutes) : 18;
  const il = settings.il === true;
  const zip = String(settings.zipCode || '').trim();
  const theme = ALLOWED_THEMES.includes(settings.theme) ? settings.theme : 'dark';
  const fontFamily = ALLOWED_FONTS.includes(settings.font) ? settings.font : 'Heebo';
  const mainBg = safeUrl(settings.mainBg);
  const panelBg = safeUrl(settings.panelBg);
  const logoUrl = safeUrl(settings.logoUrl);
  const shulName = settings.shulName || 'בית כנסת אוהל משה';
  const shulSubtitle = settings.shulSubtitle ?? 'קהילת קודש';

  /* ---------- Location ----------
     The admin saves coordinates in settings/location. Older setups that only
     have a zip code get a one-time lookup from Hebcal, cached on the device. */
  const settingsLoc = validLocation(settings.location) ? settings.location : null;
  const [zipLoc, setZipLoc] = useState(() => {
    try { const raw = zip && localStorage.getItem(LOC_CACHE_PREFIX + zip); return raw ? JSON.parse(raw) : null; }
    catch (e) { return null; }
  });

  useEffect(() => {
    if (settingsLoc || !zip) return;
    let cancelled = false;
    try {
      const raw = localStorage.getItem(LOC_CACHE_PREFIX + zip);
      if (raw) { setZipLoc(JSON.parse(raw)); setLocError(null); return; }
    } catch (e) { /* ignore */ }
    setZipLoc(null);
    (async () => {
      try {
        const res = await fetch(`https://www.hebcal.com/zmanim?cfg=json&zip=${encodeURIComponent(zip)}`);
        const data = await res.json();
        if (!res.ok || !data.location) throw new Error(data.error || `Zip ${zip} not found`);
        const found = { latitude: data.location.latitude, longitude: data.location.longitude, tzid: data.location.tzid, name: data.location.name };
        if (cancelled) return;
        try { localStorage.setItem(LOC_CACHE_PREFIX + zip, JSON.stringify(found)); } catch (e) { /* ignore */ }
        setZipLoc(found);
        setLocError(null);
      } catch (err) {
        if (!cancelled) setLocError(err.message || String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [zip, !!settingsLoc, locRetry]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!locError) return;
    const id = setInterval(() => setLocRetry(n => n + 1), 15 * 60000);
    return () => clearInterval(id);
  }, [locError]);

  const loc = settingsLoc || (validLocation(zipLoc) ? zipLoc : null);
  const tz = loc ? loc.tzid : BROWSER_TZ;

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

  /* ---------- Calendar: calculated on the device, recalculated daily ---------- */
  const calc = useMemo(() => {
    if (!loc) return { data: null, error: null };
    try {
      return { data: buildCalendar({ loc, il, candleMins, startKey: addDays(civilKey, -7), endKey: addDays(civilKey, 35) }), error: null };
    } catch (err) {
      console.error('Calendar calculation failed', err);
      return { data: null, error: err.message || String(err) };
    }
  }, [loc && loc.latitude, loc && loc.longitude, loc && loc.tzid, loc && loc.name, il, candleMins, civilKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const hebcal = calc.data;

  /* ---------- Derived board data ---------- */
  const dynamicRules = useMemo(() => toList(rulesNode.value), [rulesNode.value]);
  const weekdayRules = useMemo(() => toList(weekdayRulesNode.value), [weekdayRulesNode.value]);
  const seasonal = seasonalNode.value || EMPTY_OBJ;
  const board = useMemo(
    () => computeBoard({ hebcal, now: activeNow, tz, settings, dynamicRules, weekdayRules, seasonal, il }),
    [hebcal, activeNow.getTime(), tz, settings, dynamicRules, weekdayRules, seasonal, il] // eslint-disable-line react-hooks/exhaustive-deps
  );

  /* ---------- Heartbeat to Admin ---------- */
  let tvStatus = 'OK', tvMessage = `Rendering for ${loc ? loc.name || `${loc.latitude}, ${loc.longitude}` : ''} (${il ? 'Eretz Yisrael' : 'Chutz Laaretz'})`;
  if (!loc) { tvStatus = 'ERROR'; tvMessage = locError ? `No location: ${locError}` : 'No location set - choose the shul location in the admin panel.'; }
  else if (calc.error) { tvStatus = 'ERROR'; tvMessage = `Calendar calculation failed: ${calc.error}`; }
  else if (!board.hasToday) { tvStatus = 'ERROR'; tvMessage = `No zmanim for ${civilKey}`; }
  else if (simActive) { tvStatus = 'SIMULATION'; tvMessage = `Simulating ${sim.date} ${sim.time || ''}`; }

  const beatRef = useRef({});
  beatRef.current = { status: tvStatus, message: tvMessage, activeDate: civilKey, location: loc ? `${loc.name || ''} (${il ? 'Eretz Yisrael' : 'Chutz Laaretz'})` : '' };
  const sendBeat = useCallback(() => {
    set(ref(db, 'system_logs/tv_status'), {
      ...beatRef.current,
      lastUpdate: serverTimestamp(),
      tvClock: Date.now()
    }).catch(() => { /* offline - will retry */ });
  }, []);

  const [fbConnected, setFbConnected] = useState(false);
  useEffect(() => {
    const unsub = onValue(ref(db, '.info/connected'), (snap) => {
      const connected = snap.val() === true;
      setFbConnected(connected);
      if (connected) {
        onDisconnect(ref(db, 'system_logs/tv_status')).update({ status: 'OFFLINE', message: 'Screen lost its connection to Firebase' });
        sendBeat();
      }
    });
    return () => unsub();
  }, [sendBeat]);

  /* ---------- Nightly refresh ----------
     Reloads once between 3:00 and 3:10 AM (shul time) to keep long-running
     browsers fresh. Only reloads when the site is reachable, so an internet
     outage can never leave the screen on an error page. */
  const bootedAt = useRef(Date.now());
  useEffect(() => {
    const p = tzParts(realTime, tz);
    if (p.hour !== 3 || p.minute > 10) return undefined;
    if (Date.now() - bootedAt.current < 2 * 3600000) return undefined; // already fresh (also prevents loops)
    if (!navigator.onLine || !fbConnected) return undefined;
    let cancelled = false;
    fetch(window.location.href, { method: 'HEAD', cache: 'no-store' })
      .then((res) => { if (!cancelled && res.ok) window.location.reload(); })
      .catch(() => { /* site unreachable - try again next minute */ });
    return () => { cancelled = true; };
  }, [realTime, tz, fbConnected]);

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
  const displayWeekdayMinyanim = [...toList(manualNode.value), ...(board.weekdayDynamic || [])]
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

  const finalInsertions = board.inserts || [];

  const motzeiLabel = period && period.lastIsShabbos ? 'מוצאי שבת' : 'מוצאי יו״ט';

  const fitKey = JSON.stringify([
    board.zmanim, board.fast && [board.fast.name, board.fast.mode], board.chanukahTonight, finalInsertions, board.seasonal,
    period, board.mevorchim, board.klActiveEnd, displayDaf, displayOmer, displayParsha, displayHaftarah, candleRows,
    displayWeekdayMinyanim, displayShabbosMinyanim, board.holyMode, fontFamily, theme, simActive, !!loc
  ]);
  const todayFitRef = useFitToPanel(fitKey);
  const minyanFitRef = useFitToPanel(fitKey);
  const shabbosFitRef = useFitToPanel(fitKey);

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Frank+Ruhl+Libre:wght@400;700;900&family=Heebo:wght@400;700;900&family=Rubik:wght@400;700;900&display=swap');

        * { box-sizing: border-box; margin: 0; padding: 0; }

        body {
          margin: 0; padding: 0; overflow: hidden;
          font-family: '${fontFamily}', sans-serif;
          background-color: #000;
          -webkit-user-select: none; user-select: none;
          -webkit-tap-highlight-color: transparent;
        }
        /* Kiosk: no mouse pointer or text selection on the screen */
        html, body, body * { cursor: none !important; }

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
        /* never squeeze the contents; the auto-fit hook scales them instead */
        .panel-fit { display: flex; flex-direction: column; flex-shrink: 0; }
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
            <div className="panel-fit" ref={todayFitRef}>
            <div className="panel-header">זמני היום</div>

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
              <div style={{ backgroundColor: 'var(--bg-row)', padding: '0.8vh 1vh', borderRadius: '6px', textAlign: 'center', marginBottom: '1vh', border: '1px solid var(--accent)' }}>
                <h4 style={{ color: 'var(--accent)', fontSize: '1.9vh', margin: '0 0 1.8vh 0', fontWeight: '900' }}>
                  {board.chanukahTonight === 1 ? "חנוכה -  נר ראשון" : `ליל חנוכה  ${['', '', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ז׳', 'ח׳'][board.chanukahTonight]} נרות`}
                </h4>
                {/* Laid out left-to-right so the first night's candle is on the right, as it is lit */}
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'flex-end', gap: '0.8vw', height: '3.8vh', direction: 'ltr' }}>
                  {[8, 7, 6, 5, 0, 4, 3, 2, 1].map((dayTh, idx) => {
                    const isShamash = idx === 4;
                    const isLit = isShamash || (dayTh <= board.chanukahTonight && dayTh !== 0);
                    return (
                      <div key={idx} style={{ width: '1.2vw', height: isShamash ? '3.8vh' : '2.6vh', backgroundColor: isLit ? 'var(--accent)' : 'var(--border)', borderRadius: '2px', position: 'relative' }}>
                        {isLit && (
                          <div style={{ position: 'absolute', top: '-1.7vh', left: '50%', transform: 'translateX(-50%)', width: '0.8vw', height: '1.4vh', backgroundColor: '#ffb300', borderRadius: '50% 50% 20% 20%', boxShadow: '0 0 10px #ffb300, 0 0 15px #ff8f00', animation: `flame-flicker ${1.5 + ((idx * 0.37) % 1)}s infinite alternate` }} />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {finalInsertions.length > 0 && (
              <div style={{ backgroundColor: '#c62828', padding: '0.8vh', borderRadius: '6px', textAlign: 'center', marginBottom: '1vh' }}>
                <h4 style={{ color: '#ffcdd2', fontSize: '1.6vh', margin: '0 0 0.2vh 0' }}>תזכורת תפילה</h4>
                {finalInsertions.map((ins, i) => (<div key={i} style={{ color: '#fff', fontSize: '2.2vh', fontWeight: 'bold' }}>{ins}</div>))}
              </div>
            )}

            {board.seasonal && (
              <div style={{ border: '1px solid var(--border)', borderRadius: '6px', overflow: 'hidden', marginBottom: '1vh', flexShrink: 0 }}>
                {board.seasonal.map((row, i) => (
                  <div key={i} style={{
                    display: 'flex', justifyContent: 'center', alignItems: 'baseline', gap: '0.8vw', flexWrap: 'wrap',
                    padding: '0.6vh 0.8vw', fontSize: '2.1vh', fontWeight: 'bold', textAlign: 'center',
                    backgroundColor: row.highlight ? '#c62828' : 'var(--bg-row)',
                    color: row.highlight ? '#fff' : 'var(--text-main)',
                    borderTop: i > 0 ? '1px solid var(--border)' : 'none'
                  }}>
                    <span>{row.text}</span>
                    {row.note && <span style={{ fontSize: '1.6vh', fontWeight: 'normal', color: '#ffcdd2' }}>({row.note})</span>}
                  </div>
                ))}
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
                {!loc ? 'לא הוגדר מיקום לבית הכנסת' : 'טוען זמנים...'}
              </div>
            )}
            </div>
          </div>

          {/* ===== CENTER: MINYANIM ===== */}
          <div className="panel" style={{ backgroundColor: 'var(--bg-center)' }}>
            <div className="panel-fit" ref={minyanFitRef}>
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
          </div>

          {/* ===== RIGHT: SHABBOS / YOM TOV ===== */}
          <div className="panel" style={{ padding: '2vh 1vw' }}>
            <div className="panel-fit" ref={shabbosFitRef}>
            {(displayDaf || displayOmer) && (
              <div style={{ marginBottom: '1vh' }}>
                {displayDaf && <div className="compact-row"><span>דף היומי:</span><span style={{ fontWeight: 'bold', color: theme === 'light' ? '#1565c0' : '#64b5f6' }}>{displayDaf}</span></div>}
                {displayOmer && (
                  <div className="compact-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '0.3vh' }}>
                    <span>ספירת העומר:</span>
                    <span style={{ fontWeight: 'bold', textAlign: 'center', color: theme === 'light' ? '#e65100' : '#ffb74d' }}>{displayOmer}</span>
                  </div>
                )}
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
                {!board.mevorchim && board.klActiveEnd && <div className="compact-row"><span>סוף זמן קידוש לבנה:</span><span className="val" style={{ direction: 'ltr', unicodeBidi: 'isolate' }}>{board.klActiveEnd}</span></div>}
              </div>
            )}
            {board.mevorchim && (
              <div style={{ marginTop: '1vh', border: '1px solid var(--accent)', borderRadius: '6px', overflow: 'hidden' }}>
                <div style={{ backgroundColor: 'var(--accent)', color: '#000', padding: '0.6vh', textAlign: 'center', fontWeight: 'bold', fontSize: '1.8vh' }}>{board.mevorchim.title}</div>
                <div style={{ backgroundColor: 'var(--bg-row)', color: 'var(--text-main)', padding: '0.4vh', textAlign: 'center', fontSize: '1.6vh' }}>{board.mevorchim.rcDays}</div>
                <div style={{ backgroundColor: 'var(--bg-row)', color: 'var(--text-main)', padding: '0.4vh', textAlign: 'center', fontSize: '1.6vh', borderBottom: '1px solid var(--border)' }}>{board.mevorchim.molad}</div>
                <div style={{ backgroundColor: 'var(--bg-panel)', color: 'var(--text-main)', padding: '0.6vh 1vw', fontSize: '1.6vh' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px dotted var(--border)', paddingBottom: '0.3vh', marginBottom: '0.3vh' }}><span>קידוש לבנה (תחילה):</span><span style={{ fontWeight: 'bold', direction: 'ltr', unicodeBidi: 'isolate' }}>{board.mevorchim.klStart}</span></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>קידוש לבנה (סוף):</span><span style={{ fontWeight: 'bold', direction: 'ltr', unicodeBidi: 'isolate' }}>{board.mevorchim.klEnd}</span></div>
                </div>
              </div>
            )}
            </div>
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