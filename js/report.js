// report.js — public staff report form. Submit-only; no inbox access.
(async function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const key = new URLSearchParams(location.search).get('k') || '';
  const form = $('form');

  try { const n = localStorage.getItem('shift_reporter_name'); if (n) form.elements.name.value = n; } catch {}

  const res = await fetch(`/api/intake?k=${encodeURIComponent(key)}`).catch(() => null);
  const data = res ? await res.json().catch(() => ({})) : {};
  if (!res || !res.ok || !data.ok) {
    $('title').textContent = "This link isn't working";
    $('lead').textContent = data.error || 'Ask your social team for the current report link.';
    return;
  }
  $('lead').textContent = `Goes straight to the ${data.teamName} social team.`;
  form.hidden = false;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    $('err').textContent = '';
    const fd = new FormData(form);
    const name = String(fd.get('name') || '').trim();
    try { if (name) localStorage.setItem('shift_reporter_name', name); } catch {}
    $('submit').disabled = true;
    $('submit').textContent = 'Sending…';
    try {
      const r = await fetch('/api/intake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          k: key, type: fd.get('type'), text: fd.get('text'), name,
          priority: fd.get('urgent') ? 'high' : 'normal', website: fd.get('website'),
        }),
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok || !out.ok) throw new Error(out.error || "Couldn't send that. Try again.");
      $('ref').textContent = out.ref;
      form.hidden = true;
      $('done').hidden = false;
    } catch (err) {
      $('err').textContent = err.message;
    } finally {
      $('submit').disabled = false;
      $('submit').textContent = 'Send to the social team';
    }
  });

  $('another').addEventListener('click', () => {
    form.elements.text.value = '';
    form.elements.urgent.checked = false;
    $('done').hidden = true;
    form.hidden = false;
    form.elements.text.focus();
  });
})();
