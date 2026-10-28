// _lib.mjs — shared server helpers for Shift.
// Storage (Netlify Blobs), Buffer-token authorization, /shift command parsing.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getStore } from "@netlify/blobs";

export const STORE_NAME = "shift-data";
export const ITEM_TYPES = ["issue", "idea", "update", "request", "note"];
export const STATUSES = ["new", "in_progress", "resolved", "dismissed"];
export const PRIORITIES = ["normal", "high"];
const ORG_ID = /^[a-f\d]{24}$/i;

// ---------- small utils ----------

export function store() {
  return getStore({ name: STORE_NAME, consistency: "strong" });
}

export const json = (data, status = 200, extra = {}) =>
  Response.json(data, { status, headers: { "cache-control": "no-store", ...extra } });

export function cleanText(value, max = 1000) {
  return typeof value === "string" ? value.replace(/\u0000/g, "").trim().slice(0, max) : "";
}

export function validOrgId(value) {
  return ORG_ID.test(String(value || ""));
}

export function newId() {
  return crypto.randomUUID();
}

// Short human reference for GroupMe replies, e.g. "S-7K2Q".
export function newRef() {
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  const bytes = randomBytes(4);
  return "S-" + Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export function newIntakeKey() {
  return randomBytes(18).toString("base64url");
}

export function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

// ---------- Buffer authorization ----------
// A caller may only touch workspace <orgId> if their own Buffer token can see
// that organization. The token is used for this one check and never stored.

const accessCache = new Map(); // sha256(token) -> { account, orgs, exp }
const ACCESS_TTL_MS = 5 * 60 * 1000;

export async function bufferAccount(token, fetchImpl = fetch) {
  const key = sha256(token);
  const cached = accessCache.get(key);
  if (cached && cached.exp > Date.now()) return cached;

  const res = await fetchImpl("https://api.buffer.com", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query: "query{ account{ id name organizations{ id name } } }" }),
  });
  const data = await res.json().catch(() => null);
  const account = data?.data?.account;
  if (!res.ok || !account) {
    const err = new Error("Buffer did not accept this connection. Reconnect Buffer and try again.");
    err.status = res.status === 429 ? 429 : 401;
    throw err;
  }
  const entry = {
    account: { id: account.id, name: account.name || "" },
    orgs: (account.organizations || []).map((o) => ({ id: o.id, name: o.name })),
    exp: Date.now() + ACCESS_TTL_MS,
  };
  accessCache.set(key, entry);
  return entry;
}

export async function authorize(request, orgId, fetchImpl = fetch) {
  const token = request.headers.get("x-buffer-token") || "";
  if (!token) {
    const err = new Error("Connect Buffer to use Shift.");
    err.status = 401;
    throw err;
  }
  if (!validOrgId(orgId)) {
    const err = new Error("Unknown workspace.");
    err.status = 400;
    throw err;
  }
  const access = await bufferAccount(token, fetchImpl);
  const org = access.orgs.find((o) => o.id === orgId);
  if (!org) {
    const err = new Error("Your Buffer account doesn't have access to this workspace.");
    err.status = 403;
    throw err;
  }
  return { account: access.account, org };
}

export function _clearAccessCache() {
  accessCache.clear();
}

// ---------- workspace records ----------

const wsKey = (org, rest) => `ws/${org}/${rest}`;

export const DEFAULT_RELATED_TERMS = [
  ["train", "railroad", "railway", "locomotive", "choo choo"],
  ["pool", "splash pad", "water park", "swim"],
  ["parking", "garage", "shuttle"],
  ["rain", "storm", "lightning", "weather"],
];

export async function getConfig(org) {
  return (await store().get(wsKey(org, "config"), { type: "json" })) || null;
}

export async function ensureConfig(org, orgName, who) {
  const db = store();
  const existing = await getConfig(org);
  if (existing) return existing;
  const config = {
    org,
    teamName: cleanText(orgName, 80) || "My team",
    intakeKey: newIntakeKey(),
    groupmeBotId: "",
    relatedTerms: DEFAULT_RELATED_TERMS,
    createdAt: new Date().toISOString(),
    createdBy: cleanText(who, 120),
  };
  await db.setJSON(wsKey(org, "config"), config);
  await db.setJSON(`intake/${config.intakeKey}`, { org });
  return config;
}

export async function saveConfig(org, patch) {
  const db = store();
  const current = await getConfig(org);
  if (!current) throw Object.assign(new Error("Workspace not set up yet."), { status: 404 });
  const next = { ...current };
  if (typeof patch.teamName === "string") next.teamName = cleanText(patch.teamName, 80) || current.teamName;
  if (typeof patch.groupmeBotId === "string") next.groupmeBotId = cleanText(patch.groupmeBotId, 64).replace(/[^a-zA-Z0-9]/g, "");
  if (Array.isArray(patch.relatedTerms)) next.relatedTerms = normalizeTermGroups(patch.relatedTerms);
  if (patch.rotateKey) {
    await db.delete(`intake/${current.intakeKey}`);
    next.intakeKey = newIntakeKey();
    await db.setJSON(`intake/${next.intakeKey}`, { org });
  }
  next.updatedAt = new Date().toISOString();
  await db.setJSON(wsKey(org, "config"), next);
  return next;
}

