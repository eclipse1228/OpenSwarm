// ============================================
// OpenSwarm - Tracker-backed coordination board
// ============================================

import type { ITaskSource } from '../automation/taskSource.js';
import { redactCoordinationText, type CoordinationEvent } from './coordinationStore.js';

const MARKER = '<!-- openswarm-coordination:';
const BOARD_SUMMARY_LIMIT = 500;
const BOARD_DETAIL_LIMIT = 4_000;
const OMIT_DETAIL_KINDS = new Set<CoordinationEvent['kind']>([
  'human-answer',
  'mcp-audit',
  'instruction-snapshot',
]);

/**
 * Linear is a remote, human-facing coordination surface. Keep it useful for
 * progress while ensuring it never becomes a copy of prompts, tool arguments,
 * or a person's potentially sensitive answer.
 */
function eventForCoordinationBoard(event: CoordinationEvent): CoordinationEvent {
  const detail = event.kind === 'human-answer'
    ? 'Answer received; contents remain in local coordination state.'
    : OMIT_DETAIL_KINDS.has(event.kind)
      ? undefined
      : event.detail ? redactCoordinationText(event.detail, BOARD_DETAIL_LIMIT) : undefined;

  return {
    ...event,
    summary: redactCoordinationText(event.summary, BOARD_SUMMARY_LIMIT),
    detail,
    // Metadata may contain an MCP invocation envelope. It is intentionally
    // useful locally but must never be mirrored to Linear.
    metadata: undefined,
  };
}

export function formatCoordinationComment(event: CoordinationEvent): string {
  const safeEvent = eventForCoordinationBoard(event);
  const body = {
    version: 1,
    id: safeEvent.id,
    seq: safeEvent.seq,
    repository: safeEvent.repository,
    repoKey: safeEvent.repoKey,
    taskId: safeEvent.taskId,
    taskLabel: safeEvent.taskLabel,
    sourceTaskId: safeEvent.sourceTaskId,
    sourceTaskLabel: safeEvent.sourceTaskLabel,
    targetTaskId: safeEvent.targetTaskId,
    targetTaskLabel: safeEvent.targetTaskLabel,
    actor: safeEvent.actor,
    // Call signs travel with the message: a board comment restored on another
    // host would otherwise show routing addresses where the operator expects
    // the name the agent is known by.
    actorName: safeEvent.actorName,
    actorRole: safeEvent.actorRole,
    recipient: safeEvent.recipient,
    recipientName: safeEvent.recipientName,
    recipientRole: safeEvent.recipientRole,
    kind: safeEvent.kind,
    status: safeEvent.status,
    correlationId: safeEvent.correlationId,
    summary: safeEvent.summary,
    detail: safeEvent.detail,
    fingerprint: safeEvent.fingerprint,
    timestamp: safeEvent.timestamp,
  };
  return [
    `## Agent board — ${safeEvent.kind}`,
    '',
    `**${safeEvent.actorName ?? safeEvent.actor} → ${safeEvent.recipientName ?? safeEvent.recipient ?? 'all'}** · ${safeEvent.status}`,
    '',
    safeEvent.summary,
    ...(safeEvent.detail ? ['', safeEvent.detail] : []),
    '',
    `${MARKER}${Buffer.from(JSON.stringify(body)).toString('base64url')} -->`,
  ].join('\n');
}

export function parseCoordinationComment(body: string): CoordinationEvent | null {
  const start = body.lastIndexOf(MARKER);
  if (start < 0) return null;
  const end = body.indexOf(' -->', start);
  if (end < 0) return null;
  try {
    const encoded = body.slice(start + MARKER.length, end).trim();
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as CoordinationEvent & { version?: number };
    if (parsed.version !== 1 || typeof parsed.id !== 'string' || typeof parsed.fingerprint !== 'string') return null;
    const { version: _version, ...event } = parsed;
    return event;
  } catch { // cxt-ignore: error_swallow,exception_hiding — a non-board comment is not an error, just not ours
    return null;
  }
}

export class TrackerCoordinationBoard {
  private commentQuotaExhausted = false;

  constructor(private readonly source: ITaskSource, private readonly boardIssueId: string) {}

  async publish(event: CoordinationEvent): Promise<void> {
    if (this.commentQuotaExhausted) return;
    try {
      await this.source.addComment(this.boardIssueId, formatCoordinationComment(event), `coordination:${event.fingerprint}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Linear rejects every subsequent comment once an issue reaches its hard
      // 2,000-comment limit. The local coordination store remains durable, so
      // retrying each event only creates an unbounded error storm.
      if (/quota exceeded|maximum of \d+ comments/i.test(message)) {
        this.commentQuotaExhausted = true;
        console.error(`[CoordinationBoard] disabled remote mirror for ${this.boardIssueId}: ${message}`);
        return;
      }
      throw error;
    }
  }

  async read(): Promise<CoordinationEvent[]> {
    if (!this.source.getExecutionComments) return [];
    const comments = await this.source.getExecutionComments(this.boardIssueId);
    return comments.flatMap((comment) => {
      const event = parseCoordinationComment(comment.body);
      return event ? [event] : [];
    }).sort((a, b) => a.seq - b.seq);
  }
}
