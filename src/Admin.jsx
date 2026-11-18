import React, { useState, useEffect, useRef } from 'react';
import { ref, onValue, push, remove, set, update, get, query, limitToLast, limitToFirst, orderByChild, endAt, serverTimestamp } from 'firebase/database';
import { signInWithEmailAndPassword, signOut, onAuthStateChanged } from 'firebase/auth';
import { db, auth } from './firebase';

/* =====================================================================
   HELPERS
   ===================================================================== */
const pad = (n) => String(n).padStart(2, '0');

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

// Turns "7pm", "7:00 p.m.", "19:00" into "7:00 PM". Hebrew text like "אחר מעריב" is allowed as text.
const normalizeTime = (raw) => {
  const s = String(raw || '').trim();
  if (!s) return { ok: false, error: 'Enter a time.' };
  if (/[\u0590-\u05FF]/.test(s) || !/\d/.test(s)) return { ok: 'text', value: s };
  const m12 = s.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m?\.?$/i);
  if (m12) {
    const h = parseInt(m12[1], 10), mi = m12[2] ? parseInt(m12[2], 10) : 0;
    if (h < 1 || h > 12 || mi > 59) return { ok: false, error: 'That time is out of range.' };
    return { ok: true, value: `${h}:${pad(mi)} ${m12[3].toUpperCase()}M` };
  }
  const m24 = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m24) {
    const h = parseInt(m24[1], 10), mi = parseInt(m24[2], 10);
    if (h > 23 || mi > 59) return { ok: false, error: 'That time is out of range.' };
    if (h >= 13) return { ok: true, value: `${h - 12}:${pad(mi)} PM` };
    if (h === 0) return { ok: true, value: `12:${pad(mi)} AM` };
    return { ok: false, error: 'Add AM or PM (e.g. 7:00 PM), or use 24-hour time like 19:00.' };
  }
  return { ok: false, error: 'Use a format like 7:00 AM or 19:00.' };
};

// Returns the time to save, or null if the admin should fix it first.
const resolveTime = (raw, onError) => {
  const n = normalizeTime(raw);
  if (n.ok === true) return n.value;
  if (n.ok === 'text') {
    return window.confirm(`"${n.value}" isn't a clock time, so it will be listed at the end of the schedule. Save it as text?`) ? n.value : null;
  }
  onError(n.error);
  return null;
};

const isValidImageUrl = (u) => !u || /^https:\/\/[^'"()<>{}\\\s]+$/.test(u.trim());

const localDateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const nextSundayKey = () => {
  const d = new Date();
  d.setDate(d.getDate() + (((7 - d.getDay()) % 7) || 7));
  return localDateKey(d);
};

const useNow = (ms) => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(id); }, [ms]);
  return now;
};

/* =====================================================================
   CHANGE HISTORY
   Every admin change goes through commit(): it reads the old values,
   writes the new ones and a history entry in one atomic update, so any
   change can be undone later.
   ===================================================================== */
const HISTORY_DAYS = 120;

