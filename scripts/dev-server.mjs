// Local dev server for Shift — NOT deployed.
// Serves the static site, runs the real /api/* functions against a local
// Netlify Blobs server, and swaps Buffer for an in-memory mock so the UI can be
// exercised end to end without touching a real account.
//
//   node scripts/dev-server.mjs            → http://localhost:8888
//   MOCK_EMPTY=1 node scripts/dev-server.mjs  → no scheduled posts (empty states)

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { BlobsServer } from '@netlify/blobs/server';

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = Number(process.env.PORT || 8888);
const ORG = '5b5f2a466e8b8b8f360939d5';
const MOCK_TOKEN = 'mock-token';

const blobs = new BlobsServer({ directory: mkdtempSync(join(tmpdir(), 'shift-dev-')), token: 'dev', port: 0 });
const { port: blobPort } = await blobs.start();
process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify({
  edgeURL: `http://localhost:${blobPort}`, uncachedEdgeURL: `http://localhost:${blobPort}`, siteID: 'shift-dev', token: 'dev',
})).toString('base64');

// ---------- mock Buffer ----------
const at = (minutesFromNow) => new Date(Date.now() + minutesFromNow * 60000).toISOString();
const tomorrowAt = (days, hour) => {
  const d = new Date(); d.setDate(d.getDate() + days); d.setHours(hour, 0, 0, 0); return d.toISOString();
};
const channels = [
  { id: 'ch_ig', name: 'sazoo', displayName: 'San Antonio Zoo', service: 'instagram', avatar: '/icons/shift-192.png', isDisconnected: false, isLocked: false, allowedActions: ['scheduleUpdates'], metadata: { __typename: 'InstagramMetadata', defaultToReminders: false } },
  { id: 'ch_fb', name: 'sanantoniozoo', displayName: 'San Antonio Zoo', service: 'facebook', avatar: '/icons/shift-192.png', isDisconnected: false, isLocked: false, allowedActions: ['scheduleUpdates'], metadata: null },
  { id: 'ch_th', name: 'sazoo', displayName: '@sazoo', service: 'threads', avatar: '/icons/shift-192.png', isDisconnected: false, isLocked: false, allowedActions: ['scheduleUpdates'], metadata: null },
  { id: 'ch_li', name: 'san-antonio-zoo', displayName: 'San Antonio Zoo', service: 'linkedin', avatar: '/icons/shift-192.png', isDisconnected: false, isLocked: false, allowedActions: ['scheduleUpdates'], metadata: null },
];
const ALLOWED = ['publishPostNow', 'updatePost', 'movePostToDraft', 'updatePostSchedule', 'deletePost'];
const img = (thumb) => [{ __typename: 'ImageAsset', type: 'image', source: thumb, thumbnail: thumb, image: { altText: 'Zoo photo' } }];
let seq = 100;
let posts = process.env.MOCK_EMPTY ? [] : [
  { id: 'p_sent', status: 'sent', dueAt: at(-180), sentAt: at(-180), text: 'Good morning from the flamingo lagoon 🦩 Gates are open!', channelId: 'ch_th', assets: [] },
  { id: 'p_train', status: 'scheduled', dueAt: at(45), text: 'All aboard! 🚂 The Eagle train is running every 20 minutes this afternoon. Grab the kids and take a ride around the zoo.', channelId: 'ch_ig', assets: img('/icons/shift-512.png') },
  { id: 'p_keeper', status: 'scheduled', dueAt: at(150), text: 'Keeper talk at the hippo habitat at 4:30. Bring your questions about Uma!', channelId: 'ch_fb', assets: [] },
  { id: 'p_li', status: 'scheduled', dueAt: at(240), text: 'We’re hiring seasonal educators for Zoo Camp. Apply by Friday.', channelId: 'ch_li', assets: [] },
  { id: 'p_week1', status: 'scheduled', dueAt: tomorrowAt(1, 10), text: 'Saturday plan: penguin feeding at 11, then the railroad loop with the whole crew. 🐧🚂', channelId: 'ch_fb', assets: [] },
  { id: 'p_week2', status: 'scheduled', dueAt: tomorrowAt(2, 14), text: 'Member Monday: early entry starts at 8am for all members.', channelId: 'ch_th', assets: [] },
  { id: 'p_week3', status: 'scheduled', dueAt: tomorrowAt(3, 12), text: 'Meet the newest giraffe calf! Name reveal coming soon. 🦒', channelId: 'ch_ig', assets: img('/icons/shift-512.png') },
];
const ideas = [];

function shape(p) {
  return {
    allowedActions: p.status === 'scheduled' ? ALLOWED : ['publishPostNow', 'updatePost', 'addPostToQueue', 'deletePost'],
    isCustomScheduled: true, shareMode: 'customScheduled', schedulingType: 'automatic', error: null,
    channelService: channels.find((c) => c.id === p.channelId)?.service, sentAt: p.sentAt || null, ...p,
  };
}

