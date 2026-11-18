'use strict';

// Test_App server. Plain Node http, no dependencies. Bound to loopback only.
const http = require('http');
const fs = require('fs');
const path = require('path');
const mockApi = require('./mock-api');
const { runHealth } = require('./health');

const HOST = '127.0.0.1';
const PORT = Number(process.env.TESTAPP_PORT) || 4100;
const PUBLIC_DIR = path.join(__dirname, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function createServer() {
  const server = http.createServer(async (req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);

    if (urlPath === '/health') {
      const body = await runHealth({ port: server.address().port });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }
    if (mockApi.handle(req, res)) return;

    if (req.method !== 'GET') {
      res.writeHead(405);
      res.end();
      return;
    }
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const file = path.resolve(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return server;
}

if (require.main === module) {
  createServer().listen(PORT, HOST, () => {
    console.log('Test_App listening on http://' + HOST + ':' + PORT);
  });
}

module.exports = { createServer, HOST, PORT };
