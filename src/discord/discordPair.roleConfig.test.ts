import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  const session = {
    id: 'pair-role-config',
    taskId: 'SMOKE-002',
    taskTitle: 'Role configuration smoke test',
    taskDescription: 'Exercise the configured worker and reviewer routes.',
    projectPath: '/workspace/OpenSwarm',
    status: 'pending',
    worker: { attempts: 0, maxAttempts: 4 },
    reviewer: {},
    messages: [],
    startedAt: Date.now(),
  };

  return {
    session,
    config: {
      maxAttempts: 4,
      workerTimeoutMs: 111_000,
      reviewerTimeoutMs: 222_000,
      roles: {
        worker: { adapter: 'opencode-go', model: 'muse-spark-1.3-contributor' },
        reviewer: { adapter: 'openrouter', model: 'cohere/north-mini-code:free' },
      },
    },
    getIssue: vi.fn(),
    createPairSession: vi.fn(),
    setSessionThreadId: vi.fn(),
    addMessage: vi.fn(),
    getPairSession: vi.fn(),
    canRetry: vi.fn(),
    updateSessionStatus: vi.fn(),
    saveWorkerResult: vi.fn(),
    saveReviewerResult: vi.fn(),
    runWorker: vi.fn(),
    runReviewer: vi.fn(),
    isDirty: vi.fn(async () => false),
  };
});

vi.mock('discord.js', () => ({
  ChannelType: { PublicThread: 11 },
  EmbedBuilder: class {
    setTitle() { return this; }
    setColor() { return this; }
    addFields() { return this; }
    setTimestamp() { return this; }
    setFooter() { return this; }
  },
}));

vi.mock('../linear/index.js', () => ({
  getIssue: state.getIssue,
  logPairStart: vi.fn(async () => {}),
  logPairReview: vi.fn(async () => {}),
  logPairComplete: vi.fn(async () => {}),
}));
vi.mock('../support/dev.js', () => ({ resolveRepoPath: (project: string) => project }));
vi.mock('../support/gitTracker.js', () => ({ isDirty: state.isDirty }));
vi.mock('../agents/agentPair.js', () => ({
  createPairSession: state.createPairSession,
  setSessionThreadId: state.setSessionThreadId,
  addMessage: state.addMessage,
  getPairSession: state.getPairSession,
  canRetry: state.canRetry,
  updateSessionStatus: state.updateSessionStatus,
  saveWorkerResult: state.saveWorkerResult,
  saveReviewerResult: state.saveReviewerResult,
  getActiveSessions: vi.fn(() => []),
  cancelSession: vi.fn(),
}));
vi.mock('../agents/worker.js', () => ({
  runWorker: state.runWorker,
  formatWorkReport: vi.fn(() => 'worker report'),
}));
vi.mock('../agents/reviewer.js', () => ({
  runReviewer: state.runReviewer,
  formatReviewFeedback: vi.fn(() => 'review report'),
  buildRevisionPrompt: vi.fn(() => 'revision prompt'),
}));
vi.mock('../agents/pairMetrics.js', () => ({ recordSession: vi.fn(async () => {}) }));
vi.mock('../agents/pairWebhook.js', () => ({}));
vi.mock('./discordCore.js', () => ({
  get pairModeConfig() { return state.config; },
  isRepositoryAllowedInChannel: () => true,
  repositoryForMessageChannel: () => undefined,
}));
vi.mock('../locale/index.js', () => ({
  t: (key: string) => key,
  getDateLocale: () => 'en-US',
}));
vi.mock('../support/safeLog.js', () => ({ safeConsole: console }));

import { handlePair } from './discordPair.js';

function message() {
  const thread = {
    id: 'thread-role-config',
    send: vi.fn(async () => {}),
    toString: () => '<#thread-role-config>',
  };
  return {
    reply: vi.fn(async () => {}),
    channel: { threads: { create: vi.fn(async () => thread) } },
  };
}

describe('Discord pair role configuration', () => {
  beforeEach(() => {
    state.session.worker.attempts = 0;
    state.session.status = 'pending';
    state.session.reviewer = {};
    state.session.messages = [];
    state.isDirty.mockResolvedValue(false);
    state.createPairSession.mockReturnValue(state.session);
    state.getPairSession.mockReturnValue(state.session);
    state.canRetry.mockImplementation(() => state.session.worker.attempts < state.session.worker.maxAttempts);
    state.saveWorkerResult.mockImplementation((_id, result) => {
      state.session.worker.attempts += 1;
      state.session.worker.result = result;
    });
    state.saveReviewerResult.mockImplementation((_id, result) => {
      state.session.reviewer.feedback = result;
    });
    state.updateSessionStatus.mockImplementation((_id, status) => {
      state.session.status = status;
    });
    state.runWorker.mockResolvedValue({
      success: true,
      summary: 'implemented',
      filesChanged: [],
      commands: [],
      output: '',
    });
    state.runReviewer.mockResolvedValue({ decision: 'approve', feedback: 'looks good' });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('runs the worker and read-only reviewer with their independently configured provider, model, and timeout', async () => {
    state.getIssue.mockRejectedValueOnce(new Error('Linear unavailable'));

    await handlePair(message() as never, [
      'run', 'SMOKE-002', '/workspace/OpenSwarm', '--', 'Exercise', 'role', 'routing.',
    ]);

    await vi.waitFor(() => expect(state.runReviewer).toHaveBeenCalledTimes(1));

    expect(state.createPairSession).toHaveBeenCalledWith(expect.objectContaining({ maxAttempts: 4 }));
    expect(state.runWorker).toHaveBeenCalledWith(expect.objectContaining({
      adapterName: 'opencode-go',
      model: 'muse-spark-1.3-contributor',
      timeoutMs: 111_000,
    }));
    expect(state.runReviewer).toHaveBeenCalledWith(expect.objectContaining({
      adapterName: 'openrouter',
      model: 'cohere/north-mini-code:free',
      timeoutMs: 222_000,
      readOnly: true,
    }));
  });
});
