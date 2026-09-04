// ============================================
// OpenSwarm - OpenAI-compatible native adapter building blocks
// ============================================

import type {
  AdapterCapabilities,
  AdapterName,
  CliAdapter,
  CliRunOptions,
  CliRunResult,
  ReviewResult,
  WorkerResult,
} from './types.js';
import { abortSignalWithDeadline } from './requestDeadline.js';
import { runAgenticLoop, loopResultToCliResult, type AgenticLoopOptions, type ChatMessage } from './agenticLoop.js';
import { resolveMcpTools } from '../mcp/mcpClient.js';
import { parseReviewerResult, parseWorkerResult } from './resultParsing.js';
import { RateLimitError } from './rateLimitError.js';
import { isInfraError } from './errorClassification.js';
import { consumeChatCompletionsStream } from './chatStream.js';
import { chatToResponsesInput, consumeResponsesStream, toolsToResponsesTools } from './codexResponses.js';
import { resolveLimitResponse, type ThrottleState } from './throttleRetry.js';
import type { ToolDefinition } from './tools.js';
import { prepareApprovedModelRequest } from '../support/approvedEgress.js';
import { loadModelCatalog, parseOpenAiModelList, resolveDefaultModel, type CatalogSpec } from './modelCatalog.js';

const MODEL_LIST_TIMEOUT_MS = 10_000;

export interface CompatibleApiCallerOptions {
  onToken?: (delta: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Stable per-run identifier for provider-side prompt caching and abuse controls. */
  sessionId?: string;
}

export interface CompatibleAdapterSpec {
  name: AdapterName;
  label: string;
  apiBase: string;
  defaultModel: string;
  curatedModels: string[];
  /** Models exposed only through the OpenAI Responses API, not chat completions. */
  responsesModels?: readonly string[];
  /**
   * Chat Completions temperature. `false` leaves the provider's model default
   * untouched for providers that reject a shared OpenAI-compatible value.
   */
  chatTemperature?: number | false;
  getApiKeys: () => string[];
  authError: string;
  userAgent?: string;
}

function apiEndpoint(spec: CompatibleAdapterSpec, suffix: 'models' | 'chat/completions' | 'responses'): string {
  return `${spec.apiBase}/${suffix}`;
}

function catalogSpec(spec: CompatibleAdapterSpec): CatalogSpec {
  return {
    provider: spec.name,
    curated: spec.curatedModels,
    fetchLive: async () => {
      const apiKey = spec.getApiKeys()[0];
      if (!apiKey) return [];
      const res = await fetch(apiEndpoint(spec, 'models'), {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS),
      });
      if (!res.ok) return [];
      return parseOpenAiModelList(await res.json());
    },
  };
}

/** A fallback is safe only before a response body has been accepted. */
function mayTryNextKey(status: number): boolean {
  return status === 401 || status === 403 || status === 429 || status >= 500;
}

export function createCompatibleApiCaller(
  spec: CompatibleAdapterSpec,
  model: string,
  opts: CompatibleApiCallerOptions = {},
) {
  return async (messages: ChatMessage[], tools: ToolDefinition[]) => {
    const usesResponsesApi = spec.responsesModels?.includes(model) ?? false;
    const body: Record<string, unknown> = usesResponsesApi
      ? (() => {
        const { instructions, input } = chatToResponsesInput(messages);
        const payload: Record<string, unknown> = { model, input, stream: true, store: false };
        if (instructions) payload.instructions = instructions;
        if (tools.length > 0) payload.tools = toolsToResponsesTools(tools);
        return payload;
      })()
      : (() => {
        const payload: Record<string, unknown> = {
          model,
          messages,
          max_tokens: 16384,
          stream: true,
          stream_options: { include_usage: true },
        };
        if (spec.chatTemperature !== false) payload.temperature = spec.chatTemperature ?? 0.2;
        return payload;
      })();
    if (!usesResponsesApi && tools.length > 0) body.tools = tools;

    const keys = spec.getApiKeys();
    if (keys.length === 0) throw new Error(spec.authError);
    let lastError: Error | undefined;
    for (let index = 0; index < keys.length; index++) {
      const apiKey = keys[index];
      const throttle: ThrottleState = { attempts: 0 };
      let responseAccepted = false;
      try {
        const request = prepareApprovedModelRequest(apiEndpoint(spec, usesResponsesApi ? 'responses' : 'chat/completions'), body);
        const res = await fetch(request.url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            ...(spec.userAgent ? { 'User-Agent': spec.userAgent } : {}),
            ...(opts.sessionId ? { 'x-opencode-session': opts.sessionId } : {}),
            ...(usesResponsesApi ? { Accept: 'text/event-stream' } : {}),
          },
          body: request.body,
          signal: abortSignalWithDeadline(opts.signal, opts.timeoutMs),
        });
        if (res.ok) {
          // Once this response is handed to the stream consumer, never replay it
          // with another key: a partial tool call must not be duplicated.
          responseAccepted = true;
          return usesResponsesApi
            ? consumeResponsesStream(res, opts.onToken)
            : consumeChatCompletionsStream(res, opts.onToken);
        }

        const errText = await res.text().catch(() => '');
        lastError = new Error(`${spec.label} API error (${res.status}): ${errText.slice(0, 500)}`);
        if (index + 1 < keys.length && mayTryNextKey(res.status)) continue;
        if (await resolveLimitResponse(spec.name, res.status, res.headers, errText, throttle, { signal: opts.signal }) === 'retry') {
          index--;
          continue;
        }
        throw lastError;
      } catch (err) {
        if (err instanceof RateLimitError) throw err;
        // A TypeError from fetch is a connection-level failure before any response.
        if (err instanceof TypeError && !responseAccepted && index + 1 < keys.length && !opts.signal?.aborted) {
          lastError = err;
          continue;
        }
        throw err;
      }
    }
    throw lastError ?? new Error(`${spec.label} API request failed before a response was received.`);
  };
}

