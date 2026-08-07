/**
 * useAgentEvents — OMP agent 事件订阅 hook。
 *
 * 主 useEffect 监听 `agent:event` IPC 通道，分发处理 19 种事件类型：
 * - config_loaded / available_commands    配置与可用命令
 * - status_changed / log                  状态变更与日志
 * - plan / plan_preview / plan_full       计划生成流程
 * - tool_call / tool_result               工具调用与结果
 * - permission / elicitation / questionnaire  审批三队列
 * - turn_complete / turn_error            回合完成 / 错误
 * - usage                                 用量统计
 *
 * ## 参数
 * @param app          useAppCore 返回的状态对象
 * @param toolGroups   useToolGroups 返回的折叠管理方法
 * @param refreshGitBranches, refreshDiff  useGitReview 的刷新函数（done/error 后自动调用）
 *
 * ## 维护
 * - 新增事件类型在本文件末尾追加 else-if 分支。
 * - 事件 payload 解析走 utils 中的 getPayload* 系列，不在此处内联。
 */
import { useEffect } from 'react';
import type { AcpConfigOption, ChatMessage, ElicitationRequest, PermissionOption, PermissionRequest, QuestionnaireRequest } from '../types';
import {
  getElicitationKind,
  getLogLevel,
  getPayloadAvailableCommands,
  getPayloadConfigOptions,
  getPayloadElicitationField,
  getPayloadFullPlan,
  getPayloadQuestionnaire,
  getPayloadPermissionOptions,
  getPayloadRequestId,
  splitElicitationPlan,
} from '../utils';
import { applyActiveSessionPlan, getActiveSessionPlan, getHistoryLoadedEvents, getHistoryLoadedPlans, insertHistoricalPlans } from '../lib/historyLoaders';
import { mergeAgentEventIntoMessages } from '../lib/messageMerge';
import { type ReviewSource } from '../lib/constants';
import { useAppCore } from './useAppCore';
import { useToolGroups } from './useToolGroups';

type RefreshDiff = (source: ReviewSource, project?: StoredProject | null) => Promise<void>;
type RefreshGitBranches = (project?: StoredProject | null) => Promise<string | null>;

