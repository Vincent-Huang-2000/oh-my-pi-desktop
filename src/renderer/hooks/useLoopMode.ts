/**
 * useLoopMode — Loop 运行模式（桌面端驱动的 /loop）。
 *
 * omp 的 /loop 只在 TUI 实现，omp acp 不处理；桌面端在每轮 prompt 结算后自动重发同一条提示：
 * - handleLoopCommand：拦截输入框中的 /loop，开关 Loop 并返回需立即发送的内联提示
 * - enableCurrentLoop / disableCurrentLoop：Loop 开关与运行模式状态条的入口
 * - adoptDraftLoop：草稿会话首次发送创建 session 后迁移草稿 Loop
 * - recordManualPrompt：手动发送的消息成为新的 Loop 提示（并解除暂停）
 * - pauseLoop：停止回合、发送失败等场景暂停 Loop（保持开启，发送消息即可继续）
 * - handleTurnSettled：prompt 结算后，完成则延迟重发，出错或取消则暂停
 *
 * ## 维护
 * - handleTurnSettled / handleSessionReplaced 由 useAgentEvents 的一次性订阅闭包调用，
 *   闭包里的 app 是首次渲染时的对象：这些路径只能读 ref、调用稳定 setter 或仅依赖它们的 app 方法，
 *   不能读 app.selectedSession / app.planReviewBySession 等 state，也不能调用 app.reloadState。
 * - Loop 状态按 sessionId 分桶、不持久化，渲染进程重载即失效（与 omp TUI 一致）。
 */
import type { ChatMessage } from '../types';
import {
  createLoopState,
  describeLoopLimitSpec,
  getLoopSettleOutcome,
  isLoopRunning,
  LOOP_FIRE_DELAY_MS,
  LOOP_ICON,
  parseLoopArgs,
  planLoopFire,
  type LoopLimitSpec,
  type LoopState,
} from '../lib/loopMode';
import { useAppCore } from './useAppCore';