export function normalizeTermGroups(groups) {
  return groups
    .slice(0, 40)
    .map((g) => (Array.isArray(g) ? g : String(g).split(","))
      .map((t) => cleanText(String(t), 40).toLowerCase())
      .filter(Boolean)
      .slice(0, 15))
    .filter((g) => g.length >= 2);
}

export async function orgForIntakeKey(key) {
  const clean = cleanText(key, 64);
  if (!clean) return null;
  const hit = await store().get(`intake/${clean}`, { type: "json" });
  if (!hit?.org) return null;
  const config = await getConfig(hit.org);
  // The index can only be trusted if the workspace still holds this exact key.
  if (!config || !safeEqual(config.intakeKey, clean)) return null;
  return config;
}

// ---------- items ----------

export async function createItem(org, input) {
  const db = store();
  const source = cleanText(input.source, 20) || "dashboard";
  const sourceId = cleanText(input.sourceId, 120);
  if (sourceId) {
    const dedupeKey = wsKey(org, `dedupe/${source}-${sourceId.replace(/[^a-zA-Z0-9_-]/g, "-")}`);
    const seen = await db.get(dedupeKey, { type: "json" });
    if (seen?.id) {
      const existing = await getItem(org, seen.id);
      if (existing) return { item: existing, duplicate: true };
    }
  }

  const type = ITEM_TYPES.includes(input.type) ? input.type : "update";
  const text = cleanText(input.text, 2000);
  if (text.length < 2) throw Object.assign(new Error("Add a few words describing what's going on."), { status: 400 });

  const now = new Date().toISOString();
  const item = {
    id: newId(),
    ref: newRef(),
    type,
    text,
    priority: PRIORITIES.includes(input.priority) ? input.priority : "normal",
    status: "new",
    source,
    submittedBy: cleanText(input.submittedBy, 120) || "Someone",
    dueAt: cleanText(input.dueAt, 40) || null,
    createdAt: now,
    updatedAt: now,
    linkedPosts: [],
    history: [{ at: now, who: cleanText(input.submittedBy, 120) || "Someone", action: "created", detail: `via ${source}` }],
  };
  await db.setJSON(wsKey(org, `items/${item.id}`), item);
  if (sourceId) {
    await db.setJSON(wsKey(org, `dedupe/${source}-${sourceId.replace(/[^a-zA-Z0-9_-]/g, "-")}`), { id: item.id });
  }
  await logActivity(org, {
    who: item.submittedBy,
    kind: "item_created",
    text: `${labelFor(type)} ${item.ref}: ${item.text.slice(0, 140)}`,
    itemId: item.id,
  });
  return { item, duplicate: false };
}

export async function getItem(org, id) {
  if (!/^[a-f0-9-]{36}$/i.test(String(id || ""))) return null;
  return store().get(wsKey(org, `items/${id}`), { type: "json" });
}