function mockGraphQL(query, v) {
  if (query.includes('account{') || query.includes('account {')) {
    return { account: { id: 'acct', name: 'Ben Campbell', timezone: 'America/Chicago', organizations: [{ id: ORG, name: 'San Antonio Zoo' }] } };
  }
  if (query.includes('configuration(')) {
    const lim = { instagram: 2200, facebook: 63206, threads: 500, linkedin: 3000 };
    return { configuration: { channels: channels.map((c) => ({ channelId: c.id, content: [{ configurationContentTypes: ['post'], rules: [{ __typename: 'LengthRule', property: 'text', maxLength: lim[c.service] }] }] })) } };
  }
  if (query.includes('channels(')) return { channels };
  if (query.includes('createIdea')) {
    const idea = { id: `idea_${++seq}` }; ideas.push({ ...idea, ...v.input }); return { createIdea: { __typename: 'Idea', ...idea } };
  }
  if (query.includes('createPost')) {
    const i = v.input;
    if (!i.text) return { createPost: { __typename: 'InvalidInputError', message: 'Invalid post: Post must have either text or media.' } };
    const ch = channels.find((c) => c.id === i.channelId);
    if (ch?.service === 'instagram' && !(i.assets || []).length) return { createPost: { __typename: 'InvalidInputError', message: 'Instagram posts need at least one image or video.' } };
    let status = 'scheduled'; let dueAt = i.dueAt; let sentAt = null;
    if (i.saveToDraft) { status = 'draft'; dueAt = null; }
    else if (i.mode === 'shareNow') { status = 'sent'; dueAt = sentAt = new Date().toISOString(); }
    else if (i.mode === 'addToQueue') dueAt = at(90);
    const p = { id: `p_${++seq}`, status, dueAt, sentAt, text: i.text, channelId: i.channelId, assets: [] };
    posts.push(p);
    return { createPost: { __typename: 'PostActionSuccess', post: shape(p) } };
  }
  if (query.includes('editPost')) {
    const i = v.input; const p = posts.find((x) => x.id === i.id);
    if (!p) return { editPost: { __typename: 'NotFoundError', message: 'Post not found' } };
    if (!i.text && !(i.assets || []).length) return { editPost: { __typename: 'InvalidInputError', message: 'Invalid post: Post must have either text or media.' } };
    p.text = i.text;
    if (i.saveToDraft) p.status = 'draft';
    else { p.status = 'scheduled'; if (i.mode === 'customScheduled') p.dueAt = i.dueAt; if (i.mode === 'addToQueue') p.dueAt = at(90); }
    return { editPost: { __typename: 'PostActionSuccess', post: shape(p) } };
  }
  if (query.includes('posts(')) {
    const isDraftQuery = query.includes('status:[draft]');
    let list = posts.filter((p) => isDraftQuery ? (p.status === 'draft' && p.dueAt) : p.status !== 'draft');
    if (!isDraftQuery && v.start) list = list.filter((p) => (p.dueAt || p.sentAt) >= v.start && (p.dueAt || p.sentAt) <= v.end);
    list.sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)));
    return { posts: { edges: list.map((p) => ({ node: shape(p) })) } };
  }
  throw new Error(`Mock Buffer has no handler for: ${query.slice(0, 80)}`);
}

// Point the server-side Buffer auth check at the mock as well.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  if (String(url) === 'https://api.buffer.com') {
    const tok = (opts.headers?.Authorization || '').replace('Bearer ', '');
    if (tok !== MOCK_TOKEN) return new Response(JSON.stringify({ errors: [{ message: 'Unauthorized' }] }), { status: 401 });
    const { query, variables } = JSON.parse(opts.body);
    return new Response(JSON.stringify({ data: mockGraphQL(query, variables || {}) }), { status: 200 });
  }
  if (String(url) === 'https://api.groupme.com/v3/bots/post') {
    console.log('[groupme reply]', JSON.parse(opts.body).text);
    return new Response('', { status: 202 });
  }
  return realFetch(url, opts);
};

const handlers = {
  '/api/ws': (await import('../netlify/functions/api.mjs')).default,
  '/api/groupme': (await import('../netlify/functions/groupme.mjs')).default,
  '/api/intake': (await import('../netlify/functions/intake.mjs')).default,
  '/api/config': (await import('../netlify/functions/app-config.mjs')).default,
};
const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);
const proxy = require('../netlify/functions/buffer-proxy.js').handler;

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const REWRITES = { '/report': '/report.html', '/app': '/app.html', '/': '/index.html' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  try {
    if (handlers[url.pathname]) {
      const request = new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
      const out = await handlers[url.pathname](request, { ip: '127.0.0.1' });
      res.writeHead(out.status, Object.fromEntries(out.headers));
      res.end(Buffer.from(await out.arrayBuffer()));
      return;
    }
    if (url.pathname === '/.netlify/functions/buffer-proxy') {
      const out = await proxy({ httpMethod: req.method, headers: req.headers, body: body.toString() });
      res.writeHead(out.statusCode, out.headers); res.end(out.body); return;
    }
    let path = REWRITES[url.pathname] || url.pathname;
    path = normalize(path).replace(/^(\.\.[/\\])+/, '');
    const data = await readFile(join(ROOT, path));
    res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' });
    res.end(data);
  } catch (err) {
    res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'content-type': 'text/plain' });
    res.end(err.code === 'ENOENT' ? 'Not found' : String(err.stack || err));
  }
}).listen(PORT, () => console.log(`Shift dev server on http://localhost:${PORT} (mock Buffer token: ${MOCK_TOKEN})`));
