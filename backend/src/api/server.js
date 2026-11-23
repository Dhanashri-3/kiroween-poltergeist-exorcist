// Binds the API application to the loopback address only (Requirement 13.1).
import { API_HOST } from './app.js';

/**
 * @param {import('express').Express} app
 * @param {{port?: number}} [options] port 0 picks a free port
 * @returns {Promise<{server: import('node:http').Server, host: string, port: number, close: () => Promise<void>}>}
 */
export function startApiServer(app, { port = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, API_HOST);
    server.once('error', reject);
    server.once('listening', () => {
      server.off('error', reject);
      resolve({
        server,
        host: API_HOST,
        port: server.address().port,
        close: () => new Promise((done, fail) => {
          server.close((e) => (e ? fail(e) : done()));
          server.closeAllConnections?.();
        }),
      });
    });
  });
}
