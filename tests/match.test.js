const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../js/match.js');

const groups = [['train', 'railroad', 'railway', 'locomotive', 'choo choo'], ['pool', 'splash pad', 'water park', 'swim']];
const item = (text, extra = {}) => ({ id: text, type: 'issue', status: 'new', text, ...extra });
const post = (id, text) => ({ id, text });

test('flags the 2pm train post when the train goes down', () => {
  const { byPost, byItem } = M.findImpacts(
    [item('Train is down until 3pm, mechanical')],
    [post('p1', 'Hop aboard the train this weekend! 🚂'), post('p2', 'Meet our new baby giraffe')],
    groups,
  );
  assert.deepEqual([...byPost.keys()], ['p1']);
  assert.equal(byItem.get('Train is down until 3pm, mechanical').length, 1);
});

test('related terms catch posts that use a different word', () => {
  const { byPost } = M.findImpacts([item('The train broke down')], [post('p1', 'All aboard the Zoo Railroad!')], groups);
  assert.ok(byPost.has('p1'));
  const { byPost: b2 } = M.findImpacts([item('Choo choo is closed')], [post('p2', 'Ride the locomotive today')], groups);
  assert.ok(b2.has('p2'));
});

test('multi-word terms match as phrases', () => {
  const { byPost } = M.findImpacts([item('Splash pad is shut for repairs')], [post('p1', 'Cool off at the water park')], groups);
  assert.ok(byPost.has('p1'));
});

test('status words alone never cause a match', () => {
  const { byPost } = M.findImpacts([item('Gift shop closed today')], [post('p1', "We're closed Monday for the holiday"), post('p2', 'Train rides today')], groups);
  assert.equal(byPost.size, 0);
});

test('plural and -ing forms still match', () => {
  const { byPost } = M.findImpacts([item('Penguin encounters cancelled')], [post('p1', 'Book a penguin encounter this Saturday')], []);
  assert.ok(byPost.has('p1'));
});

test('ideas, notes, and closed items are not checked', () => {
  const posts = [post('p1', 'Ride the train')];
  assert.equal(M.findImpacts([item('train idea', { type: 'idea' })], posts, groups).byPost.size, 0);
  assert.equal(M.findImpacts([item('train note', { type: 'note' })], posts, groups).byPost.size, 0);
  assert.equal(M.findImpacts([item('train down', { status: 'resolved' })], posts, groups).byPost.size, 0);
});

test('links in posts are ignored', () => {
  const { byPost } = M.findImpacts([item('Website train page broken')], [post('p1', 'Tickets: https://zoo.example/train-tickets')], []);
  assert.equal(byPost.size, 0);
});
