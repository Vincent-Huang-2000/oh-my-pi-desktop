import './RunModeStrip.css';

type RunModeStripProps = {
  icon: string;
  // 运行模式名称，如 Loop。
  label: string;
  // 当前状态，如「运行中」「已暂停」。
  status: string;
  // 补充说明，如剩余次数或截止时间。
  detail?: string;
  tone?: 'active' | 'paused';
  actionLabel: string;
  onAction: () => void;
};

// 运行模式状态条：显示在输入区顶部，展示当前会话运行模式的状态与关闭入口。
// 只负责展示，模式状态与文案由调用方提供，便于后续其它运行模式复用。
export function RunModeStrip({
  icon,
  label,
  status,
  detail,
  tone = 'active',
  actionLabel,
  onAction,
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
      {detail && <span className="run-mode-strip-detail">{detail}</span>}
      <button type="button" className="run-mode-strip-action" onClick={onAction}>
        {actionLabel}
      </button>
    </div>
  );
}
