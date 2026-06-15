import type { Server } from 'node:http';

/**
 * Listen on `startPort`; if it's already in use (EADDRINUSE), try `startPort + 1`,
 * `+ 2`, … up to `maxAttempts` extra ports. Resolves with the port actually bound,
 * or rejects if every candidate is taken (or another listen error occurs).
 *
 * This keeps the app from dying when something else (e.g. another SiteDeck
 * instance, or Google Drive, which uses nearby ports) already holds the port.
 */
export function listenWithFallback(
  server: Server,
  startPort: number,
  maxAttempts: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let port = startPort;
    let attempt = 0;

    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && attempt < maxAttempts) {
        attempt += 1;
        port += 1;
        server.listen(port);
      } else {
        cleanup();
        reject(err);
      }
    };
    const onListening = () => {
      cleanup();
      resolve(port);
    };
    const cleanup = () => {
      server.removeListener('error', onError);
      server.removeListener('listening', onListening);
    };

    server.on('error', onError);
    server.on('listening', onListening);
    server.listen(port);
  });
}
