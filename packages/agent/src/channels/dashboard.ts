import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { db } from "@hermes/shared/db";
import { env } from "@hermes/shared/env";
import { ingest } from "../pipeline/ingest.js";
import { runQuery } from "../pipeline/query.js";
import { previewAndSave, generateSubagent, saveSubagent, SubagentSpec } from "../lib/agent-generator.js";
import { transcribeWithVoxtral } from "../lib/voxtral.js";

export const dashboard = new Hono();

const COOKIE = "hermes_session";

function dashboardPassword(): string {
  return env.DASHBOARD_PASSWORD || env.INTERNAL_API_KEY;
}

function requireAuth(c: import("hono").Context): boolean {
  const expected = dashboardPassword();
  return expected.length > 0 && getCookie(c, COOKIE) === expected;
}

const LOGIN_HTML = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Hermes</title></head>
<body style="font-family:system-ui;padding:40px;background:#0a0a0a;color:#eee;min-height:100vh">
  <h2 style="margin:0 0 24px">Hermes</h2>
  <form method="POST" action="/login" style="display:flex;gap:8px;max-width:420px">
    <input name="key" type="password" autofocus required placeholder="access key"
      style="flex:1;background:#222;color:#eee;border:1px solid #444;padding:10px;border-radius:6px"/>
    <button style="background:#7c3aed;border:none;color:white;padding:10px 16px;border-radius:6px;cursor:pointer">Sign in</button>
  </form>
