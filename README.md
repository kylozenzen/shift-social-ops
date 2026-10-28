# Shift

**Your social team shouldn't be the last to know.**

Shift is an ops dashboard for social teams at places that physically operate: zoos, attractions, venues, nonprofits. Staff report what's happening (in GroupMe or with a link), and the social manager sees it right next to what Buffer is about to publish today and this week.

The train goes down at 1:10. The "come ride the train" post is set for 2:00. Shift flags it, you move it to draft in one tap, publish an update to the channels you pick, and leave a note for whoever's on next.

Buffer stays the system of record. Shift never publishes on its own; every public action is confirmed by a person and recorded.

---

## What it does

| | |
|---|---|
| **Capture** | `/shift issue Train is down` in GroupMe, or a report link for staff without GroupMe. Types: issue, update, idea, request, note. `!` marks urgent. |
| **Context** | Inbox on the left, today's Buffer schedule on a timeline with a live "now" marker on the right, then the rest of the week. Posts that mention the same thing as an open issue get flagged ("might clash"). |
| **Action** | Move a post to draft (and put it back at its original time later), publish/queue/schedule/draft an update to chosen channels, save ideas to Buffer Ideas. |
| **Handoff** | Notes for next shift, a "what happened today" log, and a copyable handoff summary built only from recorded actions. |
| **Onboarding** | A 3-step setup card on first visit. Step 2 shows the user's real next Buffer post with three word chips ("Pretend something's wrong with: train"); tapping one files a labeled sample report so they watch their own post get flagged. Step 3 connects GroupMe with a Save & test button that makes the bot say hello in the group. |

## How it's built

- Static HTML/CSS/vanilla JS, no build step. Netlify Functions + Netlify Blobs.
- **Your Buffer login is your Shift login.** Each workspace is a Buffer organization. Every `/api/ws` call carries the user's own Buffer token; the server asks Buffer which organizations that token can see and refuses anything else. The token is never stored server-side.
- Buffer OAuth + PKCE, token storage/refresh, and the GraphQL proxy are the shared layer from PostIQ (`js/shared/`, `netlify/functions/buffer-*.js`). The proxy's server-side token fallback was removed, since Shift is multi-user.
- Publishing reuses Uplink's `createPost` pattern.
- GroupMe intake reuses the tour-report bot pattern: an unguessable key in the callback URL, message-ID dedupe, replies via bot ID.

```
index.html          landing + connect (OAuth or API key)
app.html            dashboard
report.html         public staff report form
auth/callback.html  OAuth return
js/app.js           dashboard logic
js/match.js         impact check (keyword + related-word matching)
js/shared/          PostIQ's shared Buffer OAuth/connection layer
netlify/functions/
  api.mjs           /api/ws        workspace API (Buffer-token authorized)
  groupme.mjs       /api/groupme   GroupMe bot callback
  intake.mjs        /api/intake    report form (submit-only, rate limited, honeypot)
  app-config.mjs    /api/config    public client settings
  _lib.mjs          storage, auth, /shift parser
  buffer-proxy.js   Buffer GraphQL pass-through
  buffer-token.js   OAuth code/refresh exchange
```

## Setup

### 1. Deploy

1. Push this folder to a GitHub repo and import it in Netlify (no build command; publish directory is the repo root).
2. Netlify Blobs works automatically on Netlify. Nothing to configure.

### 2. Connect Buffer

**Option A: OAuth (what judges and new users should see)**
1. Register an OAuth app with Buffer (developers.buffer.com). Redirect URI: `https://YOUR-SITE.netlify.app/auth/callback.html`
2. In Netlify → Site configuration → Environment variables, set:
   - `BUFFER_CLIENT_ID` = the client ID (public, not a secret)
   - optional `BUFFER_OAUTH_SCOPE` (default: `posts:write posts:read account:read offline_access`)
   - optional `BUFFER_ALLOWED_ORIGINS` = `https://YOUR-SITE.netlify.app` (locks the proxy to your site)
3. Redeploy. "Connect with Buffer" appears on the landing page.

**Option B: API key** (works with no env vars): "Use an API key instead" on the landing page. The key stays in that browser.

### 3. Connect GroupMe (2 minutes)

