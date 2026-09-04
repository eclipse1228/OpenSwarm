// ============================================
// OpenSwarm - OpenCode Go API adapter
// ============================================

import { createCompatibleApiCaller, OpenAiCompatibleCliAdapter, type CompatibleApiCallerOptions, type CompatibleAdapterSpec } from './openAiCompatible.js';

export const OPENCODE_GO_API_BASE = 'https://opencode.ai/zen/go/v1';
export const OPENCODE_GO_DEFAULT_MODEL = 'kimi-k2.7-code';
export const OPENCODE_GO_CURATED_MODELS = [
  OPENCODE_GO_DEFAULT_MODEL,
  'muse-spark-1.3-contributor',
  'glm-5.3-flash',
  'deepseek-v4-flash',
];
export const OPENCODE_GO_RESPONSES_MODELS = ['muse-spark-1.3-contributor'];

function getEnvApiKeys(): string[] {
  const key = process.env.OPENCODE_GO_API_KEY?.trim();
  return key ? [key] : [];
}

const spec: CompatibleAdapterSpec = {
  name: 'opencode-go',
  label: 'OpenCode Go',
  apiBase: OPENCODE_GO_API_BASE,
  defaultModel: OPENCODE_GO_DEFAULT_MODEL,
  curatedModels: OPENCODE_GO_CURATED_MODELS,
  responsesModels: OPENCODE_GO_RESPONSES_MODELS,
  // Go rejects the generic temperature value for Kimi; use provider defaults.
  chatTemperature: false,
  getApiKeys: getEnvApiKeys,
  userAgent: 'OpenSwarm/0.21.6',
  authError: 'Auth error: Set OPENCODE_GO_API_KEY to use the OpenCode Go adapter.',
};

export class OpenCodeGoCliAdapter extends OpenAiCompatibleCliAdapter {
  constructor() { super(spec); }
}

export function createApiCaller(apiKey: string, model: string, options: CompatibleApiCallerOptions = {}) {
  return createCompatibleApiCaller({ ...spec, getApiKeys: () => [apiKey].filter(Boolean) }, model, options);
}