</body></html>`;

dashboard.get("/login", (c) => c.html(LOGIN_HTML));

dashboard.post("/login", async (c) => {
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const key = typeof form.key === "string" ? form.key : "";
  const expected = dashboardPassword();
  if (!expected || key !== expected) {
    return c.html(LOGIN_HTML.replace("</form>", "</form><p style='color:#f87171;margin-top:16px'>Invalid password</p>"), 401);
  }
  setCookie(c, COOKIE, key, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: 60 * 60 * 24 * 365,
    path: "/",
  });
  return c.redirect("/");
});

dashboard.get("/logout", (c) => {
  setCookie(c, COOKIE, "", { httpOnly: true, secure: true, sameSite: "Lax", maxAge: 0, path: "/" });
  return c.redirect("/login");
});

dashboard.use("/api/*", async (c, next) => {
  if (!requireAuth(c)) return c.json({ error: "unauthorized" }, 401);
  await next();
});

dashboard.use("/", async (c, next) => {
  if (!requireAuth(c)) return c.redirect("/login");
  await next();
});

dashboard.get("/api/state", async (c) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - 14);
  const end = new Date(today);
  end.setDate(end.getDate() + 60);

  const [events, bills, reminders, tasks, shopping, notes] = await Promise.all([
    db.event.findMany({ where: { startsAt: { gte: start, lt: end } }, orderBy: { startsAt: "asc" } }),
    db.bill.findMany({ where: { paid: false }, orderBy: { dueDate: "asc" } }),
    db.reminder.findMany({ where: { done: false }, orderBy: { remindAt: "asc" } }),
    db.task.findMany({ where: { done: false }, orderBy: { createdAt: "desc" }, take: 30 }),
    db.shoppingItem.findMany({ where: { bought: false }, orderBy: { createdAt: "desc" } }),
    db.note.findMany({ orderBy: { createdAt: "desc" }, take: 20 }),
  ]);
  return c.json({ events, bills, reminders, tasks, shopping, notes });
});

dashboard.post("/api/capture", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { text?: string } | null;
  if (!body?.text) return c.json({ error: "text required" }, 400);
  const replies: string[] = [];
  const result = await ingest({
    channel: "pwa",
    inputType: "text",
    rawContent: body.text,
    reply: async (t) => {
      replies.push(t);
    },
  });
  return c.json({ ...result, reply: replies.join("\n") });
});

dashboard.post("/api/capture/audio", async (c) => {
  const form = await c.req.parseBody().catch(() => null);
  const file = form?.file;
  if (!file || typeof file === "string" || !(file instanceof File)) {
    return c.json({ error: "file required" }, 400);
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  const text = await transcribeWithVoxtral({
    buffer,
    filename: file.name || "recording.webm",
    mimeType: file.type || "audio/webm",
    language: "en",
  });
  if (!text.trim()) return c.json({ error: "empty transcript" }, 400);
  const replies: string[] = [];
  const result = await ingest({
    channel: "pwa",
    inputType: "voice",
    rawContent: text,
    reply: async (t) => {
      replies.push(t);
    },
  });
  return c.json({ ...result, transcript: text, reply: replies.join("\n") });
});

dashboard.post("/api/query", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { question?: string } | null;
  if (!body?.question) return c.json({ error: "question required" }, 400);
  const answer = await runQuery(body.question);
  return c.json({ answer });
});

dashboard.post("/api/shopping/:id/buy", async (c) => {
  const id = c.req.param("id");
  await db.shoppingItem.update({ where: { id }, data: { bought: true, boughtAt: new Date() } });
  return c.json({ ok: true });
});

dashboard.post("/api/task/:id/done", async (c) => {
  const id = c.req.param("id");
  await db.task.update({ where: { id }, data: { done: true, doneAt: new Date() } });
  return c.json({ ok: true });
});

dashboard.get("/api/subagents", async (c) => {
  const list = await db.subagent.findMany({ orderBy: { name: "asc" } });
  return c.json(list);
});

dashboard.post("/api/subagents/generate", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { description?: string; save?: boolean } | null;
  if (!body?.description) return c.json({ error: "description required" }, 400);
  try {
    if (body.save === false) {
      const spec = await generateSubagent(body.description);
      return c.json({ spec, saved: false });
    }
    const saved = await previewAndSave(body.description);
    return c.json({ spec: saved, saved: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

dashboard.post("/api/subagents", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = SubagentSpec.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid spec", details: parsed.error.flatten() }, 400);
  const saved = await saveSubagent(parsed.data, "manual");
  return c.json(saved);
});

dashboard.patch("/api/subagents/:id", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { enabled?: boolean };
  const updated = await db.subagent.update({ where: { id }, data: { enabled: body.enabled } });
  return c.json(updated);
});

dashboard.delete("/api/subagents/:id", async (c) => {
  const id = c.req.param("id");
  await db.subagent.delete({ where: { id } });
  return c.json({ ok: true });
});

dashboard.get("/api/drafts", async (c) => {
  const list = await db.emailDraft.findMany({
    where: { status: "pending" },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return c.json(list);
});

dashboard.post("/api/draft/:id/discard", async (c) => {
  const id = c.req.param("id");
  await db.emailDraft.update({ where: { id }, data: { status: "discarded" } });
  return c.json({ ok: true });
});

dashboard.post("/api/draft/:id/approve", async (c) => {
  const id = c.req.param("id");
  await db.emailDraft.update({ where: { id }, data: { status: "approved", approvedAt: new Date() } });
  return c.json({ ok: true, note: "Approved. Sending requires Gmail OAuth (see GOOGLE_OAUTH_SETUP.md)." });
});

dashboard.post("/api/bill/:id/paid", async (c) => {
  const id = c.req.param("id");
  await db.bill.update({ where: { id }, data: { paid: true, paidAt: new Date() } });
  return c.json({ ok: true });
});

dashboard.get("/", (c) => c.html(HTML));

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Hermes</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<script src="https://cdn.tailwindcss.com"></script>
<style>
  body { font-family: 'Inter', system-ui, sans-serif; }
  .dot { width: 6px; height: 6px; border-radius: 9999px; display: inline-block; }
  .day-cell { min-height: 84px; }
  .day-cell:hover { background: rgba(124,58,237,0.08); }
  .day-cell.selected { outline: 2px solid #a78bfa; }
  .day-cell.today .num { background: #7c3aed; color: white; border-radius: 9999px; padding: 2px 8px; }
  .pill { font-size: 10px; padding: 2px 6px; border-radius: 4px; display: inline-block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .recording { animation: pulse 1.2s infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
</style>
</head>
<body class="bg-zinc-950 text-zinc-100 min-h-screen">
<div class="flex">
  <aside class="w-56 border-r border-zinc-800 min-h-screen p-5 sticky top-0 self-start">
    <div class="text-xl font-bold mb-1">Hermes</div>
    <div class="text-xs text-zinc-500 mb-8">your second brain</div>
    <nav class="flex flex-col gap-1 text-sm">
      <a href="#calendar" class="px-3 py-2 rounded hover:bg-zinc-800">📅 Calendar</a>
      <a href="#today" class="px-3 py-2 rounded hover:bg-zinc-800">☀️ Today</a>
      <a href="#bills" class="px-3 py-2 rounded hover:bg-zinc-800">💷 Bills</a>
      <a href="#tasks" class="px-3 py-2 rounded hover:bg-zinc-800">✅ Tasks</a>
      <a href="#reminders" class="px-3 py-2 rounded hover:bg-zinc-800">⏰ Reminders</a>
      <a href="#shopping" class="px-3 py-2 rounded hover:bg-zinc-800">🛒 Shopping</a>
      <a href="#drafts" class="px-3 py-2 rounded hover:bg-zinc-800">✉️ Drafts</a>
      <a href="#notes" class="px-3 py-2 rounded hover:bg-zinc-800">📝 Notes</a>
      <a href="#agents" class="px-3 py-2 rounded hover:bg-zinc-800">🤖 Agents</a>
    </nav>
    <div class="mt-10 text-xs text-zinc-500">
      <a href="/oauth/google/start" class="hover:text-violet-400">Google OAuth →</a><br/>
      <a href="/logout" class="hover:text-violet-400">Logout</a>
    </div>
  </aside>

  <main class="flex-1 p-8 max-w-6xl">
    <header class="mb-8">
      <h1 id="greeting" class="text-3xl font-bold mb-1">Hello.</h1>
      <p class="text-zinc-400 text-sm" id="dateline"></p>
    </header>

    <section class="grid grid-cols-3 gap-4 mb-8">
      <div class="bg-zinc-900 border border-zinc-800 rounded-xl p-4"><div class="text-xs text-zinc-500">Today</div><div class="text-2xl font-semibold mt-1" id="stat-today">—</div></div>
      <div class="bg-zinc-900 border border-zinc-800 rounded-xl p-4"><div class="text-xs text-zinc-500">Bills due</div><div class="text-2xl font-semibold mt-1" id="stat-bills">—</div></div>
      <div class="bg-zinc-900 border border-zinc-800 rounded-xl p-4"><div class="text-xs text-zinc-500">Open tasks</div><div class="text-2xl font-semibold mt-1" id="stat-tasks">—</div></div>
    </section>

    <section class="bg-zinc-900 border border-zinc-800 rounded-xl p-5 mb-8">
      <form id="capture-form" class="flex gap-2">
        <input id="capture-text" placeholder="capture anything — bills, events, notes, tasks..." class="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-4 py-3 outline-none focus:border-violet-500"/>
        <button type="button" id="mic-btn" class="bg-zinc-800 hover:bg-zinc-700 px-4 rounded-lg" title="Hold to record (or press space)">🎙</button>
        <button class="bg-violet-600 hover:bg-violet-500 px-5 rounded-lg font-medium">Capture</button>
      </form>
      <div id="capture-out" class="text-sm text-zinc-400 mt-3 hidden"></div>
    </section>

    <section id="calendar" class="bg-zinc-900 border border-zinc-800 rounded-xl p-5 mb-8">
      <div class="flex items-center justify-between mb-4">
        <div class="flex items-center gap-3">
          <button id="cal-prev" class="bg-zinc-800 hover:bg-zinc-700 w-8 h-8 rounded">‹</button>
          <h2 id="cal-title" class="text-lg font-semibold"></h2>
          <button id="cal-next" class="bg-zinc-800 hover:bg-zinc-700 w-8 h-8 rounded">›</button>
          <button id="cal-today" class="text-xs text-zinc-400 hover:text-violet-400 ml-2">today</button>
        </div>
        <div class="flex gap-3 text-xs text-zinc-400">
          <span><span class="dot" style="background:#60a5fa"></span> event</span>
          <span><span class="dot" style="background:#fb7185"></span> bill</span>
          <span><span class="dot" style="background:#fbbf24"></span> reminder</span>
          <span><span class="dot" style="background:#34d399"></span> task</span>
        </div>
      </div>
      <div class="grid grid-cols-7 gap-px text-[10px] uppercase text-zinc-500 mb-1 px-1">
        <div>Mon</div><div>Tue</div><div>Wed</div><div>Thu</div><div>Fri</div><div>Sat</div><div>Sun</div>
      </div>
      <div id="cal-grid" class="grid grid-cols-7 gap-px bg-zinc-800 rounded overflow-hidden"></div>
      <div id="day-detail" class="mt-5 hidden">
        <h3 id="day-title" class="text-sm font-semibold text-zinc-300 mb-3"></h3>
        <div id="day-items" class="space-y-2"></div>
      </div>
    </section>

    <section id="today" class="bg-zinc-900 border border-zinc-800 rounded-xl p-5 mb-6">
      <h2 class="text-lg font-semibold mb-3">Today</h2>
      <div id="today-list" class="space-y-2 text-sm"></div>
    </section>

    <div class="grid grid-cols-2 gap-6 mb-6">
      <section id="bills" class="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
        <h2 class="text-lg font-semibold mb-3">💷 Bills</h2>
        <div id="bills-list" class="space-y-2 text-sm"></div>
      </section>
      <section id="tasks" class="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
        <h2 class="text-lg font-semibold mb-3">✅ Tasks</h2>
        <div id="tasks-list" class="space-y-2 text-sm"></div>
      </section>
      <section id="reminders" class="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
        <h2 class="text-lg font-semibold mb-3">⏰ Reminders</h2>
        <div id="reminders-list" class="space-y-2 text-sm"></div>
      </section>
      <section id="shopping" class="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
        <h2 class="text-lg font-semibold mb-3">🛒 Shopping</h2>
        <div id="shopping-list" class="space-y-2 text-sm"></div>
      </section>
    </div>

    <section id="drafts" class="bg-zinc-900 border border-zinc-800 rounded-xl p-5 mb-6">
      <h2 class="text-lg font-semibold mb-3">✉️ Email drafts</h2>
      <div id="drafts-list" class="space-y-3 text-sm"></div>
    </section>

    <section id="notes" class="bg-zinc-900 border border-zinc-800 rounded-xl p-5 mb-6">
      <h2 class="text-lg font-semibold mb-3">📝 Notes</h2>
      <div id="notes-list" class="space-y-2 text-sm"></div>
    </section>

    <section id="agents" class="bg-zinc-900 border border-zinc-800 rounded-xl p-5 mb-12">
      <h2 class="text-lg font-semibold mb-3">🤖 Subagents</h2>
      <form id="agent-form" class="flex gap-2 mb-4">
        <input id="agent-desc" placeholder="describe a new subagent..." class="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 outline-none focus:border-violet-500"/>
        <button class="bg-violet-600 hover:bg-violet-500 px-4 rounded-lg font-medium">Generate</button>
      </form>
      <div id="agents-list" class="space-y-2 text-sm"></div>
    </section>
  </main>
</div>

<script>
const $ = (s) => document.querySelector(s);
const COLORS = { event: '#60a5fa', bill: '#fb7185', reminder: '#fbbf24', task: '#34d399' };
let STATE = { events: [], bills: [], reminders: [], tasks: [], shopping: [], notes: [] };
let viewYear, viewMonth, selectedKey = null;

function fmtDate(d) { return new Date(d).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' }); }
function fmtTime(d) { return new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }
function dateKey(d) { const x = new Date(d); return x.getFullYear() + '-' + String(x.getMonth()+1).padStart(2,'0') + '-' + String(x.getDate()).padStart(2,'0'); }
function escapeHtml(s) { return String(s||'').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }

function bucketByDate() {
  const map = {};
  const push = (k, item) => { (map[dateKey(item.when)] = map[dateKey(item.when)] || []).push({ ...item, kind: k }); };
  STATE.events.forEach(e => push('event', { id: e.id, when: e.startsAt, title: e.title, location: e.location }));
  STATE.bills.forEach(b => push('bill', { id: b.id, when: b.dueDate, title: b.vendor + ' ' + (b.currency||'GBP') + b.amount }));
  STATE.reminders.forEach(r => push('reminder', { id: r.id, when: r.remindAt, title: r.text }));
  STATE.tasks.forEach(t => { if (t.dueAt) push('task', { id: t.id, when: t.dueAt, title: t.text }); });
  return map;
}

function renderCalendar() {
  const buckets = bucketByDate();
  const first = new Date(viewYear, viewMonth, 1);
  $('#cal-title').textContent = first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const startOffset = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(viewYear, viewMonth+1, 0).getDate();
  const today = new Date(); today.setHours(0,0,0,0);
  const grid = $('#cal-grid');
  grid.innerHTML = '';
  for (let i = 0; i < 42; i++) {
    const dayNum = i - startOffset + 1;
    const cell = document.createElement('div');
    cell.className = 'day-cell bg-zinc-900 p-1.5 cursor-pointer';
    if (dayNum < 1 || dayNum > daysInMonth) { cell.style.opacity = '0.25'; grid.appendChild(cell); continue; }
    const d = new Date(viewYear, viewMonth, dayNum);
    const k = dateKey(d);
    if (d.getTime() === today.getTime()) cell.classList.add('today');
    if (k === selectedKey) cell.classList.add('selected');
    const num = document.createElement('div');
    num.className = 'num text-xs font-medium inline-block';
    num.textContent = dayNum;
    cell.appendChild(num);
    const items = buckets[k] || [];
    const wrap = document.createElement('div');
    wrap.className = 'mt-1 space-y-0.5';
    items.slice(0,3).forEach(it => {
      const p = document.createElement('div');
      p.className = 'pill';
      p.style.background = COLORS[it.kind] + '22';
      p.style.color = COLORS[it.kind];
      p.textContent = it.title;
      wrap.appendChild(p);
    });
    if (items.length > 3) {
      const more = document.createElement('div');
      more.className = 'text-[10px] text-zinc-500';
      more.textContent = '+' + (items.length - 3) + ' more';
      wrap.appendChild(more);
    }
    cell.appendChild(wrap);
    cell.addEventListener('click', () => { selectedKey = k; renderCalendar(); renderDayDetail(); });
    grid.appendChild(cell);
  }
}

function renderDayDetail() {
  const panel = $('#day-detail');
  if (!selectedKey) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  const buckets = bucketByDate();
  const items = buckets[selectedKey] || [];
  const d = new Date(selectedKey + 'T00:00:00');
  $('#day-title').textContent = d.toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'long' }) + ' — ' + items.length + ' item' + (items.length===1?'':'s');
  const wrap = $('#day-items');
  wrap.innerHTML = '';
  if (!items.length) { wrap.innerHTML = '<div class="text-xs text-zinc-500">Nothing scheduled.</div>'; return; }
  items.sort((a,b) => new Date(a.when) - new Date(b.when)).forEach(it => {
    const row = document.createElement('div');
    row.className = 'flex items-center gap-3 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2';
    row.innerHTML = '<span class="dot" style="background:' + COLORS[it.kind] + '"></span>' +
      '<span class="text-xs text-zinc-500 w-12">' + fmtTime(it.when) + '</span>' +
      '<span class="flex-1">' + escapeHtml(it.title) + '</span>' +
      '<span class="text-[10px] uppercase text-zinc-500">' + it.kind + '</span>';
    wrap.appendChild(row);
  });
}

function renderLists() {
  const today = new Date(); today.setHours(0,0,0,0);
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate()+1);
  const todayItems = [];
  STATE.events.forEach(e => { const d = new Date(e.startsAt); if (d>=today && d<tomorrow) todayItems.push({ icon:'📅', t: fmtTime(e.startsAt) + ' ' + e.title }); });
  STATE.reminders.forEach(r => { const d = new Date(r.remindAt); if (d>=today && d<tomorrow) todayItems.push({ icon:'⏰', t: fmtTime(r.remindAt) + ' ' + r.text }); });
  $('#stat-today').textContent = todayItems.length;
  $('#stat-bills').textContent = STATE.bills.length;
  $('#stat-tasks').textContent = STATE.tasks.length;
  $('#today-list').innerHTML = todayItems.length
    ? todayItems.map(i => '<div class="flex gap-2"><span>' + i.icon + '</span><span>' + escapeHtml(i.t) + '</span></div>').join('')
    : '<div class="text-zinc-500 text-xs">Nothing today. ✨</div>';

  $('#bills-list').innerHTML = STATE.bills.length ? STATE.bills.map(b =>
    '<div class="flex justify-between items-center bg-zinc-950 border border-zinc-800 rounded px-3 py-2">' +
    '<div><div>' + escapeHtml(b.vendor) + ' <span class="text-zinc-500">' + (b.currency||'GBP') + b.amount + '</span></div>' +
    '<div class="text-xs text-zinc-500">due ' + fmtDate(b.dueDate) + '</div></div>' +
    '<button onclick="markBillPaid(\\''+b.id+'\\')" class="text-xs bg-zinc-800 hover:bg-violet-600 px-2 py-1 rounded">paid</button></div>'
  ).join('') : '<div class="text-zinc-500 text-xs">No bills due. 💸</div>';

  $('#tasks-list').innerHTML = STATE.tasks.length ? STATE.tasks.map(t =>
    '<div class="flex justify-between items-center bg-zinc-950 border border-zinc-800 rounded px-3 py-2">' +
    '<span>' + escapeHtml(t.text) + (t.dueAt ? ' <span class="text-xs text-zinc-500">— ' + fmtDate(t.dueAt) + '</span>' : '') + '</span>' +
    '<button onclick="markTaskDone(\\''+t.id+'\\')" class="text-xs bg-zinc-800 hover:bg-violet-600 px-2 py-1 rounded">done</button></div>'
  ).join('') : '<div class="text-zinc-500 text-xs">No tasks. 🌿</div>';

  $('#reminders-list').innerHTML = STATE.reminders.length ? STATE.reminders.map(r =>
    '<div class="bg-zinc-950 border border-zinc-800 rounded px-3 py-2"><div>' + escapeHtml(r.text) + '</div>' +
    '<div class="text-xs text-zinc-500">' + fmtDate(r.remindAt) + ' ' + fmtTime(r.remindAt) + '</div></div>'
  ).join('') : '<div class="text-zinc-500 text-xs">No reminders.</div>';

  $('#shopping-list').innerHTML = STATE.shopping.length ? STATE.shopping.map(s =>
    '<div class="flex justify-between items-center bg-zinc-950 border border-zinc-800 rounded px-3 py-2">' +
    '<span>' + escapeHtml(s.item) + (s.qty ? ' × ' + s.qty : '') + '</span>' +
    '<button onclick="markShopBought(\\''+s.id+'\\')" class="text-xs bg-zinc-800 hover:bg-violet-600 px-2 py-1 rounded">got it</button></div>'
  ).join('') : '<div class="text-zinc-500 text-xs">List empty.</div>';

  $('#notes-list').innerHTML = STATE.notes.length ? STATE.notes.map(n =>
    '<div class="bg-zinc-950 border border-zinc-800 rounded px-3 py-2"><div>' + escapeHtml(n.body || n.title || '') + '</div>' +
    '<div class="text-xs text-zinc-500 mt-1">' + new Date(n.createdAt).toLocaleString('en-GB') + '</div></div>'
  ).join('') : '<div class="text-zinc-500 text-xs">No notes yet.</div>';
}

async function loadState() {
  const r = await fetch('/api/state');
  STATE = await r.json();
  renderCalendar(); renderLists();
  if (selectedKey) renderDayDetail();
}

async function loadDrafts() {
  const r = await fetch('/api/drafts');
  const list = await r.json();
  $('#drafts-list').innerHTML = list.length ? list.map(d =>
    '<div class="bg-zinc-950 border border-zinc-800 rounded p-3">' +
    '<div class="text-xs text-zinc-500">to ' + escapeHtml(d.to||'') + '</div>' +
    '<div class="font-medium">' + escapeHtml(d.subject||'') + '</div>' +
    '<pre class="whitespace-pre-wrap text-xs mt-2 text-zinc-300">' + escapeHtml(d.body||'') + '</pre>' +
    '<div class="flex gap-2 mt-2">' +
    '<button onclick="approveDraft(\\''+d.id+'\\')" class="text-xs bg-violet-600 hover:bg-violet-500 px-3 py-1 rounded">approve</button>' +
    '<button onclick="discardDraft(\\''+d.id+'\\')" class="text-xs bg-zinc-800 hover:bg-zinc-700 px-3 py-1 rounded">discard</button>' +
    '</div></div>'
  ).join('') : '<div class="text-zinc-500 text-xs">No pending drafts.</div>';
}

async function loadAgents() {
  const r = await fetch('/api/subagents');
  const list = await r.json();
  $('#agents-list').innerHTML = list.length ? list.map(a =>
    '<div class="flex justify-between items-center bg-zinc-950 border border-zinc-800 rounded px-3 py-2">' +
    '<div><div class="font-medium">' + escapeHtml(a.name) + '</div>' +
    '<div class="text-xs text-zinc-500">' + escapeHtml(a.description||'') + '</div></div>' +
    '<span class="text-xs ' + (a.enabled?'text-emerald-400':'text-zinc-500') + '">' + (a.enabled?'enabled':'disabled') + '</span></div>'
  ).join('') : '<div class="text-zinc-500 text-xs">No subagents yet.</div>';
}

window.markBillPaid = async (id) => { await fetch('/api/bill/'+id+'/paid', { method:'POST' }); loadState(); };
window.markTaskDone = async (id) => { await fetch('/api/task/'+id+'/done', { method:'POST' }); loadState(); };
window.markShopBought = async (id) => { await fetch('/api/shopping/'+id+'/buy', { method:'POST' }); loadState(); };
window.approveDraft = async (id) => { await fetch('/api/draft/'+id+'/approve', { method:'POST' }); loadDrafts(); };
window.discardDraft = async (id) => { await fetch('/api/draft/'+id+'/discard', { method:'POST' }); loadDrafts(); };

$('#capture-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('#capture-text').value.trim();
  if (!text) return;
  const out = $('#capture-out'); out.classList.remove('hidden'); out.textContent = '⏳ thinking...';
  const r = await fetch('/api/capture', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ text }) });
  const j = await r.json();
  out.textContent = j.reply || j.error || 'done.';
  $('#capture-text').value = '';
  loadState();
});

$('#agent-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const desc = $('#agent-desc').value.trim();
  if (!desc) return;
  await fetch('/api/subagents/generate', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ description: desc }) });
  $('#agent-desc').value = '';
  loadAgents();
});

$('#cal-prev').onclick = () => { viewMonth--; if (viewMonth<0) { viewMonth=11; viewYear--; } renderCalendar(); };
$('#cal-next').onclick = () => { viewMonth++; if (viewMonth>11) { viewMonth=0; viewYear++; } renderCalendar(); };
$('#cal-today').onclick = () => { const n = new Date(); viewYear=n.getFullYear(); viewMonth=n.getMonth(); selectedKey=dateKey(n); renderCalendar(); renderDayDetail(); };

let mediaRec, chunks = [];
async function startRec() {
  if (mediaRec && mediaRec.state === 'recording') return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRec = new MediaRecorder(stream);
    chunks = [];
    mediaRec.ondataavailable = (e) => chunks.push(e.data);
    mediaRec.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(chunks, { type: 'audio/webm' });
      const fd = new FormData();
      fd.append('file', blob, 'recording.webm');
      const out = $('#capture-out'); out.classList.remove('hidden'); out.textContent = '⏳ transcribing...';
      const r = await fetch('/api/capture/audio', { method:'POST', body: fd });
      const j = await r.json();
      out.textContent = (j.transcript ? '🎙 "' + j.transcript + '" → ' : '') + (j.reply || j.error || 'done.');
      loadState();
    };
    mediaRec.start();
    $('#mic-btn').classList.add('recording','bg-rose-600');
  } catch (e) { alert('Mic access denied.'); }
}
function stopRec() {
  if (mediaRec && mediaRec.state === 'recording') mediaRec.stop();
  $('#mic-btn').classList.remove('recording','bg-rose-600');
}
$('#mic-btn').addEventListener('mousedown', startRec);
$('#mic-btn').addEventListener('mouseup', stopRec);
$('#mic-btn').addEventListener('touchstart', (e) => { e.preventDefault(); startRec(); });
$('#mic-btn').addEventListener('touchend', (e) => { e.preventDefault(); stopRec(); });
window.addEventListener('keydown', (e) => { if (e.code === 'Space' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') { e.preventDefault(); startRec(); } });
window.addEventListener('keyup', (e) => { if (e.code === 'Space') stopRec(); });

(function init() {
  const n = new Date();
  viewYear = n.getFullYear(); viewMonth = n.getMonth();
  selectedKey = dateKey(n);
  const h = n.getHours();
  const greet = h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  $('#greeting').textContent = greet + ', Sanyam.';
  $('#dateline').textContent = n.toLocaleDateString('en-GB', { weekday:'long', day:'2-digit', month:'long', year:'numeric' });
  loadState(); loadDrafts(); loadAgents();
  setInterval(loadState, 30000);
})();
</script>
</body></html>`;
