import { useEffect, useRef, useState } from 'react';
import type { ElicitationField, ElicitationRequest } from '../types';
import { formatElicitationOptionLabel, isElicitationOtherOption } from '../utils';
import './ElicitationModal.css';

type ElicitationModalProps = {
  request: ElicitationRequest;
  onRespond: (action: 'accept' | 'decline' | 'cancel', content?: Record<string, unknown>) => void;
};

type AskFieldValues = Record<string, string | boolean | string[]>;
type AskOtherValues = Record<string, string>;

const BOOLEAN_ASK_OPTIONS = [
  { label: '是', value: true },
  { label: '否', value: false },
] as const;

// 多选可同时提交候选项与自定义回答；单选自定义回答保持优先且互斥。
export function buildAskElicitationContent(
  fields: ElicitationField[],
  values: AskFieldValues,
  otherValues: AskOtherValues,
): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  fields.forEach((field) => {
    const value = values[field.name];
    const otherFieldName = field.otherFieldName;
    const otherValue = otherFieldName ? otherValues[otherFieldName]?.trim() : undefined;

    if (field.type === 'array') {
      if (value !== undefined && value !== '') {
        content[field.name] = value;
      }
      if (otherFieldName && otherValue) {
        content[otherFieldName] = otherValue;
      }
      return;
    }

    if (otherFieldName && otherValue) {
      content[otherFieldName] = otherValue;
      return;
    }
    if (value !== undefined && value !== '') {
      content[field.name] = value;
    }
  });
  return content;
}

export function getInitialAskElicitationValues(fields: ElicitationField[]): AskFieldValues {
  const values: AskFieldValues = {};
  fields.forEach((field) => {
    const defaultValue = field.defaultValue;
    if (field.type === 'boolean' && typeof defaultValue === 'boolean') {
      values[field.name] = defaultValue;
      return;
    }
    if (
      typeof defaultValue === 'string' &&
      field.options?.some((option) => option.value === defaultValue)
    ) {
      values[field.name] = defaultValue;
      return;
    }
    if (
      Array.isArray(defaultValue) &&
      field.options &&
      defaultValue.every((value) => field.options!.some((option) => option.value === value))
    ) {
      values[field.name] = defaultValue;
    }
  });
  return values;
}

// 审批场景下识别"拒绝"选项（原始值 Deny / Reject），其余选项（Approve、Approve and execute、
// Refine plan 等）按主操作高亮。仅对 approval kind 生效，question kind 的选项语义由 agent 定义，不强加颜色。
const REJECT_RAW_VALUES = new Set(['Deny', 'Reject']);
const stripRecommendedSuffix = (option: string) =>
  option.endsWith(' (Recommended)') ? option.slice(0, -' (Recommended)'.length) : option;
const isElicitationRejectOption = (option: string) =>
  REJECT_RAW_VALUES.has(stripRecommendedSuffix(option));

// approval 场景的选项按钮 className：拒绝=Danger，其余=Primary，为每个选项都提供明确视觉语义。
const approvalOptionClass = (option: string) =>
  isElicitationRejectOption(option) ? 'danger-action' : 'primary-action';

// ACP elicitation 表单弹窗：兼容旧版单字段 value 与 v18 Ask 的多字段表单。
// 旧版工具审批仍即时响应；Ask 表单保留所有 qN / qN__other 字段后一次提交。
export function ElicitationModal({ request, onRespond }: ElicitationModalProps) {
  const [field = { name: 'value', type: 'string' }] = request.fields;
  const isAskForm = request.fields.length !== 1 || field.name !== 'value';

  return isAskForm ? (
    <AskElicitationForm request={request} onRespond={onRespond} />
  ) : (
    <SingleElicitationForm request={request} field={field} onRespond={onRespond} />
  );
}

type SingleElicitationFormProps = ElicitationModalProps & {
  field: ElicitationField;
};

