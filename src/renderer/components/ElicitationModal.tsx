import { useEffect, useRef, useState } from 'react';
import type { ElicitationRequest } from '../types';
import { formatElicitationOptionLabel, isElicitationOtherOption } from '../utils';

type ElicitationModalProps = {
  request: ElicitationRequest;
  onRespond: (action: 'accept' | 'decline' | 'cancel', content?: Record<string, unknown>) => void;
};

// 审批场景下识别"拒绝"选项（原始值 Deny / Reject），其余选项（Approve、Approve and execute、
// Refine plan 等）按主操作高亮。仅对 approval kind 生效，question kind 的选项语义由 agent 定义，不强加颜色。
const REJECT_RAW_VALUES = new Set(['Deny', 'Reject']);
const stripRecommendedSuffix = (option: string) =>
  option.endsWith(' (Recommended)') ? option.slice(0, -' (Recommended)'.length) : option;
const isElicitationRejectOption = (option: string) => REJECT_RAW_VALUES.has(stripRecommendedSuffix(option));

// approval 场景的选项按钮 className：拒绝=Danger，其余=Primary，为每个选项都提供明确视觉语义。
const approvalOptionClass = (option: string) => (isElicitationRejectOption(option) ? 'danger-action' : 'primary-action');

// ACP elicitation 表单弹窗：同时兼容工具审批和 AskTool 原生提问。
// omp 总是发单字段 value，按其 type 分支渲染：
//  - string + options：按钮列表（如工具审批的 Approve/Deny）
//  - boolean：确认/取消按钮
//  - string 无 options / number / integer：文本输入框 + 提交/取消
export function ElicitationModal({ request, onRespond }: ElicitationModalProps) {
  const { field, message } = request;
  const isSelect = field.type === 'string' && field.options && field.options.length > 0;
  const isBoolean = field.type === 'boolean';
  const [textValue, setTextValue] = useState('');
  const [customInputOpen, setCustomInputOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTextValue('');
    setCustomInputOpen(false);
  }, [request.requestId]);

  // 文本输入场景自动聚焦。
  useEffect(() => {
    if (!isSelect && !isBoolean) {
      inputRef.current?.focus();
    }
  }, [isSelect, isBoolean]);

  const handleSubmit = () => {
    // number/integer 转成数值，其余按字符串提交。
    let value: string | number = textValue;
    if (field.type === 'number' || field.type === 'integer') {
      value = textValue.trim() === '' ? 0 : Number(textValue);
      if (Number.isNaN(value)) {
        value = 0;
      }
    }
    onRespond('accept', { value });
  };

  return (
    <div className="approval-float-layer" role="presentation">
      <section className="approval-modal" role="dialog" aria-modal="false" aria-labelledby="elicitation-title">
        <h2 id="elicitation-title">{request.kind === 'question' ? 'Agent 需要你的回答' : '需要确认'}</h2>
        <p>{request.hasPlanPreview ? 'Agent 已完成方案，请在消息流的「待确认方案」卡片中查看完整内容，确认是否执行。' : message}</p>
        {field.description && <p style={{ fontSize: '12px', marginTop: '-10px' }}>{field.description}</p>}
        <div className="modal-actions">
          {isSelect ? (
            <>
              {field.options!.map((option) => {
                // approval 场景：拒绝=Danger，其余=Primary；
                // question 场景：仅 (Recommended) 标注为 Primary，其余默认。
                const className =
                  request.kind === 'approval'
                    ? approvalOptionClass(option)
                    : option.endsWith(' (Recommended)') ? 'primary-action' : '';
                return (
                  <button
                    className={className}
                    key={option}
                    type="button"
                    onClick={() => {
                      if (request.kind === 'question' && isElicitationOtherOption(option)) {
                        setTextValue('');
                        setCustomInputOpen(true);
                        return;
                      }
                      onRespond('accept', { value: option });
                    }}
                  >
                    <span>{formatElicitationOptionLabel(option)}</span>
                  </button>
                );
              })}
              {request.kind === 'question' && (
                <button type="button" onClick={() => onRespond('cancel')}>
                  <span>取消回答</span>
                </button>
              )}
              {customInputOpen && (
                <div className="elicitation-custom-answer">
                  <input
                    autoFocus
                    className="elicitation-input"
                    placeholder="输入自定义回答"
                    value={textValue}
                    onChange={(event) => setTextValue(event.target.value)}
                  />
                  <button
                    className="primary-action"
                    type="button"
                    disabled={!textValue.trim()}
                    onClick={() => onRespond('accept', { value: textValue.trim() })}
                  >
                    <span>提交自定义回答</span>
                  </button>
                </div>
              )}
            </>
          ) : isBoolean ? (
            <>
              <button className="primary-action" type="button" onClick={() => onRespond('accept', { value: true })}>
                <span>确认</span>
              </button>
              <button type="button" onClick={() => onRespond('decline')}>
                <span>取消</span>
              </button>
            </>
          ) : (
            <>
              <input
                ref={inputRef}
                className="elicitation-input"
                type={field.type === 'number' || field.type === 'integer' ? 'number' : 'text'}
                value={textValue}
                onChange={(event) => setTextValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    handleSubmit();
                  }
                }}
              />
              <div className="modal-actions-horizontal">
                <button className="primary-action" type="button" onClick={handleSubmit}>
                  <span>提交</span>
                </button>
                <button type="button" onClick={() => onRespond('cancel')}>
                  <span>取消</span>
                </button>
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
