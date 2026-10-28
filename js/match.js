// match.js — Impact check. Finds upcoming posts that might be affected by an
// issue or update. Conservative keyword matching only: results are shown as
// "might be affected", never as a confirmed conflict, and nothing is changed
// automatically.

(function (global) {
  'use strict';

  const STOP = new Set((
    'a an and are as at be been but by can cant could did do does dont for from get got has have having he her here ' +
    'him his how i if in into is isnt it its just let lets me more most my no not now of off on one only or our out over ' +
    'please re so some still than that the their them then there these they this those to too up us very was we were what ' +
    'when where which while who why will with would you your yall today tonight tomorrow morning afternoon evening ' +
    'am pm until till til minutes minute hour hours guest guests people folks someone everyone team staff ' +
    'issue update fyi heads note request idea urgent asap down closed closing open opening reopen reopened broken ' +
    'shut working work new back again going currently right also need needs needed about after before ' +
    'test sample something dismiss report available unavailable'
  ).split(' '));

  function stem(word) {
    let w = word;
    if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
    else if (w.length > 4 && w.endsWith('ies')) w = w.slice(0, -3) + 'y';
    else if (w.length > 4 && w.endsWith('es') && /(sh|ch|x|z|ss)es$/.test(w)) w = w.slice(0, -2);
    else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
    return w;
  }

  function normalize(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/[’']/g, '')
      .replace(/[^a-z0-9#]+/g, ' ')
      .replace(/#/g, ' ')
      .trim();
  }

  function words(text) {
    return normalize(text).split(/\s+/).filter(Boolean);
  }

  function keywords(text) {
    const out = new Set();
    for (const w of words(text)) {
      if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w)) continue;
      out.add(stem(w));
    }
    return out;
  }

  // Expand an issue's keywords with any related-term group it touches.
  // Returns Map<matchTerm, reasonWordFromIssue>.
  function expand(issueText, termGroups) {
    const norm = ' ' + normalize(issueText) + ' ';
    const base = keywords(issueText);
    const terms = new Map();
    base.forEach((k) => terms.set(k, k));
    for (const group of termGroups || []) {
      const hit = group.find((t) => {
        const nt = normalize(t);
        return nt && (nt.includes(' ') ? norm.includes(' ' + nt + ' ') : base.has(stem(nt)));
      });
      if (!hit) continue;
      for (const t of group) {
        const nt = normalize(t);
        if (!nt) continue;
        const key = nt.includes(' ') ? nt : stem(nt);
        if (!terms.has(key)) terms.set(key, hit);
      }
    }
    return terms;
  }

  // Which of the issue's terms appear in this post? Returns [] when none.
  function sharedTerms(terms, postText) {
    const norm = ' ' + normalize(postText) + ' ';
    const postKeys = keywords(postText);
    const found = [];
    for (const [term] of terms) {
      const ok = term.includes(' ') ? norm.includes(' ' + term + ' ') : postKeys.has(term);
      if (ok) found.push(term);
    }
    return found;
  }

  // items: Shift items; posts: Buffer posts (upcoming, still scheduled).
  // Returns Map<postId, [{ item, terms }]> and Map<itemId, [{ post, terms }]>.
  function findImpacts(items, posts, termGroups) {
    const byPost = new Map();
    const byItem = new Map();
    const candidates = items.filter((i) =>
      (i.type === 'issue' || i.type === 'update') && (i.status === 'new' || i.status === 'in_progress'));
    for (const item of candidates) {
      const terms = expand(item.text, termGroups);
      if (!terms.size) continue;
      for (const post of posts) {
        const hits = sharedTerms(terms, post.text);
        if (!hits.length) continue;
        if (!byPost.has(post.id)) byPost.set(post.id, []);
        byPost.get(post.id).push({ item, terms: hits });
        if (!byItem.has(item.id)) byItem.set(item.id, []);
        byItem.get(item.id).push({ post, terms: hits });
      }
    }
    return { byPost, byItem };
  }

  const api = { normalize, keywords, expand, sharedTerms, findImpacts, stem };
  global.ShiftMatch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
