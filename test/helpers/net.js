// A port nobody listens on (ECONNREFUSED), and the bounded waits.
import { createServer } from 'node:net';

export { sleep, until, within } from './app.js';

export async function refusePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}
