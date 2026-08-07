/**
 * useMessageFlow — 消息发送与附件管理。
 *
 * 处理输入区消息发送全流程：
 * - handleSubmit：解析 slash 命令 → 创建占位卡片 → 应用草稿配置 → 调用 IPC sendContent
 * - handleCancelTurn：取消当前回合（发送 cancel IPC）
 * - handleAttachAttachment：粘贴/拖拽/文件选择器添加附件（8MB 上限，MIME + 扩展名判定 kind）
 * - handlePaste：ClipboardEvent 粘贴处理（图片走 dataURL、忽略非图片文件）
 * - applyDraftConfigValues：无 session 时先应用草稿 model/mode/thinking 再发送
 *
 * ## 维护
 * - sendContent 校验 session.projectPath === selectedProject.path，这是 cwd 不变量的一环。
 * - 附件 dataURL 不在此处做 base64 预解码，由主进程负责。
 */
import type { ClipboardEvent, FormEvent } from 'react';
import type { ChatMessage } from '../types';
import { classifyAttachment, type PendingAttachment } from '../lib/attachments';
import { DEFAULT_APPROVAL_PROFILE, MAX_IMAGE_BYTES, type DraftConfigValues } from '../lib/constants';
import { parseSlashCommand, resolveCommandPendingMeta } from '../lib/slashCommands';
import { useAppCore } from './useAppCore';