export async function listItems(org) {
  const db = store();
  const { blobs } = await db.list({ prefix: wsKey(org, "items/") });
  const items = (await Promise.all(blobs.map((b) => db.get(b.key, { type: "json" })))).filter(Boolean);
  return items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function updateItem(org, id, patch, who) {
  const item = await getItem(org, id);
  if (!item) throw Object.assign(new Error("That item no longer exists."), { status: 404 });
  const now = new Date().toISOString();
  const changes = [];

  if (patch.status && STATUSES.includes(patch.status) && patch.status !== item.status) {
    changes.push(`status ${item.status} → ${patch.status}`);
    item.status = patch.status;
  }
  if (patch.priority && PRIORITIES.includes(patch.priority) && patch.priority !== item.priority) {
    changes.push(`priority → ${patch.priority}`);
    item.priority = patch.priority;
  }
  if (typeof patch.text === "string" && cleanText(patch.text, 2000).length >= 2 && cleanText(patch.text, 2000) !== item.text) {
    changes.push("text edited");
    item.text = cleanText(patch.text, 2000);
  }
  if (patch.bufferIdeaId) {
    item.bufferIdeaId = cleanText(patch.bufferIdeaId, 64);
    changes.push("saved to Buffer Ideas");
  }
  if (patch.linkPost && typeof patch.linkPost === "object") {
    const lp = patch.linkPost;
    const action = cleanText(lp.action, 40);
    const entry = {
      postId: cleanText(lp.postId, 64),
      channelId: cleanText(lp.channelId, 64),
      channelName: cleanText(lp.channelName, 80),
      service: cleanText(lp.service, 30),
      action,
      originalDueAt: cleanText(lp.originalDueAt, 40) || null,
      textPreview: cleanText(lp.textPreview, 200),
      ok: lp.ok !== false,
      message: cleanText(lp.message, 300),
      at: now,
      who: cleanText(who, 120),
    };
    item.linkedPosts = [...(item.linkedPosts || []), entry].slice(-50);
    changes.push(`${action}${entry.ok ? "" : " (failed)"}`);
  }
  if (!changes.length) return item;

  item.updatedAt = now;
  item.history = [...(item.history || []), { at: now, who: cleanText(who, 120), action: "updated", detail: changes.join(", ") }].slice(-100);
  await store().setJSON(wsKey(org, `items/${item.id}`), item);
  return item;
}

// ---------- activity log ----------

export async function logActivity(org, entry) {
  const at = new Date().toISOString();
  const record = {
    at,
    who: cleanText(entry.who, 120),
    kind: cleanText(entry.kind, 40),
    text: cleanText(entry.text, 500),
    itemId: cleanText(entry.itemId, 64) || null,
    ok: entry.ok !== false,
  };
  await store().setJSON(wsKey(org, `activity/${at}-${randomBytes(3).toString("hex")}`), record);
  return record;
}

export async function listActivity(org, limit = 60) {
  const db = store();
  const { blobs } = await db.list({ prefix: wsKey(org, "activity/") });
  const recent = blobs.map((b) => b.key).sort().reverse().slice(0, limit);
  return (await Promise.all(recent.map((k) => db.get(k, { type: "json" })))).filter(Boolean);
}

// ---------- rate limiting (per key + bucket) ----------

export async function rateLimit(bucket, max, windowSeconds) {
  const db = store();
  const key = `ratelimit/${sha256(bucket).slice(0, 32)}`;
  const now = Date.now();
  const current = await db.get(key, { type: "json" });
  if (!current || current.resetAt <= now) {
    await db.setJSON(key, { count: 1, resetAt: now + windowSeconds * 1000 });
    return { allowed: true };
  }
  if (current.count >= max) return { allowed: false, retryAfterMs: current.resetAt - now };
  await db.setJSON(key, { count: current.count + 1, resetAt: current.resetAt });
  return { allowed: true };
}

// ---------- GroupMe ----------

export async function groupmePost(botId, text, fetchImpl = fetch) {
  if (!botId) return { ok: false, skipped: true };
  try {
    const res = await fetchImpl("https://api.groupme.com/v3/bots/post", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bot_id: botId, text: String(text).slice(0, 990) }),
    });
    return { ok: res.ok, status: res.status };
  } catch (error) {
    console.error("[shift groupme] post failed", error?.message);
    return { ok: false };
  }
}

// ---------- /shift command parsing ----------

const TYPE_WORDS = {
  issue: "issue", problem: "issue", down: "issue", broken: "issue", closed: "issue",
  idea: "idea", content: "idea", post: "idea",
  update: "update", fyi: "update", info: "update",
  request: "request", ask: "request", need: "request",
  note: "note", handoff: "note", reminder: "note", todo: "note",
  urgent: "issue",
};

export function labelFor(type) {
  return { issue: "Issue", idea: "Idea", update: "Update", request: "Request", note: "Note" }[type] || "Update";
}

// Returns null when the message isn't addressed to Shift, otherwise
// { kind: "help" | "status" | "item", type, priority, text }.
export function parseShiftCommand(raw) {
  const text = String(raw || "").trim();
  const m = text.match(/^[\/#!]shift\b[:\s-]*/i);
  if (!m) return null;
  let rest = text.slice(m[0].length).trim();
  if (!rest || /^(help|\?)$/i.test(rest)) return { kind: "help" };
  if (/^status$/i.test(rest)) return { kind: "status" };

  let type = "update";
  let priority = "normal";
  const first = rest.match(/^([a-z]+)(!*)\s*[:\-]?\s*/i);
  if (first) {
    const word = first[1].toLowerCase();
    if (TYPE_WORDS[word]) {
      // "down"/"closed"/"broken" only count as a type word when they lead the
      // message on purpose — keep them in the text so it still reads naturally.
      const keepWord = ["down", "broken", "closed", "need", "post", "content"].includes(word);
      type = TYPE_WORDS[word];
      if (word === "urgent" || first[2]) priority = "high";
      if (!keepWord) rest = rest.slice(first[0].length).trim();
    }
  }
  if (/!!\s*$/.test(rest) || /\burgent\b|\basap\b/i.test(rest)) priority = "high";
  rest = rest.replace(/\s*!!+\s*$/, "").trim();
  if (rest.length < 2) return { kind: "help" };
  return { kind: "item", type, priority, text: rest };
}

export function helpText() {
  return [
    "📣 Shift — send info to the social team:",
    "/shift issue Train is down until 3pm",
    "/shift idea Baby giraffe zoomies at 10am 🦒",
    "/shift update Gates open late Saturday",
    "/shift request Need a post for the 5pm keeper talk",
    "/shift note Schedule the CEO post at 5",
    "Add ! for urgent: /shift issue! Pool closed",
    "/shift status — what's open right now",
  ].join("\n");
}
