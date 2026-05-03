import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { db } from "@hermes/shared/db";
import { env } from "@hermes/shared/env";
import { ingest } from "../pipeline/ingest.js";
import { runQuery } from "../pipeline/query.js";

export const dashboard = new Hono();

const COOKIE = "hermes_session";

function requireAuth(c: import("hono").Context): boolean {
  return getCookie(c, COOKIE) === env.INTERNAL_API_KEY && env.INTERNAL_API_KEY.length > 0;
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
  if (!env.INTERNAL_API_KEY || key !== env.INTERNAL_API_KEY) {
    return c.html(LOGIN_HTML.replace("</form>", "</form><p style='color:#f87171;margin-top:16px'>Invalid key</p>"), 401);
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
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const weekEnd = new Date(start);
  weekEnd.setDate(weekEnd.getDate() + 7);

  const [events, bills, reminders, tasks, shopping, notes] = await Promise.all([
    db.event.findMany({ where: { startsAt: { gte: start, lt: weekEnd } }, orderBy: { startsAt: "asc" } }),
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

dashboard.post("/api/bill/:id/paid", async (c) => {
  const id = c.req.param("id");
  await db.bill.update({ where: { id }, data: { paid: true, paidAt: new Date() } });
  return c.json({ ok: true });
});

dashboard.get("/", (c) => c.html(HTML));

const HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Hermes</title>
<script src="https://cdn.tailwindcss.com"></script>
</head><body class="bg-zinc-950 text-zinc-100 min-h-screen">
<div class="max-w-3xl mx-auto p-4 space-y-4">
  <header class="flex items-center justify-between">
    <h1 class="text-2xl font-semibold">Hermes</h1>
    <span id="status" class="text-xs text-zinc-500">loading…</span>
  </header>

  <section class="bg-zinc-900 rounded-2xl p-3 space-y-2">
    <form id="capture" class="flex gap-2">
      <input id="capture-text" class="flex-1 bg-zinc-800 rounded-lg px-3 py-2 outline-none focus:ring-1 focus:ring-violet-500" placeholder="Capture or ask Hermes…" autofocus/>
      <button class="bg-violet-600 hover:bg-violet-500 px-3 rounded-lg font-medium">Send</button>
      <button id="ask-btn" type="button" class="bg-zinc-700 hover:bg-zinc-600 px-3 rounded-lg">Ask</button>
    </form>
    <pre id="reply" class="text-sm text-zinc-300 whitespace-pre-wrap"></pre>
  </section>

  <section id="today" class="bg-zinc-900 rounded-2xl p-4">
    <h2 class="font-semibold mb-2 flex items-center gap-2">📅 Today & week</h2>
    <ul id="events-list" class="text-sm space-y-1"></ul>
  </section>

  <section class="bg-zinc-900 rounded-2xl p-4">
    <h2 class="font-semibold mb-2">⏰ Reminders</h2>
    <ul id="reminders-list" class="text-sm space-y-1"></ul>
  </section>

  <section class="bg-zinc-900 rounded-2xl p-4">
    <h2 class="font-semibold mb-2">💷 Bills</h2>
    <ul id="bills-list" class="text-sm space-y-1"></ul>
  </section>

  <section class="bg-zinc-900 rounded-2xl p-4">
    <h2 class="font-semibold mb-2">✅ Tasks</h2>
    <ul id="tasks-list" class="text-sm space-y-1"></ul>
  </section>

  <section class="bg-zinc-900 rounded-2xl p-4">
    <h2 class="font-semibold mb-2">🛒 Shopping</h2>
    <ul id="shopping-list" class="text-sm space-y-1"></ul>
  </section>

  <section class="bg-zinc-900 rounded-2xl p-4">
    <h2 class="font-semibold mb-2">📝 Recent notes</h2>
    <ul id="notes-list" class="text-sm space-y-2"></ul>
  </section>
</div>

<script>
const fmtDT = (s) => new Date(s).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" });
const fmtD = (s) => new Date(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
const J = (m, u, b) => fetch(u, { method: m, headers: { "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined }).then(r => r.json());

async function load() {
  const s = await J("GET", "/api/state");
  document.getElementById("status").textContent = "online";
  document.getElementById("events-list").innerHTML = s.events.length
    ? s.events.map(e => \`<li>\${fmtDT(e.startsAt)} — \${e.title}\${e.location ? " @ " + e.location : ""}</li>\`).join("")
    : "<li class='text-zinc-500'>nothing scheduled</li>";
  document.getElementById("reminders-list").innerHTML = s.reminders.length
    ? s.reminders.map(r => \`<li>\${fmtDT(r.remindAt)} — \${r.text}</li>\`).join("")
    : "<li class='text-zinc-500'>none</li>";
  document.getElementById("bills-list").innerHTML = s.bills.length
    ? s.bills.map(b => \`<li class="flex justify-between"><span>\${b.vendor} — \${b.currency}\${b.amount} (due \${fmtD(b.dueDate)})</span><button onclick="markPaid('\${b.id}')" class="text-xs bg-emerald-700 px-2 rounded">paid</button></li>\`).join("")
    : "<li class='text-zinc-500'>none</li>";
  document.getElementById("tasks-list").innerHTML = s.tasks.length
    ? s.tasks.map(t => \`<li class="flex justify-between"><span>\${t.title}\${t.dueDate ? " (" + fmtD(t.dueDate) + ")" : ""}</span><button onclick="markDone('\${t.id}')" class="text-xs bg-emerald-700 px-2 rounded">done</button></li>\`).join("")
    : "<li class='text-zinc-500'>none</li>";
  document.getElementById("shopping-list").innerHTML = s.shopping.length
    ? s.shopping.map(i => \`<li class="flex justify-between"><span>\${i.name}\${i.qty ? " × " + i.qty : ""}</span><button onclick="markBought('\${i.id}')" class="text-xs bg-emerald-700 px-2 rounded">got</button></li>\`).join("")
    : "<li class='text-zinc-500'>nothing</li>";
  document.getElementById("notes-list").innerHTML = s.notes.length
    ? s.notes.map(n => \`<li><div class="text-zinc-500 text-xs">\${fmtD(n.createdAt)}</div>\${n.content}</li>\`).join("")
    : "<li class='text-zinc-500'>none</li>";
}
window.markBought = async (id) => { await J("POST", "/api/shopping/" + id + "/buy"); load(); };
window.markDone = async (id) => { await J("POST", "/api/task/" + id + "/done"); load(); };
window.markPaid = async (id) => { await J("POST", "/api/bill/" + id + "/paid"); load(); };

document.getElementById("capture").addEventListener("submit", async (e) => {
  e.preventDefault();
  const t = document.getElementById("capture-text");
  if (!t.value.trim()) return;
  const r = await J("POST", "/api/capture", { text: t.value });
  document.getElementById("reply").textContent = r.reply || JSON.stringify(r, null, 2);
  t.value = "";
  load();
});
document.getElementById("ask-btn").addEventListener("click", async () => {
  const t = document.getElementById("capture-text");
  if (!t.value.trim()) return;
  document.getElementById("reply").textContent = "thinking…";
  const r = await J("POST", "/api/query", { question: t.value });
  document.getElementById("reply").textContent = r.answer || JSON.stringify(r);
});

load();
setInterval(load, 30000);
</script>
</body></html>`;
