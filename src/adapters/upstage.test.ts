// ============================================
// OpenSwarm - Upstage adapter contract tests
// Purpose: direct Solar Pro 3 endpoint wiring and safe pre-stream failover
// ============================================

import { afterEach, describe, expect, it, vi } from 'vitest';
import { UpstageCliAdapter, createApiCaller } from './upstage.js';
import { getAdapter } from './index.js';

const SSE_RESPONSE =
  'data: {"choices":[{"delta":{"role":"assistant","content":"ready"},"finish_reason":"stop"}]}\n\n' +
  'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n' +
  'data: [DONE]\n';

describe('UpstageCliAdapter', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it('registers the native Upstage adapter', () => {
    const adapter = getAdapter('upstage');

    expect(adapter).toBeInstanceOf(UpstageCliAdapter);
    expect(adapter.name).toBe('upstage');
    expect(adapter.capabilities.enforcesReadOnly).toBe(true);
    expect(adapter.capabilities.enforcesHumanSurfaceReadOnly).toBe(true);
  });

  it('calls the Solar Pro 3 chat endpoint with the primary key', async () => {
    const fetchMock = vi.fn(async () => new Response(SSE_RESPONSE, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await createApiCaller('upstage-primary', 'solar-pro3')(
      [{ role: 'user', content: 'ping' }],
      [],
    );

    expect(response.choices[0].message.content).toBe('ready');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.upstage.ai/v1/chat/completions');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer upstage-primary',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: 'solar-pro3',
      messages: [{ role: 'user', content: 'ping' }],
      stream: true,
    });
  });

  it.each([
    ['authentication failure', async () => new Response('unauthorized', { status: 401 })],
    ['rate limit', async () => new Response('rate limited', { status: 429 })],
    ['server failure', async () => new Response('overloaded', { status: 503 })],
    ['connection failure', async () => { throw new TypeError('fetch failed'); }],
  ])('uses the secondary key when the primary has a pre-stream %s', async (_kind, failPrimary) => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(failPrimary)
      .mockResolvedValueOnce(new Response(SSE_RESPONSE, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await createApiCaller('upstage-primary', 'solar-pro3', {
      fallbackApiKey: 'upstage-secondary',
    })([{ role: 'user', content: 'ping' }], []);

    expect(response.choices[0].message.content).toBe('ready');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer upstage-primary' });
    expect((fetchMock.mock.calls[1][1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer upstage-secondary' });
  });

  it('does not replay a client error with the secondary key', async () => {
    const fetchMock = vi.fn(async () => new Response('invalid request', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    const callApi = createApiCaller('upstage-primary', 'solar-pro3', {
      fallbackApiKey: 'upstage-secondary',
    });

    await expect(callApi([{ role: 'user', content: 'bad request' }], [])).rejects.toThrow('Upstage API error (400)');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer upstage-primary' });
  });

  it('never replays with the secondary key after the primary stream has emitted content', async () => {
    const encoder = new TextEncoder();
    let readCount = 0;
    const interruptedPrimary = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (readCount++ === 0) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
          return;
        }
        controller.error(new TypeError('primary stream interrupted'));
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(interruptedPrimary)
      .mockResolvedValueOnce(new Response(SSE_RESPONSE, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const callApi = createApiCaller('upstage-primary', 'solar-pro3', {
      fallbackApiKey: 'upstage-secondary',
    });

    await expect(callApi([{ role: 'user', content: 'ping' }], [])).rejects.toThrow('primary stream interrupted');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
