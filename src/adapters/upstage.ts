// ============================================
// OpenSwarm - Upstage Solar API adapter
// ============================================

import { createCompatibleApiCaller, OpenAiCompatibleCliAdapter, type CompatibleApiCallerOptions, type CompatibleAdapterSpec } from './openAiCompatible.js';

export const UPSTAGE_API_BASE = 'https://api.upstage.ai/v1';
export const UPSTAGE_DEFAULT_MODEL = 'solar-pro3';

function getEnvApiKeys(): string[] {
  return [process.env.UPSTAGE_API_KEY_PRIMARY, process.env.UPSTAGE_API_KEY_SECONDARY, process.env.UPSTAGE_API_KEY]
    .map((key) => key?.trim())
    .filter((key): key is string => Boolean(key));
}

const spec: CompatibleAdapterSpec = {
  name: 'upstage',
  label: 'Upstage',
  apiBase: UPSTAGE_API_BASE,
  defaultModel: UPSTAGE_DEFAULT_MODEL,
  curatedModels: [UPSTAGE_DEFAULT_MODEL],
  getApiKeys: getEnvApiKeys,
  authError: 'Auth error: Set UPSTAGE_API_KEY_PRIMARY (and optional UPSTAGE_API_KEY_SECONDARY) to use the Upstage adapter.',
};

export class UpstageCliAdapter extends OpenAiCompatibleCliAdapter {
  constructor() { super(spec); }
}

export function createApiCaller(
  primaryApiKey: string,
  model: string,
  options: CompatibleApiCallerOptions & { fallbackApiKey?: string } = {},
) {
  const { fallbackApiKey, ...common } = options;
  return createCompatibleApiCaller({ ...spec, getApiKeys: () => [primaryApiKey, fallbackApiKey].filter((key): key is string => Boolean(key?.trim())) }, model, common);
}
