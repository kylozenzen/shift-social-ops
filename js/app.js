// app.js — Shift dashboard.
// Buffer is the system of record for posts; Shift's own API holds the inbox,
// notes, and activity. Nothing here posts without an explicit confirmation.

(function () {
  'use strict';

  const PREFIX = 'shift';
  const TOKEN_ENDPOINT = '/.netlify/functions/buffer-token';
  const PROXY_ENDPOINT = '/.netlify/functions/buffer-proxy';
  const ITEM_POLL_MS = 20000;
  const BUFFER_POLL_MS = 120000;
  const DAYS_AHEAD = 7;

  const FALLBACK_LIMITS = {
    twitter: 280, bluesky: 300, threads: 500, mastodon: 500, linkedin: 3000, instagram: 2200,
    facebook: 5000, tiktok: 2200, pinterest: 500, googlebusiness: 1500, youtube: 5000, substack: 3000,
  };
  const MEDIA_FIRST = new Set(['instagram', 'tiktok', 'youtube', 'pinterest']);
  const SERVICE_NAMES = {
    twitter: 'X', bluesky: 'Bluesky', threads: 'Threads', mastodon: 'Mastodon', linkedin: 'LinkedIn',
    instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok', pinterest: 'Pinterest',
    googlebusiness: 'Google Business', youtube: 'YouTube', substack: 'Substack', startPage: 'Start Page', whatsapp: 'WhatsApp',
  };
  const TYPE_LABEL = { issue: 'Issue', idea: 'Idea', update: 'Update', request: 'Request', note: 'Note' };

  const S = {
    account: null, orgs: [], org: null, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    config: null, items: [], activity: [],
    channels: [], channelById: new Map(), limits: new Map(),
    posts: [], pulled: [], impacts: { byPost: new Map(), byItem: new Map() },
    filter: 'open', bufferError: '', lastBufferLoad: 0, busy: false,
    seenIds: null, fresh: new Set(),
  };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- theme ----------
  function applyTheme(mode) {
    if (mode === 'light' || mode === 'dark') document.documentElement.dataset.theme = mode;
    else delete document.documentElement.dataset.theme;
  }
  function storedTheme() { try { return localStorage.getItem('shift_theme') || 'system'; } catch { return 'system'; } }
  applyTheme(storedTheme());

  // ---------- toast ----------
  let toastTimer = null;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3800);
  }

  // ---------- time ----------
  function dayKey(date) {
    return new Date(date).toLocaleDateString('en-CA', { timeZone: S.timezone });
  }
  function fmtTime(date) {
    return new Date(date).toLocaleTimeString('en-US', { timeZone: S.timezone, hour: 'numeric', minute: '2-digit' });
  }
  function fmtDay(date) {
    return new Date(date).toLocaleDateString('en-US', { timeZone: S.timezone, weekday: 'long', month: 'short', day: 'numeric' });
  }
  function fmtWhen(date) {
    const d = new Date(date);
    if (dayKey(d) === dayKey(Date.now())) return fmtTime(d);
    return d.toLocaleString('en-US', { timeZone: S.timezone, weekday: 'short', hour: 'numeric', minute: '2-digit' });
  }
  function ago(date) {
    const mins = Math.round((Date.now() - new Date(date)) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    if (mins < 60 * 24 && dayKey(date) === dayKey(Date.now())) return fmtTime(date);
    return fmtWhen(date);
  }

  // ---------- Buffer ----------
  async function token() {
    const t = await BufferConnection.getValidAccessToken();
    if (!t) throw Object.assign(new Error('Connect Buffer to continue.'), { code: 'NO_TOKEN' });
    return t;
  }

  async function gql(query, variables = {}) {
    const res = await fetch(PROXY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Buffer-Token': await token() },
      body: JSON.stringify({ query, variables }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || (data.errors && !data.data)) {
      const err = data?.errors?.[0];
      const e = new Error(err?.message || `Buffer request failed (${res.status})`);
      e.code = err?.code || (res.status === 401 ? 'AUTH_ERROR' : 'BUFFER_ERROR');
      throw e;
    }
    return data.data;
  }

  // Shift's own workspace API (authorized server-side with the same token).
  async function api(method, body) {
    const opts = { method, headers: { 'X-Buffer-Token': await token() } };
    let url = '/api/ws';
    if (method === 'GET') url += `?org=${encodeURIComponent(S.org.id)}`;
    else {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify({ org: S.org.id, ...body });
    }
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw Object.assign(new Error(data.error || `Shift request failed (${res.status})`), { status: res.status });
    return data;
  }

  const POST_FIELDS = `id status dueAt sentAt text channelId channelService allowedActions isCustomScheduled shareMode schedulingType
    error { message }
    assets { __typename type source thumbnail
      ... on ImageAsset { image { altText } }
      ... on VideoAsset { video { title } }
      ... on DocumentAsset { document { title } } }`;

  async function loadAccount() {
    const d = await gql('query{ account{ id name timezone organizations{ id name } } }');
    S.account = d.account;
    if (d.account.timezone) S.timezone = d.account.timezone;
    S.orgs = d.account.organizations || [];
    let saved = '';
    try { saved = localStorage.getItem('shift_org') || ''; } catch {}
    S.org = S.orgs.find((o) => o.id === saved) || S.orgs[0] || null;
  }

  async function loadBuffer() {
    if (!S.org) return;
    const orgId = S.org.id;
    const start = new Date(Date.now() - 26 * 3600e3).toISOString();
    const end = new Date(Date.now() + (DAYS_AHEAD + 1) * 864e5).toISOString();
    try {
      const [ch, scheduled, drafts] = await Promise.all([
        gql(`query($org: OrganizationId!){ channels(input:{organizationId:$org}){ id name displayName service avatar isDisconnected isLocked allowedActions
              metadata { __typename ... on InstagramMetadata { defaultToReminders } ... on TiktokMetadata { defaultToReminders } ... on YoutubeMetadata { defaultToReminders } } } }`, { org: orgId }),
        gql(`query($org: OrganizationId!, $start: DateTime, $end: DateTime){ posts(first: 100, input:{ organizationId:$org,
              filter:{ status:[scheduled, sending, sent, error, needs_approval], dueAt:{ start:$start, end:$end } },
              sort:[{ field: dueAt, direction: asc }] }){ edges { node { ${POST_FIELDS} } } } }`, { org: orgId, start, end }),
        gql(`query($org: OrganizationId!){ posts(first: 50, input:{ organizationId:$org,
              filter:{ status:[draft], dueAtPresence: present }, sort:[{ field: dueAt, direction: asc }] }){ edges { node { ${POST_FIELDS} } } } }`, { org: orgId }),
      ]);
      if (S.org?.id !== orgId) return;
      S.channels = ch.channels.filter((c) => !c.isLocked);
      S.channelById = new Map(ch.channels.map((c) => [c.id, c]));
      S.posts = (scheduled.posts.edges || []).map((e) => e.node).filter((p) => p.dueAt || p.sentAt);
      const pulledIds = pulledByShift();
      S.pulled = (drafts.posts.edges || []).map((e) => e.node).filter((p) => pulledIds.has(p.id));
      S.bufferError = '';
      S.lastBufferLoad = Date.now();
      loadLimits(orgId);
    } catch (err) {
      S.bufferError = err.code === 'AUTH_ERROR' || err.code === 'NO_TOKEN'
        ? 'Buffer needs you to reconnect.'
        : `Couldn't load your Buffer schedule: ${err.message}`;
    }
  }

  // Only posts Shift itself moved to draft show under "Pulled from schedule" —
  // ordinary drafts stay in Buffer where they belong.
  function pulledByShift() {
    const state = new Map();
    for (const item of S.items) {
      for (const lp of item.linkedPosts || []) {
        if (!lp.ok || !lp.postId) continue;
        if (lp.action === 'moved_to_draft') state.set(lp.postId, { at: lp.at, item, originalDueAt: lp.originalDueAt });
        if (lp.action === 'restored' || lp.action === 'published') state.delete(lp.postId);
      }
    }
    for (const id of localPulled().keys()) if (!state.has(id)) state.set(id, localPulled().get(id));
    return state;
  }
  // Posts pulled without an inbox item are remembered on this device.
  function localPulled() {
    try { return new Map(Object.entries(JSON.parse(localStorage.getItem(`shift_pulled_${S.org.id}`) || '{}'))); } catch { return new Map(); }
  }
  function setLocalPulled(postId, value) {
    try {
      const all = Object.fromEntries(localPulled());
      if (value) all[postId] = value; else delete all[postId];
      localStorage.setItem(`shift_pulled_${S.org.id}`, JSON.stringify(all));
    } catch {}
  }

  let limitsLoadedFor = '';
  async function loadLimits(orgId) {
    if (limitsLoadedFor === orgId) return;
    limitsLoadedFor = orgId;
    try {
      const d = await gql(`query($org: OrganizationId!){ configuration(input:{organizationId:$org}){ channels { channelId
          content { configurationContentTypes rules { __typename property ... on LengthRule { maxLength } } } } } }`, { org: orgId });
      for (const c of d.configuration.channels || []) {
        const postContent = (c.content || []).find((x) => (x.configurationContentTypes || []).includes('post')) || (c.content || [])[0];
        const rule = (postContent?.rules || []).find((r) => r.__typename === 'LengthRule' && r.property === 'text');
        if (rule?.maxLength) S.limits.set(c.channelId, rule.maxLength);
      }
    } catch { /* fall back to the built-in table */ }
  }

  function limitFor(channel) {
    return S.limits.get(channel.id) || FALLBACK_LIMITS[channel.service] || 3000;
  }

  async function loadWorkspace() {
    let data = await api('GET');
    if (!data.setup) {
      await api('POST', { op: 'init' });
      data = await api('GET');
      S.firstRun = true;
    }
    S.config = data.config;
    S.items = data.items || [];
    S.activity = data.activity || [];
    S.seenIds = new Set(S.items.map((i) => i.id));
  }

  // ---------- derived ----------
  function upcomingScheduled() {
    const now = Date.now();
    return S.posts.filter((p) => p.status === 'scheduled' && p.dueAt && new Date(p.dueAt) >= now - 60000);
  }

  function computeImpacts() {
    S.impacts = ShiftMatch.findImpacts(S.items, upcomingScheduled(), S.config?.relatedTerms || []);
  }

  const isOpen = (i) => i.status === 'new' || i.status === 'in_progress';

  // ---------- rendering ----------
  function render() {
    computeImpacts();
    renderHeader();
    renderBanners();
    renderSetup();
    renderInbox();
    renderNotes();
    renderSchedule();
    renderActivity();
  }

  function renderHeader() {
    const sel = $('orgSelect');
    sel.innerHTML = S.orgs.map((o) => `<option value="${esc(o.id)}"${o.id === S.org?.id ? ' selected' : ''}>${esc(o.name)}</option>`).join('');
    sel.disabled = S.orgs.length < 2;

    $('channelStack').innerHTML = S.channels.slice(0, 6).map((c) => c.avatar
      ? `<img src="${esc(c.avatar)}" alt="${esc(c.displayName || c.name)} on ${esc(SERVICE_NAMES[c.service] || c.service)}" title="${esc(c.displayName || c.name)}">`
      : `<span class="ch-fallback" title="${esc(c.name)}"></span>`).join('');

    const open = S.items.filter((i) => isOpen(i) && i.type !== 'note');
    const flaggedPosts = S.impacts.byPost.size;
    const urgent = open.filter((i) => i.priority === 'high').length;
    let headline;
    if (flaggedPosts) headline = `${flaggedPosts} scheduled ${flaggedPosts === 1 ? 'post might' : 'posts might'} need a second look`;
    else if (urgent) headline = `${urgent} urgent ${urgent === 1 ? 'thing needs' : 'things need'} you`;
    else if (open.length) headline = `${open.length} ${open.length === 1 ? 'thing' : 'things'} from the team`;
    else headline = 'All clear for now';
    $('headline').textContent = headline;

    const today = dayKey(Date.now());
    const rest = upcomingScheduled().filter((p) => dayKey(p.dueAt) === today);
    const next = rest[0];
    $('subline').textContent = next
      ? `${rest.length} more ${rest.length === 1 ? 'post goes' : 'posts go'} out today. Next at ${fmtTime(next.dueAt)} on ${channelLabel(next.channelId)}.`
      : (S.bufferError ? '' : 'Nothing else is scheduled to go out today.');
    $('tabInboxCount').textContent = open.length ? `(${open.length})` : '';
    document.title = open.length ? `(${open.length}) Shift` : 'Shift';
  }

  function renderBanners() {
    const out = [];
    if (S.bufferError) {
      out.push(`<div class="banner error"><span>${esc(S.bufferError)}</span><a class="btn btn-sm" href="/?reconnect=1">Reconnect Buffer</a></div>`);
    }
    const disconnected = S.channels.filter((c) => c.isDisconnected);
    if (disconnected.length) {
      out.push(`<div class="banner warn">${esc(disconnected.map((c) => c.displayName || c.name).join(', '))} ${disconnected.length === 1 ? 'is' : 'are'} disconnected in Buffer, so ${disconnected.length === 1 ? 'it' : 'they'} can't publish until you reconnect ${disconnected.length === 1 ? 'it' : 'them'} there.</div>`);
    }
    $('banners').innerHTML = out.join('');
  }
  function dismissed(key) { try { return localStorage.getItem(`shift_dismiss_${key}`) === '1'; } catch { return false; } }


  // ---------- first-run setup ----------
  function setupState() {
    try { return JSON.parse(localStorage.getItem(`shift_setup_${S.org.id}`) || '{}'); } catch { return {}; }
  }
  function saveSetupState(patch) {
    try { localStorage.setItem(`shift_setup_${S.org.id}`, JSON.stringify({ ...setupState(), ...patch })); } catch {}
  }

  const VERBISH = new Set(('grab take ride rides come join bring make see sees meet book check visit enjoy learn find apply ' +
    'starts start every little great best first last next with your from they them their there here what this that ' +
    'just more most into over will would should could have has been being running runs open opens free ' +
    'around aboard about above below along away inside outside across through during until while ' +
    'today tonight weekend week day days time times minutes hours always never really very ' +
    'questions question link links early late cool fun cold warm hot').split(' '));
  const DETERMINERS = new Set(['the', 'a', 'an', 'our', 'your', 'this', 'that', 'these', 'those', 'new', 'baby']);

  // Three words from a real post that someone could plausibly report a problem with.
  function candidateWords(text) {
    // Keep sentence-ending punctuation as tokens so "Tickets" after "!" isn't read as a name.
    const raw = String(text || '').replace(/https?:\/\/\S+/g, ' ').match(/[A-Za-z']+|[.!?:]/g) || [];
    const seen = new Set();
    const scored = [];
    raw.forEach((w, idx) => {
      const lower = w.toLowerCase().replace(/'s$/, '').replace(/'/g, '');
      const root = ShiftMatch.stem(lower);
      if (!/[a-z]/i.test(w) || lower.length < 4 || seen.has(root) || VERBISH.has(lower)) return;
      if (!ShiftMatch.keywords(lower).size) return;
      seen.add(root);
      const prev = raw[idx - 1] || '';
      const sentenceStart = idx === 0 || /^[.!?:]$/.test(prev);
      const proper = /^[A-Z]/.test(w) && !sentenceStart;
      const afterDeterminer = DETERMINERS.has(prev.toLowerCase());
      const prev2 = raw[idx - 2] || '';
      const afterName = /^[A-Z]/.test(prev) && !DETERMINERS.has(prev.toLowerCase()) && idx > 1 && !/^[.!?:]$/.test(prev2);
      // Things people report broken are nouns: "the train", "Eagle train", "our pool".
      const score = Math.min(lower.length, 7) + (proper ? 3 : 0) + (afterDeterminer ? 3 : 0) + (afterName ? 4 : 0) - idx * 0.05;
      scored.push({ word: proper ? w : lower, score });
    });
    return scored.sort((a, b) => b.score - a.score).slice(0, 3).map((x) => x.word);
  }

  function setupSteps() {
    const st = setupState();
    const next = upcomingScheduled()[0];
    return [
      { done: S.channels.length > 0, title: 'Buffer connected',
        body: S.channels.length
          ? `${S.channels.length} ${S.channels.length === 1 ? 'channel' : 'channels'} from ${esc(S.org.name)}. Today's posts are on the right.`
          : 'No channels yet. Connect a social account in Buffer, then hit Refresh.' },
      { done: !!st.tried || S.items.length > 0, title: 'Watch it catch a real post',
        body: next
          ? `<span>Your next post goes out ${esc(fmtWhen(next.dueAt))} on ${esc(channelLabel(next.channelId))}: “${esc(next.text.slice(0, 80))}${next.text.length > 80 ? '…' : ''}”</span>
             <span class="setup-ask">Pretend something's wrong with:</span>
             <span class="setup-chips">${candidateWords(next.text).map((w) => `<button class="btn btn-sm" type="button" data-act="try" data-word="${esc(w)}">${esc(w)}</button>`).join('')}</span>`
          : `<span>Schedule a post in Buffer for later this week, then come back and file a report about it. Or try the form now.</span>
             <span class="setup-chips"><button class="btn btn-sm" type="button" data-act="report">Report something</button></span>` },
      { done: !!S.config?.groupmeBotId || !!st.linkCopied, title: 'Bring in your team',
        body: `<span>Your team reports from the GroupMe they already use, or from a link. They never need Buffer.</span>
               <span class="setup-chips"><button class="btn btn-sm btn-primary" type="button" data-open-settings>Set up GroupMe</button>
               <button class="btn btn-sm" type="button" data-act="copylink">Copy report link</button></span>` },
    ];
  }

  function renderSetup() {
    const card = $('setupCard');
    if (!S.config || setupState().hidden) { card.hidden = true; return; }
    const steps = setupSteps();
    const done = steps.filter((x) => x.done).length;
    if (done === steps.length) { card.hidden = true; return; }
    card.hidden = false;
    $('setupProgress').textContent = `${done} of ${steps.length} done`;
    const current = steps.findIndex((x) => !x.done);
    $('setupSteps').innerHTML = steps.map((x, i) => `<li class="setup-step${x.done ? ' done' : ''}${i === current ? ' current' : ''}">
        <span class="setup-mark" aria-hidden="true">${x.done ? '✓' : i + 1}</span>
        <div><h3>${esc(x.title)}${x.done ? '<span class="sr-only"> (done)</span>' : ''}</h3>${x.done && i !== current ? '' : `<p>${x.body}</p>`}</div>
      </li>`).join('');
  }

  async function trySample(word) {
    const { item } = await api('POST', {
      op: 'createItem', type: 'issue',
      text: `Sample report: ${word} is unavailable right now. Dismiss this when you're done.`,
    });
    replaceItem(item);
    saveSetupState({ tried: true });
    await refreshItems();
    render();
    const hit = (S.impacts.byItem.get(item.id) || [])[0];
    if (hit) {
      reviewItem(item.id);
      toast('See the amber post? That\'s Shift catching it before it goes out.');
    } else {
      toast('Sample filed. It didn\'t match a post this time; try a different word.');
    }
  }

  function channelLabel(channelId) {
    const c = S.channelById.get(channelId);
    if (!c) return 'a channel';
    return SERVICE_NAMES[c.service] || c.service;
  }
  function channelChip(channelId) {
    const c = S.channelById.get(channelId);
    if (!c) return '<span class="post-ch">Channel</span>';
    const img = c.avatar ? `<img src="${esc(c.avatar)}" alt="">` : '';
    return `<span class="post-ch">${img}${esc(SERVICE_NAMES[c.service] || c.service)} <span style="opacity:.75">${esc(c.displayName || c.name)}</span></span>`;
  }

  function filteredItems() {
    const list = S.items.filter((i) => i.type !== 'note');
    switch (S.filter) {
      case 'issue': return list.filter((i) => isOpen(i) && (i.type === 'issue' || i.type === 'update' || i.type === 'request'));
      case 'idea': return list.filter((i) => isOpen(i) && i.type === 'idea');
      case 'closed': return list.filter((i) => !isOpen(i));
      default: return list.filter(isOpen).sort((a, b) =>
        (b.priority === 'high') - (a.priority === 'high')
        || (S.impacts.byItem.has(b.id) - S.impacts.byItem.has(a.id))
        || String(b.createdAt).localeCompare(String(a.createdAt)));
    }
  }

  function renderInbox() {
    const items = filteredItems();
    $('inboxCount').textContent = S.items.filter((i) => isOpen(i) && i.type !== 'note').length || '';
    if (!items.length) {
      const msg = {
        open: S.config?.groupmeBotId
          ? '<strong>Nothing from the team right now.</strong>Reports from GroupMe and your report link land here as they come in.'
          : '<strong>Nothing from the team yet.</strong>Share your report link or set up GroupMe in Settings, or add something yourself with Report something.',
        issue: '<strong>No open issues.</strong>',
        idea: '<strong>No open ideas.</strong>Content ideas from the team show up here.',
        closed: '<strong>Nothing finished in the last week.</strong>',
      }[S.filter];
      $('inboxList').innerHTML = `<div class="empty">${msg}</div>`;
      return;
    }
    $('inboxList').innerHTML = items.map(itemHtml).join('');
  }

  function itemHtml(item) {
    const open = isOpen(item);
    const impacts = S.impacts.byItem.get(item.id) || [];
    const src = { groupme: 'GroupMe', form: 'report link', dashboard: 'Shift' }[item.source] || item.source;
    const impactHtml = impacts.length ? `<div class="impact">
        <strong>${impacts.length === 1 ? 'A scheduled post might be affected' : `${impacts.length} scheduled posts might be affected`}</strong>
        ${impacts.slice(0, 3).map(({ post, terms }) => `<span class="impact-post">${esc(fmtWhen(post.dueAt))} on ${esc(channelLabel(post.channelId))}: “${esc(post.text.slice(0, 70))}${post.text.length > 70 ? '…' : ''}” <span style="color:var(--amber)">mentions ${esc(terms.join(', '))}</span></span>`).join('')}
      </div>` : '';
    const trail = (item.linkedPosts || []).slice(-4).map((lp) =>
      `<span class="${lp.ok ? 'ok' : 'bad'}">${lp.ok ? '✓' : '✕'} ${esc(actionLabel(lp.action))}${lp.action === 'idea' ? '' : ` on ${esc(lp.channelName || SERVICE_NAMES[lp.service] || 'a channel')}`} at ${esc(fmtTime(lp.at))}${lp.ok ? '' : ` (${esc(lp.message)})`}</span>`).join('');

    let actions = '';
    if (open) {
      if (item.type === 'idea') {
        actions += item.bufferIdeaId
          ? '<span class="btn btn-sm" aria-disabled="true">In Buffer Ideas</span>'
          : `<button class="btn btn-sm" data-act="idea" data-id="${item.id}">Save to Buffer Ideas</button>`;
        actions += `<button class="btn btn-sm" data-act="compose" data-id="${item.id}">Draft a post</button>`;
      } else {
        actions += `<button class="btn btn-sm btn-primary" data-act="compose" data-id="${item.id}">Post an update</button>`;
        if (impacts.length) actions += `<button class="btn btn-sm" data-act="review" data-id="${item.id}">See affected posts</button>`;
      }
      if (item.status === 'new') actions += `<button class="btn btn-sm" data-act="status" data-status="in_progress" data-id="${item.id}">I'm on it</button>`;
      actions += `<button class="btn btn-sm" data-act="status" data-status="resolved" data-id="${item.id}">${item.type === 'issue' ? 'Resolved' : 'Done'}</button>`;
      actions += `<button class="btn btn-sm btn-quiet" data-act="status" data-status="dismissed" data-id="${item.id}">Dismiss</button>`;
    } else {
      actions = `<button class="btn btn-sm" data-act="status" data-status="new" data-id="${item.id}">Reopen</button>`;
    }

    return `<article class="item item-${esc(item.type)}${item.priority === 'high' && open ? ' item-urgent' : ''}${open ? '' : ' closed'}${S.fresh.has(item.id) ? ' fresh' : ''}" id="item-${item.id}">
      <div class="item-top">
        <span class="type type-${esc(item.type)}">${esc(TYPE_LABEL[item.type] || item.type)}</span>
        ${item.priority === 'high' ? '<span class="urgent">Urgent</span>' : ''}
        <span class="ref">${esc(item.ref)}</span>
        <span>${esc(item.submittedBy)} via ${esc(src)}, ${esc(ago(item.createdAt))}</span>
        ${item.status === 'in_progress' ? '<span>· in progress</span>' : ''}
        ${!open ? `<span>· ${esc(item.status)}</span>` : ''}
      </div>
      <p class="item-text">${esc(item.text)}</p>
      ${open ? impactHtml : ''}
      ${trail ? `<div class="trail">${trail}</div>` : ''}
      <div class="item-actions">${actions}</div>
    </article>`;
  }

  function actionLabel(action) {
    return {
      moved_to_draft: 'Moved to draft', restored: 'Put back on schedule', published: 'Published',
      queued: 'Added to queue', scheduled: 'Scheduled', drafted: 'Saved as draft', idea: 'Saved to Buffer Ideas',
    }[action] || action;
  }

  function renderNotes() {
    const notes = S.items.filter((i) => i.type === 'note' && isOpen(i))
      .sort((a, b) => String(a.dueAt || '9').localeCompare(String(b.dueAt || '9')) || String(a.createdAt).localeCompare(String(b.createdAt)));
    if (!notes.length) {
      $('notesList').innerHTML = '<div class="empty">No notes waiting. Leave one for whoever picks up the account next.</div>';
      return;
    }
    $('notesList').innerHTML = notes.map((n) => {
      const overdue = n.dueAt && new Date(n.dueAt) < Date.now();
      return `<div class="note">
        <p>${esc(n.text)}</p>
        <div class="note-meta">
          ${n.dueAt ? `<span class="note-due">${overdue ? 'Was due' : 'By'} ${esc(fmtWhen(n.dueAt))}</span>` : ''}
          <span>${esc(n.submittedBy)}, ${esc(ago(n.createdAt))}</span>
          <button class="btn btn-sm" data-act="compose" data-id="${n.id}">Schedule it</button>
          <button class="btn btn-sm btn-quiet" data-act="status" data-status="resolved" data-id="${n.id}">Done</button>
        </div>
      </div>`;
    }).join('');
  }

  function renderSchedule() {
    const today = dayKey(Date.now());
    const now = Date.now();
    const todays = S.posts.filter((p) => dayKey(p.dueAt || p.sentAt) === today);
    const upcoming = upcomingScheduled();
    $('schedCount').textContent = upcoming.length ? `${upcoming.length} in the next week` : '';

    if (S.bufferError && !S.lastBufferLoad) {
      $('todayBlock').innerHTML = `<div class="empty"><strong>Your schedule isn't loading.</strong>${esc(S.bufferError)}</div>`;
      $('weekBlock').innerHTML = ''; $('pulledBlock').innerHTML = '';
      return;
    }

    // Today: a rail with a live "now" marker between what's gone out and what's next.
    let rail = '';
    let nowPlaced = false;
    for (const p of todays) {
      const t = new Date(p.dueAt || p.sentAt).getTime();
      if (!nowPlaced && t > now) { rail += nowMarker(); nowPlaced = true; }
      rail += postStop(p, t <= now && p.status !== 'scheduled');
    }
    if (!nowPlaced) rail += nowMarker();
    $('todayBlock').innerHTML = `<div class="day-label"><h3>Today</h3><span>${esc(fmtDay(now))}</span></div>
      <ol class="rail">${rail}</ol>
      ${todays.length ? '' : '<div class="empty" style="margin-top:4px"><strong>Nothing scheduled today.</strong>Use New post to publish or schedule something from here.</div>'}`;

    // Rest of the week, grouped by day.
    const later = upcoming.filter((p) => dayKey(p.dueAt) !== today);
    const byDay = new Map();
    for (const p of later) {
      const k = dayKey(p.dueAt);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(p);
    }
    $('weekBlock').innerHTML = byDay.size
      ? [...byDay.entries()].map(([, posts]) => `<div class="week-day">
          <div class="day-label"><h3>${esc(fmtDay(posts[0].dueAt).split(',')[0])}</h3><span>${esc(fmtDay(posts[0].dueAt).split(', ').slice(1).join(', '))}</span></div>
          <ol class="rail">${posts.map((p) => postStop(p, false)).join('')}</ol></div>`).join('')
      : `<div class="week-day"><div class="day-label"><h3>Rest of the week</h3></div><div class="empty">Nothing else scheduled in the next ${DAYS_AHEAD} days.</div></div>`;

    // Posts Shift pulled back to draft, with a way to put them back.
    $('pulledBlock').innerHTML = S.pulled.length ? `<div class="week-day">
        <div class="day-label"><h3>Pulled from the schedule</h3><span>Sitting in Buffer drafts</span></div>
        <ol class="rail">${S.pulled.map((p) => postStop(p, false, true)).join('')}</ol></div>` : '';
  }

  function nowMarker() {
    return `<li class="now-marker" aria-label="Current time"><span>Now ${esc(fmtTime(Date.now()))}</span></li>`;
  }

  function postStop(p, past, pulled = false) {
    const impacts = S.impacts.byPost.get(p.id) || [];
    const flagged = impacts.length > 0 && !pulled;
    const when = p.dueAt || p.sentAt;
    const thumb = (p.assets || [])[0]?.thumbnail;
    const statusPill = p.status === 'sent' ? '<span class="status-pill sent">Sent</span>'
      : p.status === 'error' ? '<span class="status-pill error">Failed</span>'
      : p.status === 'needs_approval' ? '<span class="status-pill">Needs approval</span>'
      : p.status === 'sending' ? '<span class="status-pill">Sending</span>'
      : pulled ? '<span class="status-pill">Draft</span>' : '';
    let actions = '';
    if (pulled) {
      actions = `<button class="btn btn-sm" data-act="restore" data-post="${p.id}">${new Date(p.dueAt) > Date.now() ? `Put back at ${esc(fmtTime(p.dueAt))}` : 'Add back to queue'}</button>`;
    } else if (p.status === 'scheduled' && !past) {
      if ((p.allowedActions || []).includes('movePostToDraft')) {
        actions += `<button class="btn btn-sm ${flagged ? 'btn-primary' : 'btn-quiet'}" data-act="pull" data-post="${p.id}">Move to draft</button>`;
      }
    }
    const errorNote = p.status === 'error' && p.error?.message ? `<span class="flag-note" style="color:var(--red)">${esc(p.error.message)}</span>` : '';
    return `<li class="stop${past ? ' past' : ''}${flagged ? ' flagged' : ''}${p.status === 'error' ? ' errored' : ''}" id="post-${p.id}">
      <div class="post">
        <div class="post-meta"><span class="post-time">${esc(pulled ? fmtWhen(when) : fmtTime(when))}</span>${channelChip(p.channelId)}${statusPill}</div>
        ${flagged ? `<span class="flag-note">Might clash with ${impacts.map(({ item, terms }) => `${esc(item.ref)} (${esc(terms.join(', '))})`).join(', ')}</span>` : ''}
        ${errorNote}
        <p class="post-text">${thumb ? `<img class="post-thumb" src="${esc(thumb)}" alt="">` : ''}${esc(p.text || '(media only)')}</p>
        ${actions ? `<div class="post-actions">${actions}</div>` : ''}
      </div>
    </li>`;
  }

  function renderActivity() {
    const today = dayKey(Date.now());
    const list = S.activity.filter((a) => dayKey(a.at) === today).slice(0, 25);
    $('activityList').innerHTML = list.length
      ? list.map((a) => `<li><time datetime="${esc(a.at)}">${esc(fmtTime(a.at))}</time><span class="${a.ok ? '' : 'bad'}">${esc(a.who ? `${a.who}: ` : '')}${esc(a.text)}</span></li>`).join('')
      : '<li><span class="activity-empty">Nothing yet today. Reports, status changes, and every Buffer action taken in Shift are recorded here.</span></li>';
  }

  // ---------- refresh ----------
  async function refreshItems() {
    try {
      const data = await api('GET');
      if (data.setup) {
        S.config = data.config; S.items = data.items || []; S.activity = data.activity || [];
        noteArrivals();
      }
    } catch (err) {
      if (err.status === 401 || err.status === 403) S.bufferError = 'Buffer needs you to reconnect.';
    }
  }
  // Highlight reports that arrived since the last look, from GroupMe or the link.
  function noteArrivals() {
    const ids = new Set(S.items.map((i) => i.id));
    if (S.seenIds) {
      const arrived = S.items.filter((i) => !S.seenIds.has(i.id) && i.source !== 'dashboard');
      arrived.forEach((i) => S.fresh.add(i.id));
      if (arrived.length === 1) toast(`New ${TYPE_LABEL[arrived[0].type].toLowerCase()} from ${arrived[0].submittedBy}`);
      else if (arrived.length > 1) toast(`${arrived.length} new reports from the team`);
      if (arrived.length) setTimeout(() => { arrived.forEach((i) => S.fresh.delete(i.id)); }, 6000);
    }
    S.seenIds = ids;
  }

  async function refreshAll(force = false) {
    await refreshItems();
    if (force || Date.now() - S.lastBufferLoad > BUFFER_POLL_MS) await loadBuffer();
    render();
  }

  // ---------- item actions ----------
  function findItem(id) { return S.items.find((i) => i.id === id); }
  function findPost(id) { return S.posts.find((p) => p.id === id) || S.pulled.find((p) => p.id === id); }

  function replaceItem(item) {
    const idx = S.items.findIndex((i) => i.id === item.id);
    if (idx >= 0) S.items[idx] = item; else S.items.unshift(item);
  }

  async function setStatus(id, status) {
    const { item } = await api('POST', { op: 'updateItem', id, patch: { status } });
    replaceItem(item);
    await refreshItems();
    render();
    toast({ resolved: `${item.ref} marked resolved`, dismissed: `${item.ref} dismissed`, in_progress: `${item.ref} is yours`, new: `${item.ref} reopened` }[status] || 'Updated');
  }

  async function saveIdea(id) {
    const item = findItem(id);
    const d = await gql(`mutation($input: CreateIdeaInput!){ createIdea(input:$input){ __typename
        ... on Idea { id } ... on IdeaResponse { idea { id } } ... on MutationError { message } } }`, {
      input: { organizationId: S.org.id, content: { title: item.text.slice(0, 80), text: `${item.text}\n\n(From ${item.submittedBy} via Shift, ${item.ref})` } },
    });
    const r = d.createIdea;
    const ideaId = r.id || r.idea?.id;
    if (!ideaId) throw new Error(r.message || "Buffer didn't save the idea.");
    const res = await api('POST', { op: 'updateItem', id, patch: { bufferIdeaId: ideaId, linkPost: { action: 'idea', label: 'Saved to Buffer Ideas', channelName: 'Buffer Ideas', ok: true } } });
    replaceItem(res.item);
    await refreshItems();
    render();
    toast('Saved to Buffer Ideas');
  }

  function reviewItem(id) {
    const impacts = S.impacts.byItem.get(id) || [];
    if (!impacts.length) return;
    setTab('schedule');
    const el = $(`post-${impacts[0].post.id}`);
    if (el) el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
  }

  // ---------- confirm dialog ----------
  function confirmAction({ title, lead, preview, okLabel, danger, links }) {
    return new Promise((resolve) => {
      const dlg = $('confirmDlg');
      $('confirmTitle').textContent = title;
      $('confirmLead').innerHTML = lead;
      $('confirmPreview').textContent = preview;
      $('confirmOk').textContent = okLabel;
      $('confirmOk').className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
      const linkField = $('confirmLinkField');
      if (links && links.length) {
        linkField.hidden = false;
        $('confirmLink').innerHTML = links.map((l) => `<option value="${esc(l.id)}">${esc(l.label)}</option>`).join('') + '<option value="">Don\'t attach to anything</option>';
      } else linkField.hidden = true;
      const done = (ok) => {
        $('confirmOk').onclick = null; $('confirmCancel').onclick = null; dlg.onclose = null;
        if (dlg.open) dlg.close();
        resolve(ok ? { link: links && links.length ? $('confirmLink').value : '' } : null);
      };
      $('confirmOk').onclick = () => done(true);
      $('confirmCancel').onclick = () => done(false);
      dlg.onclose = () => done(false);
      dlg.showModal();
    });
  }

  // Buffer's editPost replaces text and media with whatever is sent, so the
  // post's current text and media always go along with the change.
  function assetInputs(post) {
    const out = [];
    for (const a of post.assets || []) {
      if (a.__typename === 'ImageAsset' || a.type === 'image') out.push({ image: { url: a.source, metadata: { altText: a.image?.altText || '' } } });
      else if (a.__typename === 'VideoAsset' || a.type === 'video') out.push({ video: { url: a.source, ...(a.video?.title ? { metadata: { title: a.video.title } } : {}) } });
      else if (a.__typename === 'DocumentAsset' || a.type === 'document') out.push({ document: { url: a.source, thumbnailUrl: a.thumbnail, title: a.document?.title || 'Document' } });
    }
    return out;
  }

  const EDIT_MUTATION = `mutation($input: EditPostInput!){ editPost(input:$input){ __typename
      ... on PostActionSuccess { post { ${POST_FIELDS} } } ... on MutationError { message } } }`;

  async function pullPost(postId) {
    const post = findPost(postId);
    if (!post) return;
    const impacts = S.impacts.byPost.get(postId) || [];
    const openItems = S.items.filter((i) => isOpen(i) && i.type !== 'note');
    const links = [
      ...impacts.map(({ item }) => item),
      ...openItems.filter((i) => !impacts.some(({ item }) => item.id === i.id)),
    ].map((i) => ({ id: i.id, label: `${i.ref}: ${i.text.slice(0, 60)}` }));
    const ch = S.channelById.get(post.channelId);
    const ok = await confirmAction({
      title: 'Move this post to draft?',
      lead: `It won't go out at <strong>${esc(fmtWhen(post.dueAt))}</strong> on <strong>${esc(SERVICE_NAMES[ch?.service] || 'its channel')} (${esc(ch?.displayName || ch?.name || '')})</strong>. It stays in Buffer as a draft, and you can put it back from Shift.`,
      preview: post.text,
      okLabel: 'Move to draft',
      links,
    });
    if (!ok) return;

    const input = { id: post.id, saveToDraft: true, text: post.text || '', assets: assetInputs(post) };
    let success = false; let message = '';
    try {
      const d = await gql(EDIT_MUTATION, { input });
      const r = d.editPost;
      success = r.__typename === 'PostActionSuccess' && r.post?.status === 'draft';
      message = success ? '' : (r.message || `Buffer returned ${r.post?.status || 'an unexpected result'}`);
    } catch (err) { message = err.message; }

    await recordPostAction({
      itemId: ok.link, post, action: 'moved_to_draft', ok: success, message, originalDueAt: post.dueAt,
    });
    if (success && !ok.link) setLocalPulled(post.id, { at: new Date().toISOString(), originalDueAt: post.dueAt });
    toast(success ? `Moved to draft. It won't go out at ${fmtTime(post.dueAt)}.` : `Buffer didn't move it: ${message}`);
    await Promise.all([loadBuffer(), refreshItems()]);
    render();
  }

  async function restorePost(postId) {
    const post = findPost(postId);
    if (!post) return;
    const future = post.dueAt && new Date(post.dueAt) > Date.now();
    const ch = S.channelById.get(post.channelId);
    const ok = await confirmAction({
      title: future ? 'Put this post back on the schedule?' : 'Add this post back to the queue?',
      lead: future
        ? `It will go out at <strong>${esc(fmtWhen(post.dueAt))}</strong> on <strong>${esc(SERVICE_NAMES[ch?.service] || 'its channel')}</strong>, its original time.`
        : `Its original time has passed, so it goes to the next open slot in the <strong>${esc(SERVICE_NAMES[ch?.service] || '')}</strong> queue.`,
      preview: post.text,
      okLabel: future ? 'Put it back' : 'Add to queue',
    });
    if (!ok) return;
    const input = {
      id: post.id, saveToDraft: false, text: post.text || '', assets: assetInputs(post),
      schedulingType: post.schedulingType || 'automatic',
      ...(future ? { mode: 'customScheduled', dueAt: post.dueAt } : { mode: 'addToQueue' }),
    };
    let success = false; let message = '';
    try {
      const d = await gql(EDIT_MUTATION, { input });
      const r = d.editPost;
      success = r.__typename === 'PostActionSuccess' && r.post?.status !== 'draft';
      message = success ? '' : (r.message || 'Buffer kept it as a draft');
    } catch (err) { message = err.message; }

    const owner = S.items.find((i) => (i.linkedPosts || []).some((lp) => lp.postId === post.id && lp.action === 'moved_to_draft'));
    await recordPostAction({ itemId: owner?.id || '', post, action: 'restored', ok: success, message, originalDueAt: post.dueAt });
    if (success) setLocalPulled(post.id, null);
    toast(success ? 'Back on the schedule' : `Buffer didn't restore it: ${message}`);
    await Promise.all([loadBuffer(), refreshItems()]);
    render();
  }

  async function recordPostAction({ itemId, post, channelId, action, ok, message, originalDueAt, textPreview }) {
    const cid = channelId || post?.channelId;
    const ch = S.channelById.get(cid);
    const linkPost = {
      postId: post?.id || '', channelId: cid, channelName: ch ? `${SERVICE_NAMES[ch.service] || ch.service}` : '',
      service: ch?.service || '', action, label: actionLabel(action), originalDueAt: originalDueAt || '',
      textPreview: (textPreview || post?.text || '').slice(0, 180), ok, message: message || '',
    };
    try {
      if (itemId) {
        const res = await api('POST', { op: 'updateItem', id: itemId, patch: { linkPost } });
        replaceItem(res.item);
      } else {
        await api('POST', { op: 'log', ok, text: `${actionLabel(action)} on ${linkPost.channelName || 'a channel'}${ok ? '' : ` — failed: ${message}`}: “${linkPost.textPreview.slice(0, 80)}”` });
      }
    } catch (err) {
      console.warn('Shift could not record the action', err);
    }
  }

  // ---------- Uplink composer ----------
  const compose = { item: null };

  function openCompose(itemId) {
    const item = itemId ? findItem(itemId) : null;
    compose.item = item;
    const dlg = $('composeDlg');
    showComposeStep(1);
    const ctx = $('composeContext');
    if (item) {
      ctx.hidden = false;
      ctx.innerHTML = `<strong>${esc(TYPE_LABEL[item.type])} ${esc(item.ref)}</strong> from ${esc(item.submittedBy)}: ${esc(item.text)}`;
    } else ctx.hidden = true;
    $('composeTitle').textContent = item?.type === 'idea' ? 'Draft a post' : item?.type === 'note' ? 'Schedule it' : 'Post an update';

    const usable = S.channels.filter((c) => !c.isDisconnected);
    // Nothing is pre-selected for public updates: picking channels is part of
    // the decision. Drafts are low-stakes, so those start with text channels on.
    const preselect = (c) => usable.length === 1 || (item?.type === 'idea' && !MEDIA_FIRST.has(c.service));
    $('composeChannels').innerHTML = usable.length ? usable.map((c) => {
      const mediaFirst = MEDIA_FIRST.has(c.service);
      return `<label><input type="checkbox" name="ch" value="${esc(c.id)}"${preselect(c) ? ' checked' : ''}>
        ${c.avatar ? `<img src="${esc(c.avatar)}" alt="">` : ''}
        <span>${esc(SERVICE_NAMES[c.service] || c.service)} <span style="color:var(--muted)">${esc(c.displayName || c.name)}</span></span>
        <span class="hint">${mediaFirst ? 'Needs an image or video' : `${limitFor(c)} characters`}</span></label>`;
    }).join('') : '<div class="empty">No connected channels in this Buffer organization.</div>';

    let text = '';
    if (item?.type === 'issue' || item?.type === 'update') text = `Heads up: ${item.text}`;
    else if (item) text = item.text;
    $('composeText').value = text;
    const defaultWhen = item?.type === 'idea' ? 'draft' : item?.type === 'note' ? 'customScheduled' : 'shareNow';
    document.querySelector(`#composeWhen input[value="${defaultWhen}"]`).checked = true;
    $('composeTime').value = item?.dueAt ? toLocalInput(item.dueAt) : toLocalInput(Date.now() + 3600e3);
    syncComposeWhen();
    updateCounter();
    dlg.showModal();
    $('composeText').focus();
  }

  function toLocalInput(date) {
    const d = new Date(date);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function selectedChannels() {
    return [...document.querySelectorAll('#composeChannels input:checked')].map((i) => S.channelById.get(i.value)).filter(Boolean);
  }
  function whenValue() { return document.querySelector('#composeWhen input:checked')?.value || 'shareNow'; }
  function syncComposeWhen() { $('composeTimeField').hidden = whenValue() !== 'customScheduled'; }

  function updateCounter() {
    const len = [...$('composeText').value].length;
    const chans = selectedChannels();
    const tight = chans.length ? Math.min(...chans.map(limitFor)) : 0;
    const tightest = chans.find((c) => limitFor(c) === tight);
    const el = $('composeCounter');
    el.textContent = tight ? `${len} / ${tight}${tightest ? ` (${SERVICE_NAMES[tightest.service] || tightest.service})` : ''}` : `${len}`;
    el.classList.toggle('over', tight && len > tight);
  }

  function showComposeStep(n) {
    $('composeStep1').hidden = n !== 1;
    $('composeStep2').hidden = n !== 2;
    $('composeStep3').hidden = n !== 3;
  }

  const WHEN_COPY = {
    shareNow: { button: 'Publish now', lead: 'This publishes immediately. It can\'t be unsent from Shift.' },
    addToQueue: { button: 'Add to queue', lead: 'This goes into each channel\'s next open Buffer slot.' },
    customScheduled: { button: 'Schedule', lead: '' },
    draft: { button: 'Save as draft', lead: 'This saves a draft in Buffer. Nothing is published.' },
  };

  function reviewCompose() {
    const chans = selectedChannels();
    const text = $('composeText').value.trim();
    const when = whenValue();
    if (!chans.length) return toast('Pick at least one channel');
    if (!text) return toast('Write a message first');
    const over = chans.filter((c) => [...text].length > limitFor(c));
    if (over.length) return toast(`Too long for ${over.map((c) => SERVICE_NAMES[c.service]).join(', ')}`);
    let lead = WHEN_COPY[when].lead;
    if (when === 'customScheduled') {
      const t = new Date($('composeTime').value);
      if (!(t > Date.now())) return toast('Pick a time in the future');
      lead = `This goes out ${fmtWhen(t)} (${S.timezone.replace('_', ' ')}).`;
    }
    $('composeConfirmLead').innerHTML = `<strong>${esc(lead)}</strong>`;
    $('composeConfirmList').innerHTML = chans.map((c) => `<li>${channelChip(c.id)}${MEDIA_FIRST.has(c.service) ? '<br><small style="color:var(--amber)">This channel usually needs an image or video. Buffer will tell you if it rejects a text-only post.</small>' : ''}</li>`).join('');
    $('composeConfirmText').textContent = text;
    $('composeSend').textContent = WHEN_COPY[when].button;
    $('composeSend').className = `btn ${when === 'shareNow' ? 'btn-danger' : 'btn-primary'}`;
    showComposeStep(2);
  }

  async function sendCompose() {
    const chans = selectedChannels();
    const text = $('composeText').value.trim();
    const when = whenValue();
    const btn = $('composeSend');
    btn.disabled = true;
    btn.textContent = 'Sending to Buffer…';
    const results = [];
    for (const c of chans) {
      const input = { channelId: c.id, text, schedulingType: 'automatic', source: 'shift' };
      if (when === 'draft') { input.mode = 'addToQueue'; input.saveToDraft = true; }
      else if (when === 'customScheduled') { input.mode = 'customScheduled'; input.dueAt = new Date($('composeTime').value).toISOString(); }
      else input.mode = when;
      let ok = false; let message = ''; let post = null;
      try {
        const d = await gql(`mutation($input: CreatePostInput!){ createPost(input:$input){ __typename
            ... on PostActionSuccess { post { id status dueAt sentAt channelId text } } ... on MutationError { message } } }`, { input });
        const r = d.createPost;
        ok = r.__typename === 'PostActionSuccess';
        post = r.post || null;
        message = ok ? '' : (r.message || 'Buffer rejected the post');
      } catch (err) { message = err.message; }
      const action = { shareNow: 'published', addToQueue: 'queued', customScheduled: 'scheduled', draft: 'drafted' }[when];
      results.push({ channel: c, ok, message, post, action });
      await recordPostAction({ itemId: compose.item?.id || '', post, channelId: c.id, action, ok, message, textPreview: text });
    }
    if (compose.item && compose.item.status === 'new' && results.some((r) => r.ok)) {
      try { const res = await api('POST', { op: 'updateItem', id: compose.item.id, patch: { status: 'in_progress' } }); replaceItem(res.item); } catch {}
    }
    btn.disabled = false;
    $('composeResults').innerHTML = results.map((r) => {
      let line;
      if (!r.ok) line = `Buffer didn't accept it: ${r.message}`;
      else if (r.action === 'published') line = r.post?.status === 'sent' ? 'Published' : `Sent to Buffer to publish now (status: ${r.post?.status || 'sending'})`;
      else if (r.action === 'scheduled' || r.action === 'queued') line = r.post?.dueAt ? `Scheduled for ${fmtWhen(r.post.dueAt)}` : 'Added to the queue';
      else line = 'Saved as a Buffer draft';
      return `<li class="${r.ok ? 'ok' : 'bad'}"><strong>${esc(SERVICE_NAMES[r.channel.service] || r.channel.service)}</strong> ${esc(r.channel.displayName || r.channel.name)}: ${esc(line)}</li>`;
    }).join('');
    showComposeStep(3);
    await Promise.all([loadBuffer(), refreshItems()]);
    render();
  }

  // ---------- report something ----------
  function openReport(type = 'issue') {
    const form = $('reportForm');
    form.reset();
    const radio = form.querySelector(`input[name=type][value="${type}"]`);
    if (radio) radio.checked = true;
    $('reportDueField').hidden = type !== 'note';
    $('reportDlg').showModal();
    form.querySelector('textarea').focus();
  }

  async function submitReport(e) {
    e.preventDefault();
    if (e.submitter?.value === 'cancel') { $('reportDlg').close(); return; }
    const form = $('reportForm');
    const fd = new FormData(form);
    const text = String(fd.get('text') || '').trim();
    if (text.length < 2) return toast('Add a few words first');
    const type = fd.get('type');
    const dueRaw = fd.get('dueAt');
    $('reportSubmit').disabled = true;
    try {
      const { item } = await api('POST', {
        op: 'createItem', type, text, priority: fd.get('urgent') ? 'high' : 'normal',
        dueAt: type === 'note' && dueRaw ? new Date(dueRaw).toISOString() : '',
      });
      replaceItem(item);
      $('reportDlg').close();
      await refreshItems();
      render();
      toast(`${TYPE_LABEL[item.type]} ${item.ref} added`);
    } catch (err) { toast(err.message); }
    finally { $('reportSubmit').disabled = false; }
  }

  async function quickNote(e) {
    e.preventDefault();
    const input = $('quickNoteText');
    const text = input.value.trim();
    if (text.length < 2) return;
    try {
      const { item } = await api('POST', { op: 'createItem', type: 'note', text });
      replaceItem(item);
      input.value = '';
      await refreshItems();
      render();
      toast('Note left for next shift');
    } catch (err) { toast(err.message); }
  }

  // ---------- handoff ----------
  function buildHandoff() {
    const lines = [];
    const now = Date.now();
    lines.push(`Shift handoff: ${S.config?.teamName || S.org?.name}`);
    lines.push(`${fmtDay(now)}, ${fmtTime(now)}`);
    const open = S.items.filter((i) => isOpen(i) && i.type !== 'note');
    const section = (title, rows) => { lines.push('', `${title}${rows.length ? ` (${rows.length})` : ''}`); lines.push(...(rows.length ? rows : ['- None'])); };
    const itemLine = (i) => {
      const acts = (i.linkedPosts || []).filter((lp) => lp.ok).map((lp) => lp.action === 'idea' ? 'saved to Buffer Ideas' : `${actionLabel(lp.action).toLowerCase()} on ${lp.channelName || 'a channel'}`);
      const flagged = (S.impacts.byItem.get(i.id) || []).length;
      return `- ${i.ref}${i.priority === 'high' ? ' URGENT' : ''} ${TYPE_LABEL[i.type]}: ${i.text} (${i.submittedBy}, ${fmtWhen(i.createdAt)}${i.status === 'in_progress' ? ', in progress' : ''})`
        + (acts.length ? `\n    Done so far: ${acts.join('; ')}` : '')
        + (flagged ? `\n    Still might affect ${flagged} scheduled ${flagged === 1 ? 'post' : 'posts'}` : '');
    };
    section('Open issues and updates', open.filter((i) => i.type !== 'idea').map(itemLine));
    section('Content ideas waiting', open.filter((i) => i.type === 'idea').map(itemLine));
    section('Notes for next shift', S.items.filter((i) => isOpen(i) && i.type === 'note').map((n) => `- ${n.text}${n.dueAt ? ` (by ${fmtWhen(n.dueAt)})` : ''} (${n.submittedBy})`));
    const today = dayKey(now);
    section('Still going out today', upcomingScheduled().filter((p) => dayKey(p.dueAt) === today).map((p) => `- ${fmtTime(p.dueAt)} ${channelLabel(p.channelId)}: ${p.text.slice(0, 90).replace(/\n/g, ' ')}${p.text.length > 90 ? '…' : ''}`));
    section('Pulled from the schedule (in Buffer drafts)', S.pulled.map((p) => `- Was ${fmtWhen(p.dueAt)} ${channelLabel(p.channelId)}: ${p.text.slice(0, 90).replace(/\n/g, ' ')}`));
    section('Closed today', S.items.filter((i) => !isOpen(i) && dayKey(i.updatedAt) === today).map((i) => `- ${i.ref} ${TYPE_LABEL[i.type]} ${i.status}: ${i.text.slice(0, 80)}`));
    return lines.join('\n');
  }

  // ---------- settings ----------
  function openSettings() {
    const c = S.config || {};
    $('setTeamName').value = c.teamName || '';
    $('setIntakeUrl').value = c.intakeUrl || '';
    $('setCallbackUrl').value = c.groupmeCallbackUrl || '';
    $('setBotId').value = c.groupmeBotId || '';
    $('setTerms').value = (c.relatedTerms || []).map((g) => g.join(', ')).join('\n');
    const lastGm = S.items.filter((i) => i.source === 'groupme').sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    $('setGmStatus').textContent = lastGm
      ? `Last report from GroupMe: ${lastGm.submittedBy}, ${ago(lastGm.createdAt)}.`
      : (c.groupmeBotId ? 'No reports from GroupMe yet. Try /shift help in the group.' : '');
    const theme = storedTheme();
    document.querySelector(`#setTheme input[value="${theme}"]`).checked = true;
    $('settingsDlg').showModal();
  }

  async function saveSettings(rotateKey = false) {
    const relatedTerms = $('setTerms').value.split('\n').map((l) => l.split(',').map((t) => t.trim()).filter(Boolean)).filter((g) => g.length >= 2);
    try {
      const { config } = await api('POST', {
        op: 'saveSettings', teamName: $('setTeamName').value, groupmeBotId: $('setBotId').value.trim(), relatedTerms, rotateKey,
      });
      S.config = config;
      const theme = document.querySelector('#setTheme input:checked')?.value || 'system';
      try { localStorage.setItem('shift_theme', theme); } catch {}
      applyTheme(theme);
      render();
      if (rotateKey) { $('setIntakeUrl').value = config.intakeUrl; $('setCallbackUrl').value = config.groupmeCallbackUrl; toast('New link created. Update your GroupMe bot callback.'); }
      else { $('settingsDlg').close(); toast('Settings saved'); }
    } catch (err) { toast(err.message); }
  }

  // ---------- tabs (mobile) ----------
  function setTab(tab) {
    $('board').dataset.tab = tab;
    document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  }

  // ---------- events ----------
  function wire() {
    document.addEventListener('click', async (e) => {
      const t = e.target.closest('[data-act], [data-close], [data-open-settings], [data-dismiss], [data-copy], [data-filter], .tabs button');
      if (!t) return;
      if (t.matches('[data-close]')) { t.closest('dialog')?.close(); return; }
      if (t.matches('[data-open-settings]')) { openSettings(); return; }
      if (t.matches('[data-dismiss]')) { try { localStorage.setItem(`shift_dismiss_${t.dataset.dismiss}`, '1'); } catch {} renderBanners(); return; }
      if (t.matches('[data-copy]')) { copy($(t.dataset.copy).value); return; }
      if (t.matches('[data-filter]')) {
        S.filter = t.dataset.filter;
        document.querySelectorAll('[data-filter]').forEach((b) => b.setAttribute('aria-pressed', String(b === t)));
        renderInbox();
        return;
      }
      if (t.matches('.tabs button')) { setTab(t.dataset.tab); return; }
      if (S.busy) return;
      S.busy = true;
      t.disabled = true;
      try {
        switch (t.dataset.act) {
          case 'status': await setStatus(t.dataset.id, t.dataset.status); break;
          case 'idea': await saveIdea(t.dataset.id); break;
          case 'compose': openCompose(t.dataset.id); break;
          case 'review': reviewItem(t.dataset.id); break;
          case 'pull': await pullPost(t.dataset.post); break;
          case 'restore': await restorePost(t.dataset.post); break;
          case 'try': await trySample(t.dataset.word); break;
          case 'report': openReport(); break;
          case 'copylink': await copy(S.config?.intakeUrl || ''); saveSetupState({ linkCopied: true }); renderSetup(); break;
        }
      } catch (err) {
        toast(err.message || 'Something went wrong');
      } finally {
        S.busy = false;
        t.disabled = false;
      }
    });

    $('reportBtn').addEventListener('click', () => openReport());
    $('reportForm').addEventListener('submit', submitReport);
    $('reportTypes').addEventListener('change', (e) => { $('reportDueField').hidden = e.target.value !== 'note'; });
    $('quickNote').addEventListener('submit', quickNote);
    $('composeBtn').addEventListener('click', () => openCompose(null));
    $('composeWhen').addEventListener('change', syncComposeWhen);
    $('composeText').addEventListener('input', updateCounter);
    $('composeChannels').addEventListener('change', updateCounter);
    $('composeReview').addEventListener('click', reviewCompose);
    $('composeBack').addEventListener('click', () => showComposeStep(1));
    $('composeSend').addEventListener('click', sendCompose);
    $('handoffBtn').addEventListener('click', () => { $('handoffText').value = buildHandoff(); $('handoffDlg').showModal(); });
    $('handoffCopy').addEventListener('click', () => copy($('handoffText').value));
    $('settingsBtn').addEventListener('click', openSettings);
    $('setSave').addEventListener('click', () => saveSettings(false));
    $('setHello').addEventListener('click', async () => {
      const btn = $('setHello');
      if (!$('setBotId').value.trim()) { $('setGmStatus').textContent = 'Paste the bot ID from dev.groupme.com/bots first.'; return; }
      btn.disabled = true;
      $('setGmStatus').textContent = 'Saving and sending a hello to your group…';
      try {
        const { config } = await api('POST', { op: 'saveSettings', groupmeBotId: $('setBotId').value.trim() });
        S.config = config;
        await api('POST', { op: 'groupmeHello' });
        $('setGmStatus').textContent = '✓ Connected. Check your group for a hello from Shift, then try /shift help.';
        render();
      } catch (err) {
        $('setGmStatus').textContent = err.message;
      } finally { btn.disabled = false; }
    });
    $('setupHide').addEventListener('click', () => { saveSetupState({ hidden: true }); renderSetup(); toast('Setup hidden. Settings has everything you need.'); });
    $('setRotate').addEventListener('click', () => {
      if (confirm('Reset the report link? The old link and your GroupMe bot callback stop working until you paste the new one.')) saveSettings(true);
    });
    $('setDisconnect').addEventListener('click', () => {
      if (!confirm('Disconnect Buffer on this device? Your inbox and notes stay in Shift.')) return;
      BufferConnection.clearTokens();
      location.href = '/';
    });
    $('refreshBtn').addEventListener('click', async () => { $('refreshBtn').disabled = true; await refreshAll(true); $('refreshBtn').disabled = false; toast('Up to date'); });
    $('orgSelect').addEventListener('change', async (e) => {
      S.org = S.orgs.find((o) => o.id === e.target.value);
      try { localStorage.setItem('shift_org', S.org.id); } catch {}
      limitsLoadedFor = ''; S.limits.clear();
      S.items = []; S.posts = []; S.pulled = []; S.channels = [];
      render();
      await loadWorkspace();
      await loadBuffer();
      render();
    });

    setInterval(() => { if (!document.hidden) refreshAll(false); }, ITEM_POLL_MS);
    setInterval(() => { if (!document.hidden) renderSchedule(); }, 60000); // keeps "now" honest
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshAll(false); });
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('Copied'); }
    catch { toast('Select the text and copy it manually'); }
  }

  // ---------- boot ----------
  async function boot() {
    const cfg = await fetch('/api/config').then((r) => r.json()).catch(() => ({}));
    BufferConnection.init({ prefix: PREFIX, clientId: cfg.bufferClientId || '', tokenEndpoint: TOKEN_ENDPOINT });
    if (!BufferConnection.hasConnection()) { location.replace('/'); return; }
    wire();
    try {
      await loadAccount();
    } catch (err) {
      S.bufferError = err.code === 'NO_TOKEN' || err.code === 'AUTH_ERROR' || err.code === 'REFRESH_FAILED'
        ? 'Buffer needs you to reconnect.' : `Couldn't reach Buffer: ${err.message}`;
      $('headline').textContent = 'Shift can\'t reach Buffer';
      renderBanners();
      return;
    }
    if (!S.org) {
      $('headline').textContent = 'No Buffer organization found';
      $('subline').textContent = 'Create an organization in Buffer, then refresh.';
      return;
    }
    try {
      await Promise.all([loadWorkspace(), loadBuffer()]);
    } catch (err) {
      $('banners').innerHTML = `<div class="banner error">${esc(err.message)}</div>`;
    }
    render();
    if (S.firstRun) toast(`Welcome to Shift. Your workspace for ${S.org.name} is ready.`);
  }

  boot();
})();
