'use strict';

// Local mock API handler. Returns true if it handled the request.
const ITEMS = [
  { id: 1, name: 'Ghost Lantern' },
  { id: 2, name: 'Spectral Chain' },
  { id: 3, name: 'Haunted Mirror' },
];

function handle(req, res) {
  const url = req.url.split('?')[0];
  if (url !== '/api/items') return false;
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return true;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ items: ITEMS }));
  return true;
}

module.exports = { handle, ITEMS };
