# Agent Core v2 Phase 1 Evidence Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Agent fallback paths from answering concrete internal facts when no authorized evidence exists.

**Architecture:** Keep the existing `/api/agent/run` compatibility path. Add targeted evidence guards to the current Agent runtime before larger Agent Core v2 modules are introduced. Start with deadline answers because they currently have a hard-coded fallback value and directly affect user trust.

**Tech Stack:** TypeScript, Vitest, current `runAgentIntent` runtime, current `agentEngine` fallback path.

---

## File Structure

- Modify `src/domain/agentEngine.test.ts`: add a regression test for deadline questions with no authorized deadline evidence.
- Modify `src/domain/agentEngine.ts`: replace hard-coded deadline fallback with an explicit no-evidence response.
- Run `npm run test -- src/domain/agentEngine.test.ts` and `npm run eval:agent`.

## Task 1: Guard Deadline Answers Without Evidence

**Files:**
- Modify: `src/domain/agentEngine.test.ts`
- Modify: `src/domain/agentEngine.ts`

- [x] **Step 1: Write the failing test**

Add this test in the deadline-answer describe block or near existing `answerDeadlineQuestion` tests:

```ts
it('does not invent a deadline when authorized evidence is missing', async () => {
  const state = {
    ...createDemoState(),
    messages: [],
    files: [],
    tasks: []
  };

  const result = await answerDeadlineQuestion(state, {
    agentId: 'agent-lin',
    roomId: 'room-team',
    question: '什么时候交？'
  });

  expect(result.citations).toEqual([]);
  expect(result.answer).toContain('没有找到');
  expect(result.answer).not.toContain('5月12日 23:59');
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
npm run test -- src/domain/agentEngine.test.ts
```

Expected: FAIL because fallback currently returns `5月12日 23:59` even with no citations.

- [x] **Step 3: Implement minimal evidence guard**

In `answerDeadlineQuestionFallback`, after collecting `relevantMessages` and `relevantFiles`, return a no-evidence answer when both are empty:

```ts
if (relevantMessages.length === 0 && relevantFiles.length === 0) {
  return {
    answer: '我在当前授权上下文里没有找到明确的截止时间证据，因此不能确认具体提交时间。你可以同步最新群聊或提供课程要求文件后再让我检查。',
    citations: []
  };
}
```

- [x] **Step 4: Run test to verify it passes**

Run:

```bash
npm run test -- src/domain/agentEngine.test.ts
```

Expected: PASS.

- [x] **Step 5: Run regression eval**

Run:

```bash
npm run eval:agent
```

Expected: PASS, 40/40.

## Task 2: Additional Evidence Guards

**Files:**
- Modify: `src/domain/agentEngine.test.ts`
- Modify: `src/domain/agentEngine.ts`

- [x] **Step 1: Guard vague deadline evidence**

Added a failing test where relevant text mentions submission but contains no explicit date. The Agent now returns an evidence-insufficient answer instead of defaulting to `5月12日 23:59`.

- [x] **Step 2: Guard LLM deadline sources**

Added a failing test where the LLM returns a deadline with a made-up source id. The Agent now validates LLM citations against existing context ids and falls back to the protected local path when no real source remains.

- [x] **Step 3: Guard summary with no sources**

Added tests for source-less room summaries and LLM summaries with made-up citations. Summary fallback now refuses to synthesize the fixed assignment headline when no authorized messages or tasks are available.

- [x] **Step 4: Clean file-share audit context**

Removed fixed `msg-05`/`msg-06` context ids from runtime file-share logs. File-share audit context now includes only real existing ids directly tied to the action.

- [x] **Step 5: Clean coordination audit context**

Changed coordination audit logs to include `cal-review` and `task-check` only when those ids exist in the current state.

- [x] **Step 6: Verify**

Ran:

```bash
npm run test -- src/domain/agentEngine.test.ts
npm run test -- src/server/agentPlanRuntime.test.ts
npm run eval:agent
npm run build
```

Expected and observed: all passed.

- [x] **Step 7: Guard runtime chat answers for internal facts**

Added a failing `/api/agent/run` test where the LLM planner returns an internal project-fact answer without citations. The runtime now carries planner citations into `AgentRunDecision`, filters them against real state ids, and rejects citation-less LLM answers for internal fact questions such as responsibility, progress, files, tasks, materials, and evidence. When citations are missing, it falls back to local authorized evidence and returns an explicit no-evidence answer.

Verified with:

```bash
npm run test -- src/server/agentPlanRuntime.test.ts
npm run test -- src/domain/agentEngine.test.ts src/server/agentPlanRuntime.test.ts
npm run eval:agent
npm run build
```

Expected and observed: all passed.

## Task 3: Remaining Follow-Up Scope

After this pass, repeat the same pattern for:

- File search: no matching authorized files must return an empty result with clear wording, not a guessed file.
- LLM file-share assessment: matched file ids from the model must be validated against authorized evidence before risk is considered.
- Runtime trace: add a first-class trace object so UI and eval can inspect evidence selection without reading action logs.

These follow-ups should be implemented as separate TDD cycles.

## Self-Review

- Spec coverage: This implements the first Agent Core v2 safety slice: no-evidence refusal before broad runtime refactoring.
- Placeholder scan: No placeholder markers remain.
- Type consistency: Uses existing `answerDeadlineQuestion`, `createDemoState`, and `DeadlineAnswer` shapes.
