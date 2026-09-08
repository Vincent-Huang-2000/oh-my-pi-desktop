import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  compilePlanFeedback,
  deletePlanSection,
  getPlanSections,
  type PlanReviewDraft,
} from '../lib/planReview';
import './PlanReviewOverlay.css';

const labels: Record<Exclude<PlanReviewDecision, 'cancel'>, [string, string]> = {
  execute: ['全新上下文执行', '开启新对话，只带上这份计划。原规划记录仍可回看。'],
  compact: ['压缩后执行', '把讨论压缩为摘要，在当前对话继续执行。'],
  keep: ['完整上下文执行', '保留全部讨论，在当前对话直接执行。'],
  refine: ['让 AI 修订计划', '发送修改意见与批注，修订后再次审核。'],
  save: ['保存方案，暂不执行', '选择保存位置，存档后开启空白对话。'],
};
const plugins = [remarkGfm];
type Props = {
  sessionId: string;
  review: PlanReviewData;
  ready: boolean;
  drafts: React.RefObject<Record<string, PlanReviewDraft>>;
  onHide: () => void;
};

export function PlanReviewOverlay({ sessionId, review, ready, drafts, onHide }: Props) {
  const [draft, setDraft] = useState<PlanReviewDraft>(() =>
    drafts.current[sessionId]?.reviewId === review.reviewId
      ? drafts.current[sessionId]
      : {
          reviewId: review.reviewId,
          content: review.content ?? '',
          feedback: review.feedback,
          model:
            review.executionModels?.find((model) => model.default)?.id ??
            review.executionModels?.[0]?.id ??
            '',
          notes: [],
          deleted: [],
          undo: [],
        },
  );
  const [editing, setEditing] = useState(false);
  const anchor = draft.anchor ?? '';
  const note = draft.pendingNote ?? '';
  const setAnchor = (value: string) => update({ ...draft, anchor: value });
  const setNote = (value: string) => update({ ...draft, pendingNote: value });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const submitting = useRef(false);
  const editCheckpoint = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const sections = getPlanSections(draft.content);
  const update = (next: PlanReviewDraft) => {
    drafts.current[sessionId] = next;
    setDraft(next);
  };
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.showModal();
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  const selectSection = (start: number, title: string) => {
    setAnchor(`章节「${title}」（第 ${start + 1} 行）`);
    if (editing) {
      const offset = draft.content.split('\n').slice(0, start).join('\n').length + (start ? 1 : 0);
      editor.current?.focus();
      editor.current?.setSelectionRange(offset, offset);
    } else
      body.current
        ?.querySelector(`[data-plan-line="${start + 1}"]`)
        ?.scrollIntoView({ block: 'start' });
  };
  const submit = async (decision: PlanReviewDecision) => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      const savePath =
        decision === 'save' ? await window.ohMyPiDesktop.choosePlanSavePath(sessionId) : undefined;
      if (savePath === null) return;
      const result = await window.ohMyPiDesktop.respondPlanReview(sessionId, review.reviewId, {
        decision,
        ...(draft.content !== review.content ? { editedContent: draft.content } : {}),
        ...(decision === 'refine' ? { feedback: compilePlanFeedback(draft) } : {}),
        ...(['execute', 'compact', 'keep'].includes(decision) && draft.model
          ? { executionModel: draft.model }
          : {}),
        ...(savePath ? { savePath } : {}),
      });
      if (!result.ok) setError(result.message ?? '未能提交审核，请重试');
      // 主进程的审核通知负责关闭旧版本；异步返回不能隐藏新一轮方案。
    } catch {
      setError('未能提交审核，请检查连接后重试');
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  const undo = () => {
    const previous = draft.undo[draft.undo.length - 1];
    if (previous) update({ ...draft, ...previous, undo: draft.undo.slice(0, -1) });
  };
  return (
    <dialog
      ref={dialog}
      className="plan-review"
      aria-labelledby="plan-review-title"
      onCancel={(event) => {
        event.preventDefault();
        onHide();
      }}
    >
      <header className="plan-review__header">
        <div>
          <span className="plan-review__eyebrow">方案审核 · 尚未执行</span>
          <h2 id="plan-review-title">{review.title || '执行方案'}</h2>
        </div>
        <button type="button" onClick={onHide}>
          暂时收起 <span aria-hidden="true">×</span>
        </button>
      </header>
      <div className="plan-review__layout">
        <nav className="plan-review__toc" aria-label="方案目录">
          <h3>目录</h3>
          {sections.length ? (
            sections.map((section) => (
              <div key={section.start} className="plan-review__section">
                <button type="button" onClick={() => selectSection(section.start, section.title)}>
                  {section.title}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`删除章节：${section.title}`}
                  title="删除此章及其子章节，可撤销"
                  onClick={() => update(deletePlanSection(draft, section))}
                >
                  删除
                </button>
              </div>
            ))
          ) : (
            <p>当前方案没有章节标题</p>
          )}
          <p>点章节可跳转并选择批注位置。删除会修改正文，提交时生效。</p>
        </nav>
        <section className="plan-review__document" aria-label="计划正文">
          <div className="plan-review__tools">
            <button
              type="button"
              disabled={busy || review.content === null}
              aria-pressed={editing}
              onClick={() => setEditing(!editing)}
            >
              {editing ? '阅读预览' : '编辑正文'}
            </button>
            <button type="button" disabled={!draft.undo.length || busy} onClick={undo}>
              撤销修改
            </button>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(draft.content).then(
                  () => setCopied(true),
                  () => setError('复制失败，请手动选择正文复制'),
                );
              }}
            >
              {copied ? '已复制' : '复制全文'}
            </button>
            {draft.content !== review.content && <span>正文已修改 · 提交时保存</span>}
          </div>
          {review.content === null ? (
            <p role="alert">计划文件暂不可读取，请收起面板后重新连接并打开方案。</p>
          ) : editing ? (
            <textarea
              ref={editor}
              className="plan-review__editor"
              aria-label="编辑计划正文"
              value={draft.content}
              disabled={busy}
              onFocus={() => {
                editCheckpoint.current = false;
              }}
              onSelect={(event) => {
                const el = event.currentTarget;
                const line = el.value.slice(0, el.selectionStart).split('\n').length;
                setAnchor(`第 ${line} 行：${el.value.split('\n')[line - 1]}`);
              }}
              onChange={(event) => {
                update({
                  ...draft,
                  content: event.target.value,
                  undo: editCheckpoint.current
                    ? draft.undo
                    : [
                        ...draft.undo.slice(-19),
                        { content: draft.content, deleted: draft.deleted },
                      ],
                });
                editCheckpoint.current = true;
              }}
            />
          ) : (
            <div
              ref={body}
              className="plan-review__body"
              onMouseUp={() => {
                const selection = window.getSelection();
                if (
                  selection?.anchorNode &&
                  body.current?.contains(selection.anchorNode) &&
                  selection.toString().trim()
                )
                  setAnchor(`原文：${selection.toString().trim()}`);
              }}
            >
              <ReactMarkdown
                remarkPlugins={plugins}
                components={{
                  h1: ({ node, ...props }) => (
                    <h1 data-plan-line={node?.position?.start.line} {...props} />
                  ),
                  h2: ({ node, ...props }) => (
                    <h2 data-plan-line={node?.position?.start.line} {...props} />
                  ),
                  h3: ({ node, ...props }) => (
                    <h3 data-plan-line={node?.position?.start.line} {...props} />
                  ),
                  h4: ({ node, ...props }) => (
                    <h4 data-plan-line={node?.position?.start.line} {...props} />
                  ),
                  h5: ({ node, ...props }) => (
                    <h5 data-plan-line={node?.position?.start.line} {...props} />
                  ),
                  h6: ({ node, ...props }) => (
                    <h6 data-plan-line={node?.position?.start.line} {...props} />
                  ),
                  a: ({ children, href }) => (
                    <a href={href} target="_blank" rel="noreferrer">
                      {children}
                    </a>
                  ),
                }}
              >
                {draft.content}
              </ReactMarkdown>
            </div>
          )}
        </section>
        <aside className="plan-review__decisions" aria-label="审核意见与下一步">
          <h3>修改意见</h3>
          <textarea
            aria-label="整体修改意见"
            placeholder="希望 AI 如何改进这份计划？"
            value={draft.feedback}
            disabled={busy}
            onChange={(event) => update({ ...draft, feedback: event.target.value })}
          />
          <details>
            <summary>添加定位批注 · {draft.notes.length} 条</summary>
            <p>{anchor || '先点击目录章节、选择正文文字，或在编辑模式定位一行。'}</p>
            <textarea
              aria-label="当前位置批注"
              value={note}
              disabled={busy}
              onChange={(event) => setNote(event.target.value)}
            />
            <button
              type="button"
              disabled={!anchor || !note.trim() || busy}
              onClick={() => {
                update({
                  ...draft,
                  notes: [...draft.notes, { anchor, text: note.trim() }],
                  pendingNote: '',
                });
              }}
            >
              添加批注
            </button>
            {draft.notes.map((item, index) => (
              <div className="plan-review__note" key={index}>
                <small>{item.anchor}</small>
                <p>{item.text}</p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    update({ ...draft, notes: draft.notes.filter((_, i) => i !== index) })
                  }
                >
                  移除批注
                </button>
              </div>
            ))}
          </details>
          {(compilePlanFeedback(draft) || note.trim()) && (
            <p className="plan-review__hint">
              意见和批注仅随“让 AI 修订计划”发送。要直接执行，请先把必要要求写进正文。
              {note.trim() ? '当前批注尚未添加。' : ''}
            </p>
          )}
          {(review.executionModels?.length ?? 0) > 1 && (
            <label>
              执行模型：{review.executionModels?.find((model) => model.id === draft.model)?.label}
              <input
                type="range"
                aria-label="执行模型"
                min={0}
                max={review.executionModels!.length - 1}
                value={Math.max(
                  0,
                  review.executionModels!.findIndex((model) => model.id === draft.model),
                )}
                disabled={busy}
                onChange={(event) =>
                  update({
                    ...draft,
                    model: review.executionModels![Number(event.target.value)].id,
                  })
                }
              />
            </label>
          )}
          {review.context && (
            <p>
              上下文占用 {Math.round((review.context.tokens / review.context.contextWindow) * 100)}%
              · {review.context.tokens.toLocaleString()} /{' '}
              {review.context.contextWindow.toLocaleString()}
            </p>
          )}
          <h3>选择下一步</h3>
          {!compilePlanFeedback(draft) && (
            <p>未填写意见时，选择修订会回到对话，等待你输入修改要求。</p>
          )}
          {!ready && <p role="status">正在准备审核操作…</p>}
          {review.options.map((option) => {
            const overLimit =
              option.id === 'keep' &&
              review.context &&
              review.context.tokens / review.context.contextWindow > 0.95;
            return (
              <button
                className="plan-review__choice"
                type="button"
                key={option.id}
                disabled={
                  busy ||
                  !ready ||
                  option.disabled ||
                  !!overLimit ||
                  review.content === null ||
                  (option.id === 'refine' && !!note.trim())
                }
                onClick={() => void submit(option.id)}
              >
                <strong>{labels[option.id][0]}</strong>
                <span>
                  {overLimit ? '上下文超过 95%，请选择压缩或全新上下文。' : labels[option.id][1]}
                </span>
              </button>
            );
          })}
          {error && (
            <p role="alert" className="plan-review__error">
              {error}
            </p>
          )}
          {busy && <p role="status">正在提交选择…</p>}
          <button type="button" disabled={busy || !ready} onClick={() => void submit('cancel')}>
            取消本次审核
          </button>
          <p>取消会结束这次审核。若想稍后继续，请用“暂时收起”；草稿在本次应用运行期间保留。</p>
        </aside>
      </div>
    </dialog>
  );
}
