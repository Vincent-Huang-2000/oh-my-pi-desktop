/**
 * elicitationGroup — 消息流中 elicitation 记录的显示分组逻辑。
 *
 * 已解决的记录（accepted/declined/cancelled）统一为两段式状态行；
 * 渲染顺序相邻、标题相同的记录合并为一组档案，标题与时间只出现一次。
 */
import type { ChatMessage } from '../types';

/* 已解决（成功/拒绝/取消）的 elicitation 记录。 */
export const isResolvedElicitation = (message: ChatMessage): boolean =>
  message.elicitationStatus === 'accepted' ||
  message.elicitationStatus === 'declined' ||
  message.elicitationStatus === 'cancelled';

/* elicitation 记录标题：按状态与 kind 派生，单条渲染与连续分组共用同一语义。 */
export const getElicitationTitle = (message: ChatMessage): string => {
  const isQuestionnaire = message.elicitationKind === 'questionnaire';
  const isQuestion = message.elicitationKind === 'question';
  if (message.elicitationStatus === 'pending') {
    return isQuestionnaire || isQuestion ? '等待选择' : '等待确认';
  }
  if (message.elicitationStatus === 'submitting') {
    return isQuestionnaire || isQuestion ? '正在提交选择' : '正在提交确认';
  }
  if (message.elicitationStatus === 'failed') {
    return isQuestionnaire ? '问卷提交失败' : isQuestion ? '回答提交失败' : '确认失败';
  }
  return isQuestion ? '问答记录' : '确认记录';
};

/* 分组规则：渲染顺序相邻、均已解决且标题相同的记录合并；其余保持单条。 */
export const groupElicitationMessages = (messages: ChatMessage[]): ChatMessage[][] => {
  const groups: ChatMessage[][] = [];
  for (const message of messages) {
    const lastGroup = groups[groups.length - 1];
    const lastMessage = lastGroup?.[lastGroup.length - 1];
    const canMerge =
      lastMessage !== undefined &&
      isResolvedElicitation(lastMessage) &&
      isResolvedElicitation(message) &&
      getElicitationTitle(lastMessage) === getElicitationTitle(message);
    if (canMerge) {
      lastGroup.push(message);
    } else {
      groups.push([message]);
    }
  }
  return groups;
};
