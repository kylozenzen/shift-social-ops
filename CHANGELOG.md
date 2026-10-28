# Shift changelog

Buffer's build window runs **Oct 28 – Nov 13, 2026**. Per Buffer's guidance, work done before kickoff is allowed but must be separated from what's added during the window. This file is that record.

---

## Before the official build window (through Oct 15, 2026)

Git tag: `pre-kickoff-2026-10-15`

**Reused from earlier projects (not new for Shift)**
- Buffer OAuth + PKCE, token storage and refresh, GraphQL proxy: PostIQ's shared Buffer layer
- `createPost` publishing pattern: Uplink
- GroupMe bot pattern (keyed callback URL, message dedupe, bot replies): SWSA tour-report tool

**Built for Shift before kickoff (prototype)**
- Workspace model: each Buffer organization is a workspace; server checks every request's Buffer token against Buffer's own org list
- GroupMe `/shift` intake (issue, update, idea, request, note, urgent, status, help)
- Public report link (submit-only, rate limited, honeypot) and report form
- Dashboard: inbox, today's schedule on a timeline with a live "now" marker, rest of the week
- Impact check: keyword + related-word matching between open issues and upcoming posts
- Move to draft and restore at the original time (live-verified against the Buffer API)
- Composer: publish now, queue, schedule, or draft to chosen channels with a confirm step
- Save ideas to Buffer Ideas
- Notes for next shift, activity log, copyable handoff summary
- First-run setup card (test report on the user's real next post), GroupMe Save & test
- Animated landing page replay
- 24 automated tests, local dev server with mock Buffer

---

## During the build window (Oct 28 – Nov 13, 2026)

_Add each feature here as it ships, with the date._

- **Oct 28, 2026. Landing page rewritten as a sign-up page.** New hero with a "Sign up with Buffer" call to action, a bottom sign-up band, four value props, a features section and two use cases (places with live operations; SaaS teams with a social lead). The original connect-first page and its animated replay were pre-kickoff work and are kept on the page. The connect logic (OAuth and API key) is unchanged apart from wiring up the second button.
- **Oct 28, 2026. Landing styles.** Added layout and styles for the new sections in `css/app.css`.
