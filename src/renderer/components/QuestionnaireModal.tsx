import { useMemo, useState } from 'react';
import type { QuestionnaireAnswer, QuestionnaireRequest } from '../types';

type QuestionnaireModalProps = {
  request: QuestionnaireRequest;
  requests: QuestionnaireRequest[];
  onSelect: (request: QuestionnaireRequest) => void;
  onRespond: (action: 'submit' | 'deny', answers?: QuestionnaireAnswer[]) => Promise<boolean>;
};

// Plan 兼容问卷：选项提交即隐式批准对应 eval，不再向用户暴露底层 Approve/Deny。
export function QuestionnaireModal({ request, requests, onSelect, onRespond }: QuestionnaireModalProps) {
  const [answers, setAnswers] = useState<Record<number, string[]>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isComplete = useMemo(
    () => request.questions.every((_question, index) => (answers[index]?.length ?? 0) > 0),
    [answers, request.questions]
  );

  const setSingleAnswer = (questionIndex: number, label: string) => {
    setAnswers((current) => ({ ...current, [questionIndex]: [label] }));
  };

  const toggleMultiAnswer = (questionIndex: number, label: string) => {
    setAnswers((current) => {
      const selected = current[questionIndex] ?? [];
      return {
        ...current,
        [questionIndex]: selected.includes(label)
          ? selected.filter((item) => item !== label)
          : [...selected, label]
      };
    });
  };

  const submit = async (action: 'submit' | 'deny') => {
    if (isSubmitting || (action === 'submit' && !isComplete)) return;
    setIsSubmitting(true);
    const payload = action === 'submit'
      ? request.questions.map((_question, questionIndex) => ({
          questionIndex,
          selections: answers[questionIndex] ?? []
        }))
      : undefined;
    const accepted = await onRespond(action, payload);
    if (!accepted) setIsSubmitting(false);
  };

  return (
    <div className="approval-float-layer" role="presentation">
      <section className="approval-modal questionnaire-modal" role="dialog" aria-modal="true" aria-labelledby="questionnaire-title">
        <header className="questionnaire-modal-header">
          <div>
            <span className="questionnaire-kicker">PLAN 需求确认</span>
            <h2 id="questionnaire-title">请选择实现方向</h2>
          </div>
          <span className="questionnaire-count">{request.questions.length} 项</span>
        </header>
        <p className="questionnaire-intro">你的选择会直接用于继续生成计划。</p>

        {requests.length > 1 && (
          <nav className="questionnaire-queue" aria-label="待处理问卷">
            {requests.map((item, index) => (
              <button
                type="button"
                className={item.requestId === request.requestId ? 'active' : ''}
                key={item.requestId}
                disabled={isSubmitting}
                onClick={() => onSelect(item)}
              >
                问卷 {index + 1}
              </button>
            ))}
          </nav>
        )}

        <div className="questionnaire-list">
          {request.questions.map((question, questionIndex) => {
            const selected = answers[questionIndex] ?? [];
            return (
              <fieldset className="questionnaire-item" key={`${questionIndex}-${question.question}`} disabled={isSubmitting}>
                <legend>
                  {question.header && <span className="questionnaire-chip">{question.header}</span>}
                  <span>{question.question}</span>
                  <small>{question.multiSelect ? '可多选' : '单选'}</small>
                </legend>
                <div className="questionnaire-options">
                  {question.options.map((option) => {
                    const checked = selected.includes(option.label);
                    return (
                      <label className={`questionnaire-option${checked ? ' selected' : ''}`} key={option.label}>
                        <input
                          type={question.multiSelect ? 'checkbox' : 'radio'}
                          name={`questionnaire-${request.requestId}-${questionIndex}`}
                          checked={checked}
                          onChange={() => question.multiSelect
                            ? toggleMultiAnswer(questionIndex, option.label)
                            : setSingleAnswer(questionIndex, option.label)}
                        />
                        <span className="questionnaire-option-mark" aria-hidden="true" />
                        <span>
                          <strong>{option.label}</strong>
                          {option.description && <small>{option.description}</small>}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            );
          })}
        </div>

        <footer className="questionnaire-actions">
          <button type="button" disabled={isSubmitting || !isComplete} className="primary-action" onClick={() => void submit('submit')}>
            {isSubmitting ? '正在提交选择…' : '提交选择'}
          </button>
          <button type="button" disabled={isSubmitting} className="danger-action" onClick={() => void submit('deny')}>拒绝</button>
        </footer>
      </section>
    </div>
  );
}
