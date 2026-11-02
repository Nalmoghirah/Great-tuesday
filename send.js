/**
 * الثلاثاء العظيم — automatic notifications (runs on GitHub every 5 minutes, Riyadh time).
 * Same system as العليّة, adapted to this site's Realtime Database:
 *  1) The meeting place is set (or changed) for the coming Tuesday → everyone is told where (once per place).
 *  2) Tuesday from 12:00 noon → a reminder (once per Tuesday): who hasn't replied is asked if they're coming,
 *     who said they're coming gets a welcome, who said they're not coming gets nothing.
 *  3) The admin writes a message on the site (📣 أرسل التنبيه للكل) → it goes to everyone.
 *  Manual test: run the workflow by hand with a name → a test notification to that person only; type الكل → to everyone.
 * Needs the secret FIREBASE_SERVICE_ACCOUNT (the service-account JSON from Firebase).
 */
const admin = require("firebase-admin");

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  databaseURL: "https://the-great-tusday-default-rtdb.firebaseio.com",
});
const db = admin.database();
const SITE = "https://thegreattuesday.netlify.app/";
const TZ = "Asia/Riyadh";
const MEETING_DAY = 2;     // Tuesday (0 = Sunday)
const REMIND_HOUR = 12;    // noon reminder
const ARCHIVE_HOUR = 23;   // the site moves to next week at 11pm on Tuesday
const TEST_NAME = (process.env.TEST_NAME || "").trim();

function riyadhNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short" })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  const dow = new Date(date + "T12:00:00Z").getUTCDay();
  return { date, hour: Number(p.hour), dow };
}
const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// The meeting the site is showing right now (same rule as the site: today's meeting stays current until 11pm)
function currentMeeting(now) {
  let diff = (MEETING_DAY - now.dow + 7) % 7;
  if (diff === 0 && now.hour >= ARCHIVE_HOUR) diff = 7;
  return addDays(now.date, diff);
}
function longDate(iso) {
  const [y, mo, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("ar-SA-u-ca-gregory-nu-arab", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })
    .format(new Date(Date.UTC(y, mo - 1, d, 12))).replace("،", "");
}
// "الليلة" / "بكرة" / "يوم الثلاثاء ١٠ نوفمبر"
function whenText(iso, today) {
  const diff = Math.round((Date.parse(iso) - Date.parse(today)) / 864e5);
  if (diff === 0) return "الليلة";
  if (diff === 1) return "بكرة";
  return "يوم " + longDate(iso);
}
const ar = (n) => Number(n).toLocaleString("ar-SA");
const norm = (n) => String(n || "").replace(/[ً-ْـ]/g, "").replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي").replace(/\s+/g, " ").trim();
const firstName = (n) => String(n || "").trim().split(/\s+/)[0] || "";
const val = async (path) => (await db.ref(path).once("value")).val();
const asList = (v) => (Array.isArray(v) ? v.filter(Boolean) : v && typeof v === "object" ? Object.values(v).filter(Boolean) : []);

/** Sends to every registered device. `make(device)` returns {title, body, link?} or null to skip that device. */
async function send(tag, make, onlyName) {
  const all = (await val("pushTokens")) || {};
  let rows = Object.entries(all).map(([key, d]) => ({ key, ...d })).filter((d) => d.token);
  if (onlyName) rows = rows.filter((d) => norm(d.name) === norm(onlyName) || firstName(norm(d.name)) === norm(onlyName));
  const msgs = [];
  for (const d of rows) {
    const note = make({ name: d.name || "", memberId: d.memberId || "" });
    if (!note) continue;
    msgs.push({
      key: d.key,
      msg: {
        token: d.token,
        notification: { title: note.title, body: note.body },
        webpush: {
          notification: { title: note.title, body: note.body, icon: SITE + "icon-192.png", badge: SITE + "icon-192.png", dir: "rtl", lang: "ar", tag, renotify: true },
          fcmOptions: { link: note.link || SITE },
        },
      },
    });
  }
  if (!msgs.length) { console.log("nobody to send to", tag, onlyName || ""); return; }
  let ok = 0, bad = 0;
  for (let i = 0; i < msgs.length; i += 500) {
    const batch = msgs.slice(i, i + 500);
    const res = await admin.messaging().sendEach(batch.map((b) => b.msg));
    ok += res.successCount; bad += res.failureCount;
    await Promise.all(res.responses.map((r, k) => {
      const code = r.error && r.error.code;
      if (code) console.log("fail", code);
      if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token" || code === "messaging/invalid-argument")
        return db.ref("pushTokens/" + batch[k].key).remove().catch(() => {});
      return null;
    }));
  }
  console.log(`sent ${tag} ok=${ok} failed=${bad}`);
}

