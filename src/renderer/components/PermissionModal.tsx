import { useEffect, useState } from 'react';
import type { PermissionOption, PermissionRequest } from '../types';

type PermissionModalProps = {
  request: PermissionRequest;
  onRespond: (optionId: string) => Promise<void>;
};

// 按选项语义分类高亮：allow 系=主操作（中性反色），reject 系=拒绝/破坏（危险色），
// 其余（如"选择下一步"场景的普通选项）保持默认无高亮。
const optionActionClass = (option: PermissionOption): string => {
  if (option.kind.startsWith('allow')) return 'primary-action';
  if (option.kind.startsWith('reject')) return 'danger-action';
  return '';
};
export function PermissionModal({ request, onRespond }: PermissionModalProps) {
  const isPermissionRequest = request.options.some(
    (option) => option.kind.startsWith('allow') || option.kind.startsWith('reject'),
  );
  const title = isPermissionRequest ? '权限审批' : '选择下一步';
  const emptyText = isPermissionRequest ? '暂无可用审批选项' : '暂无可用选项';
  const [isSubmitting, setIsSubmitting] = useState(false);

  // 切换 request 时重置提交态（新请求可正常操作）
  useEffect(() => {
    setIsSubmitting(false);
  }, [request.requestId]);

  const handleClick = async (optionId: string) => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      await onRespond(optionId);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="approval-dock-panel" role="presentation">
      <section
        className="approval-modal"
        role="dialog"
        aria-modal="false"
        aria-labelledby="approval-title"
      >
        <h2 id="approval-title">{title}</h2>
        <p>{request.message}</p>
        <div className="modal-actions">
          {request.options.length === 0 ? (
            <span>{emptyText}</span>
          ) : (
            request.options.map((option) => (
              <button
                className={optionActionClass(option)}
                key={option.optionId}
                type="button"
                disabled={isSubmitting}
                onClick={() => void handleClick(option.optionId)}
              >
                <span>{option.name}</span>
                {option.description && <small>{option.description}</small>}
              </button>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
