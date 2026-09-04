import { afterEach, describe, expect, it } from 'vitest';
import { createServer, request } from 'node:http';

import { startWebServer, stopWebServer } from './web.js';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function dashboardRequest(
  port: number,
  method: 'GET' | 'POST',
  origin: string,
  host: string,
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1',
      port,
      method,
      path,
      headers: { Origin: origin, Host: host },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.once('error', reject);
    req.end();
  });
}

describe('Tailscale Serve dashboard authorization', () => {
  afterEach(async () => {
    await stopWebServer();
  });

  it('allows a same-host MagicDNS Origin forwarded to loopback to read dashboard state', async () => {
    const port = await freePort();
    const host = `macstudio.tail636ca5.ts.net:${port}`;
    await startWebServer(port);

    const response = await dashboardRequest(port, 'GET', `https://${host}`, host, '/api/stats');

    expect(response.status).toBe(200);
  });

  it('allows a same-host MagicDNS Origin forwarded to loopback to mutate through the dashboard', async () => {
    const port = await freePort();
    const host = `macstudio.tail636ca5.ts.net:${port}`;
    await startWebServer(port);

    const response = await dashboardRequest(port, 'POST', `https://${host}`, host, '/api/heartbeat');

    expect(response.status).toBe(202);
    expect(response.body).toContain('"ok":true');
  });

  it('rejects a non-Tailscale Origin even when it claims the request host', async () => {
    const port = await freePort();
    const host = `attacker.example:${port}`;
    await startWebServer(port);

    const response = await dashboardRequest(port, 'POST', `https://${host}`, host, '/api/heartbeat');

    expect(response.status).toBe(403);
    expect(response.body).toContain('Forbidden');
  });
});
