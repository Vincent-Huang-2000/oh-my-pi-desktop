import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  compilePlanFeedback,
  getHiddenLineRanges,
  getPlanSections,
  stripHiddenSections,
  toVisibleLineStart,
  togglePlanSectionHidden,
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
  // 左侧目录整栏折叠状态：仅面板存续期间有效，不持久化。
  const [tocCollapsed, setTocCollapsed] = useState(false);
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
  // 隐藏语义：deleted 中的章节正文保留，仅阅读预览与提交时剔除；
  // 被隐藏祖先覆盖的子章节在目录里一并置灰，但恢复入口只留在祖先行。
  const hiddenRanges = getHiddenLineRanges(draft.content, draft.deleted);
  const hiddenSectionStarts = new Set(
    sections
      .filter(
        (section) =>
          draft.deleted.includes(section.title) ||
          hiddenRanges.some((range) => section.start > range.start && section.start < range.end),
      )
      .map((section) => section.start),
  );
  const visibleSections = sections.filter((section) => !hiddenSectionStarts.has(section.start));
  // 全部隐藏时退回完整列表兜底，保证目录编号与激活态有合法取值。
  const listedSections = visibleSections.length > 0 ? visibleSections : sections;
  const [selectedSectionStart, setSelectedSectionStart] = useState<number | null>(null);
  const primaryLevel =
    listedSections.length === 0
      ? 1
      : listedSections.some((section) => section.level === 2)
        ? 2
        : Math.min(...listedSections.map((section) => section.level));
  const primarySectionNumbers = new Map(
    listedSections
      .filter((section) => section.level === primaryLevel)
      .map((section, index) => [section.start, index + 1]),
  );
  const activeSectionStart =
    selectedSectionStart !== null &&
    visibleSections.some((section) => section.start === selectedSectionStart)
      ? selectedSectionStart
      : listedSections[0]?.start;
  const update = (next: PlanReviewDraft) => {
    drafts.current[sessionId] = next;
    setDraft(next);
  };
  // 提交用的有效正文：剔除隐藏章节；无隐藏时 stripHiddenSections 原样返回，比较开销不变。
  const effectiveContent = stripHiddenSections(draft.content, draft.deleted);
  // 阅读预览只渲染可见部分；编辑模式 textarea 始终展示完整原文。
  const previewContent = hiddenRanges.length > 0 ? effectiveContent : draft.content;
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.showModal();
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  const selectSection = (start: number, title: string) => {
    setSelectedSectionStart(start);
    setAnchor(`章节「${title}」（第 ${start + 1} 行）`);
    if (editing) {
      const offset = draft.content.split('\n').slice(0, start).join('\n').length + (start ? 1 : 0);
      editor.current?.focus();
      editor.current?.setSelectionRange(offset, offset);
    } else {
      // 预览剔除了隐藏章节，data-plan-line 是过滤后的行号，先映射再定位。
      const visibleStart = toVisibleLineStart(start, hiddenRanges);
      body.current
        ?.querySelector(`[data-plan-line="${visibleStart + 1}"]`)
        ?.scrollIntoView({ block: 'start' });
    }
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
        ...(effectiveContent !== review.content ? { editedContent: effectiveContent } : {}),
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
      <header className="plan-review-header">
        <div>
          <span className="plan-review-eyebrow">方案审核 · 尚未执行</span>
          <h2 id="plan-review-title">{review.title || '执行方案'}</h2>
        </div>
        <button type="button" onClick={onHide}>
          暂时收起 <span aria-hidden="true">×</span>
        </button>
      </header>
      <div
        className={`plan-review-layout${tocCollapsed ? ' plan-review-layout-toc-collapsed' : ''}`}
      >
        {tocCollapsed ? (
          <div className="plan-review-toc-rail">
            <button
              type="button"
              className="plan-review-toc-toggle"
              aria-label="展开目录"
              title="展开目录"
              onClick={() => setTocCollapsed(false)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="m9 6 6 6-6 6" />
              </svg>
            </button>
          </div>
        ) : (
          <nav className="plan-review-toc" aria-label="方案目录">
            <div className="plan-review-toc-header">
              <h3>目录</h3>
              <div className="plan-review-toc-tools">
                {sections.length > 0 && <span>{sections.length} 节</span>}
                <button
                  type="button"
                  className="plan-review-toc-toggle"
                  aria-label="折叠目录"
                  title="折叠目录"
                  onClick={() => setTocCollapsed(true)}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="m15 6-6 6 6 6" />
                  </svg>
                </button>
              </div>
            </div>
            {sections.length ? (
              sections.map((section) => {
                const hidden = hiddenSectionStarts.has(section.start);
                // 被隐藏祖先覆盖的子章节不再单独提供按钮，恢复入口只留在祖先行。
                const selfHidden = draft.deleted.includes(section.title);
                return (
                  <div
                    key={section.start}
                    className={`plan-review-section plan-review-section-depth-${Math.min(
                      3,
                      Math.max(0, section.level - primaryLevel),
                    )}${section.level < primaryLevel ? ' plan-review-section-document-title' : ''}${
                      activeSectionStart === section.start ? ' plan-review-section-active' : ''
                    }${hidden ? ' plan-review-section-hidden' : ''}`}
                  >
                    <button
                      className="plan-review-section-link"
                      type="button"
                      disabled={hidden}
                      aria-current={activeSectionStart === section.start ? 'location' : undefined}
                      onClick={() => selectSection(section.start, section.title)}
                    >
                      {primarySectionNumbers.has(section.start) && (
                        <span className="plan-review-section-number">
                          {String(primarySectionNumbers.get(section.start)).padStart(2, '0')}
                        </span>
                      )}
                      <span>{section.title}</span>
                    </button>
                    {(!hidden || selfHidden) && (
                      <button
                        className={`plan-review-section-delete${
                          hidden ? ' plan-review-section-delete-restore' : ''
                        }`}
                        type="button"
                        disabled={busy}
                        aria-label={
                          hidden ? `恢复章节：${section.title}` : `隐藏章节：${section.title}`
                        }
                        title={
                          hidden ? '恢复此章及其子章节' : '隐藏此章及其子章节，提交时不包含，可恢复'
                        }
                        onClick={() => update(togglePlanSectionHidden(draft, section))}
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          {hidden ? (
                            <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
                          ) : (
                            <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM4 4l16 16" />
                          )}
                        </svg>
                      </button>
                    )}
                  </div>
                );
              })
            ) : (
              <p>当前方案没有章节标题</p>
            )}
            <p className="plan-review-toc-hint">
              点章节可定位批注；隐藏只影响提交内容，可随时恢复。
            </p>
          </nav>
        )}
        <section className="plan-review-document" aria-label="计划正文">
          <div className="plan-review-tools">
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
            {effectiveContent !== review.content && <span>正文已修改 · 提交时保存</span>}
          </div>
          {review.content === null ? (
            <p role="alert">计划文件暂不可读取，请收起面板后重新连接并打开方案。</p>
          ) : editing ? (
            <textarea
              ref={editor}
              className="plan-review-editor"
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
              className="plan-review-body"
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
                {previewContent}
              </ReactMarkdown>
            </div>
          )}
        </section>
        <aside className="plan-review-decisions" aria-label="审核意见与下一步">
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
              <div className="plan-review-note" key={index}>
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
            <p className="plan-review-hint">
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
                className="plan-review-choice"
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
            <p role="alert" className="plan-review-error">
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
