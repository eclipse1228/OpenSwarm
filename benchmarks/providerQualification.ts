#!/usr/bin/env tsx
// ============================================
// OpenSwarm - Provider qualification probe
// ============================================
// Measures a production-like direct API request without sending repository
// context. Results intentionally omit prompt text, completions, and secrets.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadEnvFile } from '../src/core/envFile.js';

const PROMPT = [
  'Write a TypeScript implementation of a bounded async retry helper with exponential backoff,',
  'AbortSignal support, and a short JSDoc comment. Return code only, between 350 and 450 tokens.',
].join(' ');
const SERIAL_SAMPLES = 5;
const CONCURRENT_SAMPLES = 4;
const REQUEST_TIMEOUT_MS = 90_000;

type ProviderId = 'upstage' | 'opencode-go' | 'openrouter';
type ApiProtocol = 'chat-completions' | 'responses';

interface ProviderSpec {
  id: ProviderId;
  model: string;
  endpoint: string;
  protocol: ApiProtocol;
  key?: string;
  body: Record<string, unknown>;
}

interface Sample {
  phase: 'warmup' | 'serial' | 'concurrent';
  status: number;
  durationMs: number;
  ttftMs?: number;
  outputTokens?: number;
  outputTps?: number;
  routedProvider?: string;
  completed?: boolean;
  error?: string;
}

interface QualificationResult {
  provider: ProviderId;
  model: string;
  eligible: boolean;
  errorRate: number;
  p50DurationMs?: number;
  p95DurationMs?: number;
  p50TtftMs?: number;
  p50OutputTps?: number;
  aggregateConcurrentTps?: number;
  passed: boolean;
  samples: Sample[];
}

function percentile(values: number[], fraction: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

async function readSse(res: Response, startedAt: number, protocol: ApiProtocol): Promise<Pick<Sample, 'ttftMs' | 'outputTokens' | 'routedProvider' | 'completed' | 'error'>> {
  if (!res.body) throw new Error('Response did not include a streaming body.');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let ttftMs: number | undefined;
  let outputTokens: number | undefined;
  let routedProvider: string | undefined;
  let completed: boolean | undefined;
  let terminalError: string | undefined;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      // OpenAI-compatible servers vary between `data: {...}` and `data:{...}`.
      // Both are valid SSE data fields, and rejecting the latter hid TTFT for
      // otherwise successful OpenCode/OpenRouter streams.
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const event = JSON.parse(data) as {
          provider?: string;
          type?: string;
          choices?: Array<{ delta?: { content?: string } }>;
          usage?: { completion_tokens?: number };
          response?: { usage?: { output_tokens?: number } };
        };
        routedProvider ??= event.provider;
        // Some compatible APIs emit a role-only first delta before content.
        // It is still the first model response event, so record TTFT rather
        // than leaving the metric unavailable for a valid streamed completion.
        if ((event.choices?.length || (protocol === 'responses' && event.type === 'response.output_text.delta')) && ttftMs === undefined) {
          ttftMs = Date.now() - startedAt;
        }
        outputTokens ??= event.usage?.completion_tokens ?? event.response?.usage?.output_tokens;
        if (protocol === 'responses' && event.type === 'response.completed') completed = true;
        if (protocol === 'responses' && event.type === 'response.incomplete') terminalError = 'INCOMPLETE_RESPONSE';
        if (protocol === 'responses' && event.type === 'response.failed') terminalError = 'FAILED_RESPONSE';
      } catch {
        // Providers may send comments or non-JSON keep-alive frames.
      }
    }
  }
  return { ttftMs, outputTokens, routedProvider, completed, error: terminalError };
}

