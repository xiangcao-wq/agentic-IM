import type { AgentRunRequest, AgentRunResult, DemoState, AgentProgressEvent } from '../../domain/types';
import type { AiProvider } from '../aiProvider';
import { runAgentIntent } from '../agentRunRuntime';
import type { WebSearchProvider } from '../webSearch';
import type { AgentEvent, AgentEventDraft } from './agentEvents';
import { agentProgressToEventDraft, createRunEventDraft } from './agentEvents';
import type { AgentEventStore } from './eventLogStore';

type ProductHarnessProgressEvent = Omit<AgentProgressEvent, 'id' | 'createdAt' | 'sequence'>;

export interface ProductHarnessToolOptions {
  webSearchProvider?: WebSearchProvider;
}

export interface ProductHarnessInput {
  state: DemoState;
  input: AgentRunRequest;
  eventStore: AgentEventStore;
  aiProvider?: AiProvider;
  tools?: ProductHarnessToolOptions;
  tenantId?: string;
  runId?: string;
  sessionId?: string;
  entrypoint?: string;
  onProgress?: (event: ProductHarnessProgressEvent) => void;
}

export interface ProductHarnessResult {
  tenantId: string;
  sessionId: string;
  runId: string;
  state: DemoState;
  response: AgentRunResult;
  events: AgentEvent[];
}

export async function runProductAgentSession(input: ProductHarnessInput): Promise<ProductHarnessResult> {
  const tenantId = input.tenantId ?? 'local';
  const runId = input.runId ?? createRunId('agent-run');
  const sessionId = input.sessionId ?? createRunId('agent-session');
  const entrypoint = input.entrypoint ?? 'chat';

  const createdDraft = createRunEventDraft({
    type: 'agent.run.created',
    tenantId,
    sessionId,
    runId,
    agentId: input.input.agentId,
    roomId: input.input.roomId,
    entrypoint,
    visibility: 'internal',
    payload: {
      intent: input.input.intent,
      userText: input.input.userText
    }
  });
  const progressDrafts: AgentEventDraft[] = [];

  try {
    const runtime = await runAgentIntent(
      input.state,
      input.input,
      input.aiProvider,
      {
        runId,
        onProgress: (event) => {
          progressDrafts.push(
            agentProgressToEventDraft(
              {
                tenantId,
                sessionId,
                runId
              },
              event
            )
          );
          try {
            input.onProgress?.(event);
          } catch {
            // Progress observers must not alter the agent runtime result.
          }
        }
      },
      input.tools ?? {}
    );
    const completedDraft = {
      ...createRunEventDraft({
        type: 'agent.run.completed',
        tenantId,
        sessionId,
        runId,
        agentId: input.input.agentId,
        roomId: input.input.roomId,
        entrypoint,
        visibility: 'internal',
        toolCalls: runtime.response.log.toolCalls,
        payload: {
          intent: runtime.response.intent,
          requiresHuman: runtime.response.requiresHuman,
          logId: runtime.response.log.id,
          riskLevel: runtime.response.log.risk.level
        }
      }),
      riskLevel: runtime.response.log.risk.level
    } satisfies AgentEventDraft;
    const events = await input.eventStore.appendMany([createdDraft, ...progressDrafts, completedDraft]);

    return {
      tenantId,
      sessionId,
      runId,
      state: runtime.state,
      response: runtime.response,
      events
    };
  } catch (error) {
    const failedDraft = createRunEventDraft({
      type: 'agent.run.failed',
      tenantId,
      sessionId,
      runId,
      agentId: input.input.agentId,
      roomId: input.input.roomId,
      entrypoint,
      visibility: 'audit',
      payload: {
        error: error instanceof Error ? error.message : 'unknown agent runtime error'
      }
    });
    try {
      await input.eventStore.appendMany([createdDraft, ...progressDrafts, failedDraft]);
    } catch {
      // Preserve the runtime failure; event persistence is best-effort on this path.
    }
    throw error;
  }
}

function createRunId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