(async () => {
  if (TEST_NAME) {
    const everyone = ["الكل", "الجميع", "all"].includes(norm(TEST_NAME).toLowerCase());
    await send("test", (u) => ({ title: "تجربة من الثلاثاء العظيم 🍽️", body: `هلا${firstName(u.name) ? " " + firstName(u.name) : ""}، هذي رسالة تجربة. التنبيهات شغّالة عندك تمام.` }), everyone ? "" : TEST_NAME);
    return;
  }
  // only one run at a time (GitHub's schedule can overlap) → no double notifications
  const lockRef = db.ref("locks/runner");
  const me = Math.random().toString(36).slice(2);
  const tx = await lockRef.transaction((l) => (l && Date.now() - (l.t || 0) < 4 * 60000 ? undefined : { t: Date.now(), by: me }));
  if (!tx.committed) { console.log("another run is busy, skipping"); return; }

  try {
    const now = riyadhNow();
    const meeting = currentMeeting(now);
    console.log("Riyadh", now, "meeting", meeting);

    // ---- 3) admin messages from the site (broadcasts with status "pending")
    const bc = (await val("broadcasts")) || {};
    const pend = Object.entries(bc).filter(([, x]) => x && x.status === "pending").sort((a, b) => String(a[1].at).localeCompare(String(b[1].at)));
    let sentNow = 0;
    for (const [id, x] of pend) {
      const ref = db.ref("broadcasts/" + id);
      const ageMin = (Date.now() - Date.parse(x.at || 0)) / 60000;
      const body = String(x.body || "").slice(0, 200);
      if (!(ageMin < 120) || sentNow >= 3 || !body) { // too old, too many at once, or empty → don't flood phones
        await ref.update({ status: "skipped", doneAt: new Date().toISOString() });
        continue;
      }
      await send("bc-" + id, () => ({ title: String(x.title || "تنبيه من الثلاثاء العظيم 🍽️").slice(0, 60), body }));
      await ref.update({ status: "sent", doneAt: new Date().toISOString() });
      sentNow++;
    }

    const week = (await val("week-data/" + meeting)) || {};
    const state = (await val("push-state/" + meeting)) || {};
    const stateRef = db.ref("push-state/" + meeting);

    // ---- 1) meeting place set or changed → tell everyone (once per place)
    const loc = week.location;
    if (loc && loc.name) {
      const sig = `${loc.name}|${loc.url || ""}`;
      if (state.locationSig !== sig) {
        const changed = !!state.locationSig;
        const when = whenText(meeting, now.date);
        const link = /^https:\/\//.test(loc.url || "") ? loc.url : SITE;
        await send("loc-" + meeting, () => ({
          title: changed ? "تغيّر مكان الثلاثاء العظيم 📍" : "مكان الثلاثاء العظيم 📍",
          body: `${when} بنتعشى في ${loc.name}. اضغط عشان تفتح الموقع على الخريطة، ولا تنسى تعلّمنا بتحضر.`,
          link,
        }));
        await stateRef.update({ locationSig: sig });
      }
    }

    // ---- 2) Tuesday noon reminder (once per Tuesday)
    if (now.date === meeting && now.hour >= REMIND_HOUR && now.hour < ARCHIVE_HOUR && !state.remindedNoon) {
      const rsvp = week.rsvp || {};
      const yes = Object.values(rsvp).filter((v) => v === "coming").length;
      const place = loc && loc.name ? ` 📍 ${loc.name}` : "";
      const title = "الليلة الثلاثاء العظيم 🍽️";
      await send("day-" + meeting, (u) => {
        const r = rsvp[u.memberId];
        const fn = firstName(u.name);
        if (r === "not_coming") return null; // said he's not coming — don't nag
        if (r === "coming") return {
          title,
          body: `حيّاك الله${fn ? " يا " + fn : ""}، ننتظرك الليلة.${yes > 1 ? ` وصرتوا ${ar(yes)} لين الحين.` : ""}${place}`,
        };
        return {
          title,
          body: `${fn ? fn + "، " : ""}للحين ما علّمتنا. بتحضر الليلة؟${yes === 1 ? " واحد أكّد لين الحين." : yes ? ` ${ar(yes)} أكّدوا لين الحين.` : ""}${place}`,
        };
      });
      await stateRef.update({ remindedNoon: true });
    }
  } finally {
    const l = (await lockRef.once("value")).val();
    if (l && l.by === me) await lockRef.remove().catch(() => {});
  }
})().catch((e) => { console.error(e); process.exit(1); });
