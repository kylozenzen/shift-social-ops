// Server tests: real Netlify Blobs (local server), mocked Buffer + GroupMe.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlobsServer } from '@netlify/blobs/server';

const ORG_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const ORG_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const ACCOUNTS = {
  'token-ben': { id: 'u1', name: 'Ben', organizations: [{ id: ORG_A, name: 'San Antonio Zoo' }] },
  'token-other': { id: 'u2', name: 'Other', organizations: [{ id: ORG_B, name: 'Other Org' }] },
};

let server;
let lib; let api; let groupme; let intake;
const groupmePosts = [];
const realFetch = globalThis.fetch;

before(async () => {
  const directory = mkdtempSync(join(tmpdir(), 'shift-blobs-'));
  server = new BlobsServer({ directory, token: 'test', port: 0 });
  const { port } = await server.start();
  process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify({
    edgeURL: `http://localhost:${port}`, uncachedEdgeURL: `http://localhost:${port}`, siteID: 'shift-test', token: 'test',
  })).toString('base64');

  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u === 'https://api.buffer.com') {
      const tok = (opts.headers?.Authorization || '').replace('Bearer ', '');
      const account = ACCOUNTS[tok];
      return new Response(JSON.stringify(account ? { data: { account } } : { errors: [{ message: 'Unauthorized' }] }), { status: account ? 200 : 401 });
    }
    if (u === 'https://api.groupme.com/v3/bots/post') {
      groupmePosts.push(JSON.parse(opts.body));
      return new Response('', { status: 202 });
    }
    return realFetch(url, opts);
  };

  lib = await import('../netlify/functions/_lib.mjs');
  api = (await import('../netlify/functions/api.mjs')).default;
  groupme = (await import('../netlify/functions/groupme.mjs')).default;
  intake = (await import('../netlify/functions/intake.mjs')).default;
});

after(async () => {
  globalThis.fetch = realFetch;
  await server.stop();
});

beforeEach(() => { groupmePosts.length = 0; });

