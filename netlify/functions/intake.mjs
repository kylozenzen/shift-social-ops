// intake.mjs — the public "Report something" form for staff without GroupMe.
// The link only lets someone submit; it can't read the inbox or touch Buffer.
//
//   GET  /api/intake?k=<key>  → { teamName }
//   POST /api/intake          { k, type, text, name, priority, website (honeypot) }

import { cleanText, createItem, json, orgForIntakeKey, rateLimit, sha256 } from "./_lib.mjs";

export default async function handler(request, context) {
  if (request.method === "GET") {
    const config = await orgForIntakeKey(new URL(request.url).searchParams.get("k"));
    if (!config) return json({ ok: false, error: "This report link has been reset or doesn't exist. Ask your social team for the current link." }, 404);
    return json({ ok: true, teamName: config.teamName });
  }
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);

  const body = await request.json().catch(() => ({}));
  const config = await orgForIntakeKey(body.k);
  if (!config) return json({ ok: false, error: "This report link has been reset. Ask your social team for the current link." }, 404);

  // Honeypot: real people never fill the hidden "website" field.
  if (cleanText(body.website, 200)) return json({ ok: true, ref: "S-THANKS" });

  const ip = context?.ip || request.headers.get("x-nf-client-connection-ip") || "unknown";
  const limit = await rateLimit(`intake:${config.org}:${sha256(ip)}`, 12, 600);
  if (!limit.allowed) return json({ ok: false, error: "That's a lot of reports in a few minutes. Wait a bit and try again." }, 429);

  try {
    const { item } = await createItem(config.org, {
      type: body.type,
      text: body.text,
      priority: body.priority === "high" ? "high" : "normal",
      source: "form",
      submittedBy: cleanText(body.name, 80) || "Staff (form)",
    });
    return json({ ok: true, ref: item.ref });
  } catch (error) {
    return json({ ok: false, error: error.status === 400 ? error.message : "Couldn't send that. Try again." }, error.status || 500);
  }
}

export const config = { path: "/api/intake" };