export function useLoopMode(app: ReturnType<typeof useAppCore>) {
  const clearLoopTimer = (sessionId: string) => {
    clearTimeout(app.loopTimerBySession.current[sessionId]);
    delete app.loopTimerBySession.current[sessionId];
  };

  const statusMessage = (text: string): ChatMessage => ({
    id: `loop-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    role: 'status',
    text: `${LOOP_ICON} ${text}`,
  });

  // 追加消息：当前选中会话（或草稿，sessionId 为 null）更新消息流，其它会话只写缓存。
  // 消息对象在 updater 外构造，避免 StrictMode 双调用生成不同 id。
  const appendMessages = (sessionId: string | null, items: ChatMessage[]) => {
    if (sessionId === null || app.selectedSessionRef.current?.id === sessionId) {
      app.setMessages((current) => {
        const next = [...current, ...items];
        if (sessionId) app.messageCache.current[sessionId] = next;
        return next;
      });
      return;
    }
    app.messageCache.current[sessionId] = [
      ...(app.messageCache.current[sessionId] ?? []),
      ...items,
    ];
  };

  // 当前选中会话属于当前项目时作用于该会话，否则视为草稿（与 sendContent 的防御分支一致）。
  const currentTarget = (): string | null => {
    const session = app.selectedSessionRef.current;
    return session && session.projectPath === app.selectedProjectRef.current?.path
      ? session.id
      : null;
  };

  const writeLoop = (target: string | null, loop: LoopState | null) => {
    if (target) {
      if (loop) app.setLoopState(target, loop);
      else app.clearLoopForSession(target);
    } else {
      app.setDraftLoop(loop);
    }
  };

  // 有待处理的审批或方案审核时不能自动重发，需用户先行处理。
  const hasPendingUserAction = (sessionId: string) =>
    (app.permissionBySession.current[sessionId]?.length ?? 0) > 0 ||
    (app.elicitationBySession.current[sessionId]?.length ?? 0) > 0 ||
    (app.questionnaireBySession.current[sessionId]?.length ?? 0) > 0 ||
    Boolean(app.planReviewBySessionRef.current[sessionId]?.review);

  const pauseLoop = (sessionId: string, notice?: string) => {
    clearLoopTimer(sessionId);
    const loop = app.loopBySessionRef.current[sessionId];
    // 只有运行中的 Loop 才需要暂停，避免停止按钮与随后的取消结算重复提示。
    if (!isLoopRunning(loop)) return;
    app.setLoopState(sessionId, { ...loop, prompt: null, paused: true });
    if (notice) appendMessages(sessionId, [statusMessage(notice)]);
  };

  const disableLoop = (sessionId: string, notice: string) => {
    if (!app.loopBySessionRef.current[sessionId]) return;
    app.clearLoopForSession(sessionId);
    appendMessages(sessionId, [statusMessage(notice)]);
  };

  const enableCurrentLoop = (spec: LoopLimitSpec | null) => {
    const projectPath = app.selectedProjectRef.current?.path;
    if (!projectPath) return;
    writeLoop(currentTarget(), createLoopState(spec, projectPath, Date.now()));
  };

  const disableCurrentLoop = () => {
    writeLoop(currentTarget(), null);
  };

  // /loop 的开关语义与 omp TUI 一致：已开启时任何 /loop 都关闭（忽略参数）；
  // 否则解析参数并开启，返回的内联提示由调用方立即作为首轮发送（不计入重复次数）。
  const handleLoopCommand = (args: string): string | undefined => {
    const projectPath = app.selectedProjectRef.current?.path;
    if (!projectPath) return undefined;
    const target = currentTarget();
    const existing = target ? app.loopBySessionRef.current[target] : app.draftLoopRef.current;
    if (existing) {
      writeLoop(target, null);
      appendMessages(target, [statusMessage('Loop 已关闭。')]);
      return undefined;
    }
    const parsed = parseLoopArgs(args);
    if (!parsed.ok) {
      appendMessages(target, [statusMessage(parsed.error)]);
      return undefined;
    }
    writeLoop(target, createLoopState(parsed.limit, projectPath, Date.now()));
    const tail = parsed.prompt ? '该提示' : '下一条消息';
    appendMessages(target, [
      statusMessage(
        `Loop 已开启：${describeLoopLimitSpec(parsed.limit)}。${tail}将在每轮结束后自动重复；点击停止可暂停，再次输入 /loop 关闭。`,
      ),
    ]);
    return parsed.prompt || undefined;
  };

  const adoptDraftLoop = (sessionId: string, projectPath: string) => {
    const draft = app.draftLoopRef.current;
    if (!draft) return;
    app.setDraftLoop(null);
    app.setLoopState(sessionId, { ...draft, projectPath });
  };

  // 手动发送会取代尚未发出的自动重发，并成为新的 Loop 提示（暂停状态随之恢复）。
  const recordManualPrompt = (sessionId: string, text: string) => {
    const loop = app.loopBySessionRef.current[sessionId];
    if (!loop) return;
    clearLoopTimer(sessionId);
    app.setLoopState(sessionId, { ...loop, prompt: text, paused: false });
  };

  const fireLoop = async (sessionId: string) => {
    const loop = app.loopBySessionRef.current[sessionId];
    const decision = planLoopFire(loop, {
      nowMs: Date.now(),
      busy: (app.agentBusyCountRef.current[sessionId] ?? 0) > 0,
      workspaceMatches: loop?.projectPath === app.selectedProjectRef.current?.path,
      awaitingUser: hasPendingUserAction(sessionId),
    });
    if (decision.action === 'skip') return;
    if (decision.action === 'pause') {
      pauseLoop(sessionId, decision.notice);
      return;
    }
    if (decision.action === 'disable') {
      disableLoop(sessionId, decision.notice);
      return;
    }
    app.setLoopState(sessionId, decision.next);
    appendMessages(sessionId, [
      { id: `${Date.now()}-user`, role: 'user', text: decision.prompt },
      statusMessage(decision.statusText),
    ]);
    // 先同步加忙碌计数再等待 IPC，保证并发到达的结算事件能看到该 session 仍忙。
    app.incrementAgentBusyCount(sessionId);
    const result = await window.ohMyPiDesktop.sendAgentMessage(
      sessionId,
      decision.next.projectPath,
      { text: decision.prompt },
    );
    if (!result.ok) {
      app.decrementAgentBusyCount(sessionId);
      pauseLoop(
        sessionId,
        `Loop 已暂停：消息发送失败（${result.message ?? '未知错误'}），发送消息即可继续。`,
      );
    }
  };

  // 由 useAgentEvents 在忙碌计数结算、消息合并之后调用。
  const handleTurnSettled = (event: AgentEvent) => {
    const sessionId = event.sessionId;
    const outcome = getLoopSettleOutcome(event);
    if (!outcome || !app.loopBySessionRef.current[sessionId]) return;
    if (outcome === 'error') {
      pauseLoop(sessionId, 'Loop 已暂停：本轮出错，发送消息即可继续。');
      return;
    }
    if (outcome === 'cancelled') {
      pauseLoop(sessionId, 'Loop 已暂停：当前回合已停止，发送消息即可继续。');
      return;
    }
    // 仍有其它 prompt 未结算（如问卷续发）时等它结算后再判定，不轮询。
    if (
      !isLoopRunning(app.loopBySessionRef.current[sessionId]) ||
      (app.agentBusyCountRef.current[sessionId] ?? 0) > 0
    ) {
      return;
    }
    clearLoopTimer(sessionId);
    app.loopTimerBySession.current[sessionId] = window.setTimeout(() => {
      delete app.loopTimerBySession.current[sessionId];
      void fireLoop(sessionId);
    }, LOOP_FIRE_DELAY_MS);
  };

  // 方案审核后切到新的执行会话：上下文已变化，暂停而不是继续重复原提示。
  const handleSessionReplaced = (sessionId: string) => {
    pauseLoop(sessionId, 'Loop 已暂停：已切换到新的执行会话，发送消息即可继续。');
  };

  return {
    enableCurrentLoop,
    disableCurrentLoop,
    handleLoopCommand,
    adoptDraftLoop,
    recordManualPrompt,
    pauseLoop,
    handleTurnSettled,
    handleSessionReplaced,
  };
}
