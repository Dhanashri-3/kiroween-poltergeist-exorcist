/* Button component: logic is pure so it can be checked outside a browser. */
(function (root) {
  'use strict';

  function nextCount(count) {
    return count + 1;
  }

  function label(count) {
    return 'Clicked ' + count + ' times';
  }

  function mount(documentRef) {
    var btn = documentRef.getElementById('test-button');
    var out = documentRef.getElementById('button-output');
    if (!btn || !out) return;
    var count = 0;
    btn.addEventListener('click', function () {
      count = nextCount(count);
      out.textContent = label(count);
    });
  }

  var api = { nextCount: nextCount, label: label, mount: mount };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ButtonComponent = api;
})(typeof window !== 'undefined' ? window : globalThis);