const req = (path, { method = 'GET', token, body } = {}) => new Request(`https://shift.test${path}`, {
  method,
  headers: { ...(token ? { 'x-buffer-token': token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});
const call = async (fn, ...a) => { const r = await fn(req(...a), { ip: '1.2.3.4' }); return { status: r.status, body: await r.json() }; };

// ---------- parser ----------
test('parses /shift commands', () => {
  const p = lib.parseShiftCommand;
  assert.equal(p('hey team, lunch?'), null);
  assert.deepEqual(p('/shift issue Train is down until 3pm'), { kind: 'item', type: 'issue', priority: 'normal', text: 'Train is down until 3pm' });
  assert.deepEqual(p('/shift issue! Pool closed'), { kind: 'item', type: 'issue', priority: 'high', text: 'Pool closed' });
  assert.deepEqual(p('/Shift urgent lost child at the carousel'), { kind: 'item', type: 'issue', priority: 'high', text: 'lost child at the carousel' });
  assert.equal(p('/shift idea Giraffe zoomies at 10').type, 'idea');
  assert.equal(p('/shift note Schedule the CEO post at 5').type, 'note');
  assert.equal(p('/shift handoff check DMs').type, 'note');
  assert.deepEqual(p('/shift Gates open late Saturday'), { kind: 'item', type: 'update', priority: 'normal', text: 'Gates open late Saturday' });
  assert.equal(p('/shift down: the train').text, 'down: the train');
  assert.equal(p('/shift down: the train').type, 'issue');
  assert.deepEqual(p('/shift'), { kind: 'help' });
  assert.deepEqual(p('/shift help'), { kind: 'help' });
  assert.deepEqual(p('/shift status'), { kind: 'status' });
  assert.equal(p('/shiftless nonsense'), null);
});

// ---------- authorization ----------
test('rejects requests without a Buffer token', async () => {
  const r = await call(api, `/api/ws?org=${ORG_A}`);
  assert.equal(r.status, 401);
});

test('rejects a token that cannot see the workspace', async () => {
  const r = await call(api, `/api/ws?org=${ORG_A}`, { token: 'token-other' });
  assert.equal(r.status, 403);
});

test('rejects an invalid token', async () => {
  const r = await call(api, `/api/ws?org=${ORG_A}`, { token: 'nope' });
  assert.equal(r.status, 401);
});

// ---------- the full demo path ----------
let intakeKey = '';
test('first visit sets up the workspace', async () => {
  let r = await call(api, `/api/ws?org=${ORG_A}`, { token: 'token-ben' });
  assert.equal(r.body.setup, false);
  r = await call(api, '/api/ws', { method: 'POST', token: 'token-ben', body: { org: ORG_A, op: 'init' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.config.teamName, 'San Antonio Zoo');
  intakeKey = new URL(r.body.config.groupmeCallbackUrl).searchParams.get('k');
  assert.ok(intakeKey.length > 20);
  // init twice keeps the same key
  const again = await call(api, '/api/ws', { method: 'POST', token: 'token-ben', body: { org: ORG_A, op: 'init' } });
  assert.equal(again.body.config.groupmeCallbackUrl, r.body.config.groupmeCallbackUrl);
});

test('saving a GroupMe bot id', async () => {
  const r = await call(api, '/api/ws', { method: 'POST', token: 'token-ben', body: { org: ORG_A, op: 'saveSettings', groupmeBotId: 'bot123', relatedTerms: [['train', 'railroad'], ['solo']] } });
  assert.equal(r.body.config.groupmeBotId, 'bot123');
  assert.deepEqual(r.body.config.relatedTerms, [['train', 'railroad']]);
});

test('Save & test makes the bot say hello in the group', async () => {
  const r = await call(api, '/api/ws', { method: 'POST', token: 'token-ben', body: { org: ORG_A, op: 'groupmeHello' } });
  assert.equal(r.status, 200);
  assert.equal(groupmePosts.length, 1);
  assert.match(groupmePosts[0].text, /Shift is connected for San Antonio Zoo/);
});

test('GroupMe /shift creates an item and confirms in chat', async () => {
  const r = await call(groupme, `/api/groupme?k=${intakeKey}`, { method: 'POST', body: { id: 'gm-1', text: '/shift issue! Train is down until 3pm', name: 'Maria Lopez', sender_type: 'user' } });
  assert.equal(r.status, 200);
  assert.match(r.body.ref, /^S-/);
  assert.equal(groupmePosts.length, 1);
  assert.equal(groupmePosts[0].bot_id, 'bot123');
  assert.match(groupmePosts[0].text, /Issue S-.* sent to the social team\. Thanks, Maria!/);
});

test('GroupMe retries of the same message are not duplicated', async () => {
  const r = await call(groupme, `/api/groupme?k=${intakeKey}`, { method: 'POST', body: { id: 'gm-1', text: '/shift issue! Train is down until 3pm', name: 'Maria Lopez' } });
  assert.equal(r.body.duplicate, true);
  assert.equal(groupmePosts.length, 0);
});

test('GroupMe ignores ordinary chat and bot messages', async () => {
  let r = await call(groupme, `/api/groupme?k=${intakeKey}`, { method: 'POST', body: { id: 'gm-2', text: 'anyone want lunch', name: 'Sam' } });
  assert.equal(r.body.ignored, true);
  r = await call(groupme, `/api/groupme?k=${intakeKey}`, { method: 'POST', body: { id: 'gm-3', text: '/shift issue loop', name: 'Shift', sender_type: 'bot' } });
  assert.equal(r.body.ignored, true);
  assert.equal(groupmePosts.length, 0);
});

test('GroupMe status lists open items', async () => {
  await call(groupme, `/api/groupme?k=${intakeKey}`, { method: 'POST', body: { id: 'gm-4', text: '/shift status', name: 'Maria' } });
  assert.match(groupmePosts[0].text, /1 open with the social team \(1 urgent\)/);
});

test('GroupMe with a wrong key is refused', async () => {
  const r = await call(groupme, '/api/groupme?k=wrong', { method: 'POST', body: { id: 'x', text: '/shift issue hi', name: 'Eve' } });
  assert.equal(r.status, 401);
});

test('report link creates items but cannot read the inbox', async () => {
  const info = await call(intake, `/api/intake?k=${intakeKey}`);
  assert.deepEqual(info.body, { ok: true, teamName: 'San Antonio Zoo' });
  const r = await call(intake, '/api/intake', { method: 'POST', body: { k: intakeKey, type: 'idea', text: 'Baby giraffe zoomies at 10am', name: 'Keeper Jo' } });
  assert.equal(r.status, 200);
  assert.ok(!('items' in r.body));
});

test('report link honeypot swallows bots', async () => {
  const r = await call(intake, '/api/intake', { method: 'POST', body: { k: intakeKey, type: 'issue', text: 'buy pills', website: 'spam.biz' } });
  assert.equal(r.body.ok, true);
  const ws = await call(api, `/api/ws?org=${ORG_A}`, { token: 'token-ben' });
  assert.ok(!ws.body.items.some((i) => i.text === 'buy pills'));
});

test('dashboard sees GroupMe + form items and records Buffer actions', async () => {
  const ws = await call(api, `/api/ws?org=${ORG_A}`, { token: 'token-ben' });
  assert.equal(ws.body.items.length, 2);
  const issue = ws.body.items.find((i) => i.type === 'issue');
  assert.equal(issue.source, 'groupme');
  assert.equal(issue.submittedBy, 'Maria Lopez');
  assert.equal(issue.priority, 'high');

  const r = await call(api, '/api/ws', { method: 'POST', token: 'token-ben', body: {
    org: ORG_A, op: 'updateItem', id: issue.id,
    patch: { linkPost: { postId: 'p1', channelName: 'Instagram', action: 'moved_to_draft', label: 'Moved to draft', ok: true, originalDueAt: '2026-10-15T19:00:00Z' } },
  } });
  assert.equal(r.body.item.linkedPosts.length, 1);
  assert.equal(r.body.item.linkedPosts[0].who, 'Ben');

  const closed = await call(api, '/api/ws', { method: 'POST', token: 'token-ben', body: { org: ORG_A, op: 'updateItem', id: issue.id, patch: { status: 'resolved' } } });
  assert.equal(closed.body.item.status, 'resolved');
  const ws2 = await call(api, `/api/ws?org=${ORG_A}`, { token: 'token-ben' });
  const kinds = ws2.body.activity.map((a) => a.kind);
  assert.ok(kinds.includes('buffer_action'));
  assert.ok(kinds.includes('item_closed'));
  assert.ok(kinds.includes('item_created'));
});

test('another Buffer account cannot touch this workspace', async () => {
  const ws = await call(api, `/api/ws?org=${ORG_A}`, { token: 'token-ben' });
  const id = ws.body.items[0].id;
  const r = await call(api, '/api/ws', { method: 'POST', token: 'token-other', body: { org: ORG_A, op: 'updateItem', id, patch: { status: 'dismissed' } } });
  assert.equal(r.status, 403);
});

test('resetting the link revokes the old GroupMe callback', async () => {
  const r = await call(api, '/api/ws', { method: 'POST', token: 'token-ben', body: { org: ORG_A, op: 'saveSettings', rotateKey: true } });
  const newKey = new URL(r.body.config.groupmeCallbackUrl).searchParams.get('k');
  assert.notEqual(newKey, intakeKey);
  const old = await call(groupme, `/api/groupme?k=${intakeKey}`, { method: 'POST', body: { id: 'gm-9', text: '/shift issue test', name: 'X' } });
  assert.equal(old.status, 401);
  const fresh = await call(groupme, `/api/groupme?k=${newKey}`, { method: 'POST', body: { id: 'gm-10', text: '/shift idea test', name: 'X' } });
  assert.equal(fresh.status, 200);
});
