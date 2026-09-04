// ============================================
// OpenSwarm - multi-provider pilot configuration contract
// ============================================

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('multi-provider pilot configuration', () => {
  it('accepts and preserves the Upstage orchestrator, OpenCode worker, and free OpenRouter reviewer routes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'openswarm-config-'));
    temporaryDirectories.push(directory);
    const configPath = join(directory, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      adapter: 'upstage',
      language: 'en',
      agents: [{ name: 'openswarm', projectPath: directory, enabled: true, paused: false }],
      autonomous: {
        enabled: true,
        openRouterFreeOnly: true,
        defaultRoles: {
          worker: { adapter: 'opencode-go', model: 'kimi-k2.7-code' },
          reviewer: { adapter: 'openrouter', model: 'cohere/north-mini-code:free' },
        },
        orchestrator: { adapter: 'upstage', model: 'solar-pro3', eventDriven: true },
        projectAgents: [{
          projectPath: directory,
          roles: {
            worker: { adapter: 'opencode-go', model: 'kimi-k2.7-code' },
            reviewer: { adapter: 'openrouter', model: 'cohere/north-mini-code:free' },
          },
        }],
      },
    }));

    const config = loadConfig(configPath);

    expect(config.adapter).toBe('upstage');
    expect(config.autonomous?.orchestrator).toMatchObject({ adapter: 'upstage', model: 'solar-pro3' });
    expect(config.autonomous?.defaultRoles?.worker).toMatchObject({
      adapter: 'opencode-go',
      model: 'kimi-k2.7-code',
    });
    expect(config.autonomous?.defaultRoles?.reviewer).toMatchObject({
      adapter: 'openrouter',
      model: 'cohere/north-mini-code:free',
    });
    expect(config.autonomous?.openRouterFreeOnly).toBe(true);
    expect(config.autonomous?.projectAgents?.[0]?.roles.worker).toMatchObject({
      adapter: 'opencode-go',
      model: 'kimi-k2.7-code',
    });
  });

  it('treats an unresolved optional project Discord channel as absent', () => {
    const directory = mkdtempSync(join(tmpdir(), 'openswarm-config-'));
    temporaryDirectories.push(directory);
    const configPath = join(directory, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      language: 'en',
      agents: [{ name: 'openswarm', projectPath: directory, discordChannelId: '', enabled: true, paused: false }],
      discord: { token: '', channelId: '', projectChannelIds: { openswarm: '' } },
    }));

    const config = loadConfig(configPath);

    expect(config.agents[0].discordChannelId).toBeUndefined();
    expect(config.discordProjectChannelIds).toEqual({});
  });
});
