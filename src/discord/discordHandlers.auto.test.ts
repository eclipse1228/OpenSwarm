import { beforeEach, describe, expect, it, vi } from 'vitest';

const startAutonomous = vi.hoisted(() => vi.fn());
const getRunner = vi.hoisted(() => vi.fn());
const clearLinearCache = vi.hoisted(() => vi.fn());

vi.mock('../automation/autonomousRunner.js', () => ({
  getRunner,
  startAutonomous,
  stopAutonomous: vi.fn(),
}));

vi.mock('../linear/index.js', () => ({ clearLinearCache }));

const { handleAuto } = await import('./discordHandlers.js');

describe('!auto start', () => {
  beforeEach(() => {
    startAutonomous.mockReset();
    getRunner.mockReset();
    clearLinearCache.mockReset();
  });

  it('cannot recreate a runner with broader defaults than the service configuration', async () => {
    const reply = vi.fn(async () => {});
    await handleAuto({ reply } as any, ['start', '*/1 * * * *', '--pair']);

    expect(startAutonomous).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(expect.stringContaining('!auto run'));
  });

  it('clears cached Linear issue reads before a manual heartbeat', async () => {
    const runNow = vi.fn(async () => {});
    getRunner.mockReturnValue({ runNow });
    const reply = vi.fn(async () => {});

    await handleAuto({ reply } as any, ['run']);

    expect(clearLinearCache).toHaveBeenCalledTimes(1);
    expect(runNow).toHaveBeenCalledTimes(1);
  });
});
