import type { PermissionOption, PermissionRequest } from '../types';

type PermissionModalProps = {
  request: PermissionRequest;
  onRespond: (optionId: string) => void;
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
    (option) => option.kind.startsWith('allow') || option.kind.startsWith('reject')
  );
  const title = isPermissionRequest ? '权限审批' : '选择下一步';
  const emptyText = isPermissionRequest ? '暂无可用审批选项' : '暂无可用选项';

  return (
    <div className="approval-float-layer" role="presentation">
      <section className="approval-modal" role="dialog" aria-modal="false" aria-labelledby="approval-title">
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
                onClick={() => onRespond(option.optionId)}
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
