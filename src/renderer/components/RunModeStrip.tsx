import './RunModeStrip.css';

export type RunModeStripAction = {
  label: string;
  onClick: () => void;
};

type RunModeStripProps = {
  icon: string;
  // 运行模式名称，如 Loop、Goal。
  label: string;
  // 当前状态，如「运行中」「已暂停」。
  status: string;
  // 补充说明，如剩余次数、目标摘要与用量。
  detail?: string;
  tone?: 'active' | 'paused';
  // 右侧操作按钮，如「关闭 Loop」「暂停」「放弃目标」。
  actions: RunModeStripAction[];
};

// 运行模式状态条：显示在输入区顶部，展示当前会话运行模式的状态与操作入口。
// 只负责展示，模式状态与文案由调用方提供，Loop / Goal / Vibe 共用。
export function RunModeStrip({
  icon,
  label,
  status,
  detail,
  tone = 'active',
  actions,
}: RunModeStripProps) {
  return (
    <div
      className={`run-mode-strip${tone === 'paused' ? ' is-paused' : ''}`}
      role="status"
      aria-live="polite"
    >
      <span className="run-mode-strip-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="run-mode-strip-label">{label}</span>
      <span className="run-mode-strip-status">{status}</span>
      {detail && (
        <span className="run-mode-strip-detail" title={detail}>
          {detail}
        </span>
      )}
      {actions.length > 0 && (
        <span className="run-mode-strip-actions">
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              className="run-mode-strip-action"
              onClick={action.onClick}
            >
              {action.label}
            </button>
          ))}
        </span>
      )}
    </div>
  );
}
