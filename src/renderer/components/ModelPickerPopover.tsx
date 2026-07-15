import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import type { AcpConfigOption } from '../types';
import { fuzzyMatch, groupModelOptions, type GroupedModelOptions } from '../utils';

type ModelOption = NonNullable<AcpConfigOption['options']>[number];

type ModelPickerPopoverProps = {
  value: string;
  options: ModelOption[];
  emptyLabel: string;
  triggerRef?: React.RefObject<HTMLElement | null>;
  /** 是否显示右侧详情面板，默认 true。底部弹出时建议关闭以节省空间。 */
  showDetail?: boolean;
  onChange: (value: string) => void;
  onClose: () => void;
};

// 方案 A: 锚定 Popover + 分组 + 详情面板。
export function ModelPickerPopover({
  value,
  options,
  emptyLabel,
  triggerRef,
  showDetail = true,
  onChange,
  onClose,
}: ModelPickerPopoverProps) {
  const [query, setQuery] = useState('');
  const [activeProviderIndex, setActiveProviderIndex] = useState(0);
  const [activeModelIndex, setActiveModelIndex] = useState(0);
  // 展开的 provider 集合,默认全折叠。
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set());
  // 当前选中模型所在的分组,方便初始化时自动展开。
  const currentValueProvider = useMemo(() => {
    if (!options.length) return null;
    const groups = groupModelOptions(options);
    const group = groups.find(g => g.models.some(m => m.value === value));
    return group?.provider ?? null;
  }, [options, value]);

  // 组件挂载后,若可确定当前选中模型的分组,自动展开该分组。
  const hasInitializedExpanded = useRef(false);
  useEffect(() => {
    if (hasInitializedExpanded.current) return;
    if (!currentValueProvider) return;
    hasInitializedExpanded.current = true;
    setExpandedProviders(new Set([currentValueProvider]));
  }, [currentValueProvider]);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Record<string, HTMLElement | null>>({});
  // useAutoAnimate:监听子节点的添加/删除,为分组展开/折叠提供平滑过渡。
  const [listRef] = useAutoAnimate<HTMLDivElement>({ duration: 180, easing: 'ease-out' });

  const filteredGroups = useMemo<GroupedModelOptions>(() => {
    const trimmed = query.trim();
    if (!trimmed) return groupModelOptions(options);
    return groupModelOptions(options).map((group) => ({
      ...group,
      models: group.models.filter((model) => fuzzyMatch(model.name, trimmed)),
    })).filter((group) => group.models.length > 0);
  }, [options, query]);

  // 搜索时自动展开所有有匹配的组，并重置键盘焦点到第一个结果。
  // 非搜索状态下分组默认折叠，不支持键盘导航，索引无需处理；
  // 搜索时 filteredGroups 会因过滤而移除组/缩减模型列表，不重置会
  // 导致 activeProviderIndex / activeModelIndex 越界，表现为高亮丢失、
  // Enter 无效、方向键无响应。
  useEffect(() => {
    if (query.trim()) {
      setExpandedProviders(new Set(filteredGroups.map((g) => g.provider)));
      setActiveProviderIndex(0);
      setActiveModelIndex(0);
    }
  }, [query, filteredGroups]);

  // 当用户折叠当前高亮所在组时，自动跳到第一个可见组的首项，避免高亮丢失。
  // 场景：手动折叠高亮组 / 首次展开非首组（此时索引仍指向未展开的首组）/
  // 跨组跳转后手动折叠目标组。
  useEffect(() => {
    if (expandedProviders.size === 0) return;
    const group = filteredGroups[activeProviderIndex];
    if (group && expandedProviders.has(group.provider)) return;
    // 当前组已折叠，找第一个展开的组
    for (let i = 0; i < filteredGroups.length; i++) {
      if (expandedProviders.has(filteredGroups[i].provider)) {
        setActiveProviderIndex(i);
        setActiveModelIndex(0);
        return;
      }
    }
  }, [expandedProviders, filteredGroups, activeProviderIndex]);

  // 弹窗打开自动聚焦搜索框。
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // 监听全局点击,点击弹窗外部且不在触发按钮上时关闭。
  useEffect(() => {
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      const insidePopover = popoverRef.current?.contains(target) ?? false;
      const insideTrigger = triggerRef?.current?.contains(target) ?? false;
      if (!insidePopover && !insideTrigger) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [onClose, triggerRef]);

  // 当键盘活动项变化时,滚动到可视区域。
  useEffect(() => {
    const group = filteredGroups[activeProviderIndex];
    if (!group) return;
    const model = group.models[activeModelIndex];
    if (!model) return;
    const el = itemRefs.current[model.value];
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeProviderIndex, activeModelIndex, filteredGroups]);

  const selectedModel = useMemo(() => {
    for (const group of filteredGroups) {
      for (const model of group.models) {
        if (model.value === value) return model;
      }
    }
    return null;
  }, [filteredGroups, value]);

  const handleSelect = (modelValue: string) => {
    onChange(modelValue);
    onClose();
  };

  // 切换分组的展开/折叠状态。
  const toggleProvider = useCallback((provider: string) => {
    setExpandedProviders((prev) => {
      const next = new Set(prev);
      if (next.has(provider)) {
        next.delete(provider);
      } else {
        next.add(provider);
      }
      return next;
    });
  }, []);

  // 组内 ↑↓ 导航：到达当前组边界时自动跳到相邻组并展开它，遍历所有匹配项。
  // filteredGroups 已经过滤空组，不会跳到无模型的组。
  const moveActive = (deltaModel: number) => {
    if (filteredGroups.length === 0) return;
    const currentGroup = filteredGroups[activeProviderIndex];
    if (!currentGroup) return;
    const nextModelIndex = activeModelIndex + deltaModel;

    // 在当前组范围内，直接移动
    if (nextModelIndex >= 0 && nextModelIndex < currentGroup.models.length) {
      setActiveModelIndex(nextModelIndex);
      return;
    }

    // 到达组边界，跨组并自动展开目标组
    const nextProviderIndex = activeProviderIndex + (deltaModel > 0 ? 1 : -1);
    if (nextProviderIndex < 0 || nextProviderIndex >= filteredGroups.length) return;

    const nextGroup = filteredGroups[nextProviderIndex];
    setExpandedProviders((prev) => {
      if (prev.has(nextGroup.provider)) return prev;
      const nextSet = new Set(prev);
      nextSet.add(nextGroup.provider);
      return nextSet;
    });
    setActiveProviderIndex(nextProviderIndex);
    setActiveModelIndex(deltaModel > 0 ? 0 : nextGroup.models.length - 1);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const group = filteredGroups[activeProviderIndex];
      const model = group?.models[activeModelIndex];
      if (model) handleSelect(model.value);
      return;
    }
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
  };

  if (options.length === 0) {
    return (
      <div ref={popoverRef} className="model-picker-popover" onKeyDown={handleKeyDown} tabIndex={-1}>
        <div className="model-picker-empty">{emptyLabel}</div>
      </div>
    );
  }

  return (
    <div ref={popoverRef} className={`model-picker-popover${showDetail ? '' : ' no-detail'}`} onKeyDown={handleKeyDown} tabIndex={-1}>
      <div className="model-picker-search">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.35-4.35" />
        </svg>
        <input
          ref={searchRef}
          type="text"
          value={query}
          placeholder="搜索模型"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="model-picker-body">
        <div className="model-picker-list" ref={listRef}>
          {filteredGroups.map((group, providerIndex) => {
            const isExpanded = expandedProviders.has(group.provider);
            return (
              <div key={group.provider} className="model-picker-group">
                <button
                  type="button"
                  className={[
                    'model-picker-group-header',
                    isExpanded ? 'expanded' : '',
                  ].join(' ')}
                  onClick={() => toggleProvider(group.provider)}
                >
                  <svg
                    className="model-picker-group-chevron"
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    aria-hidden="true"
                  >
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                  <span className="model-picker-group-label">{group.provider}</span>
                  <span className="model-picker-group-count">{group.models.length}</span>
                </button>
                {isExpanded && group.models.map((model, modelIndex) => {
                  const isActive = providerIndex === activeProviderIndex && modelIndex === activeModelIndex;
                  const isSelected = model.value === value;
                  return (
                    <button
                      key={model.value}
                      ref={(el) => { itemRefs.current[model.value] = el; }}
                      type="button"
                      className={[
                        'model-picker-item',
                        isActive ? 'active' : '',
                        isSelected ? 'selected' : '',
                      ].join(' ')}
                      onClick={() => handleSelect(model.value)}
                      onMouseEnter={() => {
                        setActiveProviderIndex(providerIndex);
                        setActiveModelIndex(modelIndex);
                      }}
                    >
                      <span className="model-picker-item-name">{model.name}</span>
                      {isSelected && (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
          {filteredGroups.length === 0 && (
            <div className="model-picker-empty">无匹配模型</div>
          )}
        </div>
        {showDetail && (
        <div className="model-picker-detail">
          {selectedModel ? (
            <>
              <div className="model-picker-detail-name">{selectedModel.name}</div>
              {selectedModel.description ? (
                <div className="model-picker-detail-desc">{selectedModel.description}</div>
              ) : (
                <div className="model-picker-detail-desc model-picker-detail-placeholder">暂无描述</div>
              )}
              {selectedModel.value === value ? (
                <span className="model-picker-current-badge">当前使用</span>
              ) : (
                <button
                  type="button"
                  className="model-picker-switch-button"
                  onClick={() => handleSelect(selectedModel.value)}
                >
                  切换
                </button>
              )}
            </>
          ) : (
            <div className="model-picker-empty">选择模型查看详情</div>
          )}
        </div>
        )}
      </div>
    </div>
  );
}
