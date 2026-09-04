import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';

// Keep this test independent of the host's ripgrep installation. Any attempt
// to spawn `rg` is observable, and must fail the test.
const execFile = vi.fn((_file: string, _args: string[], _options: unknown, callback: (error: Error) => void) => {
  callback(new Error('ripgrep must not run for invalid search_files input'));
  return undefined as never;
});

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile,
}));

const { executeTool } = await import('./tools.js');

const cwd = await fs.mkdtemp('/tmp/openswarm-search-validation-');

afterAll(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
});

describe('search_files argument validation', () => {
  it.each([
    ['missing pattern', { path: cwd }],
    ['non-string pattern', { path: cwd, pattern: 42 }],
    ['missing path', { pattern: 'needle' }],
    ['non-string path', { pattern: 'needle', path: 42 }],
  ])('rejects %s before invoking ripgrep', async (_caseName, args) => {
    execFile.mockClear();

    await expect(executeTool({
      id: 'invalid-search',
      function: { name: 'search_files', arguments: JSON.stringify(args) },
    }, cwd)).resolves.toMatchObject({
      tool_call_id: 'invalid-search',
      is_error: true,
    });

    expect(execFile).not.toHaveBeenCalled();
  });

  it('passes a dash-prefixed pattern as an explicit regexp value', async () => {
    execFile.mockClear();

    await executeTool({
      id: 'option-like-pattern',
      function: {
        name: 'search_files',
        arguments: JSON.stringify({ path: cwd, pattern: '--pre=untrusted-command' }),
      },
    }, cwd);

    expect(execFile).toHaveBeenCalledWith(
      'rg',
      expect.arrayContaining(['--regexp', '--pre=untrusted-command']),
      expect.anything(),
      expect.any(Function),
    );
  });
});