export class OpenAiCompatibleCliAdapter implements CliAdapter {
  readonly name: AdapterName;
  readonly capabilities: AdapterCapabilities = {
    supportsStreaming: true,
    supportsJsonOutput: true,
    supportsModelSelection: true,
    managedGit: false,
    supportedSkills: [],
    enforcesReadOnly: true,
    enforcesHumanSurfaceReadOnly: true,
  };

  constructor(protected readonly spec: CompatibleAdapterSpec) {
    this.name = spec.name;
  }

  async isAvailable(): Promise<boolean> {
    return this.spec.getApiKeys().length > 0;
  }

  buildCommand(_options: CliRunOptions): { command: string; args: string[] } {
    return { command: 'echo', args: [`"${this.spec.label} adapter uses run() — not shell spawn"`] };
  }

  async listModels(): Promise<string[]> {
    return (await loadModelCatalog(catalogSpec(this.spec))).models;
  }

  async getDefaultModel(): Promise<string> {
    return resolveDefaultModel(catalogSpec(this.spec), this.spec.defaultModel);
  }

  async run(options: CliRunOptions): Promise<CliRunResult> {
    const startTime = Date.now();
    if (!(await this.isAvailable())) {
      return { exitCode: 1, stdout: '', stderr: this.spec.authError, durationMs: Date.now() - startTime };
    }

    const model = options.model ?? await this.getDefaultModel();
    const callApi = createCompatibleApiCaller(this.spec, model, {
      onToken: options.onToken,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 300000,
      sessionId: `openswarm-${options.processContext?.taskId ?? 'interactive'}-${options.processContext?.stage ?? 'run'}-${model}`,
    });
    const mcpTools = options.readOnly ? undefined : await resolveMcpTools(options.mcpTools);
    const loopOptions: AgenticLoopOptions = {
      systemPrompt: options.systemPrompt,
      prompt: options.prompt,
      cwd: options.cwd ?? process.cwd(),
      model,
      callApi,
      maxTurns: options.maxTurns ?? 20,
      timeoutMs: options.timeoutMs ?? 300000,
      onLog: options.onLog,
      enableTools: options.enableTools ?? true,
      nudgeMaxOnNoEdit: options.nudgeMaxOnNoEdit,
      protectedFiles: options.protectedFiles,
      bashTimeoutMs: options.bashTimeoutMs,
      webTools: options.webTools,
      memoryTools: options.memoryTools,
      shellTools: options.shellTools,
      filesystemTools: options.filesystemTools,
      diagnosticsTool: options.diagnosticsTool,
      readOnly: options.readOnly,
      mcpTools,
      coordinationContext: options.coordinationContext,
      signal: options.signal,
      editFormat: options.editFormat,
      usageAttribution: { adapter: this.name, taskId: options.processContext?.taskId, stage: options.processContext?.stage },
    };
    try {
      const result = await runAgenticLoop(loopOptions);
      options.onLog?.(`[${this.spec.label}] ${result.apiCallCount} API calls, ${result.toolCallCount} tool uses, ${result.totalTokens} tokens`);
      const cli = loopResultToCliResult(result);
      if (cli.costInfo) cli.costInfo.model = model;
      return cli;
    } catch (err) {
      if (err instanceof RateLimitError) throw err;
      if (isInfraError(err)) throw err;
      return { exitCode: 1, stdout: '', stderr: `${this.spec.label} agentic loop failed: ${err instanceof Error ? err.message : String(err)}`, durationMs: Date.now() - startTime };
    }
  }

  parseWorkerOutput(raw: CliRunResult): WorkerResult {
    return parseWorkerResult(raw.stdout);
  }

  parseReviewerOutput(raw: CliRunResult): ReviewResult {
    return parseReviewerResult(raw.stdout);
  }
}
