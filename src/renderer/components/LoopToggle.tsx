import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  buildLoopLimitSpec,
  describeLoopStatus,
  LOOP_ICON,
  type LoopDurationUnit,
  type LoopLimitKind,
  type LoopLimitSpec,
  type LoopState,
} from '../lib/loopMode';
import './LoopToggle.css';

type LoopToggleProps = {
  // 当前会话（或草稿）的 Loop 状态；null 表示未开启。
  loop: LoopState | null;
  disabled: boolean;
  onEnable: (spec: LoopLimitSpec | null) => void;
  onDisable: () => void;
};

const LIMIT_KIND_OPTIONS: Array<{ value: LoopLimitKind; label: string }> = [
  { value: 'none', label: '不限' },
  { value: 'iterations', label: '次数' },
  { value: 'duration', label: '时长' },
];

const DURATION_UNIT_OPTIONS: Array<{ value: LoopDurationUnit; label: string }> = [
  { value: 'minutes', label: '分钟' },
  { value: 'hours', label: '小时' },
];

// Loop 开关：位于输入区配置行，弹层中选择限制方式（不限 / 次数 / 时长）后开启，已开启时可关闭。
// 开启后不支持修改限制（与 omp TUI 一致），需先关闭再重新开启。
export function LoopToggle({ loop, disabled, onEnable, onDisable }: LoopToggleProps) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<LoopLimitKind>('iterations');
  const [count, setCount] = useState('10');
  const [duration, setDuration] = useState('30');
  const [unit, setUnit] = useState<LoopDurationUnit>('minutes');
  const [error, setError] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // 外部点击或 Esc 关闭弹层。
  useEffect(() => {
    if (!open) return;
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      const insidePopover = popoverRef.current?.contains(target) ?? false;
      const insideTrigger = triggerRef.current?.contains(target) ?? false;
      if (!insidePopover && !insideTrigger) setOpen(false);
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const handleEnable = () => {
    const result = buildLoopLimitSpec(kind, kind === 'duration' ? duration : count, unit);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError('');
    onEnable(result.spec);
    setOpen(false);
  };

  const handleDisable = () => {
    onDisable();
    setOpen(false);
  };

  // 组件位于输入区 form 内：数字框里按 Enter 只开启 Loop，不能提交消息。
  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleEnable();
    }
  };

  const status = loop ? describeLoopStatus(loop, Date.now()) : null;

  return (
    <div className="loop-toggle">
      <button
        ref={triggerRef}
        type="button"
        className={`segment-select-trigger loop-toggle-trigger${loop ? ' is-active' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={loop ? 'Loop 运行模式（已开启）' : 'Loop 运行模式'}
        title="Loop：每轮结束后自动重复提示"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        {loop && <span className="loop-toggle-dot" aria-hidden="true" />}
        <span className="segment-select-label">Loop</span>
        <svg
          className="segment-select-chevron"
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div ref={popoverRef} className="loop-toggle-popover" role="dialog" aria-label="Loop 设置">
          {status ? (
            <>
              <p className="loop-toggle-title">
                {LOOP_ICON} Loop · {status.status}
              </p>
              <p className="loop-toggle-hint">{status.detail}</p>
              <button type="button" className="loop-toggle-primary" onClick={handleDisable}>
                关闭 Loop
              </button>
            </>
          ) : (
            <>
              <p className="loop-toggle-title">{LOOP_ICON} Loop 运行模式</p>
              <div className="loop-toggle-options" role="radiogroup" aria-label="限制方式">
                {LIMIT_KIND_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={kind === option.value}
                    className={`loop-toggle-option${kind === option.value ? ' is-selected' : ''}`}
                    onClick={() => {
                      setKind(option.value);
                      setError('');
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              {kind === 'iterations' && (
                <div className="loop-toggle-field">
                  <span>重复</span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    inputMode="numeric"
                    aria-label="重复次数"
                    value={count}
                    onChange={(event) => setCount(event.target.value)}
                    onKeyDown={handleInputKeyDown}
                  />
                  <span>次</span>
                </div>
              )}
              {kind === 'duration' && (
                <div className="loop-toggle-field">
                  <span>持续</span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    inputMode="numeric"
                    aria-label="持续时长"
                    value={duration}
                    onChange={(event) => setDuration(event.target.value)}
                    onKeyDown={handleInputKeyDown}
                  />
                  <div className="loop-toggle-options" role="radiogroup" aria-label="时长单位">
                    {DURATION_UNIT_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={unit === option.value}
                        className={`loop-toggle-option${unit === option.value ? ' is-selected' : ''}`}
                        onClick={() => setUnit(option.value)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <p className="loop-toggle-hint">
                下一条消息会在每轮结束后自动重复，首次发送不计入次数；也可输入 /loop。
              </p>
              {error && (
                <p className="loop-toggle-error" role="alert">
                  {error}
                </p>
              )}
              <button type="button" className="loop-toggle-primary" onClick={handleEnable}>
                开启 Loop
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
