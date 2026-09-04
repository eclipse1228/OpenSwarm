import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = vi.hoisted(() => ({
  spawnCli: vi.fn(async () => ({
    exitCode: 0,
    stdout: '안녕하세요! 무엇을 도와드릴까요?',
    stderr: '',
    durationMs: 12,
  })),
  parseWorkerOutput: vi.fn(() => ({
    success: true,
    summary: 'Files Modified - package.json',
    filesChanged: ['package.json'],
    commands: ['npm test'],
  })),
  searchMemory: vi.fn(async () => []),
  formatMemoryContext: vi.fn(() => ''),
  saveConversation: vi.fn(async () => {}),
}));

vi.mock('../adapters/index.js', () => ({
  getAdapter: () => ({ name: 'upstage', parseWorkerOutput: state.parseWorkerOutput }),
  spawnCli: state.spawnCli,
}));

vi.mock('../memory/index.js', () => ({
  searchMemory: state.searchMemory,
  formatMemoryContext: state.formatMemoryContext,
  saveConversation: state.saveConversation,
}));

import { channelHistoryMap, handleChat } from './discordCore.js';

describe('Discord general chat', () => {
  let historyDirectory: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    channelHistoryMap.clear();
    state.spawnCli.mockClear();
    state.parseWorkerOutput.mockClear();
    state.searchMemory.mockClear();
    state.formatMemoryContext.mockClear();
    state.saveConversation.mockClear();
    delete process.env.OPENSWARM_CHAT_HISTORY_FILE;
    if (historyDirectory) await rm(historyDirectory, { recursive: true, force: true });
    historyDirectory = undefined;
  });

  it('uses a dedicated no-tools conversational completion and replies with raw text', async () => {
    historyDirectory = mkdtempSync(join(tmpdir(), 'openswarm-discord-chat-'));
    process.env.OPENSWARM_CHAT_HISTORY_FILE = join(historyDirectory, 'history.json');
    const reply = vi.fn(async () => {});
    const sendTyping = vi.fn(async () => {});

    await handleChat({
      id: 'message-1',
      content: '안녕',
      author: { id: 'operator', username: 'Daniel' },
      channel: { id: 'project-channel', sendTyping },
      reply,
    } as never);

    expect(state.spawnCli).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'upstage' }),
      expect.objectContaining({
        readOnly: true,
        enableTools: false,
        shellTools: false,
        filesystemTools: false,
        webTools: false,
        memoryTools: false,
        maxTurns: 1,
      }),
    );

    const options = state.spawnCli.mock.calls[0][1] as { prompt: string };
    expect(options.prompt).toContain('Discord conversation');
    expect(options.prompt).not.toContain('Use the tools to actually edit files');
    expect(state.parseWorkerOutput).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith('안녕하세요! 무엇을 도와드릴까요?');
  });

  it('keeps general chat out of durable and long-term memory stores', async () => {
    historyDirectory = mkdtempSync(join(tmpdir(), 'openswarm-discord-chat-'));
    const historyPath = join(historyDirectory, 'history.json');
    process.env.OPENSWARM_CHAT_HISTORY_FILE = historyPath;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleChat({
      id: 'message-private',
      content: '이 대화는 장기 메모리에 저장되면 안 됩니다',
      author: { id: 'operator', username: 'Daniel' },
      channel: { id: 'project-channel', sendTyping: vi.fn(async () => {}) },
      reply: vi.fn(async () => {}),
    } as never);

    expect(channelHistoryMap.get('project-channel')).toHaveLength(1);
    expect(state.searchMemory).not.toHaveBeenCalled();
    expect(state.formatMemoryContext).not.toHaveBeenCalled();
    expect(state.saveConversation).not.toHaveBeenCalled();
    expect(existsSync(historyPath)).toBe(false);
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('이 대화는 장기 메모리에 저장되면 안 됩니다'));
  });
});