// Compares values regardless of key order
const stable = (v) => {
  if (v === undefined || v === null) return 'null';
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (typeof v === 'object') return `{${Object.keys(v).sort().filter(k => v[k] !== null && v[k] !== undefined).map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
};

const commit = async (changes, summary, meta = {}) => {
  const user = auth.currentUser;
  const paths = Object.keys(changes);
  const befores = await Promise.all(paths.map(p => get(ref(db, p)).then(snap => snap.val())));
  const entries = paths
    .map((p, i) => ({ path: p, before: befores[i] ?? null, after: changes[p] ?? null }))
    .filter(e => stable(e.before) !== stable(e.after));
  if (entries.length === 0) return false; // nothing actually changed

  const logKey = push(ref(db, 'audit_log')).key;
  const email = (user && user.email) || 'unknown';
  const updates = {};
  entries.forEach(e => { updates[e.path] = e.after; });
  updates[`audit_log/${logKey}`] = {
    ts: serverTimestamp(),
    uid: user ? user.uid : 'unknown',
    email,
    summary,
    changes: entries,
    ...(meta.undoOf ? { undoOf: meta.undoOf, baseSummary: meta.baseSummary || summary } : {})
  };
  if (meta.undoOf) {
    updates[`audit_log/${meta.undoOf}/undone`] = { byEmail: email, logId: logKey, ts: serverTimestamp() };
    if (meta.reviveId) updates[`audit_log/${meta.reviveId}/undone`] = null; // undoing an undo brings the original back
  }
  await update(ref(db), updates);
  return true;
};

const SECTION_NAMES = {
  manual_minyanim: 'weekday minyan',
  shabbos_minyanim: 'Shabbos minyan',
  dynamic_rules: 'Shabbos rule',
  weekday_rules: 'weekday rule'
};
const BASE_NAMES = { friday_candle: 'Fri candles', friday_shkia: 'Fri Shkia', shabbos_shkia: 'Shabbos Shkia', shabbos_tzeis: 'Shabbos Tzeis' };
const ANCHOR_NAMES = {
  alos: 'Alos', netz: 'Netz', chatzos: 'Chatzos', mincha_gedola: 'Mincha Gedola', mincha_ketana: 'Mincha Ketana',
  plag: 'Plag', shkia: 'Shkia', tzeis: 'Tzeis', tzeis85: 'Tzeis (8.5°)'
};
const shortText = (t) => { const s = String(t || ''); return s.length > 40 ? `${s.slice(0, 40)}…` : s; };
const describeOffset = (offset, anchorName) => {
  const n = Number(offset) || 0;
  if (n === 0) return `at ${anchorName}`;
  return `${Math.abs(n)} min ${n < 0 ? 'before' : 'after'} ${anchorName}`;
};
const describeMinyan = (m, withDay) => `"${m.label} ${m.time}"${withDay ? ` (${m.day === 'erev' ? 'Fri night' : 'Sat'})` : ''}`;
const describeShabbosRule = (r) => `"${r.label}" ${describeOffset(r.offset, BASE_NAMES[r.base] || r.base)}`;
const describeWeekdayRule = (r) => {
  const days = (Array.isArray(r.days) ? r.days : []).map(d => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'][d]).filter(Boolean).join('/');
  const weekly = r.weekly === 'earliest' ? ', same all week (earliest)' : r.weekly === 'latest' ? ', same all week (latest)' : '';
  return `"${r.label}" ${describeOffset(r.offset, ANCHOR_NAMES[r.anchor] || r.anchor)} (${days}${weekly})`;
};
const describeForSection = (section, item, withDay) => {
  if (section === 'dynamic_rules') return describeShabbosRule(item);
  if (section === 'weekday_rules') return describeWeekdayRule(item);
  return describeMinyan(item, withDay);
};

const formatWhen = (ts) => {
  if (typeof ts !== 'number') return 'just now';
  return new Date(ts).toLocaleString([], { weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

// Small inline status message ("✓ Saved", errors)
const useStatus = () => {
  const [st, setSt] = useState(null);
  const timer = useRef();
  const show = (type, msg, ms) => {
    clearTimeout(timer.current);
    setSt(type ? { type, msg } : null);
    if (type === 'ok') timer.current = setTimeout(() => setSt(null), ms || 2500);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  return [st, show];
};
const StatusText = ({ st }) => (st ? <span className={`row-status ${st.type}`}>{st.msg}</span> : null);

const DAY_OPTIONS = [
  { value: 'erev', label: 'ליל שבת / ערב (Friday night)' },
  { value: 'yom', label: 'יום שבת (Saturday)' }
];
const ROUND_OPTIONS = [
  { value: 'down', label: 'Round earlier (5 min)' },
  { value: 'nearest', label: 'Round nearest (5 min)' },
  { value: 'up', label: 'Round later (5 min)' },
  { value: 'none', label: 'Exact minute' }
];
const defaultRound = (base) => (base === 'shabbos_tzeis' ? 'none' : 'down');

const WEEKDAY_ANCHOR_OPTIONS = [
  { value: 'alos', label: 'Alos HaShachar' },
  { value: 'netz', label: 'Netz (sunrise)' },
  { value: 'chatzos', label: 'Chatzos' },
  { value: 'mincha_gedola', label: 'Mincha Gedola' },
  { value: 'mincha_ketana', label: 'Mincha Ketana' },
  { value: 'plag', label: 'Plag HaMincha' },
  { value: 'shkia', label: 'Shkia (sunset)' },
  { value: 'tzeis', label: 'Tzeis (7.083°)' },
  { value: 'tzeis85', label: 'Tzeis (8.5°)' }
];
const WEEKLY_OPTIONS = [
  { value: 'daily', label: 'Changes daily' },
  { value: 'earliest', label: 'Same all week (earliest)' },
  { value: 'latest', label: 'Same all week (latest)' }
];
const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const ruleDayList = (raw) => {
  const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? Object.values(raw) : [0, 1, 2, 3, 4]);
  return list.map(Number).filter(n => n >= 0 && n <= 5).sort();
};
const weekdayDefaultRound = (offset) => (Number(offset) <= 0 ? 'down' : 'up');

const TIMEZONES = (() => {
  try { return Intl.supportedValuesOf('timeZone'); } catch (e) { return ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Asia/Jerusalem', 'Europe/London']; }
})();

const DayPicker = ({ days, onChange }) => (
  <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
    {WEEKDAY_NAMES.map((name, d) => {
      const on = days.includes(d);
      return (
        <button key={d} type="button" onClick={() => onChange(on ? days.filter(x => x !== d) : [...days, d].sort())}
          className={`day-chip ${on ? 'on' : ''}`} aria-pressed={on}>{name}</button>
      );
    })}
  </div>
);

/* =====================================================================
   ROW EDITORS
   ===================================================================== */
const ManualMinyanRow = ({ minyan, dbPath, withDay }) => {
  const [lbl, setLbl] = useState(minyan.label || '');
  const [tm, setTm] = useState(minyan.time || '');
  const [st, show] = useStatus();
  const savedDay = minyan.day === 'erev' ? 'erev' : 'yom';

  useEffect(() => {
    setLbl(minyan.label || '');
    setTm(minyan.time || '');
  }, [minyan.label, minyan.time]);

  const section = SECTION_NAMES[dbPath] || dbPath;
  const write = (data) => commit(
    { [`${dbPath}/${minyan.id}`]: data },
    `Changed ${section} ${describeMinyan(minyan, withDay)} → ${describeMinyan(data, withDay)}`
  )
    .then(() => show('ok', '✓ Saved'))
    .catch(() => show('err', 'Save failed - check your connection or permissions.'));

  const handleSave = () => {
    if (lbl === (minyan.label || '') && tm === (minyan.time || '')) return;
    if (!lbl.trim()) { show('err', "Name can't be empty."); setLbl(minyan.label || ''); return; }
    const time = resolveTime(tm, (msg) => show('err', msg));
    if (time === null) { if (normalizeTime(tm).ok === 'text') setTm(minyan.time || ''); return; }
    setTm(time);
    write({ label: lbl.trim(), time, ...(withDay ? { day: savedDay } : {}) });
  };

  const handleDayChange = (day) => write({ label: minyan.label || '', time: minyan.time || '', day });

  const handleDelete = () => {
    if (window.confirm(`Delete "${minyan.label} ${minyan.time}"?`)) {
      commit({ [`${dbPath}/${minyan.id}`]: null }, `Deleted ${section} ${describeMinyan(minyan, withDay)}`)
        .catch(() => show('err', 'Delete failed.'));
    }
  };

  const onKey = (e) => { if (e.key === 'Enter') e.target.blur(); };

  return (
    <li className="data-item" style={{ gap: '10px', flexWrap: 'wrap' }}>
      <input value={lbl} onChange={e => setLbl(e.target.value)} onBlur={handleSave} onKeyDown={onKey} className="form-control" style={{ flex: 2, minWidth: '120px', background: 'transparent' }} dir="auto" />
      <input value={tm} onChange={e => setTm(e.target.value)} onBlur={handleSave} onKeyDown={onKey} className="form-control" style={{ flex: 1, minWidth: '100px', background: 'transparent' }} dir="auto" />
      {withDay && (
        <select value={savedDay} onChange={e => handleDayChange(e.target.value)} className="form-control" style={{ flex: 1, minWidth: '150px', background: 'transparent', padding: '6px' }}>
          {DAY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )}
      <StatusText st={st} />
      <button onClick={handleDelete} className="btn btn-danger" style={{ padding: '8px 12px' }}>Delete</button>
    </li>
  );
};

const DynamicMinyanRow = ({ minyan }) => {
  const [lbl, setLbl] = useState(minyan.label || '');
  const [offset, setOffset] = useState(String(minyan.offset ?? ''));
  const [st, show] = useStatus();
  const base = minyan.base || 'friday_candle';
  const round = minyan.round || defaultRound(base);

  useEffect(() => {
    setLbl(minyan.label || '');
    setOffset(String(minyan.offset ?? ''));
  }, [minyan.label, minyan.offset]);

  const write = (data) => commit(
    { [`dynamic_rules/${minyan.id}`]: data },
    `Changed Shabbos rule ${describeShabbosRule(minyan)} → ${describeShabbosRule(data)}`
  )
    .then(() => show('ok', '✓ Saved'))
    .catch(() => show('err', 'Save failed - check your connection or permissions.'));

  const validOffset = () => offset.trim() !== '' && Number.isFinite(Number(offset));

  const handleSave = () => {
    if (lbl === (minyan.label || '') && offset === String(minyan.offset ?? '')) return;
    if (!lbl.trim()) { show('err', "Name can't be empty."); setLbl(minyan.label || ''); return; }
    if (!validOffset()) { show('err', 'Enter minutes, e.g. -20 or 15.'); setOffset(String(minyan.offset ?? '')); return; }
    write({ label: lbl.trim(), base, offset: Number(offset), round });
  };

  const handleSelect = (changes) => write({
    label: minyan.label || '', base, round,
    offset: Number.isFinite(Number(minyan.offset)) ? Number(minyan.offset) : 0,
    ...changes
  });

  const handleDelete = () => {
    if (window.confirm(`Delete the rule "${minyan.label}"?`)) {
      commit({ [`dynamic_rules/${minyan.id}`]: null }, `Deleted Shabbos rule ${describeShabbosRule(minyan)}`)
        .catch(() => show('err', 'Delete failed.'));
    }
  };

  const onKey = (e) => { if (e.key === 'Enter') e.target.blur(); };

  return (
    <li className="data-item" style={{ gap: '10px', flexWrap: 'wrap' }}>
      <input value={lbl} onChange={e => setLbl(e.target.value)} onBlur={handleSave} onKeyDown={onKey} className="form-control" style={{ flex: 2, minWidth: '120px', background: 'transparent' }} dir="auto" />
      <div style={{ flex: 4, display: 'flex', gap: '5px', alignItems: 'center', flexWrap: 'wrap' }}>
        <input type="number" value={offset} onChange={e => setOffset(e.target.value)} onBlur={handleSave} onKeyDown={onKey} className="form-control" style={{ width: '70px', background: 'transparent', padding: '6px' }} />
        <span style={{ fontSize: '13px', color: '#64748b' }}>mins from</span>
        <select value={base} onChange={e => handleSelect({ base: e.target.value, round: minyan.round || defaultRound(e.target.value) })} className="form-control" style={{ flex: 1, minWidth: '110px', background: 'transparent', padding: '6px' }}>
          <option value="friday_candle">Fri: Candles</option>
          <option value="friday_shkia">Fri: Shkia</option>
          <option value="shabbos_shkia">Shab: Shkia</option>
          <option value="shabbos_tzeis">Shab: Tzeis</option>
        </select>
        <select value={round} onChange={e => handleSelect({ round: e.target.value })} className="form-control" style={{ flex: 1, minWidth: '140px', background: 'transparent', padding: '6px' }}>
          {ROUND_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      <StatusText st={st} />
      <button onClick={handleDelete} className="btn btn-danger" style={{ padding: '8px 12px' }}>Delete</button>
    </li>
  );
};

const WeekdayRuleRow = ({ rule }) => {
  const [lbl, setLbl] = useState(rule.label || '');
  const [offset, setOffset] = useState(String(rule.offset ?? ''));
  const [st, show] = useStatus();
  const anchor = rule.anchor || 'shkia';
  const weekly = rule.weekly || 'daily';
  const days = ruleDayList(rule.days);
  const round = rule.round || weekdayDefaultRound(rule.offset);

  useEffect(() => {
    setLbl(rule.label || '');
    setOffset(String(rule.offset ?? ''));
  }, [rule.label, rule.offset]);

  const current = () => ({
    label: rule.label || '', anchor, weekly, days, round,
    offset: Number.isFinite(Number(rule.offset)) ? Number(rule.offset) : 0
  });
  const write = (data) => commit(
    { [`weekday_rules/${rule.id}`]: data },
    `Changed weekday rule ${describeWeekdayRule({ ...rule, days })} → ${describeWeekdayRule(data)}`
  )
    .then(() => show('ok', '✓ Saved'))
    .catch(() => show('err', 'Save failed - check your connection or permissions.'));

  const handleSave = () => {
    if (lbl === (rule.label || '') && offset === String(rule.offset ?? '')) return;
    if (!lbl.trim()) { show('err', "Name can't be empty."); setLbl(rule.label || ''); return; }
    if (offset.trim() === '' || !Number.isFinite(Number(offset))) { show('err', 'Enter minutes, e.g. -15 or 10.'); setOffset(String(rule.offset ?? '')); return; }
    write({ ...current(), label: lbl.trim(), offset: Number(offset) });
  };

  const handleChange = (changes) => {
    if (changes.days && changes.days.length === 0) { show('err', 'Pick at least one day.'); return; }
    write({ ...current(), ...changes });
  };

  const handleDelete = () => {
    if (window.confirm(`Delete the rule "${rule.label}"?`)) {
      commit({ [`weekday_rules/${rule.id}`]: null }, `Deleted weekday rule ${describeWeekdayRule({ ...rule, days })}`)
        .catch(() => show('err', 'Delete failed.'));
    }
  };
  const onKey = (e) => { if (e.key === 'Enter') e.target.blur(); };

  return (
    <li className="data-item" style={{ gap: '10px', flexWrap: 'wrap' }}>
      <input value={lbl} onChange={e => setLbl(e.target.value)} onBlur={handleSave} onKeyDown={onKey} className="form-control" style={{ flex: 2, minWidth: '120px', background: 'transparent' }} dir="auto" />
      <div style={{ flex: 5, display: 'flex', gap: '5px', alignItems: 'center', flexWrap: 'wrap' }}>
        <input type="number" value={offset} onChange={e => setOffset(e.target.value)} onBlur={handleSave} onKeyDown={onKey} className="form-control" style={{ width: '70px', background: 'transparent', padding: '6px' }} />
        <span style={{ fontSize: '13px', color: '#64748b' }}>mins from</span>
        <select value={anchor} onChange={e => handleChange({ anchor: e.target.value })} className="form-control" style={{ flex: 1, minWidth: '130px', background: 'transparent', padding: '6px' }}>
          {WEEKDAY_ANCHOR_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select value={weekly} onChange={e => handleChange({ weekly: e.target.value })} className="form-control" style={{ flex: 1, minWidth: '160px', background: 'transparent', padding: '6px' }}>
          {WEEKLY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select value={round} onChange={e => handleChange({ round: e.target.value })} className="form-control" style={{ flex: 1, minWidth: '140px', background: 'transparent', padding: '6px' }}>
          {ROUND_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <DayPicker days={days} onChange={(d) => handleChange({ days: d })} />
      </div>
      <StatusText st={st} />
      <button onClick={handleDelete} className="btn btn-danger" style={{ padding: '8px 12px' }}>Delete</button>
    </li>
  );
};

/* =====================================================================
   ADMIN
   ===================================================================== */
const Admin = () => {
  const [user, setUser] = useState(null);
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [isAdmin, setIsAdmin] = useState(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const now = useNow(30000);

  const [settings, setSettings] = useState({});
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState("");

  const [manualMinyanim, setManualMinyanim] = useState([]);
  const [minyanLabel, setMinyanLabel] = useState("");
  const [minyanTime, setMinyanTime] = useState("");
  const [manualSt, showManual] = useStatus();

  const [shabbosMinyanim, setShabbosMinyanim] = useState([]);
  const [shabbosLabel, setShabbosLabel] = useState("");
  const [shabbosTime, setShabbosTime] = useState("");
  const [shabbosDay, setShabbosDay] = useState("yom");
  const [shabbosSt, showShabbos] = useStatus();

  const [dynamicRules, setDynamicRules] = useState([]);
  const [dynLabel, setDynLabel] = useState("");
  const [dynBase, setDynBase] = useState("friday_candle");
  const [dynOffset, setDynOffset] = useState("");
  const [dynRound, setDynRound] = useState("down");
  const [dynSt, showDyn] = useStatus();

  const [seasonal, setSeasonal] = useState({ mode: 'auto', mashivHaruach: false, vtenTal: false });

  const [weekdayRules, setWeekdayRules] = useState([]);
  const [wkLabel, setWkLabel] = useState("");
  const [wkAnchor, setWkAnchor] = useState("shkia");
  const [wkOffset, setWkOffset] = useState("");
  const [wkWeekly, setWkWeekly] = useState("daily");
  const [wkRound, setWkRound] = useState("");
  const [wkDays, setWkDays] = useState([0, 1, 2, 3, 4]);
  const [wkSt, showWk] = useStatus();
  const [overrides, setOverrides] = useState({ parsha: "", haftarah: "", daf: "", omer: "", candles: "", expires: "" });
  const [overrideSt, showOverride] = useStatus();
  const [tvStatus, setTvStatus] = useState(null);
  const [history, setHistory] = useState([]);
  const [historyLimit, setHistoryLimit] = useState(25);
  const [historySt, showHistory] = useStatus();
  const [undoingId, setUndoingId] = useState(null);

  // Settings form fields
  const [zipInput, setZipInput] = useState("");
  const [zipSt, showZip] = useStatus();
  const [locMode, setLocMode] = useState("zip");
  const [latInput, setLatInput] = useState("");
  const [lonInput, setLonInput] = useState("");
  const [tzInput, setTzInput] = useState("Asia/Jerusalem");
  const [locName, setLocName] = useState("");
  const [coordSt, showCoord] = useStatus();
  const [ilSt, showIl] = useStatus();
  const [candleMinutes, setCandleMinutes] = useState("18");
  const [klStartDays, setKlStartDays] = useState("3");
  const [klEndOpinion, setKlEndOpinion] = useState("15days");
  const [omerRollover, setOmerRollover] = useState("tzeis");
  const [halachaSt, showHalacha] = useStatus();
  const [shulName, setShulName] = useState("");
  const [shulSubtitle, setShulSubtitle] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [mainBg, setMainBg] = useState("");
  const [panelBg, setPanelBg] = useState("");
  const [visualSt, showVisual] = useStatus();
  const [simDate, setSimDate] = useState("");
  const [simTime, setSimTime] = useState("");
  const [simSt, showSim] = useStatus();

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setLoadingAuth(false);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!user) return;
    const subs = [];
    const listen = (path, fn) => subs.push(onValue(ref(db, path), (s) => fn(s.val()), () => {}));

    listen(`admins/${user.uid}`, (v) => setIsAdmin(v === true));
    listen('settings', (v) => setSettings(v || {}));
    listen('ticker', (data) => {
      if (data) setMessages(typeof data === 'string' ? [{ id: 'legacy', text: data }] : Object.keys(data).map(key => ({ id: key, text: data[key] })));
      else setMessages([]);
    });
    listen('manual_minyanim', (data) => {
      const parsed = data ? Object.keys(data).map(key => ({ id: key, ...data[key] })) : [];
      parsed.sort((a, b) => parseTimeStrToMinutes(a.time) - parseTimeStrToMinutes(b.time));
      setManualMinyanim(parsed);
    });
    listen('shabbos_minyanim', (data) => {
      const parsed = data ? Object.keys(data).map(key => ({ id: key, ...data[key] })) : [];
      const rank = (d) => (d === 'erev' ? 0 : 1);
      parsed.sort((a, b) => (rank(a.day) - rank(b.day)) || (parseTimeStrToMinutes(a.time) - parseTimeStrToMinutes(b.time)));
      setShabbosMinyanim(parsed);
    });
    listen('dynamic_rules', (data) => setDynamicRules(data ? Object.keys(data).map(key => ({ id: key, ...data[key] })) : []));
    listen('seasonal_tefillah', (data) => setSeasonal({ mode: 'auto', mashivHaruach: false, vtenTal: false, ...(data || {}) }));
    listen('weekday_rules', (data) => setWeekdayRules(data ? Object.keys(data).map(key => ({ id: key, ...data[key] })) : []));
    listen('overrides', (data) => setOverrides({ parsha: "", haftarah: "", daf: "", omer: "", candles: "", expires: "", ...(data || {}) }));
    listen('system_logs/tv_status', (data) => setTvStatus(data || null));

    return () => subs.forEach(u => u());
  }, [user]);

  useEffect(() => {
    if (!user || isAdmin !== true) return undefined;
    // +1 so we know whether there are older entries to show
    return onValue(query(ref(db, 'audit_log'), limitToLast(historyLimit + 1)), (snap) => {
      const list = [];
      snap.forEach(child => { list.push({ id: child.key, ...child.val() }); });
      setHistory(list.reverse());
    }, () => setHistory([]));
  }, [user, isAdmin, historyLimit]);

  // Remove history older than HISTORY_DAYS (runs once per admin visit)
  useEffect(() => {
    if (!user || isAdmin !== true) return;
    const cutoff = Date.now() - HISTORY_DAYS * 86400000;
    get(query(ref(db, 'audit_log'), orderByChild('ts'), endAt(cutoff), limitToFirst(200)))
      .then((snap) => {
        const removals = {};
        snap.forEach(child => { removals[`audit_log/${child.key}`] = null; });
        if (Object.keys(removals).length) return update(ref(db), removals);
        return null;
      })
      .catch(() => { /* not critical */ });
  }, [user, isAdmin]);

  const handleUndo = async (entry) => {
    const changes = Array.isArray(entry.changes) ? entry.changes : Object.values(entry.changes || {});
    if (changes.length === 0) return;
    const isRedo = !!entry.undoOf;
    const base = entry.baseSummary || entry.summary;
    setUndoingId(entry.id);
    try {
      const current = await Promise.all(changes.map(c => get(ref(db, c.path)).then(snap => snap.val())));
      const changedSince = changes.some((c, i) => stable(current[i]) !== stable(c.after ?? null));
      let msg = isRedo ? `Re-apply this change?\n\n${base}` : `Undo this change?\n\n${entry.summary}`;
      if (changedSince) msg += `\n\nHeads up: this was changed again afterwards. ${isRedo ? 'Re-applying' : 'Undoing'} will replace the newer value too.`;
      if (!window.confirm(msg)) return;
      const restore = {};
      changes.forEach(c => { restore[c.path] = c.before ?? null; });
      const did = await commit(restore, `${isRedo ? 'Redid' : 'Undid'}: ${base}`, { undoOf: entry.id, baseSummary: base, reviveId: entry.undoOf || null });
      showHistory('ok', did ? (isRedo ? '✓ Change re-applied.' : '✓ Change undone.') : 'Nothing to change - it already matches.', 4000);
    } catch (err) {
      showHistory('err', 'Undo failed - check your connection or permissions.');
    } finally {
      setUndoingId(null);
    }
  };

  // Seed each form field only when its own setting changes, so typing in one card isn't overwritten
  useEffect(() => { setZipInput(settings.zipCode || ""); }, [settings.zipCode]);
  useEffect(() => {
    const l = settings.location;
    if (!l) return;
    setLatInput(String(l.latitude ?? ''));
    setLonInput(String(l.longitude ?? ''));
    setTzInput(l.tzid || 'Asia/Jerusalem');
    setLocName(l.name || '');
    setLocMode(settings.zipCode ? 'zip' : 'coords');
  }, [settings.location, settings.zipCode]);
  useEffect(() => { setCandleMinutes(String(settings.candleMinutes ?? 18)); }, [settings.candleMinutes]);
  useEffect(() => { setKlStartDays(String(settings.klStartDays ?? 3)); }, [settings.klStartDays]);
  useEffect(() => { setKlEndOpinion(settings.klEndOpinion || "15days"); }, [settings.klEndOpinion]);
  useEffect(() => { setOmerRollover(settings.omerRollover || "tzeis"); }, [settings.omerRollover]);
  useEffect(() => { setShulName(settings.shulName || ""); }, [settings.shulName]);
  useEffect(() => { setShulSubtitle(settings.shulSubtitle ?? ""); }, [settings.shulSubtitle]);
  useEffect(() => { setLogoUrl(settings.logoUrl || ""); }, [settings.logoUrl]);
  useEffect(() => { setMainBg(settings.mainBg || ""); }, [settings.mainBg]);
  useEffect(() => { setPanelBg(settings.panelBg || ""); }, [settings.panelBg]);
  useEffect(() => {
    const s = settings.simulation;
    setSimDate((s && s.date) || "");
    setSimTime((s && s.time) || "");
  }, [settings.simulation]);

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoginError("");
    try { await signInWithEmailAndPassword(auth, email, password); }
    catch (err) { setLoginError("Invalid email or password."); }
  };

  /* ---------- Add handlers ---------- */
  const handleAddMessage = (e) => {
    e.preventDefault();
    if (!newMessage.trim()) return;
    const text = newMessage.trim();
    const key = push(ref(db, 'ticker')).key;
    commit({ [`ticker/${key}`]: text }, `Added announcement "${shortText(text)}"`);
    setNewMessage("");
  };

  const handleDeleteMessage = (msg) => {
    if (!window.confirm(`Delete this announcement?\n\n${msg.text}`)) return;
    commit({ [msg.id === 'legacy' ? 'ticker' : `ticker/${msg.id}`]: null }, `Deleted announcement "${shortText(msg.text)}"`);
  };

  const handleAddManual = (e) => {
    e.preventDefault();
    if (!minyanLabel.trim()) return showManual('err', 'Enter a name.');
    const time = resolveTime(minyanTime, (msg) => showManual('err', msg));
    if (time === null) return;
    const item = { label: minyanLabel.trim(), time };
    commit({ [`manual_minyanim/${push(ref(db, 'manual_minyanim')).key}`]: item }, `Added weekday minyan ${describeMinyan(item)}`)
      .then(() => showManual('ok', `✓ Added ${item.label} ${time}`))
      .catch(() => showManual('err', 'Save failed.'));
    setMinyanLabel(""); setMinyanTime("");
  };

  const handleAddShabbos = (e) => {
    e.preventDefault();
    if (!shabbosLabel.trim()) return showShabbos('err', 'Enter a name.');
    const time = resolveTime(shabbosTime, (msg) => showShabbos('err', msg));
    if (time === null) return;
    const item = { label: shabbosLabel.trim(), time, day: shabbosDay };
    commit({ [`shabbos_minyanim/${push(ref(db, 'shabbos_minyanim')).key}`]: item }, `Added Shabbos minyan ${describeMinyan(item, true)}`)
      .then(() => showShabbos('ok', `✓ Added ${item.label} ${time}`))
      .catch(() => showShabbos('err', 'Save failed.'));
    setShabbosLabel(""); setShabbosTime("");
  };

  const handleAddDynamic = (e) => {
    e.preventDefault();
    if (!dynLabel.trim()) return showDyn('err', 'Enter a name.');
    if (dynOffset.trim() === '' || !Number.isFinite(Number(dynOffset))) return showDyn('err', 'Enter minutes, e.g. -20 or 15.');
    const item = { label: dynLabel.trim(), base: dynBase, offset: Number(dynOffset), round: dynRound };
    commit({ [`dynamic_rules/${push(ref(db, 'dynamic_rules')).key}`]: item }, `Added Shabbos rule ${describeShabbosRule(item)}`)
      .then(() => showDyn('ok', `✓ Added ${item.label}`))
      .catch(() => showDyn('err', 'Save failed.'));
    setDynLabel(""); setDynOffset("");
  };

  const handleAddWeekdayRule = (e) => {
    e.preventDefault();
    if (!wkLabel.trim()) return showWk('err', 'Enter a name.');
    if (wkOffset.trim() === '' || !Number.isFinite(Number(wkOffset))) return showWk('err', 'Enter minutes, e.g. -15 or 10.');
    if (wkDays.length === 0) return showWk('err', 'Pick at least one day.');
    const item = {
      label: wkLabel.trim(), anchor: wkAnchor, offset: Number(wkOffset), weekly: wkWeekly,
      round: wkRound || weekdayDefaultRound(wkOffset), days: wkDays
    };
    commit({ [`weekday_rules/${push(ref(db, 'weekday_rules')).key}`]: item }, `Added weekday rule ${describeWeekdayRule(item)}`)
      .then(() => showWk('ok', `✓ Added ${item.label}`))
      .catch(() => showWk('err', 'Save failed.'));
    setWkLabel(""); setWkOffset(""); setWkRound("");
  };

  const setSeasonalMode = (mode) => commit({ seasonal_tefillah: { ...seasonal, mode } }, `Set seasonal inserts to ${mode === 'manual' ? 'Manual' : 'Automatic'}`);
  const toggleMashiv = () => commit(
    { seasonal_tefillah: { ...seasonal, mode: 'manual', mashivHaruach: !seasonal.mashivHaruach } },
    `Set seasonal insert to ${!seasonal.mashivHaruach ? 'משיב הרוח' : 'מוריד הטל'} (manual)`
  );
  const toggleVten = () => commit(
    { seasonal_tefillah: { ...seasonal, mode: 'manual', vtenTal: !seasonal.vtenTal } },
    `Set seasonal insert to ${!seasonal.vtenTal ? 'ותן טל ומטר' : 'ברכנו'} (manual)`
  );
  const setSetting = (key, value, summary) => commit({ [`settings/${key}`]: value }, summary);

  /* ---------- Settings handlers ---------- */
  const handleSaveZip = async (e) => {
    e.preventDefault();
    const z = zipInput.trim();
    if (!/^\d{5}$/.test(z)) return showZip('err', 'Enter a 5-digit US zip code.');
    showZip('info', 'Checking zip code with Hebcal...');
    let data = null;
    try {
      const res = await fetch(`https://www.hebcal.com/zmanim?cfg=json&zip=${z}`);
      data = await res.json();
      if (!res.ok || data.error || !data.location) {
        return showZip('err', `Hebcal doesn't recognize zip ${z}. Check the number and try again.`);
      }
    } catch (err) {
      if (!window.confirm(`Couldn't reach Hebcal to verify zip ${z}. Save it anyway?`)) return showZip(null);
    }
    const changes = { 'settings/zipCode': z };
    if (data) {
      changes['settings/location'] = { latitude: data.location.latitude, longitude: data.location.longitude, tzid: data.location.tzid, name: data.location.name };
      changes['settings/il'] = data.location.tzid === 'Asia/Jerusalem';
    }
    try {
      await commit(changes, `Changed location to ${data ? data.location.name : `zip ${z}`}`);
    } catch (err) {
      return showZip('err', 'Save failed - check your connection or permissions.');
    }
    showZip('ok', data ? `✓ Location set to ${data.location.name}. The screen updates within a minute.` : `✓ Zip ${z} saved (not verified). The screen will look it up when it's online.`, 6000);
  };

  const handleSaveCoords = (e) => {
    e.preventDefault();
    const lat = Number(latInput), lon = Number(lonInput);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || latInput.trim() === '') return showCoord('err', 'Latitude must be a number between -90 and 90 (e.g. 31.778).');
    if (!Number.isFinite(lon) || lon < -180 || lon > 180 || lonInput.trim() === '') return showCoord('err', 'Longitude must be a number between -180 and 180 (e.g. 35.235).');
    if (!TIMEZONES.includes(tzInput)) return showCoord('err', 'Choose a time zone from the list.');
    const placeName = locName.trim() || `${lat}, ${lon}`;
    commit({
      'settings/location': { latitude: lat, longitude: lon, tzid: tzInput, name: placeName },
      'settings/zipCode': null,
      'settings/il': tzInput === 'Asia/Jerusalem'
    }, `Changed location to ${placeName}`).then(() => showCoord('ok', `✓ Location saved${tzInput === 'Asia/Jerusalem' ? ' and set to Israel' : ''}. The Screen updates within a minute.`, 6000))
      .catch(() => showCoord('err', 'Save failed.'));
  };

  const handleSetIl = (value) => {
    setSetting('il', value, `Switched calendar to ${value ? 'Eretz Yisrael' : 'Chutz Laaretz'}`)
      .then(() => showIl('ok', value ? '✓ Israel: one-day Yom Tov, Israeli parsha schedule, V\'sen Tal from 7 Cheshvan.' : '✓ Chutz Laaretz: two-day Yom Tov, Chutz Laaretz parsha schedule, V\'sen Tal from Dec 4/5.', 6000));
  };

  const handleSaveHalacha = (e) => {
    e.preventDefault();
    const mins = Number(candleMinutes);
    if (!Number.isInteger(mins) || mins < 10 || mins > 60) return showHalacha('err', 'Candle lighting must be a whole number between 10 and 60 minutes.');
    const klDays = Number(klStartDays) === 7 ? 7 : 3;
    const diffs = [];
    if (Number(settings.candleMinutes ?? 18) !== mins) diffs.push(`candle lighting ${settings.candleMinutes ?? 18} → ${mins} min`);
    if (Number(settings.klStartDays ?? 3) !== klDays) diffs.push(`Kiddush Levana start ${settings.klStartDays ?? 3} → ${klDays} days`);
    if ((settings.klEndOpinion || '15days') !== klEndOpinion) diffs.push(`Kiddush Levana end → ${klEndOpinion === 'between_moldos' ? 'Mechaber' : 'Rema'}`);
    if ((settings.omerRollover || 'tzeis') !== omerRollover) diffs.push(`Omer changes at ${omerRollover === 'shkia' ? 'Shkia' : 'Tzeis'}`);
    commit({
      'settings/candleMinutes': mins,
      'settings/klStartDays': klDays,
      'settings/klEndOpinion': klEndOpinion,
      'settings/omerRollover': omerRollover
    }, diffs.length ? `Changed ${diffs.join(', ')}` : 'Saved halachic settings')
      .then((did) => showHalacha('ok', did ? '✓ Saved' : 'No changes to save.', 4000))
      .catch(() => showHalacha('err', 'Save failed.'));
  };

  const handleSaveVisuals = (e) => {
    e.preventDefault();
    const bad = [['Logo', logoUrl], ['Main background', mainBg], ['Panel background', panelBg]].filter(([, u]) => !isValidImageUrl(u));
    if (bad.length) return showVisual('err', `${bad.map(b => b[0]).join(', ')}: use a direct https:// link with no spaces or quotes.`);
    const next = { shulName: shulName.trim(), shulSubtitle: shulSubtitle.trim(), logoUrl: logoUrl.trim(), mainBg: mainBg.trim(), panelBg: panelBg.trim() };
    const names = { shulName: 'shul name', shulSubtitle: 'subtitle', logoUrl: 'logo', mainBg: 'main background', panelBg: 'panel background' };
    const changed = Object.keys(next).filter(k => (settings[k] || '') !== next[k]).map(k => names[k]);
    const changes = {};
    Object.keys(next).forEach(k => { changes[`settings/${k}`] = next[k]; });
    commit(changes, changed.length ? `Changed ${changed.join(', ')}` : 'Saved name & visuals')
      .then((did) => showVisual('ok', did ? '✓ Saved' : 'No changes to save.', 4000))
      .catch(() => showVisual('err', 'Save failed.'));
  };

  /* ---------- Overrides ---------- */
  const handleSaveOverrides = (e) => {
    e.preventDefault();
    const fields = ['parsha', 'haftarah', 'daf', 'omer', 'candles'];
    const clean = {};
    fields.forEach(f => { clean[f] = (overrides[f] || '').trim(); });
    const anySet = fields.some(f => clean[f]);
    clean.expires = anySet ? (overrides.expires || nextSundayKey()) : '';
    const setNames = { parsha: 'parsha', haftarah: 'haftarah', daf: 'daf', omer: 'omer', candles: 'candle lighting' };
    commit({ overrides: clean }, anySet ? `Set overrides (${fields.filter(f => clean[f]).map(f => setNames[f]).join(', ')}) through ${clean.expires}` : 'Cleared override values')
      .then((did) => showOverride('ok', !did ? 'No changes to save.' : anySet ? `✓ Saved. Overrides stop showing after ${clean.expires}.` : '✓ Saved.', 6000))
      .catch(() => showOverride('err', 'Save failed.'));
  };

  const handleClearOverrides = () => {
    if (!window.confirm('Clear all overrides and go back to automatic values?')) return;
    commit({ overrides: null }, 'Cleared all overrides').then(() => showOverride('ok', '✓ All overrides cleared.', 4000));
  };

  /* ---------- Simulation ---------- */
  const sim = settings.simulation;
  const simActive = !!(sim && sim.date && (!sim.expiresAt || now < sim.expiresAt));
  const simExpired = !!(sim && sim.date && sim.expiresAt && now >= sim.expiresAt);

  const handleSimulate = (e) => {
    e.preventDefault();
    if (!simDate) return showSim('err', 'Pick a date to simulate.');
    const t = Date.now();
    set(ref(db, 'settings/simulation'), { date: simDate, time: simTime || '12:00', setAt: t, expiresAt: t + 12 * 3600000 })
      .then(() => { remove(ref(db, 'settings/simulationDate')); showSim('ok', '✓ The screen is now simulating that moment.', 4000); });
  };

  const handleClearSimulation = () => {
    remove(ref(db, 'settings/simulation'));
    remove(ref(db, 'settings/simulationDate'));
    setSimDate(""); setSimTime("");
  };

  /* ---------- Screen health ---------- */
  const lastBeat = tvStatus && typeof tvStatus.lastUpdate === 'number' ? tvStatus.lastUpdate : null;
  const beatAgeMin = lastBeat ? Math.max(0, Math.round((now - lastBeat) / 60000)) : null;
  const tvStale = beatAgeMin !== null && beatAgeMin > 15;
  const tvState = !tvStatus ? null : tvStale ? 'NOT RESPONDING' : (tvStatus.status || 'UNKNOWN');
  const tvTone = tvState === 'OK' ? 'good' : (tvState === 'WARNING' || tvState === 'SIMULATION') ? 'warn' : 'bad';
  const toneColors = {
    good: { bg: '#ecfdf5', border: '#6ee7b7', text: '#059669' },
    warn: { bg: '#fffbeb', border: '#fcd34d', text: '#b45309' },
    bad: { bg: '#fef2f2', border: '#fca5a5', text: '#dc2626' }
  }[tvTone];
  const clockDriftMin = tvStatus && lastBeat && tvStatus.tvClock ? Math.round((tvStatus.tvClock - lastBeat) / 60000) : 0;

  const overridesActive = !!overrides.expires && localDateKey(new Date()) <= overrides.expires;
  const overridesExpired = !!overrides.expires && localDateKey(new Date()) > overrides.expires;

  if (loadingAuth) return <div style={{ textAlign: 'center', marginTop: '50px', fontFamily: 'sans-serif' }}>Loading...</div>;
  if (!user) {
    return (
      <div style={{ padding: '50px 20px', fontFamily: 'sans-serif', maxWidth: '400px', margin: '0 auto', textAlign: 'center' }}>
        <h2>Secure Admin Login</h2>
        <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email address" style={{ padding: '12px' }} required />
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" style={{ padding: '12px' }} required />
          {loginError && <p style={{ color: '#d32f2f', margin: 0 }}>{loginError}</p>}
          <button type="submit" style={{ padding: '12px', background: '#0d47a1', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer' }}>Login</button>
        </form>
      </div>
    );
  }

  return (
    <>
      <style>{`
        .admin-bg { background-color: #f3f4f6; min-height: 100vh; padding: 30px 15px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1f2937; }
        .admin-container { max-width: 900px; margin: 0 auto; }
        .header-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 30px; padding-bottom: 15px; border-bottom: 2px solid #e5e7eb; }
        .header-bar h1 { margin: 0; font-size: 24px; color: #111827; }
        .btn-logout { background: #e5e7eb; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-weight: 600; color: #4b5563; }
        .btn-logout:hover { background: #d1d5db; }
        .card { background: #fff; border-radius: 12px; padding: 25px; margin-bottom: 25px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03); border: 1px solid #e5e7eb; }
        .card h3 { margin: 0 0 15px 0; font-size: 20px; color: #111827; display: flex; align-items: center; gap: 8px; border-bottom: 1px solid #f3f4f6; padding-bottom: 10px; }
        .help-box { background: #eff6ff; border-left: 4px solid #3b82f6; padding: 12px 15px; border-radius: 0 8px 8px 0; font-size: 14px; color: #1e3a8a; margin-bottom: 20px; line-height: 1.5; }
        .warn-box { background: #fffbeb; border: 1px solid #fcd34d; color: #92400e; padding: 12px 15px; border-radius: 8px; font-size: 14px; margin-bottom: 25px; line-height: 1.5; }
        .form-row { display: flex; gap: 15px; margin-bottom: 15px; align-items: flex-end; flex-wrap: wrap; }
        .form-group { display: flex; flex-direction: column; flex: 1; min-width: 150px; }
        .form-group label { font-size: 13px; font-weight: 600; color: #4b5563; margin-bottom: 6px; }
        .form-control { padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 15px; outline: none; transition: border-color 0.2s; }
        .form-control:focus { border-color: #3b82f6; }
        .btn { padding: 10px 20px; border: none; border-radius: 6px; font-size: 15px; font-weight: 600; cursor: pointer; transition: background 0.2s; height: 42px; }
        .btn-primary { background: #2563eb; color: white; }
        .btn-primary:hover { background: #1d4ed8; }
        .btn-secondary { background: #e2e8f0; color: #475569; }
        .btn-secondary:hover { background: #cbd5e1; }
        .btn-danger { background: #fee2e2; color: #ef4444; border: 1px solid #f87171; height: auto; padding: 6px 12px; font-size: 13px; }
        .btn-danger:hover { background: #fca5a5; color: #b91c1c; }
        .toggle-group { display: flex; gap: 15px; flex-wrap: wrap; }
        .toggle-btn { flex: 1; min-width: 150px; padding: 12px; border-radius: 8px; font-weight: 600; font-size: 15px; cursor: pointer; border: 2px solid transparent; transition: all 0.2s; background: #f3f4f6; color: #4b5563; }
        .toggle-btn.active { background: #eff6ff; border-color: #3b82f6; color: #1d4ed8; box-shadow: 0 2px 4px rgba(59,130,246,0.1); }
        .toggle-on { background: #10b981; color: white; box-shadow: 0 2px 4px rgba(16, 185, 129, 0.2); }
        .toggle-off { background: #f3f4f6; color: #4b5563; border: 2px solid #e5e7eb; }
        .data-list { list-style: none; padding: 0; margin: 0; }
        .data-item { display: flex; justify-content: space-between; align-items: center; padding: 6px 10px; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; margin-bottom: 8px; transition: border-color 0.2s; }
        .data-item:hover { border-color: #94a3b8; }
        .sim-card { background: #fef2f2; border: 2px solid #ef4444; }
        .sim-active-title { color: #dc2626 !important; }
        .row-status { font-size: 13px; font-weight: 600; white-space: nowrap; }
        .row-status.ok { color: #059669; }
        .row-status.err { color: #dc2626; white-space: normal; }
        .row-status.info { color: #2563eb; }
        .card-status { margin-top: 10px; display: block; }
        .day-chip { padding: 6px 10px; border-radius: 6px; border: 1px solid #d1d5db; background: #fff; color: #4b5563; font-size: 13px; font-weight: 600; cursor: pointer; }
        .day-chip.on { background: #2563eb; border-color: #2563eb; color: #fff; }
        .day-chip:focus-visible, .toggle-btn:focus-visible, .btn:focus-visible { outline: 2px solid #1d4ed8; outline-offset: 2px; }
        .history-item { display: flex; align-items: center; gap: 12px; padding: 10px 12px; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; margin-bottom: 8px; }
        .history-item.undone { opacity: 0.6; }
        .history-item.undone .history-summary { text-decoration: line-through; }
        .history-summary { font-size: 14px; color: #111827; overflow-wrap: anywhere; }
        .history-meta { font-size: 12px; color: #64748b; margin-top: 3px; }
        .history-btn { height: auto; padding: 6px 14px; font-size: 13px; flex-shrink: 0; }
        .health-row { display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 14px; color: #4b5563; gap: 10px; }
      `}</style>

      <div className="admin-bg">
        <div className="admin-container">

          <div className="header-bar">
            <h1>Shul Board Admin</h1>
            <button className="btn-logout" onClick={() => signOut(auth)}>Logout</button>
          </div>

          {isAdmin === false && (
            <div className="warn-box">
              <strong>This account isn't on the admin list.</strong> Once the database security rules are published, changes from this account will be blocked.
              To authorize it, open the Firebase console → Realtime Database and add <code>admins/{user.uid}: true</code>.
            </div>
          )}

          {/* ===== SCREEN HEALTH ===== */}
          <div className="card" style={{ background: '#f8fafc', borderColor: '#cbd5e1' }}>
            <h3 style={{ color: '#0f172a' }}>📡 Screen System Health</h3>
            {tvStatus ? (
              <div style={{ padding: '15px', background: toneColors.bg, border: `1px solid ${toneColors.border}`, borderRadius: '8px' }}>
                <div className="health-row" style={{ fontSize: '15px' }}>
                  <strong>Status:</strong>
                  <span style={{ color: toneColors.text, fontWeight: 'bold' }}>{tvState}</span>
                </div>
                <div className="health-row">
                  <strong>Last heartbeat:</strong>
                  <span>{lastBeat ? `${new Date(lastBeat).toLocaleString()} (${beatAgeMin === 0 ? 'just now' : `${beatAgeMin} min ago`})` : 'unknown'}</span>
                </div>
                <div className="health-row"><strong>Board date:</strong> <span>{tvStatus.activeDate}</span></div>
                {tvStatus.location && <div className="health-row"><strong>Location:</strong> <span>{tvStatus.location}</span></div>}
                {tvStale && (
                  <div className="health-row" style={{ color: '#dc2626' }}>
                    The screen hasn't checked in for over 15 minutes. Check that it's powered on and connected to the internet.
                  </div>
                )}
                {Math.abs(clockDriftMin) >= 2 && !tvStale && (
                  <div className="health-row" style={{ color: '#b45309' }}>
                    The screen's clock is off by about {Math.abs(clockDriftMin)} minutes. Fix the date and time settings on the device.
                  </div>
                )}
                <div style={{ fontSize: '14px', color: '#4b5563', marginTop: '10px', padding: '10px', background: '#fff', borderRadius: '4px', border: '1px solid #e2e8f0' }}>
                  <strong>Message:</strong> {tvStatus.message}
                </div>
              </div>
            ) : (
              <p style={{ color: '#64748b' }}>Waiting for the screen to check in. If this doesn't change within 5 minutes, open the board on the screen.</p>
            )}
          </div>

          {/* ===== CHANGE HISTORY ===== */}
          <div className="card">
            <h3>🕘 Recent Changes</h3>
            <div className="help-box">
              Every change made in this panel is listed here, newest first. <strong>Undo</strong> puts back what was there before;
              an undo can itself be reversed with <strong>Redo</strong>. History is kept for {HISTORY_DAYS} days. Simulation tests aren't listed.
            </div>
            <StatusText st={historySt} />
            {history.length === 0 ? (
              <p style={{ color: '#64748b', margin: 0 }}>No changes recorded yet.</p>
            ) : (
              <ul className="data-list">
                {history.slice(0, historyLimit).map((h) => {
                  const undone = !!h.undone;
                  return (
                    <li key={h.id} className={`history-item ${undone ? 'undone' : ''}`}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="history-summary" dir="auto">{h.summary}</div>
                        <div className="history-meta">
                          {formatWhen(h.ts)} · {h.email}
                          {undone && <> · <strong>{h.undoOf ? 'Redone' : 'Undone'} by {h.undone.byEmail}</strong></>}
                        </div>
                      </div>
                      {!undone && (
                        <button onClick={() => handleUndo(h)} disabled={undoingId === h.id} className="btn btn-secondary history-btn">
                          {undoingId === h.id ? '…' : h.undoOf ? 'Redo' : 'Undo'}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {history.length > historyLimit && (
              <button onClick={() => setHistoryLimit(n => n + 25)} className="btn btn-secondary" style={{ marginTop: '10px' }}>Show older changes</button>
            )}
          </div>

          {/* ===== SIMULATION ===== */}
          <div className={`card ${simActive ? 'sim-card' : ''}`}>
            <h3 className={simActive ? 'sim-active-title' : ''}>
              {simActive ? "⚠️ Simulation Mode Active" : "🧪 Testing & Simulation"}
            </h3>
            <div className="help-box">
              Jump the display to any date and time to test zmanim, Shkia rollovers, fast days and Shabbos layouts.
              The simulated clock keeps running from the time you choose, so you can watch Shkia or Tzeis pass.
              Simulation turns itself off after 12 hours.
            </div>
            {simActive && (
              <p style={{ color: '#dc2626', fontWeight: 600, marginTop: 0 }}>
                Simulating {sim.date} from {sim.time}. Turns off automatically at {new Date(sim.expiresAt).toLocaleString()}.
              </p>
            )}
            {simExpired && (
              <p style={{ color: '#b45309', fontWeight: 600, marginTop: 0 }}>
                The last simulation expired and the screen is back on the real date. Clear it to tidy up.
              </p>
            )}
            <form onSubmit={handleSimulate} className="form-row">
              <div className="form-group" style={{ flex: 2 }}>
                <label>Date</label>
                <input type="date" value={simDate} onChange={(e) => setSimDate(e.target.value)} className="form-control" />
              </div>
              <div className="form-group" style={{ flex: 1 }}>
                <label>Starting time (shul time)</label>
                <input type="time" value={simTime} onChange={(e) => setSimTime(e.target.value)} className="form-control" />
              </div>
              <button type="submit" className="btn btn-primary">Simulate</button>
              {(simActive || simExpired) && (
                <button type="button" onClick={handleClearSimulation} className="btn" style={{ background: '#ef4444', color: 'white' }}>Back to Real Time</button>
              )}
            </form>
            <StatusText st={simSt} />
          </div>

          {/* ===== LOCATION & HALACHIC SETTINGS ===== */}
          <div className="card">
            <h3>🌍 Location & Halachic Settings</h3>
            <div className="help-box">
              The board calculates every zman on the screen itself from these coordinates, so it keeps working with no internet.
              {settings.location && (
                <><br /><strong>Current location:</strong> {settings.location.name} ({Number(settings.location.latitude).toFixed(4)}, {Number(settings.location.longitude).toFixed(4)}, {settings.location.tzid})</>
              )}
            </div>
            <div className="toggle-group" style={{ marginBottom: '15px' }}>
              <button type="button" onClick={() => setLocMode('zip')} className={`toggle-btn ${locMode === 'zip' ? 'active' : ''}`}>US zip code</button>
              <button type="button" onClick={() => setLocMode('coords')} className={`toggle-btn ${locMode === 'coords' ? 'active' : ''}`}>Coordinates (Eretz Yisrael & elsewhere)</button>
            </div>

            {locMode === 'zip' ? (
              <form onSubmit={handleSaveZip} className="form-row" style={{ marginBottom: '10px' }}>
                <div className="form-group" style={{ flex: 2 }}>
                  <label>Shul Zip Code</label>
                  <input type="text" inputMode="numeric" value={zipInput} onChange={(e) => setZipInput(e.target.value)} placeholder="e.g. 10001" className="form-control" required />
                </div>
                <button type="submit" className="btn btn-primary">Update Location</button>
              </form>
            ) : (
              <form onSubmit={handleSaveCoords} style={{ marginBottom: '10px' }}>
                <div className="form-row">
                  <div className="form-group">
                    <label>Latitude</label>
                    <input type="text" inputMode="decimal" value={latInput} onChange={(e) => setLatInput(e.target.value)} placeholder="31.778" className="form-control" />
                  </div>
                  <div className="form-group">
                    <label>Longitude</label>
                    <input type="text" inputMode="decimal" value={lonInput} onChange={(e) => setLonInput(e.target.value)} placeholder="35.235" className="form-control" />
                  </div>
                  <div className="form-group">
                    <label>Time zone</label>
                    <select value={tzInput} onChange={(e) => setTzInput(e.target.value)} className="form-control">
                      {TIMEZONES.map(z => <option key={z} value={z}>{z}</option>)}
                    </select>
                  </div>
                </div>
                <div className="form-row">
                  <div className="form-group" style={{ flex: 2 }}>
                    <label>Place name (for your reference)</label>
                    <input type="text" value={locName} onChange={(e) => setLocName(e.target.value)} placeholder="e.g. Jerusalem" dir="auto" className="form-control" />
                  </div>
                  <button type="submit" className="btn btn-primary">Save Location</button>
                </div>
                <div style={{ fontSize: '13px', color: '#64748b' }}>
                  To find coordinates, right-click the shul on Google Maps; the first item in the menu is the latitude, longitude.
                </div>
              </form>
            )}
            <StatusText st={locMode === 'zip' ? zipSt : coordSt} />

            <div style={{ marginTop: '20px', borderTop: '1px solid #f3f4f6', paddingTop: '20px' }}>
              <label style={{ fontSize: '13px', fontWeight: 600, color: '#4b5563', display: 'block', marginBottom: '8px' }}>Calendar:</label>
              <div className="toggle-group">
                <button type="button" onClick={() => handleSetIl(false)} className={`toggle-btn ${settings.il !== true ? 'active' : ''}`}>Chutz Laaretz (חוץ לארץ)</button>
                <button type="button" onClick={() => handleSetIl(true)} className={`toggle-btn ${settings.il === true ? 'active' : ''}`}>Eretz Yisrael (ארץ ישראל)</button>
              </div>
              <StatusText st={ilSt} />
            </div>

            <form onSubmit={handleSaveHalacha} style={{ marginTop: '20px', borderTop: '1px solid #f3f4f6', paddingTop: '20px' }}>
              <div className="form-row">
                <div className="form-group">
                  <label>Candle lighting (minutes before Shkia; Jerusalem uses 40)</label>
                  <input type="number" min="10" max="60" value={candleMinutes} onChange={(e) => setCandleMinutes(e.target.value)} className="form-control" />
                </div>
                <div className="form-group">
                  <label>Omer count changes at</label>
                  <select value={omerRollover} onChange={(e) => setOmerRollover(e.target.value)} className="form-control">
                    <option value="tzeis">Tzeis (nightfall)</option>
                    <option value="shkia">Shkia (sunset)</option>
                  </select>
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Kiddush Levana begins</label>
                  <select value={klStartDays} onChange={(e) => setKlStartDays(e.target.value)} className="form-control">
                    <option value="3">3 days after the molad</option>
                    <option value="7">7 days after the molad</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Kiddush Levana ends</label>
                  <select value={klEndOpinion} onChange={(e) => setKlEndOpinion(e.target.value)} className="form-control">
                    <option value="15days">15 days after the molad (Rema)</option>
                    <option value="between_moldos">Halfway between moldos, 14d 18h 22m (Mechaber)</option>
                  </select>
                </div>
              </div>
              <button type="submit" className="btn btn-primary">Save Halachic Settings</button>
              <StatusText st={halachaSt} />
            </form>
          </div>

          {/* ===== DISPLAY ===== */}
          <div className="card">
            <h3>🎨 Display</h3>
            <label style={{ fontSize: '13px', fontWeight: 600, color: '#4b5563', display: 'block', marginBottom: '8px' }}>Select Decor Theme:</label>
            <div className="toggle-group" style={{ marginBottom: '20px' }}>
              <button onClick={() => setSetting('theme', 'dark', 'Changed theme to Modern Dark')} className={`toggle-btn ${settings.theme === 'dark' || !settings.theme ? 'active' : ''}`}>🌙 Modern Dark</button>
              <button onClick={() => setSetting('theme', 'light', 'Changed theme to Modern Light')} className={`toggle-btn ${settings.theme === 'light' ? 'active' : ''}`}>☀️ Modern Light</button>
              <button onClick={() => setSetting('theme', 'marble', 'Changed theme to Gold & Marble')} className={`toggle-btn ${settings.theme === 'marble' ? 'active' : ''}`}>🏛️ Gold & Marble</button>
              <button onClick={() => setSetting('theme', 'wood', 'Changed theme to Natural Wood')} className={`toggle-btn ${settings.theme === 'wood' ? 'active' : ''}`}>🌲 Natural Wood</button>
            </div>

            <label style={{ fontSize: '13px', fontWeight: 600, color: '#4b5563', display: 'block', marginBottom: '8px' }}>Select Font Style:</label>
            <div className="toggle-group" style={{ marginBottom: '25px', borderBottom: '1px solid #f3f4f6', paddingBottom: '20px' }}>
              <button onClick={() => setSetting('font', 'Heebo', 'Changed font to Heebo')} className={`toggle-btn ${settings.font === 'Heebo' || !settings.font ? 'active' : ''}`}>Heebo (Clean & Modern)</button>
              <button onClick={() => setSetting('font', 'Rubik', 'Changed font to Rubik')} className={`toggle-btn ${settings.font === 'Rubik' ? 'active' : ''}`}>Rubik (Soft & Rounded)</button>
              <button onClick={() => setSetting('font', 'Frank Ruhl Libre', 'Changed font to Frank Ruhl Libre')} className={`toggle-btn ${settings.font === 'Frank Ruhl Libre' ? 'active' : ''}`}>Frank Ruhl (Classic Serif)</button>
            </div>

            <div className="help-box">
              Image links must start with <code>https://</code> and point directly to an image file. Leave a field empty to use the built-in look.
            </div>
            <form onSubmit={handleSaveVisuals} style={{ marginBottom: '25px', borderBottom: '1px solid #f3f4f6', paddingBottom: '20px' }}>
              <div className="form-row">
                <div className="form-group">
                  <label>Shul Name</label>
                  <input type="text" value={shulName} onChange={(e) => setShulName(e.target.value)} placeholder="בית כנסת אוהל משה" dir="auto" className="form-control" />
                </div>
                <div className="form-group">
                  <label>Subtitle</label>
                  <input type="text" value={shulSubtitle} onChange={(e) => setShulSubtitle(e.target.value)} placeholder="קהילת קודש" dir="auto" className="form-control" />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group" style={{ minWidth: '200px' }}>
                  <label>Shul Logo URL</label>
                  <input type="text" value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} placeholder="https://..." className="form-control" />
                </div>
                <div className="form-group" style={{ minWidth: '200px' }}>
                  <label>Main Background URL</label>
                  <input type="text" value={mainBg} onChange={(e) => setMainBg(e.target.value)} placeholder="https://..." className="form-control" />
                </div>
                <div className="form-group" style={{ minWidth: '200px' }}>
                  <label>Panels Background URL</label>
                  <input type="text" value={panelBg} onChange={(e) => setPanelBg(e.target.value)} placeholder="https://..." className="form-control" />
                </div>
              </div>
              <button type="submit" className="btn btn-primary" style={{ background: '#4f46e5' }}>Save Name & Visuals</button>
              <StatusText st={visualSt} />
            </form>

            <label style={{ fontSize: '13px', fontWeight: 600, color: '#4b5563', display: 'block', marginBottom: '8px' }}>Seasonal Tefillah Inserts:</label>
            <div className="toggle-group" style={{ marginBottom: '12px' }}>
              <button onClick={() => setSeasonalMode('auto')} className={`toggle-btn ${seasonal.mode !== 'manual' ? 'active' : ''}`}>Automatic</button>
              <button onClick={() => setSeasonalMode('manual')} className={`toggle-btn ${seasonal.mode === 'manual' ? 'active' : ''}`}>Manual</button>
            </div>
            {seasonal.mode !== 'manual' ? (
              <div style={{ fontSize: '14px', color: '#4b5563', lineHeight: 1.5 }}>
                משיב הרוח starts at Musaf of Shemini Atzeres and stops at Musaf of the first day of Pesach.
                ותן טל ומטר starts at Maariv of {settings.il === true ? '7 Cheshvan (Israel)' : 'December 4, or December 5 before a civil leap year (Chutz Laaretz)'} and
                ends after Mincha of Erev Pesach. The board always shows which version to say (משיב הרוח or מוריד הטל, ותן טל ומטר or ברכנו) and highlights the day each one changes.
              </div>
            ) : (
              <div className="toggle-group">
                <button onClick={toggleMashiv} className={`toggle-btn ${seasonal.mashivHaruach ? 'toggle-on' : 'toggle-off'}`}>
                  {seasonal.mashivHaruach ? "✓ משיב הרוח" : "מוריד הטל"}
                </button>
                <button onClick={toggleVten} className={`toggle-btn ${seasonal.vtenTal ? 'toggle-on' : 'toggle-off'}`}>
                  {seasonal.vtenTal ? "✓ ותן טל ומטר" : "ברכנו"}
                </button>
              </div>
            )}
          </div>

          {/* ===== WEEKDAY SCHEDULE ===== */}
          <div className="card">
            <h3>📅 Weekday Schedule</h3>
            <div className="help-box">
              Shown Sunday through Friday midday. Type times like <code>7:00 AM</code>, <code>7pm</code> or <code>19:00</code>. Changes save when you click away or press Enter.
            </div>

            <div style={{ marginBottom: '15px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '13px', fontWeight: 600, color: '#4b5563', alignSelf: 'center' }}>Quick Fill:</span>
              <button type="button" onClick={() => { setMinyanLabel('שחרית'); setMinyanTime('7:00 AM'); }} className="btn btn-secondary" style={{ fontSize: '13px', padding: '6px 12px', height: 'auto' }}>שחרית 7:00</button>
              <button type="button" onClick={() => { setMinyanLabel('שחרית'); setMinyanTime('8:00 AM'); }} className="btn btn-secondary" style={{ fontSize: '13px', padding: '6px 12px', height: 'auto' }}>שחרית 8:00</button>
              <button type="button" onClick={() => { setMinyanLabel('מנחה'); setMinyanTime('6:00 PM'); }} className="btn btn-secondary" style={{ fontSize: '13px', padding: '6px 12px', height: 'auto' }}>מנחה 6:00</button>
              <button type="button" onClick={() => { setMinyanLabel('מעריב'); setMinyanTime('10:00 PM'); }} className="btn btn-secondary" style={{ fontSize: '13px', padding: '6px 12px', height: 'auto' }}>מעריב 10:00</button>
            </div>

            <form onSubmit={handleAddManual} className="form-row">
              <div className="form-group" style={{ flex: 2 }}>
                <label>Minyan Name</label>
                <input type="text" value={minyanLabel} onChange={(e) => setMinyanLabel(e.target.value)} placeholder="e.g. שחרית" dir="auto" className="form-control" required />
              </div>
              <div className="form-group" style={{ flex: 1 }}>
                <label>Time</label>
                <input type="text" value={minyanTime} onChange={(e) => setMinyanTime(e.target.value)} placeholder="e.g. 6:30 AM" dir="auto" className="form-control" required />
              </div>
              <button type="submit" className="btn btn-primary">Add</button>
            </form>
            <StatusText st={manualSt} />

            <ul className="data-list" style={{ marginTop: '10px' }}>
              {manualMinyanim.map((m) => (
                <ManualMinyanRow key={m.id} minyan={m} dbPath="manual_minyanim" />
              ))}
            </ul>
          </div>

          {/* ===== WEEKDAY DYNAMIC ===== */}
          <div className="card">
            <h3>🌅 Weekday Schedule (Dynamic)</h3>
            <div className="help-box">
              Minyanim that follow the sun, like "Mincha 15 minutes before Shkia". Use a negative number for before, positive for after.
              "Same all week" gives one steady time based on the earliest (or latest) Shkia of the week, so people don't have to check every day.
              These appear alongside your fixed weekday times on the selected days.
            </div>
            <form onSubmit={handleAddWeekdayRule}>
              <div className="form-row">
                <div className="form-group" style={{ flex: 2 }}>
                  <label>Minyan Name</label>
                  <input type="text" value={wkLabel} onChange={(e) => setWkLabel(e.target.value)} placeholder="e.g. מנחה" dir="auto" className="form-control" required />
                </div>
                <div className="form-group" style={{ flex: 1 }}>
                  <label>Minutes</label>
                  <input type="number" value={wkOffset} onChange={(e) => setWkOffset(e.target.value)} placeholder="-15" className="form-control" required />
                </div>
                <div className="form-group" style={{ flex: 2 }}>
                  <label>From</label>
                  <select value={wkAnchor} onChange={(e) => setWkAnchor(e.target.value)} className="form-control">
                    {WEEKDAY_ANCHOR_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Time changes</label>
                  <select value={wkWeekly} onChange={(e) => setWkWeekly(e.target.value)} className="form-control">
                    {WEEKLY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label>Rounding</label>
                  <select value={wkRound || weekdayDefaultRound(wkOffset)} onChange={(e) => setWkRound(e.target.value)} className="form-control">
                    {ROUND_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div className="form-group" style={{ flex: 2 }}>
                  <label>Days</label>
                  <DayPicker days={wkDays} onChange={setWkDays} />
                </div>
                <button type="submit" className="btn btn-primary">Add</button>
              </div>
            </form>
            <StatusText st={wkSt} />
            <ul className="data-list" style={{ marginTop: '10px' }}>
              {weekdayRules.map((r) => <WeekdayRuleRow key={r.id} rule={r} />)}
            </ul>
          </div>

          {/* ===== SHABBOS FIXED ===== */}
          <div className="card">
            <h3>🍷 Shabbos Schedule (Fixed Times)</h3>
            <div className="help-box">
              Choose whether each minyan is Friday night or Saturday, so the board lists Friday night first.
              Older entries without a day are treated as Saturday; set the day on any Friday-night entries below.
            </div>

            <div style={{ marginBottom: '15px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '13px', fontWeight: 600, color: '#4b5563', alignSelf: 'center' }}>Quick Fill:</span>
              <button type="button" onClick={() => { setShabbosLabel('שחרית'); setShabbosTime('9:00 AM'); setShabbosDay('yom'); }} className="btn btn-secondary" style={{ fontSize: '13px', padding: '6px 12px', height: 'auto' }}>שחרית 9:00</button>
              <button type="button" onClick={() => { setShabbosLabel('מנחה גדולה'); setShabbosTime('1:30 PM'); setShabbosDay('yom'); }} className="btn btn-secondary" style={{ fontSize: '13px', padding: '6px 12px', height: 'auto' }}>מנחה גדולה 1:30</button>
            </div>

            <form onSubmit={handleAddShabbos} className="form-row">
              <div className="form-group" style={{ flex: 2 }}>
                <label>Minyan Name</label>
                <input type="text" value={shabbosLabel} onChange={(e) => setShabbosLabel(e.target.value)} placeholder="e.g. שחרית" dir="auto" className="form-control" required />
              </div>
              <div className="form-group" style={{ flex: 1 }}>
                <label>Time</label>
                <input type="text" value={shabbosTime} onChange={(e) => setShabbosTime(e.target.value)} placeholder="e.g. 9:00 AM" dir="auto" className="form-control" required />
              </div>
              <div className="form-group" style={{ flex: 1.5 }}>
                <label>Day</label>
                <select value={shabbosDay} onChange={(e) => setShabbosDay(e.target.value)} className="form-control">
                  {DAY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <button type="submit" className="btn btn-primary">Add</button>
            </form>
            <StatusText st={shabbosSt} />

            <ul className="data-list" style={{ marginTop: '10px' }}>
              {shabbosMinyanim.map((m) => (
                <ManualMinyanRow key={m.id} minyan={m} dbPath="shabbos_minyanim" withDay />
              ))}
            </ul>
          </div>

          {/* ===== DYNAMIC ===== */}
          <div className="card">
            <h3>⚙️ Shabbos & Yom Tov (Dynamic)</h3>
            <div className="help-box">
              These times are calculated from candle lighting, Shkia or Tzeis each week. For Yom Tov, "Fri" anchors use Erev Yom Tov,
              "Shab: Shkia" uses Shabbos (or the first day of Yom Tov), and "Shab: Tzeis" uses the last day.
              Times anchored to Shkia round earlier by default so a minyan is never listed later than the rule allows.
            </div>

            <form onSubmit={handleAddDynamic} className="form-row">
              <div className="form-group" style={{ flex: 2 }}>
                <label>Minyan Name</label>
                <input type="text" value={dynLabel} onChange={(e) => setDynLabel(e.target.value)} placeholder="e.g. מנחה" dir="auto" className="form-control" required />
              </div>
              <div className="form-group" style={{ flex: 2 }}>
                <label>Anchor Time</label>
                <select value={dynBase} onChange={(e) => { setDynBase(e.target.value); setDynRound(defaultRound(e.target.value)); }} className="form-control">
                  <option value="friday_candle">Friday: Candle Lighting</option>
                  <option value="friday_shkia">Friday: Shkia</option>
                  <option value="shabbos_shkia">Shabbos: Shkia</option>
                  <option value="shabbos_tzeis">Shabbos: Tzeis</option>
                </select>
              </div>
              <div className="form-group" style={{ flex: 1 }}>
                <label>Minutes</label>
                <input type="number" value={dynOffset} onChange={(e) => setDynOffset(e.target.value)} placeholder="-40 or 15" className="form-control" required />
              </div>
              <div className="form-group" style={{ flex: 2 }}>
                <label>Rounding</label>
                <select value={dynRound} onChange={(e) => setDynRound(e.target.value)} className="form-control">
                  {ROUND_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <button type="submit" className="btn btn-primary">Add</button>
            </form>
            <StatusText st={dynSt} />

            <ul className="data-list" style={{ marginTop: '10px' }}>
              {dynamicRules.map((m) => (
                <DynamicMinyanRow key={m.id} minyan={m} />
              ))}
            </ul>
          </div>

          {/* ===== TICKER ===== */}
          <div className="card">
            <h3>💬 Scrolling Announcements</h3>
            <form onSubmit={handleAddMessage} className="form-row">
              <div className="form-group">
                <label>New Message</label>
                <input type="text" value={newMessage} onChange={(e) => setNewMessage(e.target.value)} placeholder="Type a new announcement..." dir="auto" className="form-control" />
              </div>
              <button type="submit" className="btn btn-primary">Add</button>
            </form>

            <ul className="data-list">
              {messages.map((msg) => (
                <li key={msg.id} className="data-item">
                  <span className="data-text" dir="auto">{msg.text}</span>
                  <button onClick={() => handleDeleteMessage(msg)} className="btn btn-danger">Delete</button>
                </li>
              ))}
            </ul>
          </div>

          {/* ===== OVERRIDES ===== */}
          <div className="card" style={{ background: '#fffbeb', border: '1px solid #fde68a' }}>
            <h3 style={{ color: '#d97706' }}>🛠️ Manual Overrides (Emergency Use)</h3>
            <div className="help-box" style={{ background: '#fff7ed', borderColor: '#f59e0b', color: '#7c2d12' }}>
              Overrides replace the automatic values until the date you choose (next Sunday by default), then the board goes back to automatic.
              {overridesActive && <><br /><strong>Active until {overrides.expires}.</strong></>}
              {overridesExpired && <><br /><strong>Expired on {overrides.expires} - the board is ignoring them.</strong></>}
            </div>
            <form onSubmit={handleSaveOverrides}>
              <div className="form-row">
                <div className="form-group"><label>Parsha Override</label><input type="text" value={overrides.parsha} onChange={(e) => setOverrides({ ...overrides, parsha: e.target.value })} placeholder="Auto" dir="auto" className="form-control" /></div>
                <div className="form-group"><label>Haftarah Override</label><input type="text" value={overrides.haftarah} onChange={(e) => setOverrides({ ...overrides, haftarah: e.target.value })} placeholder="Auto" dir="auto" className="form-control" /></div>
              </div>
              <div className="form-row">
                <div className="form-group"><label>Daf Yomi Override</label><input type="text" value={overrides.daf} onChange={(e) => setOverrides({ ...overrides, daf: e.target.value })} placeholder="Auto" dir="auto" className="form-control" /></div>
                <div className="form-group"><label>Omer Override</label><input type="text" value={overrides.omer} onChange={(e) => setOverrides({ ...overrides, omer: e.target.value })} placeholder="Auto" dir="auto" className="form-control" /></div>
                <div className="form-group"><label>Candle Lighting Override</label><input type="text" value={overrides.candles} onChange={(e) => setOverrides({ ...overrides, candles: e.target.value })} placeholder="Auto" dir="auto" className="form-control" /></div>
              </div>
              <div className="form-row">
                <div className="form-group" style={{ maxWidth: '250px' }}>
                  <label>Show overrides through</label>
                  <input type="date" value={overrides.expires || ''} onChange={(e) => setOverrides({ ...overrides, expires: e.target.value })} className="form-control" />
                </div>
              </div>
              <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
                <button type="submit" className="btn btn-primary" style={{ background: '#d97706' }}>Save Overrides</button>
                <button type="button" onClick={handleClearOverrides} className="btn btn-secondary">Clear All Overrides</button>
                <StatusText st={overrideSt} />
              </div>
            </form>
          </div>

        </div>
      </div>
    </>
  );
};

export default Admin;
