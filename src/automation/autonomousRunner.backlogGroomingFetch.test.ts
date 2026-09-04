// The grooming lane must see parked Linear Backlog cards without widening the
// execution lane.  This is intentionally a heartbeat-level contract: a fetch
// implementation that merely changes `includeBacklog` globally would make the
// planner work, but would also risk sending a parked card to the DecisionEngine.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { ITaskSource } from './taskSource.js';
import type { AutonomousConfig } from './runnerTypes.js';

vi.mock('../support/timeWindow.js', () => ({
  checkWorkAllowed: vi.fn(() => ({ allowed: true, reason: 'test window' })),
}));
vi.mock('../core/providerOverride.js', () => ({ writeProviderOverride: vi.fn() }));
vi.mock('../agents/stageModelResolver.js', () => ({
  resolveAdapterDefaultModel: vi.fn(async () => 'test-model'),
}));

const config = (): AutonomousConfig => ({
  linearTeamId: 'team',
  allowedProjects: ['/repo'],
  heartbeatSchedule: '0 * * * *',
  autoExecute: true,
  dryRun: true,
  includeBacklog: false,
  pairMode: true,
  backlogGrooming: { enabled: true, mode: 'comment' },
});

const task = (id: string, linearState: string): TaskItem => ({
  id,
  issueId: id,
  issueIdentifier: id.toUpperCase(),
  source: 'linear',
  title: `${linearState} task`,
  priority: 3,
  createdAt: 1,
  linearState,
  linearProject: { id: 'project-1', name: 'Mapped project' },
});

describe('AutonomousRunner backlog grooming fetch boundary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('fetches Backlog for comment-mode grooming but never passes it to the DecisionEngine when execution excludes Backlog', async () => {
    const [{ AutonomousRunner }, execution] = await Promise.all([
      import('./autonomousRunner.js'),
      import('./runnerExecution.js'),
    ]);
    const todo = task('todo-1', 'Todo');
    const backlog = task('backlog-1', 'Backlog');

    // The source represents the two Linear read scopes the runner needs.  The
    // current execution scope deliberately omits Backlog; the grooming scope
    // includes it.  Production must request the latter explicitly, rather
    // than changing the execution fetch globally.
    const fetchTasks = vi.fn(async (options?: { includeBacklog?: boolean }) => (
      options?.includeBacklog ? [todo, backlog] : [todo]
    ));
    execution.setTaskSource({
      kind: 'linear',
      fetchTasks,
      lookupIssueState: vi.fn(async () => ({ ok: true as const, issue: null })),
      updateState: vi.fn(async () => true),
      addComment: vi.fn(async () => {}),
      createTask: vi.fn(),
      createSubIssue: vi.fn(),
      logPairStart: vi.fn(),
      logPairComplete: vi.fn(),
      logBlocked: vi.fn(),
      logStuck: vi.fn(),
      unstick: vi.fn(),
      logHalt: vi.fn(),
      markAsDecomposed: vi.fn(),
    } as unknown as ITaskSource);

    const runner = new AutonomousRunner(config());
    const internal = runner as unknown as {
      maybeRunBacklogGrooming(tasks: TaskItem[]): Promise<TaskItem[]>;
      engine: { heartbeat(tasks: TaskItem[]): Promise<unknown> };
      executeTaskPairMode(task: TaskItem): Promise<void>;
      durableRuns: { close(): void };
      refreshKnowledgeGraphs(): void;
      refreshCodeRegistries(): void;
    };
    const groom = vi.fn(async (tasks: TaskItem[]) => tasks);
    const decide = vi.fn(async () => ({ action: 'skip', reason: 'test stop' }));
    internal.maybeRunBacklogGrooming = groom;
    internal.engine.heartbeat = decide;
    internal.executeTaskPairMode = vi.fn(async () => {});
    internal.refreshKnowledgeGraphs = vi.fn();
    internal.refreshCodeRegistries = vi.fn();

    try {
      await runner.heartbeat();
    } finally {
      internal.durableRuns.close();
    }

    expect(fetchTasks.mock.calls.some(([options]) => (
      (options as { includeBacklog?: boolean } | undefined)?.includeBacklog === true
    ))).toBe(true);
    expect(groom).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ id: 'backlog-1', linearState: 'Backlog' }),
    ]));
    expect(decide).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'todo-1', linearState: 'Todo' }),
    ]);
    expect(decide.mock.calls[0]?.[0]).not.toContainEqual(
      expect.objectContaining({ id: 'backlog-1' }),
    );
    expect(internal.executeTaskPairMode).not.toHaveBeenCalled();
  });

  it('runs the advisory grooming fetch even when the execution queue is empty', async () => {
    const [{ AutonomousRunner }, execution] = await Promise.all([
      import('./autonomousRunner.js'),
      import('./runnerExecution.js'),
    ]);
    const backlog = task('backlog-only', 'Backlog');
    const fetchTasks = vi.fn(async (options?: { includeBacklog?: boolean }) => (
      options?.includeBacklog ? [backlog] : []
    ));
    execution.setTaskSource({
      kind: 'linear', fetchTasks,
      lookupIssueState: vi.fn(async () => ({ ok: true as const, issue: null })),
      updateState: vi.fn(async () => true), addComment: vi.fn(async () => {}),
      createTask: vi.fn(), createSubIssue: vi.fn(), logPairStart: vi.fn(),
      logPairComplete: vi.fn(), logBlocked: vi.fn(), logStuck: vi.fn(),
      unstick: vi.fn(), logHalt: vi.fn(), markAsDecomposed: vi.fn(),
    } as unknown as ITaskSource);
    const runner = new AutonomousRunner(config());
    const internal = runner as unknown as {
      maybeRunBacklogGrooming(tasks: TaskItem[]): Promise<TaskItem[]>;
      engine: { heartbeat(tasks: TaskItem[]): Promise<unknown> };
      durableRuns: { close(): void };
      refreshKnowledgeGraphs(): void;
      refreshCodeRegistries(): void;
    };
    const groom = vi.fn(async (tasks: TaskItem[]) => tasks);
    const decide = vi.fn(async () => ({ action: 'skip', reason: 'must not execute parked work' }));
    internal.maybeRunBacklogGrooming = groom;
    internal.engine.heartbeat = decide;
    internal.refreshKnowledgeGraphs = vi.fn();
    internal.refreshCodeRegistries = vi.fn();
    try {
      await runner.heartbeat();
    } finally {
      internal.durableRuns.close();
    }
    expect(groom).toHaveBeenCalledWith([backlog]);
    expect(decide).not.toHaveBeenCalled();
  });
});
