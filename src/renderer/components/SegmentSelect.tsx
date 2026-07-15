import { useEffect, useMemo, useRef, useState } from 'react';
import type { AcpConfigOption } from '../types';

type Option = NonNullable<AcpConfigOption['options']>[number];

type SegmentSelectProps = {
  ariaLabel: string;
  options: Option[];
  value: string;
  emptyLabel: string;
  disabled?: boolean;
  // 当下拉为空、用户点击触发器时是否仍展开（用于展示 emptyLabel 提示）。
  openWhenEmpty?: boolean;
  onChange: (value: string) => void;
};

// 配置区段落下拉：替代原生 <select>。
// 设计目标：
//   - 视觉上与 config-group 的分段风格统一（无自带边框，铺满所在 segment）。
//   - 下拉菜单用统一的 popover 样式（圆角、阴影、分隔、active/selected 态）。
//   - 支持外部点击 / Esc 关闭、键盘 ↑↓/Enter 导航。
//   - 不带搜索与分组（选项数通常很少），保持轻量。
export function SegmentSelect({
  ariaLabel,
  options,
  value,
  emptyLabel,
  disabled,
  openWhenEmpty = false,
  onChange,
}: SegmentSelectProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Record<string, HTMLElement | null>>({});
  const [activeIndex, setActiveIndex] = useState(0);

  const currentName = useMemo(() => {
    const matched = options.find((o) => o.value === value);
    if (matched) return matched.name;
    return options.length === 0 ? emptyLabel : '未选择';
  }, [options, value, emptyLabel]);

  // 打开菜单时把高亮重置到当前选中项（若有），便于直接 Enter 确认或方向键微调。
  useEffect(() => {
    if (!open) return;
    const idx = options.findIndex((o) => o.value === value);
    setActiveIndex(idx >= 0 ? idx : 0);
  }, [open, options, value]);

  // 外部点击关闭：点击菜单外且不在触发按钮内时关闭。
  useEffect(() => {
    if (!open) return;
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      const insideMenu = menuRef.current?.contains(target) ?? false;
      const insideTrigger = triggerRef.current?.contains(target) ?? false;
      if (!insideMenu && !insideTrigger) setOpen(false);
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [open]);

  // 高亮项滚动入视。
  useEffect(() => {
    if (!open) return;
    const opt = options[activeIndex];
    if (!opt) return;
    itemRefs.current[opt.value]?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex, options]);

  const handleTriggerClick = () => {
    if (disabled) return;
    if (options.length === 0 && !openWhenEmpty) return;
    setOpen((o) => !o);
  };

  const moveActive = (delta: number) => {
    if (options.length === 0) return;
    setActiveIndex((prev) => {
      const next = prev + delta;
      if (next < 0) return 0;
      if (next > options.length - 1) return options.length - 1;
      return next;
    });
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (options.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveActive(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveActive(-1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const opt = options[activeIndex];
      if (opt) {
        onChange(opt.value);
        setOpen(false);
      }
    }
  };

  const handleSelect = (val: string) => {
    onChange(val);
    setOpen(false);
  };

  return (
    <div className="segment-select">
      <button
        ref={triggerRef}
        type="button"
        className="segment-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled || (options.length === 0 && !openWhenEmpty)}
        onClick={handleTriggerClick}
      >
        <span className="segment-select-label">{currentName}</span>
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
        <div ref={menuRef} className="segment-select-menu" role="listbox" onKeyDown={handleKeyDown} tabIndex={-1}>
          {options.length === 0 ? (
            <div className="segment-select-empty">{emptyLabel}</div>
          ) : (
            options.map((opt, index) => {
              const isActive = index === activeIndex;
              const isSelected = opt.value === value;
              return (
                <button
                  key={opt.value}
                  ref={(el) => { itemRefs.current[opt.value] = el; }}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={['segment-select-item', isActive ? 'active' : '', isSelected ? 'selected' : ''].join(' ')}
                  onClick={() => handleSelect(opt.value)}
                  onMouseEnter={() => setActiveIndex(index)}
                >
                  <span className="segment-select-item-name">{opt.name}</span>
                  {isSelected && (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
