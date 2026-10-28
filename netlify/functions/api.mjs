// api.mjs — the dashboard's workspace API. Every call is authorized by the
// caller's own Buffer token (X-Buffer-Token) against Buffer's org list.
//
//   GET  /api/ws?org=<orgId>            → config, items, activity
//   POST /api/ws  { org, op, ... }      → init | createItem | updateItem | log | saveSettings

import {
  authorize, cleanText, createItem, ensureConfig, getConfig, groupmePost, json, listActivity,
  listItems, logActivity, saveConfig, updateItem, validOrgId,
} from "./_lib.mjs";

function publicConfig(config, request) {
  if (!config) return null;
  const origin = new URL(request.url).origin;
  return {
    teamName: config.teamName,
    groupmeBotId: config.groupmeBotId || "",
    relatedTerms: config.relatedTerms || [],
    intakeUrl: `${origin}/report?k=${config.intakeKey}`,
    groupmeCallbackUrl: `${origin}/api/groupme?k=${config.intakeKey}`,
    createdAt: config.createdAt,
  };
}

function fail(error) {
  const status = error?.status || 500;
  if (status >= 500) console.error("[shift api]", error?.message || error);
  return json({ ok: false, error: status >= 500 ? "Something went wrong on Shift's side. Try again." : error.message }, status);
}

export default async function handler(request) {
  try {
    if (request.method === "GET") {
      const org = new URL(request.url).searchParams.get("org") || "";
      const { account, org: orgInfo } = await authorize(request, org);
      const config = await getConfig(org);
      if (!config) {
        return json({ ok: true, setup: false, org: orgInfo, account });
      }
      const [items, activity] = await Promise.all([listItems(org), listActivity(org)]);
      // Keep the payload small: everything open, plus anything closed in the last 7 days.
      const weekAgo = Date.now() - 7 * 864e5;
      const visible = items.filter((i) =>
        i.status === "new" || i.status === "in_progress" || Date.parse(i.updatedAt) > weekAgo);
      return json({ ok: true, setup: true, org: orgInfo, account, config: publicConfig(config, request), items: visible, activity });
    }

    if (request.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);

    const body = await request.json().catch(() => ({}));
    const org = String(body.org || "");
    if (!validOrgId(org)) return json({ ok: false, error: "Unknown workspace." }, 400);
    const { account, org: orgInfo } = await authorize(request, org);
    const who = account.name || "Social team";

    switch (body.op) {
      case "init": {
        const config = await ensureConfig(org, orgInfo.name, who);
        return json({ ok: true, config: publicConfig(config, request) });
      }
      case "createItem": {
        const { item } = await createItem(org, {
          type: body.type,
          text: body.text,
          priority: body.priority,
          dueAt: body.dueAt,
          source: "dashboard",
          submittedBy: who,
        });
        return json({ ok: true, item });
      }
      case "updateItem": {
        const item = await updateItem(org, String(body.id || ""), body.patch || {}, who);
        if (body.patch?.status && ["resolved", "dismissed"].includes(body.patch.status)) {
          await logActivity(org, { who, kind: "item_closed", text: `${item.ref} marked ${body.patch.status}`, itemId: item.id });
        }
        if (body.patch?.linkPost) {
          const lp = body.patch.linkPost;
          await logActivity(org, {
            who,
            kind: "buffer_action",
            ok: lp.ok !== false,
            text: `${cleanText(lp.label || lp.action, 80)} on ${cleanText(lp.channelName, 60) || "a channel"}${lp.ok === false ? ` — failed: ${cleanText(lp.message, 160)}` : ""} (${item.ref})`,
            itemId: item.id,
          });
        }
        return json({ ok: true, item });
      }
      case "log": {
        // Buffer actions taken outside an item (e.g. pulling a post straight
        // from the schedule) still belong in the record.
        const entry = await logActivity(org, {
          who,
          kind: "buffer_action",
          ok: body.ok !== false,
          text: cleanText(body.text, 400),
        });
        return json({ ok: true, entry });
      }
      case "saveSettings": {
        const config = await saveConfig(org, {
          teamName: body.teamName,
          groupmeBotId: body.groupmeBotId,
          relatedTerms: body.relatedTerms,
          rotateKey: body.rotateKey === true,
        });
        if (body.rotateKey) await logActivity(org, { who, kind: "settings", text: "Intake link reset — old links and GroupMe callback stop working" });
        return json({ ok: true, config: publicConfig(config, request) });
      }
      case "groupmeHello": {
        // Proves the bot ID works by having the bot speak in the group.
        const config = await getConfig(org);
        if (!config?.groupmeBotId) return json({ ok: false, error: "Add your GroupMe bot ID first." }, 400);
        const sent = await groupmePost(config.groupmeBotId, [
          `👋 Shift is connected for ${config.teamName}.`,
          "Tell the social team what's happening right here:",
          "/shift issue Train is down until 3pm",
          "/shift help for everything else",
        ].join("\n"));
        if (!sent.ok) {
          return json({ ok: false, error: sent.status === 404 ? "GroupMe doesn't recognize that bot ID. Copy it again from dev.groupme.com/bots." : "GroupMe didn't accept the message. Check the bot ID and try again." }, 400);
        }
        await logActivity(org, { who, kind: "settings", text: "GroupMe bot connected and said hello in the group" });
        return json({ ok: true });
      }
      default:
        return json({ ok: false, error: "Unknown operation." }, 400);
    }
  } catch (error) {
    return fail(error);
  }
}

export const config = { path: "/api/ws" };
