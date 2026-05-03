import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { db } from "@hermes/shared/db";
import { env } from "@hermes/shared/env";
import { ingest } from "../pipeline/ingest.js";
import { runQuery } from "../pipeline/query.js";
import { previewAndSave, generateSubagent, saveSubagent, SubagentSpec } from "../lib/agent-generator.js";

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
  // TODO: when Gmail OAuth is set, send the email via gmail.users.messages.send and mark sent
  return c.json({ ok: true, note: "Approved. Sending requires Gmail OAuth (see GOOGLE_OAUTH_SETUP.md)." });
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
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<script src="https://cdn.tailwindcss.com"></script>
<style>
  body { font-family: "Inter", system-ui, -apple-system, sans-serif; }
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #27272a; border-radius: 4px; }
  ::-webkit-scrollbar-thumb:hover { background: #3f3f46; }
  .nav-item.active { background: linear-gradient(90deg, rgba(124,58,237,0.18), transparent); border-left: 2px solid #a78bfa; color: #f4f4f5; }
  .nav-item { border-left: 2px solid transparent; }
  .hero-grad { background: radial-gradient(circle at 0% 0%, rgba(124,58,237,0.18), transparent 60%), radial-gradient(circle at 100% 100%, rgba(56,189,248,0.10), transparent 60%); }
  .pulse-dot { animation: p 2s infinite; }
  @keyframes p { 0%,100% { opacity: 1 } 50% { opacity: 0.4 } }
</style>
</head><body class="bg-zinc-950 text-zinc-100 min-h-screen antialiased">
<div class="flex min-h-screen">
  <!-- SIDEBAR -->
  <aside class="hidden md:flex w-60 shrink-0 flex-col border-r border-zinc-900 bg-zinc-950/80 backdrop-blur sticky top-0 h-screen">
    <div class="px-5 py-5 border-b border-zinc-900">
      <div class="flex items-center gap-2">
        <div class="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-600 grid place-items-center font-bold">H</div>
        <div>
          <div class="font-semibold leading-tight">Hermes</div>
          <div class="text-[11px] text-zinc-500 leading-tight">personal assistant</div>
        </div>
      </div>
    </div>
    <nav class="flex-1 py-3 text-sm">
      <a href="#today" class="nav-item flex items-center gap-3 px-5 py-2.5 hover:bg-zinc-900/60 text-zinc-400 hover:text-zinc-200">📅 <span>Today</span></a>
      <a href="#bills" class="nav-item flex items-center gap-3 px-5 py-2.5 hover:bg-zinc-900/60 text-zinc-400 hover:text-zinc-200">💷 <span>Bills</span><span id="badge-bills" class="ml-auto text-[10px] bg-zinc-800 text-zinc-400 rounded-full px-1.5 hidden"></span></a>
      <a href="#tasks" class="nav-item flex items-center gap-3 px-5 py-2.5 hover:bg-zinc-900/60 text-zinc-400 hover:text-zinc-200">✅ <span>Tasks</span><span id="badge-tasks" class="ml-auto text-[10px] bg-zinc-800 text-zinc-400 rounded-full px-1.5 hidden"></span></a>
      <a href="#reminders" class="nav-item flex items-center gap-3 px-5 py-2.5 hover:bg-zinc-900/60 text-zinc-400 hover:text-zinc-200">⏰ <span>Reminders</span><span id="badge-reminders" class="ml-auto text-[10px] bg-zinc-800 text-zinc-400 rounded-full px-1.5 hidden"></span></a>
      <a href="#shopping" class="nav-item flex items-center gap-3 px-5 py-2.5 hover:bg-zinc-900/60 text-zinc-400 hover:text-zinc-200">🛒 <span>Shopping</span><span id="badge-shopping" class="ml-auto text-[10px] bg-zinc-800 text-zinc-400 rounded-full px-1.5 hidden"></span></a>
      <a href="#notes" class="nav-item flex items-center gap-3 px-5 py-2.5 hover:bg-zinc-900/60 text-zinc-400 hover:text-zinc-200">📝 <span>Notes</span></a>
      <a href="#drafts" class="nav-item flex items-center gap-3 px-5 py-2.5 hover:bg-zinc-900/60 text-zinc-400 hover:text-zinc-200">📨 <span>Email triage</span><span id="badge-drafts" class="ml-auto text-[10px] bg-zinc-800 text-zinc-400 rounded-full px-1.5 hidden"></span></a>
      <div class="px-5 mt-4 mb-2 text-[10px] uppercase tracking-wider text-zinc-600">Intelligence</div>
      <a href="#agents" class="nav-item flex items-center gap-3 px-5 py-2.5 hover:bg-zinc-900/60 text-zinc-400 hover:text-zinc-200">🤖 <span>Agents</span></a>
      <a href="#ask" class="nav-item flex items-center gap-3 px-5 py-2.5 hover:bg-zinc-900/60 text-zinc-400 hover:text-zinc-200">💬 <span>Ask Hermes</span></a>
    </nav>
    <div class="px-5 py-4 border-t border-zinc-900 text-xs text-zinc-500 flex items-center justify-between">
      <span class="flex items-center gap-1.5"><span class="pulse-dot w-1.5 h-1.5 rounded-full bg-emerald-500"></span><span id="status">online</span></span>
      <a href="/logout" class="hover:text-zinc-300">sign out</a>
    </div>
  </aside>

  <!-- MAIN -->
  <main class="flex-1 min-w-0">
    <div class="max-w-4xl mx-auto px-4 md:px-8 py-6 md:py-10 space-y-6">
      <!-- HERO -->
      <section class="hero-grad rounded-3xl border border-zinc-900 p-6 md:p-8">
        <div class="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div class="text-xs uppercase tracking-wider text-violet-300/70 mb-1" id="hero-date">—</div>
            <h1 class="text-2xl md:text-3xl font-semibold" id="hero-greeting">Hermes</h1>
            <p class="text-sm text-zinc-400 mt-1" id="hero-summary">loading your day…</p>
          </div>
          <div class="flex gap-2 text-xs">
            <div class="bg-zinc-900/60 border border-zinc-800 rounded-xl px-3 py-2"><div class="text-zinc-500">today</div><div class="text-lg font-semibold" id="stat-events">0</div></div>
            <div class="bg-zinc-900/60 border border-zinc-800 rounded-xl px-3 py-2"><div class="text-zinc-500">bills</div><div class="text-lg font-semibold" id="stat-bills">0</div></div>
            <div class="bg-zinc-900/60 border border-zinc-800 rounded-xl px-3 py-2"><div class="text-zinc-500">tasks</div><div class="text-lg font-semibold" id="stat-tasks">0</div></div>
          </div>
        </div>
        <!-- CAPTURE BAR -->
        <form id="capture" class="mt-6 flex gap-2 items-stretch">
          <div class="relative flex-1">
            <input id="capture-text" autocomplete="off" autofocus
              class="w-full bg-zinc-900/80 border border-zinc-800 rounded-xl px-4 py-3 pr-12 text-base outline-none focus:border-violet-500 focus:ring-1 focus:ring-violet-500"
              placeholder="Capture anything — or type a question and press Ask"/>
            <span class="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-600 text-xs hidden md:inline">⏎ to send</span>
          </div>
          <button class="bg-violet-600 hover:bg-violet-500 px-4 rounded-xl font-medium text-sm">Send</button>
          <button id="ask-btn" type="button" class="bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 px-4 rounded-xl text-sm">Ask</button>
        </form>
        <pre id="reply" class="mt-3 text-sm text-zinc-300 whitespace-pre-wrap"></pre>
      </section>

      <!-- TODAY -->
      <section id="today" class="space-y-3 scroll-mt-8">
        <h2 class="text-xs uppercase tracking-wider text-zinc-500">📅 Today & next 7 days</h2>
        <ul id="events-list" class="space-y-2"></ul>
      </section>

      <!-- BILLS -->
      <section id="bills" class="space-y-3 scroll-mt-8">
        <h2 class="text-xs uppercase tracking-wider text-zinc-500">💷 Bills</h2>
        <ul id="bills-list" class="space-y-2"></ul>
      </section>

      <!-- TASKS -->
      <section id="tasks" class="space-y-3 scroll-mt-8">
        <h2 class="text-xs uppercase tracking-wider text-zinc-500">✅ Tasks</h2>
        <ul id="tasks-list" class="space-y-2"></ul>
      </section>

      <!-- REMINDERS -->
      <section id="reminders" class="space-y-3 scroll-mt-8">
        <h2 class="text-xs uppercase tracking-wider text-zinc-500">⏰ Reminders</h2>
        <ul id="reminders-list" class="space-y-2"></ul>
      </section>

      <!-- SHOPPING -->
      <section id="shopping" class="space-y-3 scroll-mt-8">
        <h2 class="text-xs uppercase tracking-wider text-zinc-500">🛒 Shopping</h2>
        <ul id="shopping-list" class="space-y-2"></ul>
      </section>

      <!-- NOTES -->
      <section id="notes" class="space-y-3 scroll-mt-8">
        <h2 class="text-xs uppercase tracking-wider text-zinc-500">📝 Recent notes</h2>
        <ul id="notes-list" class="space-y-2"></ul>
      </section>

      <!-- DRAFTS -->
      <section id="drafts" class="space-y-3 scroll-mt-8">
        <h2 class="text-xs uppercase tracking-wider text-zinc-500">📨 Email triage</h2>
        <ul id="drafts-list" class="space-y-2"></ul>
      </section>

      <!-- AGENTS -->
      <section id="agents" class="space-y-3 scroll-mt-8">
        <div class="flex items-center justify-between">
          <h2 class="text-xs uppercase tracking-wider text-zinc-500">🤖 Specialist agents</h2>
          <button id="gen-toggle" class="text-xs bg-violet-600 hover:bg-violet-500 px-3 py-1.5 rounded-lg font-medium">+ Generate new</button>
        </div>
        <p class="text-xs text-zinc-500">Subagents Hermes can delegate to. The orchestrator routes to whichever charter cleanly fits.</p>
        <ul id="agents-list" class="space-y-2"></ul>
        <div id="gen-form" class="hidden space-y-2 pt-3 border-t border-zinc-900">
          <textarea id="gen-desc" rows="3" class="w-full bg-zinc-900/80 border border-zinc-800 rounded-xl px-4 py-3 outline-none focus:border-violet-500 focus:ring-1 focus:ring-violet-500" placeholder="Describe the new agent's purpose. E.g. 'A CESR Coach that tracks competency gaps and asks weekly progress prompts.'"></textarea>
          <div class="flex gap-2">
            <button id="gen-preview" class="bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 px-3 py-1.5 rounded-lg text-sm">Preview</button>
            <button id="gen-save" class="bg-violet-600 hover:bg-violet-500 px-3 py-1.5 rounded-lg text-sm font-medium">Generate &amp; save</button>
          </div>
          <pre id="gen-out" class="text-xs text-zinc-400 whitespace-pre-wrap bg-zinc-900/40 rounded-lg p-3 max-h-72 overflow-auto"></pre>
        </div>
      </section>

      <div id="ask" class="h-2"></div>
      <div class="text-center text-xs text-zinc-700 pt-6">Hermes • Grok 4 Fast → Gemini 3 fallback</div>
    </div>
  </main>
</div>

<script>
const fmtDT = (s) => new Date(s).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" });
const fmtD = (s) => new Date(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
const J = (m, u, b) => fetch(u, { method: m, headers: { "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined }).then(r => r.json());

const card = "bg-zinc-900/60 border border-zinc-800 rounded-xl px-4 py-3 hover:border-zinc-700 transition";
const empty = (msg) => \`<li class="text-sm text-zinc-600 py-2">\${msg}</li>\`;

function setBadge(id, n) {
  const el = document.getElementById("badge-" + id);
  if (!el) return;
  if (n > 0) { el.textContent = n; el.classList.remove("hidden"); }
  else el.classList.add("hidden");
}

function updateHero(s) {
  const now = new Date();
  const h = now.getHours();
  const part = h < 5 ? "Up late" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : h < 22 ? "Good evening" : "Late night";
  document.getElementById("hero-greeting").textContent = part + ", Sanyam";
  document.getElementById("hero-date").textContent = now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  const todayEvs = s.events.filter(e => new Date(e.startsAt) < new Date(now.getTime() + 24*60*60*1000));
  document.getElementById("stat-events").textContent = todayEvs.length;
  document.getElementById("stat-bills").textContent = s.bills.length;
  document.getElementById("stat-tasks").textContent = s.tasks.length;
  const bits = [];
  if (todayEvs.length) bits.push(\`\${todayEvs.length} event\${todayEvs.length>1?"s":""} today\`);
  if (s.bills.length) bits.push(\`\${s.bills.length} bill\${s.bills.length>1?"s":""} pending\`);
  if (s.tasks.length) bits.push(\`\${s.tasks.length} open task\${s.tasks.length>1?"s":""}\`);
  document.getElementById("hero-summary").textContent = bits.length ? bits.join(" · ") : "nothing pressing — quiet day";
}

async function load() {
  const s = await J("GET", "/api/state");
  document.getElementById("status").textContent = "online";
  updateHero(s);
  setBadge("bills", s.bills.length);
  setBadge("tasks", s.tasks.length);
  setBadge("reminders", s.reminders.length);
  setBadge("shopping", s.shopping.length);

  document.getElementById("events-list").innerHTML = s.events.length
    ? s.events.map(e => \`<li class="\${card}"><div class="flex justify-between items-baseline gap-3"><div class="font-medium">\${e.title}</div><div class="text-xs text-zinc-500 shrink-0">\${fmtDT(e.startsAt)}</div></div>\${e.location ? \`<div class="text-xs text-zinc-500 mt-0.5">📍 \${e.location}</div>\` : ""}</li>\`).join("")
    : empty("Nothing scheduled in the next 7 days.");

  document.getElementById("reminders-list").innerHTML = s.reminders.length
    ? s.reminders.map(r => \`<li class="\${card} flex justify-between items-center"><div><div>\${r.text}</div><div class="text-xs text-zinc-500 mt-0.5">\${fmtDT(r.remindAt)}</div></div></li>\`).join("")
    : empty("No active reminders.");

  document.getElementById("bills-list").innerHTML = s.bills.length
    ? s.bills.map(b => \`<li class="\${card} flex justify-between items-center"><div><div class="font-medium">\${b.vendor}</div><div class="text-xs text-zinc-500">\${b.currency}\${b.amount} · due \${fmtD(b.dueDate)}</div></div><button onclick="markPaid('\${b.id}')" class="text-xs bg-emerald-600/20 border border-emerald-700/40 text-emerald-300 hover:bg-emerald-600/30 px-3 py-1.5 rounded-lg">mark paid</button></li>\`).join("")
    : empty("All caught up — no unpaid bills.");

  document.getElementById("tasks-list").innerHTML = s.tasks.length
    ? s.tasks.map(t => \`<li class="\${card} flex justify-between items-center"><div><div>\${t.title}\${t.dueDate ? \` <span class="text-xs text-zinc-500">· \${fmtD(t.dueDate)}</span>\` : ""}</div></div><button onclick="markDone('\${t.id}')" class="text-xs bg-emerald-600/20 border border-emerald-700/40 text-emerald-300 hover:bg-emerald-600/30 px-3 py-1.5 rounded-lg">done</button></li>\`).join("")
    : empty("No open tasks.");

  document.getElementById("shopping-list").innerHTML = s.shopping.length
    ? s.shopping.map(i => \`<li class="\${card} flex justify-between items-center"><div>\${i.name}\${i.qty ? \` <span class="text-xs text-zinc-500">× \${i.qty}</span>\` : ""}</div><button onclick="markBought('\${i.id}')" class="text-xs bg-emerald-600/20 border border-emerald-700/40 text-emerald-300 hover:bg-emerald-600/30 px-3 py-1.5 rounded-lg">got</button></li>\`).join("")
    : empty("Shopping list is empty.");

  document.getElementById("notes-list").innerHTML = s.notes.length
    ? s.notes.map(n => \`<li class="\${card}"><div class="text-[11px] text-zinc-500 mb-0.5">\${fmtD(n.createdAt)}</div><div class="whitespace-pre-wrap text-sm">\${n.content}</div></li>\`).join("")
    : empty("No notes yet.");
}

// nav active highlighting
function syncNav() {
  const hash = location.hash || "#today";
  document.querySelectorAll(".nav-item").forEach(a => a.classList.toggle("active", a.getAttribute("href") === hash));
}
window.addEventListener("hashchange", syncNav);
syncNav();
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

async function loadAgents() {
  const list = await J("GET", "/api/subagents");
  document.getElementById("agents-list").innerHTML = list.length
    ? list.map(a => \`<li class="flex justify-between items-start gap-2 py-1">
        <div>
          <div class="font-medium">\${a.displayName} <span class="text-zinc-500 text-xs">(\${a.name})</span></div>
          <div class="text-zinc-400 text-xs">\${a.description}</div>
          <div class="text-zinc-500 text-xs mt-1">tools: \${a.allowedTools.join(", ") || "(none)"}\${a.enabled ? "" : " · disabled"}</div>
        </div>
        <div class="flex gap-1 shrink-0">
          <button onclick="toggleAgent('\${a.id}', \${!a.enabled})" class="text-xs bg-zinc-700 px-2 rounded">\${a.enabled ? "disable" : "enable"}</button>
          <button onclick="deleteAgent('\${a.id}')" class="text-xs bg-rose-700 px-2 rounded">x</button>
        </div>
      </li>\`).join("")
    : "<li class='text-zinc-500'>No agents yet — click 'Generate new'.</li>";
}
window.toggleAgent = async (id, enabled) => { await J("PATCH", "/api/subagents/" + id, { enabled }); loadAgents(); };
window.deleteAgent = async (id) => { if (!confirm("Delete this agent?")) return; await J("DELETE", "/api/subagents/" + id); loadAgents(); };

document.getElementById("gen-toggle").onclick = () => {
  document.getElementById("gen-form").classList.toggle("hidden");
};
document.getElementById("gen-preview").onclick = async () => {
  const desc = document.getElementById("gen-desc").value.trim();
  if (!desc) return;
  document.getElementById("gen-out").textContent = "thinking…";
  const r = await J("POST", "/api/subagents/generate", { description: desc, save: false });
  document.getElementById("gen-out").textContent = JSON.stringify(r.spec, null, 2);
};
document.getElementById("gen-save").onclick = async () => {
  const desc = document.getElementById("gen-desc").value.trim();
  if (!desc) return;
  document.getElementById("gen-out").textContent = "generating…";
  const r = await J("POST", "/api/subagents/generate", { description: desc, save: true });
  document.getElementById("gen-out").textContent = r.error ? "Error: " + r.error : "Saved: " + r.spec.name;
  if (!r.error) {
    document.getElementById("gen-desc").value = "";
    loadAgents();
  }
};

async function loadDrafts() {
  const list = await J("GET", "/api/drafts");
  setBadge("drafts", list.length);
  document.getElementById("drafts-list").innerHTML = list.length
    ? list.map(d => {
        const tone = d.triage === "URGENT_PING" ? "bg-rose-600/20 border-rose-700/40 text-rose-300"
          : d.triage === "REPLY_NEEDED" ? "bg-amber-600/20 border-amber-700/40 text-amber-300"
          : "bg-zinc-700/40 border-zinc-600/40 text-zinc-300";
        return \`<li class="\${card}">
          <div class="flex justify-between items-start gap-2">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 mb-1"><span class="text-[10px] px-2 py-0.5 rounded-full border \${tone}">\${d.triage}</span><span class="text-xs text-zinc-500">\${fmtD(d.createdAt)}</span></div>
              <div class="font-medium truncate">\${d.subject}</div>
              <div class="text-xs text-zinc-500 truncate">from \${d.fromAddress}</div>
              \${d.reasoning ? \`<div class="text-xs text-zinc-500 mt-1 italic">\${d.reasoning}</div>\` : ""}
              \${d.draftReply ? \`<details class="mt-2"><summary class="text-xs text-violet-300 cursor-pointer">view drafted reply</summary><pre class="mt-2 text-xs text-zinc-300 whitespace-pre-wrap bg-zinc-950/60 rounded p-2">\${d.draftReply}</pre></details>\` : ""}
            </div>
            <div class="flex flex-col gap-1 shrink-0">
              \${d.draftReply ? \`<button onclick="approveDraft('\${d.id}')" class="text-xs bg-emerald-600/20 border border-emerald-700/40 text-emerald-300 hover:bg-emerald-600/30 px-3 py-1.5 rounded-lg">approve</button>\` : ""}
              <button onclick="discardDraft('\${d.id}')" class="text-xs bg-zinc-800 border border-zinc-700 text-zinc-400 hover:text-zinc-200 px-3 py-1.5 rounded-lg">dismiss</button>
            </div>
          </div>
        </li>\`;
      }).join("")
    : empty("No emails awaiting triage. (Forward to your assistant Gmail once OAuth is wired.)");
}
window.discardDraft = async (id) => { await J("POST", "/api/draft/" + id + "/discard"); loadDrafts(); };
window.approveDraft = async (id) => { const r = await J("POST", "/api/draft/" + id + "/approve"); if (r.note) alert(r.note); loadDrafts(); };

load();
loadAgents();
loadDrafts();
setInterval(() => { load(); loadDrafts(); }, 30000);
</script>
</body></html>`;
