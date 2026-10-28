// connect.js — landing page: Buffer OAuth (PKCE) or a personal API key.
(async function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const msg = (text, bad) => { $('connectMsg').textContent = text; $('connectMsg').style.color = bad ? 'var(--red)' : 'var(--muted)'; };

  const cfg = await fetch('/api/config').then((r) => r.json()).catch(() => ({}));
  BufferConnection.init({ prefix: 'shift', clientId: cfg.bufferClientId || '', tokenEndpoint: '/.netlify/functions/buffer-token' });

  const params = new URLSearchParams(location.search);
  if (params.get('reconnect')) {
    BufferConnection.clearTokens();
    msg('Your Buffer connection expired. Connect again to pick up where you left off.');
  } else if (BufferConnection.hasConnection() && !params.has('home')) {
    location.replace('/app');
    return;
  }

  if (!cfg.bufferClientId) {
    $('connectBtn').hidden = true;
    $('keyToggle').hidden = true;
    $('keyForm').hidden = false;
  }

  $('connectBtn').addEventListener('click', async () => {
    try {
      $('connectBtn').disabled = true;
      await BufferOAuth.startAuthorization({
        prefix: 'shift',
        clientId: cfg.bufferClientId,
        redirectUri: `${location.origin}/auth/callback.html`,
        scope: cfg.bufferScope,
        returnTo: '/app',
      });
    } catch (err) {
      $('connectBtn').disabled = false;
      msg(err.message, true);
    }
  });

  $('keyToggle').addEventListener('click', () => {
    $('keyForm').hidden = !$('keyForm').hidden;
    if (!$('keyForm').hidden) $('keyInput').focus();
  });

  $('keyForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const key = $('keyInput').value.trim();
    if (!key) return msg('Paste your Buffer API key first.', true);
    msg('Checking with Buffer…');
    try {
      const res = await fetch('/.netlify/functions/buffer-proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Buffer-Token': key },
        body: JSON.stringify({ query: 'query{ account{ id name } }' }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.data?.account) throw new Error(data?.errors?.[0]?.message || 'Buffer did not accept that key.');
      BufferConnection.storeTokens({ access_token: key, token_type: 'Bearer' });
      location.href = '/app';
    } catch (err) {
      msg(err.message, true);
    }
  });
})();

// Landing replay: play once when visible, replay on demand.
(function () {
  const fig = document.getElementById('replay');
  const btn = document.getElementById('replayBtn');
  if (!fig) return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) { btn.hidden = true; return; }
  const play = () => { fig.classList.remove('play'); void fig.offsetWidth; fig.classList.add('play'); };
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { play(); io.disconnect(); }
    }, { threshold: 0.4 });
    io.observe(fig);
  } else play();
  btn.addEventListener('click', play);
})();