function SingleElicitationForm({ request, field, onRespond }: SingleElicitationFormProps) {
  const { message } = request;
  const isSelect = field.type === 'string' && field.options && field.options.length > 0;
  const isBoolean = field.type === 'boolean';
  const [textValue, setTextValue] = useState('');
  const [customInputOpen, setCustomInputOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTextValue('');
    setCustomInputOpen(false);
    setCollapsed(false);
  }, [request.requestId]);

  // 文本输入场景自动聚焦；若用户正在输入框中打字则不抢焦点。
  useEffect(() => {
    if (!isSelect && !isBoolean) {
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
      inputRef.current?.focus();
    }
  }, [isSelect, isBoolean]);

  const respond = (action: 'accept' | 'decline' | 'cancel', value?: string | number | boolean) => {
    onRespond(action, value === undefined ? undefined : { [field.name]: value });
  };

  const handleSubmit = () => {
    // number/integer 转成数值，其余按字符串提交。
    let value: string | number = textValue;
    if (field.type === 'number' || field.type === 'integer') {
      value = textValue.trim() === '' ? 0 : Number(textValue);
      if (Number.isNaN(value)) {
        value = 0;
      }
    }
    respond('accept', value);
  };

  return (
    <div className="approval-dock-panel" role="presentation">
      <section
        className={`approval-modal${collapsed ? ' is-collapsed' : ''}`}
        role="dialog"
        aria-modal="false"
        aria-labelledby="elicitation-title"
      >
        <div className="approval-modal-header">
          <h2 id="elicitation-title">
            {request.kind === 'question' ? 'Agent 需要你的回答' : '需要确认'}
          </h2>
          <button
            type="button"
            className="approval-collapse-btn"
            aria-label={collapsed ? '展开审批面板' : '折叠审批面板'}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((current) => !current)}
          >
            {collapsed ? '▶' : '▼'}
          </button>
        </div>
        {!collapsed &&
          (request.kind === 'approval' && !request.hasPlanPreview ? (
            <div className="approval-message">{message}</div>
          ) : (
            <p>
              {request.hasPlanPreview
                ? 'Agent 已完成方案，请在消息流的「待确认方案」卡片中查看完整内容，确认是否执行。'
                : message}
            </p>
          ))}
        {!collapsed && field.description && (
          <p className="elicitation-field-description">{field.description}</p>
        )}
        {!collapsed && (
          <div className="modal-actions">
            {isSelect ? (
              <>
                {field.options!.map((option) => {
                  const className =
                    request.kind === 'approval'
                      ? approvalOptionClass(option.value)
                      : option.value.endsWith(' (Recommended)')
                        ? 'primary-action'
                        : '';
                  return (
                    <button
                      className={className}
                      key={option.value}
                      type="button"
                      onClick={() => {
                        if (request.kind === 'question' && isElicitationOtherOption(option.value)) {
                          setTextValue('');
                          setCustomInputOpen(true);
                          return;
                        }
                        respond('accept', option.value);
                      }}
                    >
                      <span>{formatElicitationOptionLabel(option.label)}</span>
                      {option.description && <small>{option.description}</small>}
                    </button>
                  );
                })}
                {request.kind === 'question' && (
                  <button type="button" onClick={() => respond('cancel')}>
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
                      onClick={() => respond('accept', textValue.trim())}
                    >
                      <span>提交自定义回答</span>
                    </button>
                  </div>
                )}
              </>
            ) : isBoolean ? (
              <>
                <button
                  className="primary-action"
                  type="button"
                  onClick={() => respond('accept', true)}
                >
                  <span>确认</span>
                </button>
                <button type="button" onClick={() => respond('decline')}>
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
                  <button type="button" onClick={() => respond('cancel')}>
                    <span>取消</span>
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

type AskElicitationFormProps = ElicitationModalProps;

function AskElicitationForm({ request, onRespond }: AskElicitationFormProps) {
  const [values, setValues] = useState<AskFieldValues>({});
  const [otherValues, setOtherValues] = useState<AskOtherValues>({});

  useEffect(() => {
    setValues(getInitialAskElicitationValues(request.fields));
    setOtherValues({});
  }, [request.fields, request.requestId]);
  const content = buildAskElicitationContent(request.fields, values, otherValues);
  const canSubmit = Object.keys(content).length > 0;

  const toggleMultiValue = (field: ElicitationField, value: string) => {
    setValues((current) => {
      const existing = current[field.name];
      const selected = Array.isArray(existing) ? existing : [];
      return {
        ...current,
        [field.name]: selected.includes(value)
          ? selected.filter((item) => item !== value)
          : [...selected, value],
      };
    });
  };

  const selectSingleValue = (field: ElicitationField, value: string | boolean) => {
    setValues((current) => ({ ...current, [field.name]: value }));
    const otherFieldName = field.otherFieldName;
    if (!otherFieldName) return;
    setOtherValues((current) => {
      if (!(otherFieldName in current)) return current;
      const { [otherFieldName]: _, ...remaining } = current;
      return remaining;
    });
  };

  const updateOtherValue = (field: ElicitationField, value: string) => {
    const otherFieldName = field.otherFieldName;
    if (!otherFieldName) return;
    setOtherValues((current) => ({ ...current, [otherFieldName]: value }));
    if (field.type === 'array' || !value) return;
    setValues((current) => {
      if (!(field.name in current)) return current;
      const { [field.name]: _, ...remaining } = current;
      return remaining;
    });
  };

  const submit = () => {
    if (!canSubmit) return;
    onRespond('accept', content);
  };

  return (
    <div className="approval-dock-panel" role="presentation">
      <section
        className="approval-modal elicitation-form-modal"
        role="dialog"
        aria-modal="false"
        aria-labelledby="elicitation-form-title"
      >
        <div className="approval-modal-header">
          <h2 id="elicitation-form-title">Agent 需要你的回答</h2>
        </div>
        <p>{request.message}</p>
        <div className="elicitation-form-fields">
          {request.fields.map((field, index) => {
            const selected = values[field.name];
            const hasOptions = Boolean(field.options?.length);
            const title = field.name.endsWith('__other')
              ? `回答 ${index + 1}`
              : (field.title ?? `问题 ${index + 1}`);
            return (
              <fieldset className="elicitation-form-field" key={field.name}>
                <legend>{title}</legend>
                {field.description && (
                  <p className="elicitation-field-description">{field.description}</p>
                )}
                {field.type === 'boolean' ? (
                  <div className="elicitation-form-options">
                    {BOOLEAN_ASK_OPTIONS.map((option) => {
                      const checked = selected === option.value;
                      return (
                        <label
                          className={`elicitation-form-option${checked ? ' selected' : ''}`}
                          key={option.label}
                        >
                          <input
                            type="radio"
                            name={`elicitation-${request.requestId}-${field.name}`}
                            checked={checked}
                            onChange={() => selectSingleValue(field, option.value)}
                          />
                          <span>
                            <strong>{option.label}</strong>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                ) : hasOptions ? (
                  <div className="elicitation-form-options">
                    {field.options!.map((option) => {
                      const checked = Array.isArray(selected)
                        ? selected.includes(option.value)
                        : selected === option.value;
                      return (
                        <label
                          className={`elicitation-form-option${checked ? ' selected' : ''}`}
                          key={option.value}
                        >
                          <input
                            type={field.type === 'array' ? 'checkbox' : 'radio'}
                            name={`elicitation-${request.requestId}-${field.name}`}
                            checked={checked}
                            onChange={() => {
                              if (field.type === 'array') {
                                toggleMultiValue(field, option.value);
                                return;
                              }
                              selectSingleValue(field, option.value);
                            }}
                          />
                          <span>
                            <strong>{formatElicitationOptionLabel(option.label)}</strong>
                            {option.description && <small>{option.description}</small>}
                          </span>
                        </label>
                      );
                    })}
                    {field.otherFieldName && (
                      <label className="elicitation-form-other">
                        <span>其他</span>
                        <input
                          className="elicitation-input"
                          value={otherValues[field.otherFieldName] ?? ''}
                          onChange={(event) => updateOtherValue(field, event.target.value)}
                        />
                      </label>
                    )}
                  </div>
                ) : (
                  <input
                    className="elicitation-input"
                    type={field.type === 'number' || field.type === 'integer' ? 'number' : 'text'}
                    value={typeof selected === 'string' ? selected : ''}
                    onChange={(event) =>
                      setValues((current) => ({ ...current, [field.name]: event.target.value }))
                    }
                  />
                )}
              </fieldset>
            );
          })}
        </div>
        <div className="modal-actions-horizontal">
          <button className="primary-action" type="button" disabled={!canSubmit} onClick={submit}>
            <span>提交选择</span>
          </button>
          <button type="button" onClick={() => onRespond('cancel')}>
            <span>取消</span>
          </button>
        </div>
      </section>
    </div>
  );
}
