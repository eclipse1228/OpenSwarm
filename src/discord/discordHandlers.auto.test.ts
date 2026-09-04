import { beforeEach, describe, expect, it, vi } from 'vitest';

const startAutonomous = vi.hoisted(() => vi.fn());

vi.mock('../automation/autonomousRunner.js', () => ({
  getRunner: vi.fn(),
  startAutonomous,
  stopAutonomous: vi.fn(),
}));

const { handleAuto } = await import('./discordHandlers.js');

describe('!auto start', () => {
  beforeEach(() => {
    startAutonomous.mockReset();
  });

  it('cannot recreate a runner with broader defaults than the service configuration', async () => {
    const reply = vi.fn(async () => {});
    await handleAuto({ reply } as any, ['start', '*/1 * * * *', '--pair']);

    expect(startAutonomous).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(expect.stringContaining('!auto run'));
  });
});