1. Open Shift → Settings and copy the **GroupMe callback URL**.
2. Go to dev.groupme.com/bots → Create Bot → pick your team's group → paste the callback URL.
3. Copy the new bot's **Bot ID** back into Shift → Settings → Save.
4. In the group, type `/shift help`.

Resetting the report link in Settings revokes the old link *and* the GroupMe callback immediately; paste the new callback URL into the bot afterwards.

## GroupMe commands

```
/shift issue Train is down until 3pm
/shift issue! Pool closed           (! = urgent)
/shift urgent Lost child at carousel
/shift idea Giraffe zoomies at 10am
/shift update Gates open late Saturday
/shift request Need a post for the 5pm keeper talk
/shift note Schedule the CEO post at 5
/shift status
/shift help
```
Anything not starting with `/shift` is ignored.

## Two-minute demo script

1. **Connect.** Landing page (the animated replay tells the story in 9 seconds) → Connect with Buffer → dashboard shows real channels and today's posts on the timeline, plus the setup card.
2. **Capture.** On a phone in GroupMe: `/shift issue! Train is down until 3pm, mechanical`. The bot replies with a reference. Within 20 seconds it's in the Inbox (or hit Refresh).
3. **Context.** The 2:00 "ride the train" post turns amber: *Might clash with S-XXXX (train)*. A Friday post mentioning "railroad" is flagged too, via related words.
4. **Action.** Move to draft → confirm. Post an update → pick Facebook + Threads → Review → Publish now. Buffer's real result is shown per channel.
5. **Handoff.** Leave a note ("Put the train post back once it's running"), then Copy handoff. Later, Put back at 2:00 restores the original post.

For the demo, schedule a "ride the train" post in Buffer for later today first.

## Verified against the live Buffer API (Oct 15, 2026)

- `editPost` with `saveToDraft: true` moves a scheduled post to draft and **keeps its `dueAt`**, which is what powers "Put back at 2:00."
- `editPost` with `saveToDraft: false, mode: customScheduled, dueAt` puts it back on the schedule.
- **`editPost` rejects the change unless the post's text is sent again** ("Post must have either text or media"). Shift always resends text and media.
- Scheduled posts expose `allowedActions` including `movePostToDraft`; Shift only shows the button when Buffer allows it.

## Known limitations (be honest in the submission)

- **Media on move-to-draft is not live-tested yet.** Shift resends images/videos/documents from the post's assets, but a live test with an image post hasn't been run. Before the demo: schedule a post with an image, move it to draft in Shift, and confirm the image is still attached in Buffer. Platform-specific metadata (first comment, link previews, Threads topics) is not resent and may be dropped on posts that use it.
- **Buffer has no webhooks.** The dashboard polls Shift every 20s and Buffer every 2 minutes (and on Refresh).
- **Buffer Ideas** may need an ideas scope on OAuth tokens. If "Save to Buffer Ideas" fails, Shift shows Buffer's error; set `BUFFER_OAUTH_SCOPE` accordingly.
- **Impact check is keyword matching**, not AI. It's conservative and labeled "might clash"; it can miss posts that describe the same thing in different words. Add those words under Settings → Words that mean the same thing.
- **No roles yet.** Anyone with Buffer access to the organization can use that workspace; GroupMe and report-link contributors can only submit.
- GroupMe callbacks are unsigned by GroupMe, so the callback URL key is the secret. Treat it like a password.
- Posts pulled from the schedule without attaching them to an inbox item are remembered on that device only.

## Development

```
npm install
npm test                       # 24 tests: matcher, /shift parser, auth isolation, GroupMe, intake, link reset
node scripts/dev-server.mjs    # http://localhost:8888, mock Buffer, API key: mock-token
```
`scripts/dev-server.mjs` runs the real functions against a local Blobs server and an in-memory mock Buffer, so you can click through the whole flow without touching a real account. Simulate a GroupMe message:

```
curl -X POST "localhost:8888/api/groupme?k=KEY_FROM_SETTINGS" \
  -H 'content-type: application/json' \
  -d '{"id":"1","name":"Maria","text":"/shift issue! Train is down"}'
```

---
Built by [Nobody Creative](https://bencampbell.netlify.app).
