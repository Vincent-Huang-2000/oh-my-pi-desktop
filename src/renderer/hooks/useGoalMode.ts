/**
 * useGoalMode — Goal / Vibe 运行模式状态条的操作入口。
 *
 * 两种模式都由 omp acp 实现，桌面端不维护目标的生命周期，只把状态条上的操作转成：
 * - 暂停：回合进行中直接停止当前回合（omp 在取消时暂停目标），空闲时发送 /goal pause
 * - 继续 / 放弃 / 引导设定：发送 /goal resume、/goal drop、/guided-goal
 * - 取消待设定、退出 Vibe：切回 Default 模式（离开 Goal 的警告由 useConfigSync 负责）
 *
 * ## 维护
 * - 放弃目标前弹窗确认，文案与切换模式时的警告共用 getGoalExitWarning。
 */
import { getGoalExitWarning, type GoalStripAction } from '../lib/goalMode';
import { useAppCore } from './useAppCore';
import { useConfigSync } from './useConfigSync';
import { useMessageFlow } from './useMessageFlow';

export function useGoalMode(
  app: ReturnType<typeof useAppCore>,
  messageFlow: Pick<ReturnType<typeof useMessageFlow>, 'handleCancelTurn' | 'sendRunModeCommand'>,
  configSync: Pick<ReturnType<typeof useConfigSync>, 'handleModeChange'>,
) {
  const runGoalAction = (action: GoalStripAction) => {
    const session = app.selectedSessionRef.current;
    if (!session) return;
    switch (action) {
      case 'pause':
        if ((app.agentBusyCountRef.current[session.id] ?? 0) > 0) {
          void messageFlow.handleCancelTurn();
        } else {
          void messageFlow.sendRunModeCommand('/goal pause');
        }
        return;
      case 'resume':
        void messageFlow.sendRunModeCommand('/goal resume');
        return;
      case 'drop': {
        const warning = getGoalExitWarning(app.goalBySessionRef.current[session.id]);
        if (warning && !window.confirm(warning)) return;
        void messageFlow.sendRunModeCommand('/goal drop');
        return;
      }
      case 'guided':
        void messageFlow.sendRunModeCommand('/guided-goal');
        return;
      case 'cancel':
        void configSync.handleModeChange('default');
        return;
    }
  };

  const exitVibe = () => {
    void configSync.handleModeChange('default');
  };

  return { runGoalAction, exitVibe };
}