async function request(spec: ProviderSpec, phase: Sample['phase']): Promise<Sample> {
  const startedAt = Date.now();
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(spec.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${spec.key}`, 'Content-Type': 'application/json', ...(spec.protocol === 'responses' ? { Accept: 'text/event-stream' } : {}) },
      body: JSON.stringify(spec.protocol === 'responses'
        ? { ...spec.body, stream: true, store: false }
        : { ...spec.body, stream: true, stream_options: { include_usage: true } }),
      signal,
    });
    if (!res.ok) {
      return { phase, status: res.status, durationMs: Date.now() - startedAt, error: `HTTP_${res.status}` };
    }
    const stream = await readSse(res, startedAt, spec.protocol);
    const durationMs = Date.now() - startedAt;
    return {
      phase,
      status: res.status,
      durationMs,
      ...stream,
      outputTps: stream.outputTokens && stream.ttftMs !== undefined && durationMs > stream.ttftMs
        ? stream.outputTokens / ((durationMs - stream.ttftMs) / 1000)
        : undefined,
    };
  } catch (error) {
    return {
      phase,
      status: 0,
      durationMs: Date.now() - startedAt,
      error: safeRequestError(error),
    };
  }
}

/** Keep benchmark artifacts free of provider error bodies, prompts, and credentials. */
function safeRequestError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'TIMEOUT';
  if (error instanceof DOMException && error.name === 'AbortError') return 'ABORTED';
  if (error instanceof TypeError) return 'NETWORK_ERROR';
  return 'STREAM_OR_RUNTIME_ERROR';
}

async function verifyOpenRouterFreeModel(spec: ProviderSpec): Promise<string | undefined> {
  const res = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { Authorization: `Bearer ${spec.key}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return `Model catalog request failed (${res.status}).`;
  const catalog = await res.json() as { data?: Array<{ id?: string; pricing?: { prompt?: string; completion?: string }; supported_parameters?: string[] }> };
  const model = catalog.data?.find((candidate) => candidate.id === spec.model);
  if (!model) return `${spec.model} is absent from the live OpenRouter catalog.`;
  if (Number(model.pricing?.prompt) !== 0 || Number(model.pricing?.completion) !== 0) return `${spec.model} is not free in the live catalog.`;
  if (!model.supported_parameters?.includes('tools')) return `${spec.model} does not advertise tool support.`;
  return undefined;
}

function summarize(spec: ProviderSpec, eligible: boolean, samples: Sample[]): QualificationResult {
  const measured = samples.filter((sample) => sample.phase !== 'warmup');
  const successful = measured.filter((sample) =>
    sample.status >= 200 && sample.status < 300 && !sample.error && (sample.outputTokens ?? 0) > 0 &&
    (spec.protocol !== 'responses' || (sample.completed && sample.ttftMs !== undefined)),
  );
  const durations = successful.map((sample) => sample.durationMs);
  const ttfts = successful.flatMap((sample) => sample.ttftMs === undefined ? [] : [sample.ttftMs]);
  const tps = successful.flatMap((sample) => sample.outputTps === undefined ? [] : [sample.outputTps]);
  const concurrent = successful.filter((sample) => sample.phase === 'concurrent');
  const concurrentTokens = concurrent.reduce((sum, sample) => sum + (sample.outputTokens ?? 0), 0);
  const concurrentWallMs = concurrent.length ? Math.max(...concurrent.map((sample) => sample.durationMs)) : 0;
  const errorRate = measured.length ? (measured.length - successful.length) / measured.length : 1;
  return {
    provider: spec.id,
    model: spec.model,
    eligible,
    errorRate,
    p50DurationMs: percentile(durations, 0.5),
    p95DurationMs: percentile(durations, 0.95),
    p50TtftMs: percentile(ttfts, 0.5),
    p50OutputTps: percentile(tps, 0.5),
    aggregateConcurrentTps: concurrentWallMs > 0 ? concurrentTokens / (concurrentWallMs / 1000) : undefined,
    passed: eligible && errorRate === 0 && successful.length === measured.length,
    samples,
  };
}

async function qualify(spec: ProviderSpec): Promise<QualificationResult> {
  if (!spec.key) return summarize(spec, false, [{ phase: 'warmup', status: 0, durationMs: 0, error: 'Missing required API key.' }]);
  const eligibilityError = spec.id === 'openrouter' ? await verifyOpenRouterFreeModel(spec) : undefined;
  if (eligibilityError) return summarize(spec, false, [{ phase: 'warmup', status: 0, durationMs: 0, error: eligibilityError }]);
  const samples: Sample[] = [await request(spec, 'warmup')];
  for (let index = 0; index < SERIAL_SAMPLES; index++) samples.push(await request(spec, 'serial'));
  samples.push(...await Promise.all(Array.from({ length: CONCURRENT_SAMPLES }, () => request(spec, 'concurrent'))));
  return summarize(spec, true, samples);
}

function outputPath(argv: string[]): string {
  const index = argv.indexOf('--out');
  if (index >= 0 && argv[index + 1]) return argv[index + 1];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return join(process.cwd(), '.openswarm', 'benchmarks', `provider-qualification-${stamp}.json`);
}

async function main(): Promise<void> {
  loadEnvFile();
  const specs: ProviderSpec[] = [
    { id: 'upstage', model: 'solar-pro3', endpoint: 'https://api.upstage.ai/v1/chat/completions', protocol: 'chat-completions', key: process.env.UPSTAGE_API_KEY_PRIMARY, body: { model: 'solar-pro3', messages: [{ role: 'user', content: PROMPT }], max_tokens: 600 } },
    { id: 'opencode-go', model: 'muse-spark-1.3-contributor', endpoint: 'https://opencode.ai/zen/go/v1/responses', protocol: 'responses', key: process.env.OPENCODE_GO_API_KEY, body: { model: 'muse-spark-1.3-contributor', input: PROMPT, max_output_tokens: 600 } },
    { id: 'openrouter', model: 'cohere/north-mini-code:free', endpoint: 'https://openrouter.ai/api/v1/chat/completions', protocol: 'chat-completions', key: process.env.OPENROUTER_API_KEY, body: { model: 'cohere/north-mini-code:free', messages: [{ role: 'user', content: PROMPT }], max_tokens: 600, provider: { data_collection: 'deny', sort: 'throughput' } } },
  ];
  const results = await Promise.all(specs.map(qualify));
  const report = { measuredAt: new Date().toISOString(), serialSamples: SERIAL_SAMPLES, concurrentSamples: CONCURRENT_SAMPLES, results };
  const path = outputPath(process.argv.slice(2));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  for (const result of results) {
    console.log(`${result.provider}: ${result.passed ? 'PASS' : 'FAIL'} | errors=${(result.errorRate * 100).toFixed(1)}% | p50 TPS=${result.p50OutputTps?.toFixed(1) ?? 'n/a'} | ${result.model}`);
  }
  console.log(`Saved redacted qualification report: ${path}`);
  if (results.some((result) => !result.passed)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
