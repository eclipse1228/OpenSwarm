import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getScopedIssue: vi.fn(),
  resolveRepoPath: vi.fn((project: string) => project),
  createPairSession: vi.fn(),
  setSessionThreadId: vi.fn(),
  addMessage: vi.fn(),
  getPairSession: vi.fn(),
  cancelSession: vi.fn(),
  isRepositoryAllowedInChannel: vi.fn(() => true),
  repositoryForMessageChannel: vi.fn(() => undefined),
  isDirty: vi.fn(async () => false),
  runWorker: vi.fn(),
}));

vi.mock('discord.js', () => ({
  ChannelType: { PublicThread: 11 },
  EmbedBuilder: class {
    setTitle() { return this; }
    setColor() { return this; }
    addFields() { return this; }
    setTimestamp() { return this; }
    setDescription() { return this; }
  },
}));

vi.mock('../linear/index.js', () => ({ getScopedIssue: mocks.getScopedIssue, getMyIssues: vi.fn(async () => []) }));
vi.mock('../support/dev.js', () => ({ resolveRepoPath: mocks.resolveRepoPath }));
vi.mock('../support/gitTracker.js', () => ({ isDirty: mocks.isDirty }));
vi.mock('../agents/agentPair.js', () => ({
  createPairSession: mocks.createPairSession,
  setSessionThreadId: mocks.setSessionThreadId,
  addMessage: mocks.addMessage,
  getPairSession: mocks.getPairSession,
  cancelSession: mocks.cancelSession,
  getActiveSessions: vi.fn(() => []),
}));
vi.mock('../agents/worker.js', () => ({ runWorker: mocks.runWorker }));
vi.mock('../agents/reviewer.js', () => ({}));
vi.mock('../agents/pairMetrics.js', () => ({}));
vi.mock('../agents/pairWebhook.js', () => ({}));
vi.mock('./discordCore.js', () => ({
  pairModeConfig: undefined,
  isRepositoryAllowedInChannel: mocks.isRepositoryAllowedInChannel,
  repositoryForMessageChannel: mocks.repositoryForMessageChannel,
}));
vi.mock('../locale/index.js', () => ({
  t: (key: string) => key,
  getDateLocale: () => 'en-US',
}));
vi.mock('../support/safeLog.js', () => ({ safeConsole: console }));

import { handlePair } from './discordPair.js';

const message = () => {
  const thread = {
    id: 'thread-1',
    send: vi.fn(async () => {}),
    toString: () => '<#thread-1>',
  };
  return {
    reply: vi.fn(async () => {}),
    channel: { threads: { create: vi.fn(async () => thread) } },
  };
};

