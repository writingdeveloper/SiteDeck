import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { listenWithFallback } from './listen';

const opened: http.Server[] = [];

function track(s: http.Server): http.Server {
  opened.push(s);
  return s;
}

function closeAll(): Promise<void> {
  return Promise.all(
    opened.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  ).then(() => undefined);
}

// Bind with the default host (all interfaces), exactly like the production server
// and listenWithFallback do — so a blocker on the same port actually collides.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.on('error', reject);
    probe.listen(0, () => {
      const addr = probe.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

afterEach(closeAll);

describe('listenWithFallback', () => {
  it('binds the requested port when it is free', async () => {
    const port = await freePort();
    const server = track(http.createServer());
    const bound = await listenWithFallback(server, port, 5);
    expect(bound).toBe(port);
    const addr = server.address();
    expect(typeof addr === 'object' && addr ? addr.port : 0).toBe(port);
  });

  it('falls back to the next free port when the requested one is taken', async () => {
    const port = await freePort();
    const blocker = track(http.createServer());
    await new Promise<void>((r) => blocker.listen(port, () => r()));

    const server = track(http.createServer());
    const bound = await listenWithFallback(server, port, 5);

    expect(bound).toBeGreaterThan(port);
    const addr = server.address();
    expect(typeof addr === 'object' && addr ? addr.port : 0).toBe(bound);
  });

  it('rejects when no port in range is free', async () => {
    const port = await freePort();
    const blocker = track(http.createServer());
    await new Promise<void>((r) => blocker.listen(port, () => r()));

    const server = track(http.createServer());
    await expect(listenWithFallback(server, port, 0)).rejects.toThrow();
  });
});
