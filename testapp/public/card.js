/* Styled card component. */
(function (root) {
  'use strict';

  function render(title, body) {
    function esc(s) {
      return String(s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }
    return '<h2 class="card-title">' + esc(title) + '</h2><p class="card-body">' + esc(body) + '</p>';
  }

  function mount(documentRef) {
    var el = documentRef.getElementById('test-card');
    if (el) el.innerHTML = render('Haunted Card', 'This card is styled by card.css.');
  }

  var api = { render: render, mount: mount };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CardComponent = api;
})(typeof window !== 'undefined' ? window : globalThis);
