// ============================================
// OpenSwarm - OpenCode Go adapter contract tests
// Purpose: direct Kimi K2.7 Code endpoint wiring
// ============================================

import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenCodeGoCliAdapter, createApiCaller } from './opencodeGo.js';
import { getAdapter } from './index.js';

const SSE_RESPONSE =
  'data: {"choices":[{"delta":{"role":"assistant","content":"implemented"},"finish_reason":"stop"}]}\n\n' +
  'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n' +
  'data: [DONE]\n';

const RESPONSES_SSE_RESPONSE =
  'data: {"type":"response.output_text.delta","delta":"implemented"}\n\n' +
  'data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2}}}\n\n' +
  'data: [DONE]\n';

const RESPONSES_TOOL_CALL_SSE_RESPONSE =
  'data: {"type":"response.output_item.added","item":{"id":"item_1","type":"function_call","call_id":"call_1","name":"read_file","arguments":""}}\n\n' +
  'data: {"type":"response.function_call_arguments.delta","item_id":"item_1","delta":"{\\"path\\":\\"README.md\\"}"}\n\n' +
  'data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2}}}\n\n' +
  'data: [DONE]\n';

const RESPONSES_INCOMPLETE_SSE_RESPONSE =
  'data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}\n\n' +
  'data: [DONE]\n';

describe('OpenCodeGoCliAdapter', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it('registers the native OpenCode Go adapter', () => {
    const adapter = getAdapter('opencode-go');

    expect(adapter).toBeInstanceOf(OpenCodeGoCliAdapter);
    expect(adapter.name).toBe('opencode-go');
    expect(adapter.capabilities.enforcesReadOnly).toBe(true);
    expect(adapter.capabilities.enforcesHumanSurfaceReadOnly).toBe(true);
  });

  it('calls the Go endpoint using a Bearer API key and Kimi K2.7 Code model', async () => {
    const fetchMock = vi.fn(async () => new Response(SSE_RESPONSE, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await createApiCaller('opencode-go-key', 'kimi-k2.7-code')(
      [{ role: 'user', content: 'implement this' }],
      [],
    );

    expect(response.choices[0].message.content).toBe('implemented');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://opencode.ai/zen/go/v1/chat/completions');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer opencode-go-key',
      'Content-Type': 'application/json',
      'User-Agent': 'OpenSwarm/0.21.6',
    });
    const requestBody = JSON.parse(init.body as string);
    expect(requestBody).toMatchObject({
      model: 'kimi-k2.7-code',
      messages: [{ role: 'user', content: 'implement this' }],
      stream: true,
    });
    // OpenCode Go rejects the shared OpenAI-compatible default (0.2) for
    // Kimi, so the adapter must leave temperature provider-defaulted.
    expect(requestBody).not.toHaveProperty('temperature');
  });

  it('routes Muse Spark 1.3 Contributor through the Responses endpoint and protocol', async () => {
    const fetchMock = vi.fn(async () => new Response(RESPONSES_SSE_RESPONSE, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await createApiCaller('opencode-go-key', 'muse-spark-1.3-contributor', { sessionId: 'task-1' })(
      [
        { role: 'system', content: 'You are a careful implementer.' },
        { role: 'user', content: 'implement this' },
      ],
      [],
    );

    expect(response.choices[0].message.content).toBe('implemented');
    expect(response.usage).toMatchObject({
      prompt_tokens: 3,
      completion_tokens: 2,
      total_tokens: 5,
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://opencode.ai/zen/go/v1/responses');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer opencode-go-key',
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'User-Agent': 'OpenSwarm/0.21.6',
      'x-opencode-session': 'task-1',
    });
    expect(JSON.parse(init.body as string)).toEqual(expect.objectContaining({
      model: 'muse-spark-1.3-contributor',
      instructions: 'You are a careful implementer.',
      input: [{ role: 'user', content: 'implement this' }],
      stream: true,
      store: false,
    }));
    expect(JSON.parse(init.body as string)).not.toHaveProperty('messages');
  });

  it('maps Muse Responses function-call stream events back to agentic-loop tool calls', async () => {
    const fetchMock = vi.fn(async () => new Response(RESPONSES_TOOL_CALL_SSE_RESPONSE, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await createApiCaller('opencode-go-key', 'muse-spark-1.3-contributor')(
      [{ role: 'user', content: 'Inspect README.md.' }],
      [{
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a repository file.',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      }],
    );

    expect(response.choices[0]).toMatchObject({
      finish_reason: 'tool_calls',
      message: {
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"README.md"}' },
        }],
      },
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      tools: [{
        type: 'function',
        name: 'read_file',
        description: 'Read a repository file.',
        strict: false,
      }],
    });
  });

  it('rejects incomplete Muse Responses streams instead of treating them as an empty final answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(RESPONSES_INCOMPLETE_SSE_RESPONSE, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })));

    await expect(createApiCaller('opencode-go-key', 'muse-spark-1.3-contributor')(
      [{ role: 'user', content: 'Implement this.' }],
      [],
    )).rejects.toThrow('incomplete');
  });

  it('reports availability from OPENCODE_GO_API_KEY without relying on a CLI login', async () => {
    process.env.OPENCODE_GO_API_KEY = 'opencode-go-key';
    await expect(new OpenCodeGoCliAdapter().isAvailable()).resolves.toBe(true);
  });
});