export function useMessageFlow(app: ReturnType<typeof useAppCore>) {
  const hasDraftConfigValues = (values: DraftConfigValues) => {
    return Boolean(values.model || values.mode || values.thinking);
  };

  const applyDraftConfigValues = async (
    session: StoredSession,
    workspacePath: string,
    values: DraftConfigValues
  ) => {
    const entries: Array<['model' | 'mode' | 'thinking', string | undefined]> = [
      ['model', values.model],
      ['mode', values.mode],
      ['thinking', values.thinking]
    ];
    for (const [configId, value] of entries) {
      if (!value) {
        continue;
      }
      const result = await window.ohMyPiDesktop.setAgentConfigOption(
        session.id,
        workspacePath,
        configId,
        value
      );
      if (result.ok) {
        app.setAcpConfigOptions(result.configOptions ?? []);
      } else {
        app.setAgentStatus(result.message ?? '草稿配置已变化，跳过该项');
      }
    }
  };

  const isPlanModeSelected = () => {
    const modeValue = typeof app.modeConfig?.currentValue === 'string' ? app.modeConfig.currentValue : '';
    const modeName = app.modeConfig?.options?.find((option) => option.value === modeValue)?.name ?? '';
    const normalized = `${modeValue} ${modeName}`.toLowerCase();
    // 兼容不同 omp 版本的 mode value/name：常见值为 plan，中文环境可能显示“计划”。
    return normalized.includes('plan') || normalized.includes('计划');
  };

  const sendContent = async (text: string, attachments: PendingAttachment[]) => {
    if (!app.selectedProject) {
      return;
    }
    let session = app.selectedSession;
    // 新建 session 时要把输入区当前显示的 ACP 配置（model/mode/thinking）全部应用，
    // 不再只应用用户显式改过的草稿值——否则未改动项会落到 omp 默认配置，
    // 出现"重启后直接发消息用了别的模型/推理强度"的问题。
    // 来源：app.displayedConfigOptions 已合并缓存配置 + 草稿覆盖，直接取 currentValue。
    let configValuesToApply: DraftConfigValues = {};
    // 防御：若 app.selectedSession 不属于当前 app.selectedProject（理论上不应发生，但闭包/快速切换下可能），
    // 视同没有 session，新建一个绑定到当前项目的 session，避免复用旧项目子进程。
    if (!session || session.projectPath !== app.selectedProject.path) {
      for (const option of app.displayedConfigOptions) {
        const key = option.id as keyof DraftConfigValues;
        if (key === 'model' || key === 'mode' || key === 'thinking') {
          const value =
            app.draftConfigValues[key] ??
            (typeof option.currentValue === 'string' ? option.currentValue : undefined);
          if (value) {
            configValuesToApply[key] = value;
          }
        }
      }
      session = await window.ohMyPiDesktop.createSession(
        app.selectedProject.path,
        text.trim().slice(0, 42) || '新的 agent 会话',
        app.draftApprovalProfile
      );
      app.setDraftApprovalProfile(DEFAULT_APPROVAL_PROFILE);
    }
    if (hasDraftConfigValues(configValuesToApply)) {
      app.setAgentStatus('应用会话配置');
      await applyDraftConfigValues(session, app.selectedProject.path, configValuesToApply);
      app.setDraftConfigValues({});
    }
    // 先应用草稿配置再切到真实 session，避免 app.selectSession 将 app.displayedConfigOptions
    // 从缓存+草稿覆盖切换到空的 app.acpConfigOptions，导致顶栏选择器短暂显示"模型未加载"。
    app.selectSession(session);
    app.setAgentStatus('运行中');
    app.setIsAgentBusy(true);
    // 立即在底部插入「正在执行 slash 命令」卡片：仅当用户输入是合法 slash 命令时设置，
    // 由 onAgentEvent 收到首个 output/tool_call/plan/done/error 时清掉。
    const parsed = parseSlashCommand(text);
    const showPlanPending = !parsed && isPlanModeSelected();
    if (parsed) {
      const meta = resolveCommandPendingMeta(parsed.name);
      app.pendingSlashCommandBySession.current[session.id] = {
        id: `pending-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name: parsed.name,
        args: parsed.args,
        sentAt: new Date().toISOString(),
        icon: meta.icon,
        label: meta.label
      };
      app.bumpPendingSlashCommand();
    }
    app.setMessages((current) => {
      const userMessage: ChatMessage = {
        id: `${Date.now()}-user`,
        role: 'user',
        text: text.trim()
      };
      if (!showPlanPending) {
        return [...current, userMessage];
      }
      return [
        ...current,
        userMessage,
        {
          id: `plan-pending-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          role: 'plan',
          text: '正在整理任务步骤，稍后会替换为正式计划。',
          planPending: true
        }
      ];
    });
    const result = await window.ohMyPiDesktop.sendAgentMessage(session.id, app.selectedProject.path, {
      text: text.trim(),
      attachments: attachments.map((att) => ({ dataUrl: att.dataUrl, fileName: att.fileName, kind: att.kind }))
    });
    if (!result.ok) {
      app.setIsAgentBusy(false);
      app.setAgentStatus(result.message ?? '错误');
    }
    await app.reloadState();
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!app.selectedProject || !app.prompt.trim()) {
      return;
    }
    const text = app.prompt.trim();
    const attachments = app.pendingAttachments;
    app.setPrompt('');
    app.setPendingAttachments([]);
    await sendContent(text, attachments);
  };

  const handleAttachAttachment = (file: File) => {
    const kind = classifyAttachment(file);
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        return;
      }
      const dataUrl = reader.result;
      if (dataUrl.length > (MAX_IMAGE_BYTES * 4) / 3) {
        app.setAgentStatus('附件超过 8MB，未添加');
        return;
      }
      app.setPendingAttachments((current) => [
        ...current,
        { dataUrl, fileName: file.name, kind }
      ]);
    };
    reader.readAsDataURL(file);
  };

  const handleSelectFile = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        return;
      }
      handleAttachAttachment(file);
    };
    input.click();
  };

  const handleCancelTurn = async () => {
    if (!app.selectedSession) {
      return;
    }
    const result = await window.ohMyPiDesktop.cancelAgentTurn(app.selectedSession.id);
    if (result.ok) {
      app.clearApprovalStateForSession(app.selectedSession.id, { alsoClearActive: true });
      app.setAgentStatus('正在取消');
      app.setIsAgentBusy(false);
    } else {
      app.setAgentStatus('取消失败');
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(event.clipboardData.items);
    const imageItem = items.find((item) => item.type.startsWith('image/'));
    if (!imageItem) {
      return;
    }
    const file = imageItem.getAsFile();
    if (!file) {
      return;
    }
    event.preventDefault();
    handleAttachAttachment(file);
  };

  return {
    handleSubmit,
    handleCancelTurn,
    handleSelectFile,
    handlePaste,
  };
}
