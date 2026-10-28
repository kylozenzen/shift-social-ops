// callback.js — finishes Buffer OAuth, then hands off to the dashboard.
(async function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const cfg = await fetch('/api/config').then((r) => r.json()).catch(() => ({}));
  BufferConnection.init({ prefix: 'shift', clientId: cfg.bufferClientId || '', tokenEndpoint: '/.netlify/functions/buffer-token' });

  const result = await BufferOAuth.handleCallback({ prefix: 'shift', tokenEndpoint: '/.netlify/functions/buffer-token', clientId: cfg.bufferClientId });
  // Drop the code and state from the address bar and history.
  history.replaceState(null, '', location.pathname);

  if (result.ok) {
    $('title').textContent = 'Buffer connected';
    $('message').textContent = 'Opening your dashboard…';
    location.replace(result.returnTo || '/app');
    return;
  }
  $('title').textContent = result.reason === 'cancelled' ? 'Connection cancelled' : "Buffer didn't connect";
  $('message').textContent = result.message || 'Something interrupted the connection. Try again.';
  $('action').hidden = false;
  $('action').textContent = result.reason === 'cancelled' ? 'Back to Shift' : 'Try again';
})();
