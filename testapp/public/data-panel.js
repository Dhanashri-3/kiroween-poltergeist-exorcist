/* Data panel component: loads items from the local mock API (same origin only). */
(function (root) {
  'use strict';

  var ENDPOINT = '/api/items';

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function render(items) {
    if (!Array.isArray(items) || items.length === 0) return '<p>No data</p>';
    return '<ul>' + items.map(function (i) {
      return '<li data-id="' + escapeHtml(i.id) + '">' + escapeHtml(i.name) + '</li>';
    }).join('') + '</ul>';
  }

  function load(fetchFn, documentRef) {
    var panel = documentRef.getElementById('data-panel-content');
    if (!panel) return Promise.resolve();
    panel.textContent = 'Loading...';
    return fetchFn(ENDPOINT)
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (body) { panel.innerHTML = render(body.items); })
      .catch(function (e) { panel.textContent = 'Failed to load data: ' + e.message; });
  }

  var api = { ENDPOINT: ENDPOINT, render: render, load: load };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DataPanelComponent = api;
})(typeof window !== 'undefined' ? window : globalThis);
