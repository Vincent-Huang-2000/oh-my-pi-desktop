import { useMemo, useRef, useState } from 'react';
import type { ChatMessage } from '../types';

// 工具调用折叠状态：按 sessionId 分桶，key = 「该工具组最后一条 tool 消息的 id」，
// value = true 表示折叠成摘要卡、false 表示用户主动展开、undefined 表示从未被用户操作过。
// ChatWorkspace 会把 undefined 也按默认折叠展示；用户主动展开后保持 false 不被覆盖。

export function useToolGroups(
  selectedSession: StoredSession | null,
  messageCache: { current: Record<string, ChatMessage[]> },
) {
  const collapsedToolGroupsBySession = useRef<Record<string, Record<string, boolean | undefined>>>({});
  const [collapsedToolGroupsVersion, setCollapsedToolGroupsVersion] = useState(0);
  const bumpCollapsedToolGroups = () => setCollapsedToolGroupsVersion((value) => value + 1);

  // 当前选中 session 的折叠 map：供 ChatWorkspace 通过 props 读取。
  const collapsedToolGroups = useMemo<Record<string, boolean | undefined>>(() => {
    if (!selectedSession) {
      return {};
    }
    return collapsedToolGroupsBySession.current[selectedSession.id] ?? {};
  }, [selectedSession, collapsedToolGroupsVersion]);

  // 在消息流末尾反向扫描「最近一个 user 消息之后」的工具组，返回其中最后一条 tool 消息的 id。
  // 用于 done 时确定本轮工具组的 groupId：所有介于该 user 与末尾之间的 tool 消息视为同一组折叠。
  const findLatestToolGroupId = (list: ChatMessage[]): string | undefined => {
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const message = list[index];
      if (message.role === 'user') {
        return undefined;
      }
      if (message.role === 'tool') {
        return message.id;
      }
    }
    return undefined;
  };

  // 扫描整条消息流，找出所有「连续 tool 段」的 groupId（每段最后一条 tool 消息的 id），
  // 把未操作（undefined）的组设为 true 折叠。用于打开旧会话（load/resume/fork 重放）后一次性折叠全部工具组。
  const collapseAllToolGroupsForSession = (sessionId: string, messagesForSession?: ChatMessage[]) => {
    const list = messagesForSession ?? messageCache.current[sessionId];
    if (!list || list.length === 0) {
      return;
    }
    const groupIds: string[] = [];
    let lastToolId: string | undefined;
    for (const message of list) {
      if (message.role === 'tool') {
        lastToolId = message.id;
      } else {
        if (lastToolId) {
          groupIds.push(lastToolId);
          lastToolId = undefined;
        }
      }
    }
    if (lastToolId) {
      groupIds.push(lastToolId);
    }
    if (groupIds.length === 0) {
      return;
    }
    const bucket = collapsedToolGroupsBySession.current[sessionId] ?? {};
    let changed = false;
    const next = { ...bucket };
    for (const groupId of groupIds) {
      if (next[groupId] === undefined) {
        next[groupId] = true;
        changed = true;
      }
    }
    if (changed) {
      collapsedToolGroupsBySession.current[sessionId] = next;
      bumpCollapsedToolGroups();
    }
  };

  // 清空指定 session 桶里的折叠 map：用于「重置消息流」场景（关闭会话、新建空会话、切项目）。
  const resetCollapsedToolGroupsForSession = (sessionId: string | null | undefined) => {
    if (!sessionId) {
      return;
    }
    if (collapsedToolGroupsBySession.current[sessionId]) {
      delete collapsedToolGroupsBySession.current[sessionId];
      bumpCollapsedToolGroups();
    }
  };

  // 用户点击摘要卡时通知切换折叠状态。
  const handleSetToolGroupCollapsed = (groupId: string, collapsed: boolean) => {
    if (!selectedSession) {
      return;
    }
    const bucket = collapsedToolGroupsBySession.current[selectedSession.id] ?? {};
    if (bucket[groupId] === collapsed) {
      return;
    }
    collapsedToolGroupsBySession.current[selectedSession.id] = { ...bucket, [groupId]: collapsed };
    bumpCollapsedToolGroups();
  };

  // 直接设置某个 session 指定 groupId 的折叠状态（不限当前 session，用于 done 事件等场景）。
  const setGroupCollapsed = (sessionId: string, groupId: string, collapsed: boolean) => {
    const bucket = collapsedToolGroupsBySession.current[sessionId] ?? {};
    if (bucket[groupId] === collapsed) return;
    collapsedToolGroupsBySession.current[sessionId] = { ...bucket, [groupId]: collapsed };
    bumpCollapsedToolGroups();
  };

  // 初始化某个 session 的空折叠桶（用于 fork 占位等场景）。
  const initBucket = (sessionId: string) => {
    if (!collapsedToolGroupsBySession.current[sessionId]) {
      collapsedToolGroupsBySession.current[sessionId] = {};
      bumpCollapsedToolGroups();
    }
  };

  return {
    collapsedToolGroups,
    findLatestToolGroupId,
    collapseAllToolGroupsForSession,
    resetCollapsedToolGroupsForSession,
    handleSetToolGroupCollapsed,
    setGroupCollapsed,
    initBucket,
  };
}