describe('!pair run task descriptions', () => {
  beforeEach(() => {
    // A dirty-repo assertion may intentionally short-circuit before consuming
    // its one-shot result, so reset this boundary mock for test isolation.
    mocks.isDirty.mockReset();
    mocks.isDirty.mockResolvedValue(false);
    mocks.createPairSession.mockReturnValue({ id: 'pair-1' });
    // Stops the asynchronously launched loop before it invokes real workers.
    mocks.getPairSession.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('forwards the literal -- description when Linear is unavailable', async () => {
    mocks.getScopedIssue.mockRejectedValueOnce(new Error('Linear unavailable'));
    const msg = message();
    const description = 'Check the parser literally: emoji 🧪, quotes "ok", and `code`.';

    await handlePair(msg as never, [
      'run', 'SMOKE-001', '/workspace/OpenSwarm', '--',
      'Check', 'the', 'parser', 'literally:', 'emoji', '🧪,', 'quotes', '"ok",', 'and', '`code`.',
    ]);

    expect(mocks.createPairSession).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'SMOKE-001',
      taskTitle: 'SMOKE-001',
      taskDescription: description,
      projectPath: '/workspace/OpenSwarm',
    }));
  });

  it('treats -- as the description delimiter and defaults the project for the short direct-run form', async () => {
    mocks.getScopedIssue.mockRejectedValueOnce(new Error('Linear unavailable'));
    const msg = message();

    await handlePair(msg as never, [
      'run', 'SMOKE-002', '--', 'Do', 'not', 'use', 'the', 'delimiter', 'as', 'a', 'working', 'directory.',
    ]);

    expect(mocks.createPairSession).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'SMOKE-002',
      taskDescription: 'Do not use the delimiter as a working directory.',
      projectPath: '~/dev',
    }));
  });

  it('keeps an explicit direct-run project when a description follows it', async () => {
    mocks.getScopedIssue.mockRejectedValueOnce(new Error('Linear unavailable'));
    const msg = message();

    await handlePair(msg as never, [
      'run', 'SMOKE-003', '/workspace/OpenSwarm', '--', 'Run', 'the', 'smoke', 'flow.',
    ]);

    expect(mocks.createPairSession).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'SMOKE-003',
      taskDescription: 'Run the smoke flow.',
      projectPath: '/workspace/OpenSwarm',
    }));
  });

  it('keeps the existing direct-run form and uses the Linear description when available', async () => {
    mocks.getScopedIssue.mockResolvedValueOnce({
      title: 'Existing Linear task',
      description: 'Description from Linear',
    });
    const msg = message();

    await handlePair(msg as never, ['run', 'AX-123', '/workspace/OpenSwarm']);

    expect(mocks.createPairSession).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'AX-123',
      taskTitle: 'Existing Linear task',
      taskDescription: 'Description from Linear',
      projectPath: '/workspace/OpenSwarm',
    }));
  });

  it('rejects !pair start when its Linear project resolves outside the originating project channel', async () => {
    mocks.resolveRepoPath.mockImplementationOnce((project: string) =>
      project === 'OtherProject' ? '/workspace/OtherProject' : project,
    );
    mocks.isRepositoryAllowedInChannel.mockReturnValueOnce(false);
    mocks.getScopedIssue.mockResolvedValueOnce({
      id: 'issue-1',
      identifier: 'AX-1',
      title: 'Cross-project issue',
      description: 'Must not start from this channel.',
      project: { name: 'OtherProject' },
    });
    const msg = message();

    await handlePair(msg as never, ['start', 'AX-1']);

    expect(mocks.isRepositoryAllowedInChannel).toHaveBeenCalledWith(msg, '/workspace/OtherProject');
    expect(mocks.createPairSession).not.toHaveBeenCalled();
    expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining('different project channel'));
  });

  it('blocks !pair start in an in-channel dirty repository before creating a session', async () => {
    mocks.resolveRepoPath.mockImplementationOnce((project: string) =>
      project === 'OpenSwarm' ? '/workspace/OpenSwarm' : project,
    );
    mocks.isRepositoryAllowedInChannel.mockReturnValueOnce(true);
    mocks.isDirty.mockResolvedValueOnce(true);
    mocks.getScopedIssue.mockResolvedValueOnce({
      id: 'issue-2',
      identifier: 'AX-2',
      title: 'Protect existing work',
      description: 'This must not launch on a dirty worktree.',
      project: { name: 'OpenSwarm' },
    });
    const msg = message();

    await handlePair(msg as never, ['start', 'AX-2']);

    expect(mocks.isRepositoryAllowedInChannel).toHaveBeenCalledWith(msg, '/workspace/OpenSwarm');
    expect(mocks.isDirty).toHaveBeenCalledWith('/workspace/OpenSwarm');
    expect(mocks.createPairSession).not.toHaveBeenCalled();
    expect(mocks.runWorker).not.toHaveBeenCalled();
    expect(msg.reply).toHaveBeenCalledWith(expect.stringMatching(/uncommitted|dirty|working tree/i));
  });

  it('resolves a direct-run project alias before authorizing and starting its pair session', async () => {
    mocks.resolveRepoPath.mockImplementationOnce((project: string) =>
      project === 'OpenSwarm' ? '/workspace/OpenSwarm' : project,
    );
    mocks.isRepositoryAllowedInChannel.mockImplementation((_msg, project) => project === '/workspace/OpenSwarm');
    mocks.getScopedIssue.mockRejectedValueOnce(new Error('Linear unavailable'));
    const msg = message();

    await handlePair(msg as never, ['run', 'SMOKE-005', 'OpenSwarm', '--', 'Use', 'the', 'canonical', 'repository.']);

    expect(mocks.isRepositoryAllowedInChannel).toHaveBeenCalledWith(msg, '/workspace/OpenSwarm');
    expect(mocks.createPairSession).toHaveBeenCalledWith(expect.objectContaining({
      projectPath: '/workspace/OpenSwarm',
      taskDescription: 'Use the canonical repository.',
    }));
  });

  it('blocks a direct pair run in a dirty repository before creating a session or launching a worker', async () => {
    mocks.isDirty.mockResolvedValueOnce(true);
    const msg = message();

    await handlePair(msg as never, [
      'run', 'SMOKE-006', '/workspace/OpenSwarm', '--', 'Do', 'not', 'overwrite', 'local', 'work.',
    ]);

    expect(mocks.isDirty).toHaveBeenCalledWith('/workspace/OpenSwarm');
    expect(mocks.createPairSession).not.toHaveBeenCalled();
    expect(mocks.runWorker).not.toHaveBeenCalled();
    expect(msg.reply).toHaveBeenCalledWith(expect.stringMatching(/uncommitted|dirty|working tree/i));
  });

  it('fails closed when the direct-run git status check cannot be completed', async () => {
    mocks.isDirty.mockRejectedValueOnce(new Error('git status unavailable'));
    const msg = message();

    await expect(handlePair(msg as never, [
      'run', 'SMOKE-007', '/workspace/OpenSwarm', '--', 'Keep', 'existing', 'work', 'safe.',
    ])).resolves.toBeUndefined();

    expect(mocks.isDirty).toHaveBeenCalledWith('/workspace/OpenSwarm');
    expect(mocks.createPairSession).not.toHaveBeenCalled();
    expect(mocks.runWorker).not.toHaveBeenCalled();
    expect(msg.reply).toHaveBeenCalledWith(expect.stringMatching(/unable|could not|git|working tree/i));
  });
});
