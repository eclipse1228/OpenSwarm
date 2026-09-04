import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  // discordCore reads this at module initialization, before each test runs.
  process.env.DISCORD_ALLOWED_USERS = 'operator';
  return {
    listeners: new Map<string, (message: unknown) => Promise<void>>(),
    pair: vi.fn(async () => {}),
    resolveRepoPath: vi.fn((project: string) => project === 'OpenSwarm' ? '/workspace/OpenSwarm' : null),
    clients: [] as Array<{
      once: ReturnType<typeof vi.fn>;
      on: ReturnType<typeof vi.fn>;
      login: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
      channels: { fetch: ReturnType<typeof vi.fn> };
      user: { tag: string; id: string };
    }>,
  };
});

vi.mock('discord.js', () => ({
  Events: { ClientReady: 'ready' },
  GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4 },
  TextChannel: class {},
  EmbedBuilder: class {
    setTitle() { return this; }
    setDescription() { return this; }
    setColor() { return this; }
    setTimestamp() { return this; }
    addFields() { return this; }
    setURL() { return this; }
  },
  Client: class {
    once = vi.fn();
    on = vi.fn((event: string, handler: (message: unknown) => Promise<void>) => {
      state.listeners.set(event, handler);
    });
    login = vi.fn(async () => 'token');
    destroy = vi.fn(async () => {});
    channels = { fetch: vi.fn() };
    user = { tag: 'test-bot', id: 'bot' };
    constructor() { state.clients.push(this); }
  },
}));

vi.mock('./discordPair.js', () => ({ handlePair: state.pair }));
vi.mock('../support/dev.js', () => ({ resolveRepoPath: state.resolveRepoPath }));

import { initDiscord, stopDiscord } from './discordCore.js';

describe('Discord pair project-channel authorization', () => {
  afterEach(async () => {
    await stopDiscord();
    state.listeners.clear();
    state.pair.mockClear();
    state.resolveRepoPath.mockClear();
    state.clients.length = 0;
  });

  it('rejects a direct pair run whose explicit repository belongs to a different project channel', async () => {
    await initDiscord(
      'token',
      'operations-hub',
      { openswarm: 'openswarm-project' },
      { '/workspace/OpenSwarm': 'openswarm-project' },
    );
    const onMessage = state.listeners.get('messageCreate');
    const reply = vi.fn(async () => {});

    await onMessage?.({
      author: { bot: false, id: 'operator' },
      content: '!pair run SMOKE-004 /workspace/OtherProject -- attempt cross-project work',
      channel: { id: 'openswarm-project' },
      reply,
    });

    expect(state.pair).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(expect.stringContaining('different project channel'));
  });

  it('allows a mapped project-channel run that names the repository by alias', async () => {
    await initDiscord(
      'token',
      'operations-hub',
      { openswarm: 'openswarm-project' },
      { '/workspace/OpenSwarm': 'openswarm-project' },
    );
    const onMessage = state.listeners.get('messageCreate');
    const reply = vi.fn(async () => {});

    await onMessage?.({
      author: { bot: false, id: 'operator' },
      content: '!pair run SMOKE-005 OpenSwarm -- use the canonical mapped repository',
      channel: { id: 'openswarm-project' },
      reply,
    });

    expect(state.pair).toHaveBeenCalledWith(expect.anything(), [
      'run', 'SMOKE-005', 'OpenSwarm', '--', 'use', 'the', 'canonical', 'mapped', 'repository',
    ]);
    expect(state.resolveRepoPath).toHaveBeenCalledWith('OpenSwarm');
    expect(reply).not.toHaveBeenCalled();
  });
});
