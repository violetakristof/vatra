// Vatra engine - pure functions. No DOM, no db. Everything here is testable in node.
(function (root) {
  const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  // ---------- dates (all in local wall-clock, as YYYY-MM-DD strings) ----------
  function pad(n) { return String(n).padStart(2, "0"); }
  function ymd(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function parse(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
  function addDays(s, n) { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); }
  function dow(s) { return DAYS[(parse(s).getDay() + 6) % 7]; }           // Mon..Sun
  function mondayOf(s) { const d = parse(s); const k = (d.getDay() + 6) % 7; d.setDate(d.getDate() - k); return ymd(d); }
  function weekIndex(rules, monday) { return Math.round((parse(monday) - parse(rules.epochMonday)) / 864e5 / 7); }
  function mod(a, n) { return ((a % n) + n) % n; }

  // Deterministic tie-break: a small hash so the same week solves the same way on every device.
  function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0); }

  // ---------- ledger ----------
  // completions: [{person, minutes, date}] ; autoCredits counted per day in range
  // minutes a completion is worth today, from Mama's standards (rules.std, 7 Nov): done jobs are recounted too
  const ZONES = ["bathLight", "entryways", "common"];
  // Mama's standard for a chore, with per-person exceptions (rules.stdPerson)
  function stdFor(rules, chore, person) { const pp = (rules.stdPerson || {})[person]; return pp && pp[chore] != null ? pp[chore] : (rules.std || {})[chore]; }
  function minutesOf(rules, c) {
    const std = rules.std || {}, m = c.minutes || 0;
    if (c.skip || c.override || c.pass || c.swap || c.move || c.cancel || c.deleted) return 0;
    if (ZONES.includes(c.chore)) return c.daily ? (rules.zoneDayMinutes || 0) : 0; // zones: per day ticked, not at "Week done"
    if (String(c.id || "").startsWith("ask:") || c.chore === "digital") return m;
    if (c.helper || / · helper/.test(c.label || "")) return m;
    if (c.split) return m; // a job Mama split between two people keeps the minutes she set (7 Nov 22:19)
    if (std[c.chore] == null) return m;
    if (m === 0 && !(rules.ownCount || []).includes(c.chore)) return 0; // e.g. Chef tapped by Tata: the daily auto credit covers it
    if ((c.chore === "deepBath" || c.chore === "ensuite") && m > 0 && m < std[c.chore]) return m; // the helper tile keeps its 15
    return stdFor(rules, c.chore, c.person);
  }
  // tile minutes from Mama's standards; zones show 7 days × 10; helpers keep theirs
  function applyStd(rules, list) {
    const std = rules.std || {};
    for (const a of list) {
      if (/ · helper/.test(a.label || "") || a.helperOf) continue;
      if (a.kind === "zone") { a.minutes = 7 * (rules.zoneDayMinutes || 0); continue; }
      if (std[a.chore] != null && (a.minutes > 0 || (rules.ownCount || []).includes(a.chore))) a.minutes = stdFor(rules, a.chore, a.person);
    }
    return list;
  }
  function ledger(rules, completions, upToDate, weeks) {
    weeks = weeks || rules.ledgerWeeks;
    let from = addDays(mondayOf(upToDate), -7 * (weeks - 1));
    if (rules.startDate && from < rules.startDate) from = rules.startDate;
    const out = {};
    for (const p of rules.order) out[p] = { fixed: 0, rotating: 0, total: 0 };
    for (const c of completions) {
      if (!c || !c.person || !out[c.person]) continue;
      if (c.date < from || c.date > upToDate) continue;
      const k = c.fixed ? "fixed" : "rotating";
      out[c.person][k] += minutesOf(rules, c);
    }
    // auto credits
    const nDays = Math.max(0, Math.round((parse(upToDate) - parse(from)) / 864e5) + 1);
    for (const a of rules.autoCredits || []) {
      if (!out[a.person]) continue;
      if (a.every === "day") {
        let n = nDays;
        for (const c of completions) if (c && c.override && c.chore === "cook" && c.from === a.person && c.date >= from && c.date <= upToDate) n--;
        for (const c of completions) if (c && c.skip && c.chore === "cook" && c.person === a.person && c.date >= from && c.date <= upToDate) n--; // cancelled Chef night: no auto credit (Mama, 6 Nov)
        out[a.person].fixed += a.minutes * Math.max(0, n);
      }
    }
    for (const p in out) out[p].total = out[p].fixed + out[p].rotating;
    return out;
  }

  // ---------- week generation ----------
  // away: {person: [dates]} ; led: ledger totals {person:{total}} ; settings: rules.settings merged with db settings
  function generateWeek(rules, monday, led, away, settings, extra) {
    settings = Object.assign({}, rules.settings, settings || {});
    extra = extra || {};
    away = away || {};
    const w = weekIndex(rules, monday);
    const dates = DAYS.map((_, i) => addDays(monday, i));
    const isAway = (p, date) => (away[p] || []).includes(date);
    const load = {};
    // each week starts fresh and is balanced to weighted targets (Mama, 7 Nov 22:31); the 4-week ledger no longer drives who gets what
    const BAL = rules.balance || {}, wt = (p) => (BAL.weights && BAL.weights[p]) || 1;
    for (const p of rules.order) load[p] = BAL.fresh ? 0 : (led && led[p] ? led[p].total : 0);
    const out = [];
    let seq = 0;
    const mk = (o) => { if (o.window === "wknd" && !o.date) o.due = addDays(monday, o.dueSun ? 6 : 5); /* weekend jobs are due Saturday: Sunday stays free for guests */ o.id = monday + "#" + (seq++); o.week = monday; o.minutes = o.minutes || 0; out.push(o); if (o.person && o.counts !== false) load[o.person] += o.minutes; return o; };
    const B = rules.buckets;
    const lowest = (cands, salt) => {
      const ok = cands.filter(Boolean);
      if (!ok.length) return null;
      ok.sort((a, b) => (load[a] / wt(a) - load[b] / wt(b)) || (hash(monday + salt + a) - hash(monday + salt + b)));
      return ok[0];
    };

    // Corvin's weekend night off: the weekend day where he is not away; else parity.
    let corvinOff = "Sat"; // Corvin is off Dinner Service on Saturdays (Mama, 6 Nov 19:09: he might be out); was alternating Sat/Sun
    if (isAway("Corvin", dates[5]) && !isAway("Corvin", dates[6])) corvinOff = "Sat";
    if (isAway("Corvin", dates[6]) && !isAway("Corvin", dates[5])) corvinOff = "Sun";

    // ---- grandparents: solver assigns weekdays from the quota, Saturday is the uncle's ----
    const gpPlan = {};
    {
      const quota = Object.assign({}, settings.grandparentsQuota || {});
      const never = settings.grandparentsNever || {};
      const fixedDays = settings.grandparents || {};
      const openDays = DAYS.filter(d => !fixedDays[d] || rules.people[fixedDays[d]]);
      for (const d of DAYS) if (fixedDays[d] && rules.people[fixedDays[d]]) { gpPlan[d] = fixedDays[d]; quota[fixedDays[d]] = (quota[fixedDays[d]] || 0) - 1; }
      const elig = (d) => Object.keys(quota).filter(p => quota[p] > 0 && !(never[p] || []).includes(d) && !isAway(p, dates[DAYS.indexOf(d)])).length;
      const todo = openDays.filter(d => !gpPlan[d]).sort((a, b) => (elig(a) - elig(b)) || (hash(monday + "gp" + a) - hash(monday + "gp" + b)));
      for (const d of todo) {
        const date = dates[DAYS.indexOf(d)];
        const cands = Object.keys(quota).filter(p => quota[p] > 0 && !(never[p] || []).includes(d) && !isAway(p, date));
        if (!cands.length) continue;
        cands.sort((a, b) => (quota[b] - quota[a]) || (hash(monday + "gpp" + d + a) - hash(monday + "gpp" + d + b)));
        gpPlan[d] = cands[0]; quota[cands[0]]--;
      }
      for (const d of DAYS) if (fixedDays[d] && !rules.people[fixedDays[d]]) gpPlan[d] = fixedDays[d];
    }

    // ---- zones (weekly owners) ----
    const pool = rules.pool, kids = rules.kids;
    const bathCycle = ["Maya", "Sofia", "Corvin", "Maya", "Sofia"];
    let bath = bathCycle[mod(w, 5)];
    // Mess rule: two mess flags in one week and that kid takes the next bathroom-light week.
    const mp = extra.messPrev || {};
    const offender = kids.filter(k => (mp[k] || 0) >= 2).sort((a, b) => mp[b] - mp[a])[0];
    const bathPenalty = !!offender;
    if (offender) bath = offender;
    const rem = pool.filter(p => p !== bath);
    const entry = rem[mod(w, 3)];
    const common = rem[mod(w + 1, 3)];
    mk({ kind: "zone", chore: "bathLight", label: "Bathroom", person: bath, due: dates[6], window: "week", minutes: B.S * 7, note: bathPenalty ? "mess rule" : undefined });
    mk({ kind: "zone", chore: "entryways", label: "Entryways", person: entry, due: dates[6], window: "week", minutes: B.S * 7 });
    mk({ kind: "zone", chore: "common", label: "Dining + Hallways", person: common, due: dates[6], window: "week", minutes: B.S * 7 });

    // ---- evenings ----
    let prevFin = null, prevDishes = null;
    const noRepeat = (cands, prev) => (cands.length > 1 ? cands.filter(p => p !== prev) : cands);
    dates.forEach((date, i) => {
      const d = DAYS[i];
      for (const p of rules.order) mk({ kind: "arrival", chore: "arrival", label: "Arrival", person: p, date, due: date, minutes: 0, counts: false, own: true });
      mk({ kind: "evening", role: "cook", chore: "cook", label: "Chef", person: "Tata", date, due: date, minutes: 45, auto: true, counts: false, claimable: rules.order });
      let dishes;
      if (d !== "Mon" && d !== corvinOff && !isAway("Corvin", date)) dishes = "Corvin";
      else dishes = lowest(noRepeat(rules.qual.dishesCover.filter(p => !isAway(p, date)), prevDishes), "dishes" + date);
      prevDishes = dishes;
      const dishesA = mk({ kind: "evening", role: "dishes", chore: "dishes", label: "Dinner Service", person: dishes, date, due: date, minutes: B.M });
      let fin = lowest(noRepeat(rules.qual.finisherDefault.filter(p => p !== dishes && !isAway(p, date)), prevFin), "fin" + date);
      if (!fin) fin = "Tata";
      prevFin = fin;
      mk({ kind: "evening", role: "finisher", chore: "finisher", label: "Finisher + pack lunches", person: fin, date, due: date, minutes: B.L, dependsOn: dishesA.id });
      const scCands = rules.qual.sousChef.filter(p => p !== dishes && p !== fin && !isAway(p, date));
      if (scCands.length) {
        const sc = scCands[mod(w * 7 + i, scCands.length)];
        mk({ kind: "evening", role: "souschef", chore: "souschef", label: "Sous-chef", person: sc, date, due: date, minutes: B.M, optional: true });
      }
      // fixed daily
      mk({ kind: "fixed", chore: "garbage", label: "Garbage + recycling", person: "Corvin", date, due: date, minutes: B.S, fixed: true });
      mk({ kind: "fixed", chore: "supplements", label: "Kids' supplements + skincare", person: "Mama", date, due: date, minutes: 10, fixed: true });
      // Empty dishwasher + rack: weekdays only, one person a day (Mama, 7 Nov 22:26); away → next free in the list
      if (i < 5) { const DP = ["Maya", "Sofia", "Corvin", "Mama", "Tata"]; let who = DP[i]; if (isAway(who, date)) who = DP.find(p => !isAway(p, date)) || who;
        mk({ kind: "fixed", chore: "dishPrep", label: "Empty dishwasher + rack · by 5 pm", person: who, date, due: date, minutes: 10, fixed: true }); }
      if (d === settings.binsOut) mk({ kind: "fixed", chore: "binsOut", label: "Bins out", person: "Corvin", date, due: date, minutes: B.S, fixed: true });
      if (d === settings.binsBack) mk({ kind: "fixed", chore: "binsBack", label: "Bins back", person: "Corvin", date, due: date, minutes: B.S, fixed: true });
      if (d === settings.shopDay) mk({ kind: "fixed", chore: "shop", label: "Costco", person: "Tata", window: "wknd", dueSun: true, minutes: 120, fixed: true }); // any time over the weekend, due Sunday (Mama, 6 Nov)
      // Costco merged into Shop as one weekly "Costco" (Mama, 7 Nov 21:42)
      const gp = gpPlan[d];
      if (gp && rules.people[gp]) mk({ kind: "fixed", chore: "grandparents", label: "Grandparents", person: gp, date, due: date, minutes: 60, fixed: true });
      else if (gp !== "brother") mk({ kind: "fixed", chore: "grandparents", label: "Grandparents", person: null, note: "nobody free", date, due: date, minutes: 0, counts: false, unassigned: true });
      if (d === "Fri") for (const p of rules.order) mk({ kind: "own", chore: "menu", label: "Menu idea", person: p, date, due: date, minutes: 0, counts: false, own: true, closes: settings.menuCloses });
      for (const p of rules.order) if (p !== "Tata") mk({ kind: "own", chore: "roomReset", label: "My Room Reset", person: p, date, due: date, minutes: B.S, own: true, counts: false, quiet: true });
    });

    // ---- weekly shared, Sat-Sun window, due Sunday ----
    const sun = dates[6], thu = dates[3];
    const wkAway = (p) => isAway(p, dates[5]) && isAway(p, dates[6]);
    const kidsBath = bathCycle[mod(w, 5)];
    const deep = mk({ kind: "weekly", chore: "deepBath", label: "Deep bathroom", person: kidsBath, due: sun, window: "wknd", minutes: B.L });
    if (!rules.qual.deepBathSolo.includes(kidsBath)) {
      const helper = lowest(rules.sisters.filter(p => !wkAway(p)), "bathhelper");
      mk({ kind: "weekly", chore: "deepBath", label: "Deep bathroom · helper", person: helper, due: sun, window: "wknd", minutes: B.M, helperOf: deep.id });
    }
    mk({ kind: "weekly", chore: "ensuite", label: "En-suite", person: "Mama", due: sun, window: "wknd", minutes: B.L, fixed: true });
    // En-suite helper removed (Mama, 7 Nov 22:07)
    const vac = mk({ kind: "weekly", chore: "vacuum", label: "Vacuum", person: lowest(pool.filter(p => !wkAway(p)), "vac"), due: sun, window: "wknd", minutes: B.L });
    mk({ kind: "weekly", chore: "floors", label: "Floors", person: lowest(pool.filter(p => !wkAway(p)), "floors"), due: sun, window: "wknd", minutes: B.M, dependsOn: vac.id });
    mk({ kind: "weekly", chore: "fridge", label: "Fridge", person: lowest(pool.filter(p => !isAway(p, thu)), "fridge"), date: thu, due: thu, minutes: B.M });
    mk({ kind: "weekly", chore: "kitchenWeekly", label: "Kitchen weekly", person: (() => { const kwOrder = ["Sofia", "Corvin", "Mama", "Tata", "Maya"]; for (let i = 0; i < 5; i++) { const p = kwOrder[mod(w + i, 5)]; if (!wkAway(p)) return p; } return kwOrder[mod(w, 5)]; })(), due: sun, window: "wknd", minutes: B.M }); // Kitchen weekly takes turns across all five, Tata included
    mk({ kind: "fixed", chore: "plants", label: "Plants", person: "Tata", due: sun, window: "week", minutes: B.S, fixed: true });

    // ---- monthly rota: job = w mod 4, person = order[(cycle + job) mod 4] ----
    const job = mod(w, 4), cycle = Math.floor(w / 4);
    const mo = settings.monthlyOrder || rules.pool;
    const mPerson = mo[mod(cycle + job, 4)];
    // Kitchen drawers + Stove and oven merged into "Kitchen deep", monthly (Mama, 7 Nov 21:42)
    // Kitchen deep merged into Kitchen weekly (Mama, 8 Nov 01:17): the monthly slot 0 is empty now
    const mLabels = [null, "Common closet", null, "Declutter zone"];
    const mChore = [null, "monthly2", null, "monthly4"][job];
    const mMin = B.L;
    const mA = !mChore ? {} : mk({ kind: "monthly", chore: mChore, label: mLabels[job], person: wkAway(mPerson) ? lowest(pool.filter(p => !wkAway(p)), "mo") : mPerson, due: sun, window: "wknd", minutes: mMin });
    if (job === 3 && settings.declutterList && settings.declutterList.length) mA.note = settings.declutterList[mod(cycle, settings.declutterList.length)];
    if (job === 1) mk({ kind: "monthly", chore: "car", label: "Car", person: "Corvin", due: sun, window: "wknd", minutes: B.L, fixed: true });
    if (job === 2) mk({ kind: "monthly", chore: "windows", label: "Windows and mirrors", person: lowest(pool.filter(p => !wkAway(p)), "win"), due: sun, window: "wknd", minutes: B.L });
    if (job === 3) mk({ kind: "monthly", chore: "cubbies", label: "Cubbies", person: lowest(pool.filter(p => !wkAway(p)), "cub"), due: sun, window: "wknd", minutes: B.M });
    if (job === 0) mk({ kind: "monthly", chore: "filters", label: "Filters", person: "Tata", due: sun, window: "wknd", minutes: B.S, fixed: true }); // always Tata (Mama, 7 Nov 22:43)

    // ---- laundry loads: scheduled, assigned, chained ----
    const lDays = settings.laundryDays || ["Mon", "Wed", "Fri"];
    lDays.forEach((d, li) => {
      const i = DAYS.indexOf(d); if (i < 0) return;
      const date = dates[i], next = i < 6 ? dates[i + 1] : dates[6];
      const pool3 = rules.qual.wash;
      let washer = pool3[mod(w + li, pool3.length)];
      if (isAway(washer, date)) washer = lowest(pool3.filter(p => !isAway(p, date)), "wash" + date) || washer;
      const other = lowest(rules.qual.deliver.filter(p => p !== washer && !isAway(p, next)), "deliver" + date) || pool3.find(p => p !== washer);
      const wash = mk({ kind: "laundry", load: li, chore: "wash", label: "Wash · load " + (li + 1), person: washer, date, due: date, minutes: rules.laundry.wash, fixed: true });
      const fold = mk({ kind: "laundry", load: li, chore: "fold", label: "Fold · load " + (li + 1), person: washer, date, due: date, minutes: rules.laundry.fold, dependsOn: wash.id, claimable: ["Tata"], fixed: true });
      const del = mk({ kind: "laundry", load: li, chore: "deliver", label: "Deliver + put away · load " + (li + 1), person: other, date, due: date, minutes: rules.laundry.deliver, dependsOn: fold.id, fixed: true });
      // put away is merged into Deliver (Mama, 4 Nov)
      if (false) mk({ kind: "laundry", load: li, chore: "putaway", label: "Put away · load " + (li + 1), person: p, date: next, due: next, minutes: 0, counts: false, own: true, dependsOn: del.id, dayAfter: true });
    });

    // ---- linen fortnight: towels + sheets together on odd weeks, from the 16 Nov week (Mama, 7 Nov 19:50) ----
    // Towels take turns: Maya, Sofia, Corvin, Tata (Mama, 7 Nov 21:55); skip anyone away all week
    if (mod(w, 2) !== 0) { const tOrder = ["Maya", "Sofia", "Corvin", "Tata"], k = Math.floor(w / 2); let tp = null; for (let i = 0; i < 4 && !tp; i++) { const c = tOrder[mod(k + i, 4)]; if (!wkAway(c)) tp = c; } mk({ kind: "weekly", chore: "towels", label: "Towels", person: tp || tOrder[mod(k, 4)], due: sun, window: "wknd", minutes: B.L, fixed: true }); }
    if (mod(w, 2) !== 0) for (const p of rules.order) { if (p === "Tata") continue; mk(Object.assign({ kind: "own", chore: "sheets", label: "Sheets", person: p, due: sun, window: "wknd", minutes: B.M, own: true, counts: false }, p === "Mama" ? { shared: ["Mama", "Tata"], note: "Mama + Tata" } : {})); }

    // ---- own weekly ----  (no Inbox to Library for Tata: Mama, 7 Nov 23:20)
    for (const p of rules.order) {
      if (p !== "Tata") mk({ kind: "own", chore: "roomDeep", label: "My Room Deep", person: p, due: sun, window: "wknd", minutes: B.L, own: true, counts: false });
      if (p !== "Tata") mk({ kind: "own", chore: "filing", label: "Inbox to Library", person: p, date: dates[5], due: dates[5], minutes: B.S, own: true, counts: false });
      if (job === 3 && p !== "Tata") mk({ kind: "own", chore: "roomDeclutter", label: "My Room Declutter", person: p, due: sun, window: "wknd", minutes: B.L, own: true, counts: false });
    }
    mk({ kind: "fixed", chore: "admin", label: "Admin", person: "Mama", date: sun, due: sun, minutes: B.XL, fixed: true });
    mk({ kind: "fixed", chore: "review", label: "Weekly review", person: "Mama", date: sun, due: sun, minutes: B.S, fixed: true });

    if (typeof extra.adjust === "function") extra.adjust(out); // one-off changes for a given week, before balancing
    applyStd(rules, out);
    const balance = BAL.weights ? balanceWeek(rules, out, isAway, dates) : null;
    return { balance, week: monday, weekIndex: w, corvinOff, generatedAt: new Date().toISOString(), rulesVersion: rules.version, assignments: out };
  }

  // ---------- weekly balance (Mama, 7 Nov 22:31) ----------
  // planned minutes per person for a generated week, counted like the ledger
  function plannedMinutes(rules, list) {
    const t = {}; for (const p of rules.order) t[p] = 0;
    const credit = {}; for (const c of rules.autoCredits || []) credit[c.person] = c.minutes;
    for (const a of list) {
      if (!a.person || t[a.person] == null || a.optional || a.unassigned) continue;
      let m = a.minutes || 0;
      if (a.kind === "zone") m = 7 * (rules.zoneDayMinutes || 0);
      else if (a.chore === "cook") m = a.person in credit ? credit[a.person] : 0;
      else if (a.counts === false && !(rules.ownCount || []).includes(a.chore)) m = 0;
      t[a.person] += m;
    }
    return t;
  }
  // move movable jobs from over-target to under-target people, keeping the existing rules
  function balanceWeek(rules, list, isAway, dates) {
    const BAL = rules.balance || {}, W = BAL.weights || {}, pool = rules.pool, wt = (p) => W[p] || 1;
    const sameWeekAway = (p) => dates.some(d => isAway(p, d));
    const wkAway = (p) => isAway(p, dates[5]) && isAway(p, dates[6]);
    const ZONES_ = ["bathLight", "entryways", "common"];
    const POOLJOBS = ["vacuum", "floors", "fridge", "windows", "cubbies", "filters", "monthly2", "monthly4"];
    const units = [];
    for (const a of list) {
      if (!a.person || a.pin || a.fixed && a.kind !== "laundry") continue;
      if (a.kind === "zone" && ZONES_.includes(a.chore) && !a.note) units.push({ tiles: [a], ok: (p) => pool.includes(p) && !sameWeekAway(p) && !list.some(x => x.kind === "zone" && x !== a && x.person === p) });
      else if (POOLJOBS.includes(a.chore) && !a.helperOf) units.push({ tiles: [a], ok: (p) => pool.includes(p) && (a.date ? !isAway(p, a.date) : !wkAway(p)) });
      else if (a.chore === "finisher") units.push({ tiles: [a], ok: (p) => { const dish = list.find(x => x.chore === "dishes" && x.date === a.date); const near = list.some(x => x.chore === "finisher" && x !== a && x.person === p && Math.abs(parse(x.date) - parse(a.date)) <= 86400000); return rules.qual.finisherDefault.includes(p) && !isAway(p, a.date) && (!dish || dish.person !== p) && !near; } });
      else if (a.kind === "laundry" && a.chore === "wash") { const fold = list.find(x => x.kind === "laundry" && x.chore === "fold" && x.dependsOn === a.id); const tiles = fold && fold.person === a.person ? [a, fold] : [a];
        units.push({ tiles, ok: (p) => { const del = list.find(x => x.kind === "laundry" && x.chore === "deliver" && x.date === a.date && x.load === a.load); return rules.qual.wash.includes(p) && !isAway(p, a.date) && (!del || del.person !== p); } }); }
      else if (a.kind === "laundry" && a.chore === "deliver") units.push({ tiles: [a], ok: (p) => { const wa = list.find(x => x.kind === "laundry" && x.chore === "wash" && x.date === a.date && x.load === a.load); return rules.qual.deliver.includes(p) && !isAway(p, a.date) && (!wa || wa.person !== p); } });
    }
    const unitMin = (u) => { const t = plannedMinutes(rules, u.tiles.map(x => Object.assign({}, x))); return Object.values(t).reduce((s, v) => s + v, 0); };
    const load = plannedMinutes(rules, list);
    const movers = pool.filter(p => !dates.every(d => isAway(p, d)));
    const target = () => { const tot = movers.reduce((s, p) => s + load[p], 0), ws = movers.reduce((s, p) => s + wt(p), 0); const o = {}; for (const p of movers) o[p] = tot / ws * wt(p); return o; };
    const cost = () => { const T = target(); return movers.reduce((s, p) => s + Math.pow(load[p] - T[p], 2) / wt(p), 0); };
    const moves = [];
    for (let it = 0; it < 60; it++) {
      let best = null, base = cost();
      for (const u of units) {
        const from = u.tiles[0].person, m = unitMin(u);
        if (!movers.includes(from) || !m) continue;
        for (const p of movers) {
          if (p === from || !u.ok(p)) continue;
          load[from] -= m; load[p] += m; const c = cost(); load[from] += m; load[p] -= m;
          if (c < base - 1 && (!best || c < best.c)) best = { u, p, c, m, from };
        }
      }
      // exchanges: two jobs trade owners when no single move helps
      for (let i = 0; !best && i < units.length; i++) for (let j = i + 1; j < units.length; j++) {
        const u = units[i], v = units[j], a = u.tiles[0].person, b = v.tiles[0].person;
        if (a === b || !movers.includes(a) || !movers.includes(b) || !u.ok(b) || !v.ok(a)) continue;
        const mu = unitMin(u), mv = unitMin(v); if (mu === mv) continue;
        load[a] += mv - mu; load[b] += mu - mv; const c = cost(); load[a] -= mv - mu; load[b] -= mu - mv;
        if (c < base - 1 && (!best || c < best.c)) best = { swap: true, u, v, a, b, mu, mv, c };
      }
      if (!best) break;
      if (best.swap) {
        for (const x of best.u.tiles) x.person = best.b; for (const x of best.v.tiles) x.person = best.a;
        load[best.a] += best.mv - best.mu; load[best.b] += best.mu - best.mv;
        moves.push(best.u.tiles[0].label + " ⇄ " + best.v.tiles[0].label + ": " + best.a + " / " + best.b); continue;
      }
      for (const x of best.u.tiles) x.person = best.p;
      load[best.from] -= best.m; load[best.p] += best.m;
      moves.push(best.u.tiles[0].label + ": " + best.from + " → " + best.p);
    }
    const T = target(), tgt = {}; for (const p of movers) tgt[p] = Math.round(T[p]);
    return { planned: load, target: tgt, moves };
  }

  // ---------- state of a tile on a given day ----------
  // done: {assignmentId: completion} ; overrides: {assignmentId: person}
  function tileState(a, today, done, now) {
    if (done && done[a.id]) return "done";
    if (done && done[a.id + ":skip"]) return "cancelled"; // cancelled for the day by Mama
    if (a.unassigned && !(done && done[a.id + ":override"])) return "unassigned";
    if (a.optional && done && done[a.id + ":pass"]) return "passed";
    if (a.due && a.due < today) return a.optional ? "missed" : "overdue";
    if (a.dependsOn && !(done && (done[a.dependsOn] || done[a.dependsOn + ":skip"]))) return "locked";
    if (a.date && a.date > today) return "future";
    if (!a.date && a.window === "wknd" && dow(today) !== "Sat" && dow(today) !== "Sun") return "future";
    return "pending";
  }

  // ---------- swaps ----------
  function swapValid(rules, give, take) {
    if (!give.length || !take.length) return "empty";
    if (give.length > rules.swap.maxBundle || take.length > rules.swap.maxBundle) return "bundle too big";
    const sum = (xs) => xs.reduce((s, a) => s + (a.minutes || 0), 0);
    if (Math.abs(sum(give) - sum(take)) > rules.swap.tolerance) return "sizes differ by more than " + rules.swap.tolerance + " min";
    const av = (xs) => xs.filter(a => a.aversion).length;
    if (av(give) !== av(take)) return "aversion count must match";
    const wk = new Set([...give, ...take].map(a => a.week));
    if (wk.size > 1) return "same week only";
    return null;
  }

  function qualifies(rules, p, a) {
    const c = a.chore;
    if (c === "bathLight" || c === "deepBath") return rules.kids.includes(p);
    if (c === "finisher") return rules.qual.finisher.includes(p);
    if (c === "wash" || c === "deliver") return rules.qual.wash.includes(p);
    if (c === "fold") return rules.qual.fold.includes(p);
    if (c === "ensuite") return p === "Mama" || p === "Tata";
    if (c === "shop" || c === "costco" || c === "plants") return p === "Tata";
    if (c === "souschef") return rules.qual.sousChef.includes(p);
    return true;
  }
  root.VatraEngine = { qualifies, DAYS, ymd, parse, addDays, dow, mondayOf, weekIndex, ledger, generateWeek, applyStd, minutesOf, plannedMinutes, tileState, swapValid, hash };
})(typeof window !== "undefined" ? window : module.exports);
