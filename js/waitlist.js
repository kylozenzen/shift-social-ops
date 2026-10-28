// waitlist.js: submits the landing waitlist to Netlify Forms, then shows the thanks page.
(function () {
  'use strict';
  var form = document.getElementById('waitForm');
  var btn = document.getElementById('submitBtn');
  var err = document.getElementById('formError');
  if (!form) return;
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    err.classList.add('hidden');
    if (!form.checkValidity()) { form.reportValidity(); return; }
    btn.disabled = true;
    var body = new URLSearchParams(new FormData(form)).toString();
    fetch('/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body })
      .then(function (r) { if (!r.ok) throw new Error('bad status'); window.location.href = '/thanks.html'; })
      .catch(function () { err.classList.remove('hidden'); btn.disabled = false; });
  });
})();
