type StatusBarProps = {
  selectedProject: StoredProject | null;
  hasDiff: boolean;
};

/** 底部状态栏 —— 只展示低频运行信息，不放操作按钮（§7）。 */
export function StatusBar({ selectedProject, hasDiff }: StatusBarProps) {
  return (
    <footer className="statusbar">
      <span>执行目录: {selectedProject?.path ?? '--'}</span>
      <span>Git diff: {hasDiff ? '有变更' : '未读取/无变更'}</span>
      <span>保存状态: 最近项目与 session 自动保留</span>
    </footer>
  );
}