export function useAgentEvents(
  app: ReturnType<typeof useAppCore>,
  toolGroups: ReturnType<typeof useToolGroups>,
  refreshGitBranches: RefreshGitBranches,
  refreshDiff: RefreshDiff,
): void {
  useEffect(() => {
    return window.ohMyPiDesktop.onAgentEvent((event) => {
      // 把所有事件原样写进 app.desktopState.logs：日志缓存按 sessionId 自然隔离，
      // 目前仅用于主进程持久化调试，渲染端不再展示基础日志。
      app.setDesktopState((current) => ({
        ...current,
        logs: [
          {
            id: `${Date.now()}-log-${Math.random().toString(16).slice(2)}`,
            sessionId: event.sessionId,
            level: getLogLevel(event.type),
            message: event.message,
            createdAt: new Date().toISOString()
          },
          ...current.logs
        ].slice(0, 120)
      }));

      // app.messages 与 app.permissionRequest 必须按 sessionId 分桶：
      // 1) 当前 session 的事件：直接更新当前 state；
      // 2) 其它 session 的事件：只更新对应缓存（app.messageCache / app.permissionBySession），
      //    等用户切回该 session 时由 handleSelectSession 还原。
      if (event.type === 'permission_request') {
        const req: PermissionRequest = {
          requestId: getPayloadRequestId(event.payload),
          message: event.message,
          options: getPayloadPermissionOptions(event.payload) as PermissionOption[]
        };
        const currentQueue = app.permissionBySession.current[event.sessionId] ?? [];
        const nextQueue = currentQueue.some((item) => item.requestId === req.requestId)
          ? currentQueue
          : [...currentQueue, req];
        app.permissionBySession.current[event.sessionId] = nextQueue;
        if (app.selectedSessionRef.current?.id === event.sessionId) {
          // 当前弹窗尚未响应时保持队首不变；响应后由 handlePermission 自动展示下一项。
          app.setPermissionRequest((current) => current ?? nextQueue[0] ?? null);
          const visibleRequest = nextQueue[0] ?? req;
          const isPermissionRequest = visibleRequest.options.some(
            (option) => option.kind.startsWith('allow') || option.kind.startsWith('reject')
          );
          app.setAgentStatus(isPermissionRequest ? '等待审批' : '等待选择');
        }
        return;
      }

      // 主进程仅在严格匹配的静态 Python 问卷上发送该事件；普通工具审批仍走 elicitation_request。
      if (event.type === 'questionnaire_request') {
        const req: QuestionnaireRequest = {
          requestId: getPayloadRequestId(event.payload),
          questions: getPayloadQuestionnaire(event.payload)
        };
        if (!req.requestId || req.questions.length === 0) {
          return;
        }
        const currentQueue = app.questionnaireBySession.current[event.sessionId] ?? [];
        const nextQueue = currentQueue.some((item) => item.requestId === req.requestId)
          ? currentQueue
          : [...currentQueue, req];
        app.questionnaireBySession.current[event.sessionId] = nextQueue;
        if (app.selectedSessionRef.current?.id === event.sessionId) {
          app.setQuestionnaireRequest((current) => current ?? nextQueue[0] ?? null);
          app.setAgentStatus('等待选择');
        }
        const recordText = req.questions.map((question, index) => [
          `${index + 1}. ${question.header ? `[${question.header}] ` : ''}${question.question}`,
          ...question.options.map((option) => `   - ${option.label}${option.description ? `：${option.description}` : ''}`)
        ].join('\n')).join('\n');
        const appendRecord = (current: ChatMessage[]) => current.some(
          (message) => message.elicitationRequestId === req.requestId
        ) ? current : [
          ...current,
          {
            id: `questionnaire-${req.requestId}`,
            role: 'elicitation' as const,
            text: recordText,
            elicitationRequestId: req.requestId,
            elicitationKind: 'questionnaire' as const,
            elicitationStatus: 'pending' as const,
            createdAt: new Date().toISOString()
          }
        ];
        if (app.selectedSessionRef.current?.id === event.sessionId) {
          app.setMessages((current) => {
            const next = appendRecord(current);
            app.messageCache.current[event.sessionId] = next;
            return next;
          });
        } else {
          app.messageCache.current[event.sessionId] = appendRecord(app.messageCache.current[event.sessionId] ?? []);
        }
        return;
      }

      // ACP elicitation/create（工具/计划审批与 AskTool 原生提问）：按 sessionId 分桶排队。
      if (event.type === 'elicitation_request') {
        const elicitationPlan = splitElicitationPlan(event.message);
        const fullPlan = getPayloadFullPlan(event.payload);
        // fullPlan 为空但 elicitationPlan.plan 非空时，只能展示 message 片段，标记降级。
        const planContent = fullPlan || elicitationPlan.plan;
        const planDegraded = !fullPlan && !!elicitationPlan.plan;
        const req: ElicitationRequest = {
          requestId: getPayloadRequestId(event.payload),
          message: event.message,
          field: getPayloadElicitationField(event.payload),
          kind: getElicitationKind(event.message),
          // 消息流已有对应的方案预览卡时，弹窗只显示简短提示。
          hasPlanPreview: !!planContent
        };
        const currentQueue = app.elicitationBySession.current[event.sessionId] ?? [];
        const nextQueue = currentQueue.some((item) => item.requestId === req.requestId)
          ? currentQueue
          : [...currentQueue, req];
        app.elicitationBySession.current[event.sessionId] = nextQueue;
        if (app.selectedSessionRef.current?.id === event.sessionId) {
          app.setElicitationRequest((current) => current ?? nextQueue[0] ?? null);
          app.setAgentStatus(req.kind === 'question' ? '等待选择' : '等待确认');
        }
        // 弹窗负责即时交互，消息流同步保留一条可回溯记录；按 requestId 去重。
        const appendRecord = (current: ChatMessage[]) => {
          if (current.some((message) => message.elicitationRequestId === req.requestId)) {
            return current;
          }
          // 新的实时 plan 审批会替代 `_meta` 恢复卡；后续交互只关联这次有效 requestId。
          const baseMessages = planContent ? current.filter((message) => !message.planActive) : current;
          let next = baseMessages;
          const pendingIndex = baseMessages.findIndex((message) => message.role === 'plan' && message.planPending);
          if (planContent) {
            const preview: ChatMessage = {
              id: pendingIndex >= 0 ? baseMessages[pendingIndex].id : `plan-preview-${req.requestId}`,
              role: 'plan',
              text: planContent,
              planContentType: 'markdown',
              planPreview: true,
              planPreviewRequestId: req.requestId,
              planPreviewDegraded: planDegraded || undefined
            };
            next = pendingIndex >= 0
              ? baseMessages.map((message, index) => index === pendingIndex ? preview : message)
              : [...baseMessages, preview];
          } else if (pendingIndex >= 0) {
            next = baseMessages.map((message, index) =>
              index === pendingIndex ? { ...message, planPreviewRequestId: req.requestId } : message
            );
          }
          return [
            ...next,
            {
              id: `elicitation-${req.requestId}`,
              role: 'elicitation' as const,
              text: elicitationPlan.question || event.message,
              elicitationRequestId: req.requestId,
              elicitationKind: req.kind === 'question' ? 'question' as const : undefined,
              elicitationStatus: 'pending' as const,
              createdAt: new Date().toISOString()
            }
          ];
        };
        if (app.selectedSessionRef.current?.id === event.sessionId) {
          app.setMessages((current) => {
            const next = appendRecord(current);
            app.messageCache.current[event.sessionId] = next;
            return next;
          });
        } else {
          app.messageCache.current[event.sessionId] = appendRecord(app.messageCache.current[event.sessionId] ?? []);
        }
        return;
      }

      // 完整方案从磁盘异步读取后单独补发，只更新对应预览，不重复创建审批记录。
      if (event.type === 'elicitation_plan_preview') {
        const requestId = getPayloadRequestId(event.payload);
        const fullPlan = getPayloadFullPlan(event.payload);
        if (!requestId || !fullPlan) {
          return;
        }
        const updatePreview = (current: ChatMessage[]) => {
          const previewIndex = current.findIndex(
            (message) => message.role === 'plan' && message.planPreviewRequestId === requestId
          );
          const preview: ChatMessage = {
            id: previewIndex >= 0 ? current[previewIndex].id : `plan-preview-${requestId}`,
            role: 'plan',
            text: fullPlan,
            planContentType: 'markdown',
            planPreview: true,
            planPreviewRequestId: requestId
          };
          return previewIndex >= 0
            ? current.map((message, index) => index === previewIndex ? preview : message)
            : [...current, preview];
        };
        if (app.selectedSessionRef.current?.id === event.sessionId) {
          app.setMessages((current) => {
            const next = updatePreview(current);
            app.messageCache.current[event.sessionId] = next;
            return next;
          });
        } else {
          app.messageCache.current[event.sessionId] = updatePreview(app.messageCache.current[event.sessionId] ?? []);
        }
        return;
      }

      // usage_update（v16.1.13）：每轮结束时 agent 下发上下文用量与费用，不进消息流，
      // 只更新右栏 Agent 状态区的用量展示。按 sessionId 分桶，切会话时还原。
      if (event.type === 'usage_update') {
        app.usageBySession.current[event.sessionId] = event.message;
        if (app.selectedSessionRef.current?.id === event.sessionId) {
          app.setUsageText(event.message);
        }
        return;
      }

      // commands_update：通知该 session 可用 slash 命令列表，同时按项目缓存（新 session 复用）。
      if (event.type === 'commands_update') {
        const commands = getPayloadAvailableCommands(event.payload);
        if (commands.length > 0) {
          app.setDesktopState((current) => {
            const eventSession = current.recentSessions.find((session) => session.id === event.sessionId);
            const projectPath = eventSession?.projectPath ?? app.selectedProjectRef.current?.path;
            if (!projectPath) {
              return current;
            }
            const existing = current.configCacheByProjectPath[projectPath];
            return {
              ...current,
              configCacheByProjectPath: {
                ...current.configCacheByProjectPath,
                [projectPath]: {
                  configOptions: existing?.configOptions ?? [],
                  availableCommands: commands,
                  updatedAt: new Date().toISOString()
                }
              }
            };
          });
        }
        if (app.selectedSessionRef.current?.id === event.sessionId) {
          app.setAvailableCommands(commands);
        }
        return;
      }

      // config_update：刷新当前 session 的 configOptions；mode/model/thinking 切换都会触发。
      if (event.type === 'config_update') {
        const configOptions = getPayloadConfigOptions(event.payload) as AcpConfigOption[];
        // 同步当前 session 的模型快照到 ref，供 tool_call 实时事件取用。
        const modelOpt = configOptions.find((o) => o.id === 'model');
        if (modelOpt && typeof modelOpt.currentValue === 'string') {
          const id = modelOpt.currentValue;
          const name = modelOpt.options?.find((o) => o.value === id)?.name ?? id;
          app.modelBySessionRef.current[event.sessionId] = { id, name };
        }
        if (configOptions.length > 0) {
          app.setDesktopState((current) => {
            const eventSession = current.recentSessions.find((session) => session.id === event.sessionId);
            const projectPath = eventSession?.projectPath ?? app.selectedProjectRef.current?.path;
            if (!projectPath) {
              return current;
            }
            return {
              ...current,
              configCacheByProjectPath: {
                ...current.configCacheByProjectPath,
                [projectPath]: {
                  configOptions,
                  availableCommands: current.configCacheByProjectPath[projectPath]?.availableCommands ?? [],
                  updatedAt: new Date().toISOString()
                }
              }
            };
          });
        }
        if (app.selectedSessionRef.current?.id === event.sessionId) {
          app.setAcpConfigOptions(configOptions);
        }
        return;
      }

      // session_update：主进程已把 ACP 的 session_info_update 写入本地状态，
      // 这里同步刷新左栏标题与当前会话标题，不把它当作聊天消息展示。
      if (event.type === 'session_update') {
        const payload = event.payload as { session?: StoredSession } | undefined;
        const session = payload?.session;
        if (!session) {
          return;
        }
        app.setDesktopState((current) => {
          const exists = current.recentSessions.some((item) => item.id === session.id);
          return {
            ...current,
            // 已存在则原位更新（仅刷新标题/字段，不置顶）；仅全新会话才插到顶部。
            // 只有用户发消息时才应置顶——那条路径由主进程 upsertSession 默认行为处理。
            recentSessions: exists
              ? current.recentSessions.map((item) => (item.id === session.id ? session : item))
              : [session, ...current.recentSessions]
          };
        });
        app.updateSelectedSession((current) => (current?.id === session.id ? session : current));
        return;
      }

      if (event.type === 'history_loaded') {
        const historyEvents = getHistoryLoadedEvents(event.payload);
        const historyMessages = historyEvents.reduce(
          (current, historyEvent) => mergeAgentEventIntoMessages(current, historyEvent),
          [] as ChatMessage[]
        );
        const nextMessages = insertHistoricalPlans(historyMessages, getHistoryLoadedPlans(event.payload));
        app.messageCache.current[event.sessionId] = nextMessages;
        toolGroups.collapseAllToolGroupsForSession(event.sessionId, nextMessages);
        app.setLoadingHistorySessionId((current) => (current === event.sessionId ? null : current));
        if (app.selectedSessionRef.current?.id === event.sessionId) {
          app.setMessages(nextMessages);
          app.setAgentStatus('历史加载完成');
          app.setIsAgentBusy(false);
          app.setHistoryScrollResetToken((value) => value + 1);
        }
        return;
      }

      // 以下事件会构造 ChatMessage，仅影响目标 session 的消息缓存。
      const cacheMessages = (mutator: (list: ChatMessage[]) => ChatMessage[]) => {
        const targetId = event.sessionId;
        if (app.selectedSessionRef.current?.id === targetId) {
          app.setMessages((current) => {
            const next = mutator(current);
            app.messageCache.current[targetId] = next;
            return next;
          });
        } else {
          const previous = app.messageCache.current[targetId] ?? [];
          app.messageCache.current[targetId] = mutator(previous);
        }
      };

      if (event.type === 'active_plan_update') {
        const activePlan = getActiveSessionPlan(event.payload);
        if (activePlan) {
          cacheMessages((current) => applyActiveSessionPlan(current, activePlan));
        }
        return;
      }

      const questionnaireRequestId = event.payload && typeof event.payload === 'object'
        ? (event.payload as Record<string, unknown>).questionnaireRequestId
        : undefined;
      if (typeof questionnaireRequestId === 'string' && (event.type === 'status_update' || event.type === 'error')) {
        cacheMessages((current) => current.map((message) =>
          message.elicitationRequestId === questionnaireRequestId
            ? {
                ...message,
                elicitationStatus: event.type === 'error' ? 'failed' : 'accepted',
                elicitationResult: event.type === 'error'
                  ? `问卷答案续发失败：${event.message}`
                  : event.message
              }
            : message
        ));
        if (event.type === 'status_update' && app.selectedSessionRef.current?.id === event.sessionId) {
          app.setIsAgentBusy(true);
        }
      }

      if (event.type === 'diff' && app.selectedSessionRef.current?.id === event.sessionId) {
        app.setDiffText(event.message);
        app.setDiffStatus('agent 返回了 diff');
      }

      if (event.type === 'done' && app.selectedSessionRef.current?.id === event.sessionId) {
        app.setAgentStatus('完成');
        app.setIsAgentBusy(false);
        // 回合结束时自动收拢本轮工具组：扫描当前 session 消息流，找到最后一条 tool 消息的 id 作为 groupId。
        // 用户可在执行期间临时展开；收到 done 后统一折叠，让已完成回合保持紧凑。
        const list = app.messageCache.current[event.sessionId];
        const groupId = list ? toolGroups.findLatestToolGroupId(list) : undefined;
        if (groupId) {
          toolGroups.setGroupCollapsed(event.sessionId, groupId, true);
        }
        // agent 可能刚写完文件或创建/切换了分支；回合结束时同步 Git 状态，让审查面板保持最新。
        void refreshGitBranches(app.selectedProjectRef.current);
        void refreshDiff(app.reviewSourceRef.current, app.selectedProjectRef.current);
      } else if (event.type === 'error' && app.selectedSessionRef.current?.id === event.sessionId) {
        app.setAgentStatus('错误');
        app.setIsAgentBusy(false);
      } else if (event.type === 'tool_call' && app.selectedSessionRef.current?.id === event.sessionId) {
        app.setAgentStatus('调用工具');
      } else if (event.type === 'plan' && app.selectedSessionRef.current?.id === event.sessionId) {
        app.setAgentStatus('生成计划');
      } else if (event.type === 'status_update' && app.selectedSessionRef.current?.id === event.sessionId) {
        app.setAgentStatus(event.message);
      } else if (app.selectedSessionRef.current?.id === event.sessionId) {
        app.setAgentStatus('运行中');
      }

      // omp 真正开始回包：收到 output / tool_call / plan / done / error 任一事件就清掉 pending 卡片，
      // 让位给真正的回复流。即便 omp 直接 done/error 没输出 chunk，pending 也会一并清理，不会卡死。
      if (
        event.type === 'output' ||
        event.type === 'tool_call' ||
        event.type === 'plan' ||
        event.type === 'done' ||
        event.type === 'error'
      ) {
        if (app.pendingSlashCommandBySession.current[event.sessionId]) {
          app.pendingSlashCommandBySession.current[event.sessionId] = null;
          app.bumpPendingSlashCommand();
        }
      }
      cacheMessages((current) =>
        mergeAgentEventIntoMessages(current, event, app.modelBySessionRef.current[event.sessionId])
      );
    });
  }, [refreshDiff, refreshGitBranches]);
}
