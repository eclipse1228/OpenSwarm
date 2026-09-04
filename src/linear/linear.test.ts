import { describe, expect, it, vi } from 'vitest';
import {
  addComment,
  clearLinearCache,
  createSubIssue,
  drainLinearConnection,
  effectCommentId,
  fetchIssuesForStates,
  getMyIssues,
  getScopedIssue,
  initLinear,
  parseBlockerIdentifiers,
  setDefaultLinearProjectIds,
  updateIssueState,
} from './linear.js';
import { LinearClient } from '@linear/sdk';

// createSubIssue reads the module-level client singleton (getClient()), set only
// via initLinear()'s real `new LinearClient(...)` — mock the constructor so
// initLinear() installs a fake we control, instead of refactoring the function
// to take an injected client just for this test.
vi.mock('@linear/sdk', () => ({ LinearClient: vi.fn() }));

describe('effectCommentId', () => {
  it('derives a stable, marker-specific UUIDv4 for Linear uniqueness', () => {
    const first = effectCommentId('complete:issue-1:attempt:1');
    expect(first).toBe(effectCommentId('complete:issue-1:attempt:1'));
    expect(first).not.toBe(effectCommentId('complete:issue-1:attempt:2'));
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('fetchIssuesForStates pagination', () => {
  it('collects every page', async () => {
    let page = 0;
    const queries: string[] = [];
    const linear = {
      client: {
        rawRequest: async (query: string) => {
          queries.push(query);
          return ({ data: { issues: {
          nodes: [{ id: `id-${page}`, identifier: `INT-${page}`, title: 't', priority: 2 }],
          pageInfo: { hasNextPage: page++ === 0, endCursor: `cursor-${page}` },
          } } });
        },
      },
    } as unknown as LinearClient;
    expect((await fetchIssuesForStates(linear, ['Todo'])).nodes.map((node) => node.id)).toEqual(['id-0', 'id-1']);
    expect(queries[0]).toMatch(/\burl\b/);
  });

  it('reports explicit truncation instead of silently returning a partial set', async () => {
    let page = 0;
    const linear = {
      client: {
        rawRequest: async () => ({ data: { issues: {
          nodes: [],
          pageInfo: { hasNextPage: true, endCursor: `cursor-${page++}` },
        } } }),
      },
    } as unknown as LinearClient;
    await expect(fetchIssuesForStates(linear, ['Todo'])).rejects.toThrow(/safety cap/);
  });
});

describe('project-scoped autonomous Linear fetches', () => {
  afterEach(() => {
    clearLinearCache();
    setDefaultLinearProjectIds(undefined);
  });

  it('admits mapped-project Todo, Ready, and In Progress work while excluding Backlog', async () => {
    const rawRequest = vi.fn(async (_query: string, _variables: { filter: Record<string, any> }) => ({
      data: {
        issues: {
          // Deliberately return malformed server-side results as well: the
          // daemon must defend the execution boundary even if a tracker query
          // broadens unexpectedly.
          nodes: [
            {
              id: 'openswarm-todo', identifier: 'AGT-1', title: 'Mapped Todo', priority: 2,
              state: { name: 'Todo' }, project: { id: 'openswarm-project', name: 'OpenSwarm' },
              labels: { nodes: [] },
            },
            {
              id: 'openswarm-ready', identifier: 'AGT-READY', title: 'Mapped Ready', priority: 2,
              state: { name: 'Ready' }, project: { id: 'openswarm-project', name: 'OpenSwarm' },
              labels: { nodes: [] },
            },
            {
              id: 'other-project-todo', identifier: 'AGT-2', title: 'Foreign Todo', priority: 1,
              state: { name: 'Todo' }, project: { id: 'other-project', name: 'Other' },
              labels: { nodes: [] },
            },
            {
              id: 'openswarm-backlog', identifier: 'AGT-3', title: 'Parked Backlog', priority: 1,
              state: { name: 'Backlog' }, project: { id: 'openswarm-project', name: 'OpenSwarm' },
              labels: { nodes: [] },
            },
            {
              id: 'openswarm-review', identifier: 'AGT-4', title: 'Human review in progress', priority: 1,
              state: { name: 'In Review' }, project: { id: 'openswarm-project', name: 'OpenSwarm' },
              labels: { nodes: [] },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    }));
    vi.mocked(LinearClient).mockImplementation(function (this: unknown) {
      return { client: { rawRequest } } as never;
    } as never);
    initLinear('oauth-token', 'agent-ko-korea', true);

    const issues = await getMyIssues({
      slim: true,
      projectIds: ['openswarm-project'],
      includeBacklog: false,
    } as Parameters<typeof getMyIssues>[0]);

    expect(issues.map((issue) => issue.id)).toEqual(['openswarm-todo', 'openswarm-ready']);
    expect(rawRequest).toHaveBeenCalledTimes(2);
    for (const [, variables] of rawRequest.mock.calls) {
      expect(variables.filter).toMatchObject({
        project: { id: { in: ['openswarm-project'] } },
      });
      expect(variables.filter.state.name.in).not.toContain('Backlog');
      expect(variables.filter.state.name.in).not.toContain('In Review');
    }
    expect(rawRequest.mock.calls.map(([, variables]) => variables.filter.state.name.in)).toContainEqual(['Todo', 'Ready']);
  });

  function installScopeQueryClient() {
    const rawRequest = vi.fn(async () => ({
      data: {
        issues: {
          nodes: [
            {
              id: 'configured-project-todo', identifier: 'AGT-SCOPE-1', title: 'Configured project task', priority: 2,
              state: { name: 'Todo' }, project: { id: 'configured-project', name: 'OpenSwarm' },
              labels: { nodes: [] },
            },
            {
              id: 'explicit-project-todo', identifier: 'AGT-SCOPE-2', title: 'Explicit override task', priority: 2,
              state: { name: 'Todo' }, project: { id: 'explicit-project', name: 'Different project' },
              labels: { nodes: [] },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    }));
    vi.mocked(LinearClient).mockImplementation(function (this: unknown) {
      return { client: { rawRequest } } as never;
    } as never);
    initLinear('oauth-token', 'agent-ko-korea', true);
    return rawRequest;
  }

  it('uses the configured project scope for slim issue reads when the caller supplies none', async () => {
    const rawRequest = installScopeQueryClient();
    setDefaultLinearProjectIds(['configured-project']);

    const issues = await getMyIssues({ slim: true, includeBacklog: false });

    expect(issues.map((issue) => issue.id)).toEqual(['configured-project-todo']);
    for (const [, variables] of rawRequest.mock.calls) {
      expect(variables.filter).toMatchObject({
        project: { id: { in: ['configured-project'] } },
      });
    }
  });

  it('lets an explicit slim issue scope override the configured default project scope', async () => {
    const rawRequest = installScopeQueryClient();
    setDefaultLinearProjectIds(['configured-project']);

    const issues = await getMyIssues({
      slim: true,
      includeBacklog: false,
      projectIds: ['explicit-project'],
    });

    expect(issues.map((issue) => issue.id)).toEqual(['explicit-project-todo']);
    for (const [, variables] of rawRequest.mock.calls) {
      expect(variables.filter).toMatchObject({
        project: { id: { in: ['explicit-project'] } },
      });
    }
  });

  it('fails closed for slim issue reads when the configured project scope is explicitly empty', async () => {
    const rawRequest = installScopeQueryClient();
    setDefaultLinearProjectIds([]);

    await expect(getMyIssues({ slim: true, includeBacklog: false })).resolves.toEqual([]);
    expect(rawRequest).not.toHaveBeenCalled();
  });
});

describe('project-scoped direct Linear issue lookups', () => {
  afterEach(() => {
    clearLinearCache();
    setDefaultLinearProjectIds(undefined);
  });

  function makeDirectIssue(projectId: string) {
    return {
      id: 'direct-issue-id',
      identifier: 'AGT-DIRECT-1',
      title: 'Direct issue',
      url: 'https://linear.app/agent-ko-korea/issue/AGT-DIRECT-1',
      description: null,
      priority: 2,
      comments: vi.fn(async () => ({ nodes: [] })),
      labels: vi.fn(async () => ({ nodes: [] })),
      project: Promise.resolve({ id: projectId, name: 'OpenSwarm' }),
      inverseRelations: vi.fn(async () => ({ nodes: [] })),
      state: Promise.resolve({ name: 'Todo', type: 'unstarted' }),
      createdAt: new Date('2026-09-04T00:00:00.000Z'),
      updatedAt: new Date('2026-09-04T00:00:00.000Z'),
    };
  }

  function installDirectIssueClient(issue: ReturnType<typeof makeDirectIssue>) {
    const linearIssue = vi.fn(async () => issue);
    const rawRequest = vi.fn(async () => ({
      data: {
        issues: {
          nodes: [{
            id: issue.id,
            identifier: issue.identifier,
            title: issue.title,
            url: issue.url,
            description: issue.description,
            priority: issue.priority,
            state: { name: 'Todo' },
            project: await issue.project,
            labels: { nodes: [] },
          }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    }));
    vi.mocked(LinearClient).mockImplementation(function (this: unknown) {
      return { issue: linearIssue, client: { rawRequest } } as never;
    } as never);
    initLinear('oauth-token', 'agent-ko-korea', true);
    return linearIssue;
  }

  it('fails closed before fetching when no default project scope is configured', async () => {
    const linearIssue = installDirectIssueClient(makeDirectIssue('foreign-project'));

    await expect(getScopedIssue('direct-issue-id')).resolves.toBeUndefined();
    expect(linearIssue).not.toHaveBeenCalled();
  });

  it('fails closed before fetching when the configured default project scope is empty', async () => {
    const linearIssue = installDirectIssueClient(makeDirectIssue('foreign-project'));
    setDefaultLinearProjectIds([]);

    await expect(getScopedIssue('direct-issue-id')).resolves.toBeUndefined();
    expect(linearIssue).not.toHaveBeenCalled();
  });

  it('does not expose a directly addressed issue from another project', async () => {
    const linearIssue = installDirectIssueClient(makeDirectIssue('foreign-project'));
    setDefaultLinearProjectIds(['openswarm-project']);

    await expect(getScopedIssue('direct-issue-id')).resolves.toBeUndefined();
    // The preliminary mapped-project scan is allowed to receive a malformed
    // foreign result, but the direct lookup must never dereference it.
    expect(linearIssue).not.toHaveBeenCalled();
  });

  it('returns a directly addressed issue only when it belongs to the configured project scope', async () => {
    const linearIssue = installDirectIssueClient(makeDirectIssue('openswarm-project'));
    setDefaultLinearProjectIds(['openswarm-project']);

    await expect(getScopedIssue('direct-issue-id')).resolves.toMatchObject({
      id: 'direct-issue-id',
      identifier: 'AGT-DIRECT-1',
      project: { id: 'openswarm-project' },
    });
    expect(linearIssue).toHaveBeenCalledWith('direct-issue-id');
  });
});

describe('unstarted state compatibility', () => {
  it('moves a failed pilot task back to the team\'s Ready state when Todo is absent', async () => {
    const updateIssue = vi.fn(async () => undefined);
    const fakeClient = {
      issue: vi.fn(async () => ({ team: Promise.resolve({ id: 'agent-ko-korea' }) })),
      team: vi.fn(async () => ({ states: vi.fn(async () => ({ nodes: [{ id: 'ready-id', name: 'Ready' }] })) })),
      updateIssue,
    };
    vi.mocked(LinearClient).mockImplementation(function (this: unknown) { return fakeClient as never; } as never);
    initLinear('oauth-token', 'agent-ko-korea', true);

    await expect(updateIssueState('issue-id', 'Todo', 0)).resolves.toBe(true);
    expect(updateIssue).toHaveBeenCalledWith('issue-id', { stateId: 'ready-id' });
  });
});

// INT-1809: the KYTE team writes dependencies as description prose ("블로커: …")
// rather than structured Linear relations, so the text parser is the high-value path.
describe('parseBlockerIdentifiers', () => {
  it('parses slash-separated ids that share a team prefix', () => {
    // The real KT-308 case: "블로커: KT-305/306/307" — 306/307 are bare numbers.
    expect(parseBlockerIdentifiers('블로커: KT-305/306/307')).toEqual([
      'KT-305',
      'KT-306',
      'KT-307',
    ]);
  });

  it('parses comma-separated full identifiers', () => {
    expect(parseBlockerIdentifiers('블로커: KT-302, KT-307')).toEqual(['KT-302', 'KT-307']);
  });

  it('parses the English "Blocked by:" label', () => {
    expect(parseBlockerIdentifiers('Blocked by: INT-1809')).toEqual(['INT-1809']);
  });

  it('tolerates markdown bold around the label', () => {
    expect(parseBlockerIdentifiers('**블로커:** KT-305/306')).toEqual(['KT-305', 'KT-306']);
  });

  it('accepts "Depends on" without a colon', () => {
    expect(parseBlockerIdentifiers('Depends on KT-42')).toEqual(['KT-42']);
  });

  it('only reads the blocker line, not surrounding prose', () => {
    const desc = 'Some intro about issue 999.\n블로커: KT-100\nMore notes mentioning 12345.';
    expect(parseBlockerIdentifiers(desc)).toEqual(['KT-100']);
  });

  it('mixes teams and dedupes', () => {
    expect(parseBlockerIdentifiers('블로커: KT-305, INT-1610, KT-305')).toEqual([
      'KT-305',
      'INT-1610',
    ]);
  });

  it('returns empty for missing or blocker-free descriptions', () => {
    expect(parseBlockerIdentifiers(undefined)).toEqual([]);
    expect(parseBlockerIdentifiers('No dependencies here.')).toEqual([]);
    expect(parseBlockerIdentifiers('블로커: 없음')).toEqual([]);
  });
});

describe('drainLinearConnection', () => {
  function connection(pages: Array<Array<{ id: string }>>) {
    // Mirrors the SDK contract: fetchNext() appends the next page onto the
    // same connection's nodes and resolves the connection itself.
    let page = 0;
    const conn = {
      nodes: [...pages[0]],
      pageInfo: { hasNextPage: pages.length > 1 },
      fetchNext: async () => {
        page += 1;
        conn.nodes.push(...pages[page]);
        conn.pageInfo.hasNextPage = page < pages.length - 1;
        return conn;
      },
    };
    return conn;
  }

  it('follows the connection past the first page instead of truncating', async () => {
    // Discovery used a single `first: 250` read, silently dropping every team
    // or project past the first page in larger workspaces.
    const conn = connection([[{ id: 'a' }, { id: 'b' }], [{ id: 'c' }], [{ id: 'd' }]]);
    await expect(drainLinearConnection(conn)).resolves.toEqual([
      { id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' },
    ]);
  });

  it('returns a single page untouched', async () => {
    await expect(drainLinearConnection(connection([[{ id: 'only' }]]))).resolves.toEqual([{ id: 'only' }]);
  });

  it('stops on a pagination cursor that never terminates', async () => {
    const conn = {
      nodes: [{ id: 'x' }],
      pageInfo: { hasNextPage: true },
      fetchNext: async () => conn,
    };
    await expect(drainLinearConnection(conn)).resolves.toEqual([{ id: 'x' }]);
  });

  it('tolerates a connection with no pageInfo', async () => {
    await expect(drainLinearConnection({ nodes: [{ id: 'n' }] })).resolves.toEqual([{ id: 'n' }]);
  });
});

// AGT-4048: a decomposition retry re-plans (and so regenerates) every sub-task's
// title/description, but reuses the same stable per-slot idempotencyId. The
// fix is to converge on an existing sub-issue by that ID + parent alone —
// content is diagnostic only, never a reason to treat "already created" as a
// hard failure.
describe('createSubIssue idempotent recovery (AGT-4048)', () => {
  function installFakeLinearClient(overrides: { existingChild: Record<string, unknown> }) {
    const parentIssue = { id: 'parent-uuid', team: Promise.resolve({ id: 'team-uuid' }) };
    const team = { labels: vi.fn(async () => ({ nodes: [] })) };
    const fakeClient = {
      issue: vi.fn(async (id: string) => {
        if (id === 'parent-uuid') return parentIssue;
        if (id === 'child-uuid-1') return overrides.existingChild;
        throw new Error(`unexpected issue() call: ${id}`);
      }),
      team: vi.fn(async () => team),
      createIssue: vi.fn(async () => {
        throw new Error('Conflict on insert of Issue - Entity Issue with id child-uuid-1 already exists.');
      }),
    };
    vi.mocked(LinearClient).mockImplementation(function (this: unknown) { return fakeClient as never; } as never);
    initLinear('fake-key', 'team-1');
    return fakeClient;
  }

  it('recovers the existing sub-issue by ID+parent alone when the re-planned title/description differs', async () => {
    installFakeLinearClient({
      existingChild: {
        id: 'child-uuid-1',
        identifier: 'INT-501',
        title: 'Original title from the first attempt',
        description: 'Original description',
        priority: 3,
        parent: Promise.resolve({ id: 'parent-uuid' }),
        state: Promise.resolve({ name: 'Todo' }),
      },
    });

    const result = await createSubIssue(
      'parent-uuid',
      'A freshly re-planned title that differs from the first attempt',
      'A freshly re-planned description',
      { idempotencyId: 'child-uuid-1' },
    );

    expect(result).toMatchObject({ id: 'child-uuid-1', identifier: 'INT-501' });
  });

  it('rejects convergence when the existing artifact belongs to a different parent', async () => {
    installFakeLinearClient({
      existingChild: {
        id: 'child-uuid-1',
        identifier: 'INT-501',
        title: 'Original title',
        description: 'Original description',
        priority: 3,
        parent: Promise.resolve({ id: 'some-other-parent' }),
        state: Promise.resolve({ name: 'Todo' }),
      },
    });

    const result = await createSubIssue('parent-uuid', 'Re-planned title', 'Re-planned description', {
      idempotencyId: 'child-uuid-1',
    });

    expect(result).toHaveProperty('error');
  });
});

// AGT-4051: same shape as AGT-4048, one call deeper — a stable commentId is
// the identity guarantee; the body (which callers bake a timestamp into) can
// legitimately differ on every retry and must not block convergence.
describe('addComment idempotent recovery (AGT-4051)', () => {
  it('converges on an existing comment by id+issue alone, even when the body differs (a timestamp changed)', async () => {
    const fakeClient = {
      createComment: vi.fn(async () => {
        throw new Error('Conflict on insert of Comment - Entity Comment with id comment-1 already exists.');
      }),
      comment: vi.fn(async ({ id }: { id: string }) =>
        id === 'comment-1'
          ? { body: 'stale body with an old timestamp', issue: Promise.resolve({ id: 'issue-1' }) }
          : (() => { throw new Error(`unexpected comment() call: ${id}`); })()),
    };
    vi.mocked(LinearClient).mockImplementation(function (this: unknown) { return fakeClient as never; } as never);
    initLinear('fake-key', 'team-1');

    await expect(addComment('issue-1', 'fresh body with a new timestamp', 'comment-1')).resolves.toBeUndefined();
  });

  it('rejects convergence when the existing comment belongs to a different issue', async () => {
    const fakeClient = {
      createComment: vi.fn(async () => {
        throw new Error('Conflict on insert of Comment - Entity Comment with id comment-1 already exists.');
      }),
      comment: vi.fn(async () => ({ body: 'body', issue: Promise.resolve({ id: 'some-other-issue' }) })),
    };
    vi.mocked(LinearClient).mockImplementation(function (this: unknown) { return fakeClient as never; } as never);
    initLinear('fake-key', 'team-1');

    await expect(addComment('issue-1', 'body', 'comment-1')).rejects.toThrow('already exists');
  });
});
