// groupme.mjs — GroupMe bot callback. GroupMe posts every message in the group
// here; only messages that start with /shift are captured.
//
// Callback URL (shown in Shift → Settings): https://<site>/api/groupme?k=<intakeKey>
// GroupMe callbacks are unsigned, so the unguessable intake key is the secret.
// Resetting the intake link in Settings revokes the old callback immediately.

import { createItem, groupmePost, helpText, json, labelFor, listItems, orgForIntakeKey, parseShiftCommand } from "./_lib.mjs";

const reply = (botId, text) => groupmePost(botId, text);

export default async function handler(request) {
  const url = new URL(request.url);
  const config = await orgForIntakeKey(url.searchParams.get("k"));
  if (!config) return json({ ok: false, error: "Unknown or reset intake link." }, 401);

  if (request.method === "GET") {
    return json({ ok: true, message: `Shift GroupMe callback is live for ${config.teamName}.`, botConfigured: !!config.groupmeBotId });
  }
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);

  const message = await request.json().catch(() => null);
  if (!message || message.sender_type === "bot" || message.system || !message.text) {
    return json({ ok: true, ignored: true });
  }

  const cmd = parseShiftCommand(message.text);
  if (!cmd) return json({ ok: true, ignored: true });

  const org = config.org;
  const sender = String(message.name || "GroupMe user").slice(0, 120);

  if (cmd.kind === "help") {
    await reply(config.groupmeBotId, helpText());
    return json({ ok: true, action: "help" });
  }

  if (cmd.kind === "status") {
    const open = (await listItems(org)).filter((i) => i.status === "new" || i.status === "in_progress");
    const urgent = open.filter((i) => i.priority === "high").length;
    const lines = open.slice(0, 5).map((i) => `• ${i.ref} ${labelFor(i.type)}: ${i.text.slice(0, 60)}`);
    await reply(config.groupmeBotId, [
      `📋 ${open.length} open with the social team${urgent ? ` (${urgent} urgent)` : ""}.`,
      ...lines,
    ].join("\n"));
    return json({ ok: true, action: "status" });
  }

  const { item, duplicate } = await createItem(org, {
    type: cmd.type,
    priority: cmd.priority,
    text: cmd.text,
    source: "groupme",
    sourceId: message.id ? String(message.id) : "",
    submittedBy: sender,
  });

  if (!duplicate) {
    const flag = item.priority === "high" ? "🚨 " : "✅ ";
    await reply(config.groupmeBotId, `${flag}${labelFor(item.type)} ${item.ref} sent to the social team. Thanks, ${sender.split(" ")[0]}!`);
  }
  return json({ ok: true, ref: item.ref, duplicate });
}

export const config = { path: "/api/groupme" };
