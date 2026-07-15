import { useEffect, useMemo, useRef, useState } from 'react';

export type SessionSearchItem = {
  project: StoredProject;
  session: StoredSession;
  promptText: string;
  isActive: boolean;
};

type SearchScope = 'all' | 'current-project' | 'session-info' | 'prompt';
type SearchSort = 'relevance' | 'updated-desc' | 'title-asc';

const searchScopeOptions: Array<{ value: SearchScope; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'current-project', label: '当前项目' },
  { value: 'session-info', label: '会话信息' },
  { value: 'prompt', label: '用户 Prompt' }
];

const searchSortOptions: Array<{ value: SearchSort; label: string }> = [
  { value: 'relevance', label: '相关度优先' },
  { value: 'updated-desc', label: '最近更新' },
  { value: 'title-asc', label: '标题 A-Z' }
];

type SessionSearchModalProps = {
  items: SessionSearchItem[];
  currentProjectPath?: string;
  onClose: () => void;
  onSelect: (project: StoredProject, session: StoredSession) => void;
};

const normalizeText = (value: string) => value.replace(/\s+/g, ' ').trim();

const getProjectDisplayName = (project: StoredProject) =>
  (project.displayName && project.displayName.trim()) || project.name;

const formatSessionTime = (value: string) => {
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) {
    return '';
  }
  const diffMinutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
  if (diffMinutes < 1) {
    return '刚刚';
  }
  if (diffMinutes < 60) {
    return `${diffMinutes} 分前`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours} 小时前`;
  }
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} 天前`;
};

const tokenizeQuery = (query: string) => {
  const trimmed = query.trim().toLowerCase();
  return trimmed ? trimmed.split(/\s+/) : [];
};

const getSessionInfoText = (item: SessionSearchItem) => {
  const projectName = getProjectDisplayName(item.project);
  return [
    item.session.id,
    item.session.acpSessionId ?? '',
    item.session.title,
    projectName,
    item.project.name,
    item.project.path
  ].filter(Boolean).join(' ');
};

const getSearchText = (item: SessionSearchItem, scope: SearchScope) => {
  if (scope === 'prompt') {
    return item.promptText;
  }
  if (scope === 'session-info') {
    return getSessionInfoText(item);
  }
  return [getSessionInfoText(item), item.promptText].filter(Boolean).join(' ');
};

const getUpdatedAtTime = (item: SessionSearchItem) => {
  const time = new Date(item.session.updatedAt).getTime();
  return Number.isNaN(time) ? 0 : time;
};

const compareTitle = (a: SessionSearchItem, b: SessionSearchItem) =>
  a.session.title.localeCompare(b.session.title, 'zh-Hans-CN') ||
  getUpdatedAtTime(b) - getUpdatedAtTime(a);

const sortSessionSearchItems = <T extends SessionSearchItem>(items: T[], sort: SearchSort) => {
  const rows = [...items];
  if (sort === 'title-asc') {
    return rows.sort(compareTitle);
  }
  return rows.sort((a, b) => getUpdatedAtTime(b) - getUpdatedAtTime(a));
};

const fuzzyTokenScore = (token: string, text: string) => {
  let tokenIndex = 0;
  let firstMatch = -1;
  let previousMatch = -1;
  let gapScore = 0;

  for (let index = 0; index < text.length && tokenIndex < token.length; index += 1) {
    if (text[index] !== token[tokenIndex]) {
      continue;
    }
    if (firstMatch === -1) {
      firstMatch = index;
    }
    if (previousMatch !== -1) {
      gapScore += index - previousMatch - 1;
    }
    previousMatch = index;
    tokenIndex += 1;
  }

  if (tokenIndex !== token.length) {
    return null;
  }

  // 分数越低越靠前：靠前、连续的字符匹配优先。
  return firstMatch + gapScore * 2;
};

type SearchPreparedItem = SessionSearchItem & {
  searchText: string;
};

const getTokenMatchScore = (token: string, textLower: string) => {
  const literalIndex = textLower.indexOf(token);
  if (literalIndex >= 0) {
    return { score: literalIndex, literal: true };
  }

  const fuzzyScore = fuzzyTokenScore(token, textLower);
  if (fuzzyScore === null || fuzzyScore > 80) {
    return null;
  }
  return { score: fuzzyScore + 100, literal: false };
};

const matchesSearchQuery = (item: SearchPreparedItem, tokens: string[]) => {
  if (tokens.length === 0) {
    return true;
  }
  const textLower = item.searchText.toLowerCase();
  return tokens.every((token) => getTokenMatchScore(token, textLower) !== null);
};

const rankSessionSearchItems = (items: SearchPreparedItem[], query: string) => {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) {
    return items;
  }

  const results: Array<{ item: SearchPreparedItem; score: number; literal: boolean; index: number }> = [];
  items.forEach((item, index) => {
    const textLower = item.searchText.toLowerCase();
    let score = 0;
    let literal = true;

    for (const token of tokens) {
      const tokenMatch = getTokenMatchScore(token, textLower);
      if (!tokenMatch) {
        return;
      }
      score += tokenMatch.score;
      if (!tokenMatch.literal) {
        literal = false;
      }
    }

    results.push({ item, score, literal, index });
  });

  results.sort((a, b) => {
    if (a.literal !== b.literal) {
      return a.literal ? -1 : 1;
    }
    if (a.literal) {
      return getUpdatedAtTime(b.item) - getUpdatedAtTime(a.item) || a.index - b.index;
    }
    return a.score - b.score || getUpdatedAtTime(b.item) - getUpdatedAtTime(a.item) || a.index - b.index;
  });

  return results.map((result) => result.item);
};

export function SessionSearchModal({ items, currentProjectPath, onClose, onSelect }: SessionSearchModalProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<SearchScope>('all');
  const [sort, setSort] = useState<SearchSort>('relevance');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const filteredItems = useMemo(() => {
    const scopeItems = scope === 'current-project' && currentProjectPath
      ? items.filter((item) => item.project.path === currentProjectPath)
      : items;
    const prepared = scopeItems.map<SearchPreparedItem>((item) => ({
      ...item,
      searchText: getSearchText(item, scope)
    }));
    const sorted = sort === 'relevance'
      ? sortSessionSearchItems(prepared, 'updated-desc')
      : sortSessionSearchItems(prepared, sort);
    if (sort === 'relevance') {
      return rankSessionSearchItems(sorted, query);
    }
    const tokens = tokenizeQuery(query);
    return sorted.filter((item) => matchesSearchQuery(item, tokens));
  }, [currentProjectPath, items, query, scope, sort]);

  useEffect(() => {
    if (scope === 'current-project' && !currentProjectPath) {
      setScope('all');
    }
  }, [currentProjectPath, scope]);

  useEffect(() => {
    inputRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query, scope, sort]);

  useEffect(() => {
    setSelectedIndex((current) => Math.min(current, Math.max(0, filteredItems.length - 1)));
  }, [filteredItems.length]);

  const handleSelect = (item: SessionSearchItem) => {
    onSelect(item.project, item.session);
    onClose();
  };

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={onClose}
    >
      <section
        className="session-search-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-search-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="session-search-modal-header">
          <h2 id="session-search-title">搜索会话</h2>
          <button
            className="session-search-close"
            type="button"
            onClick={onClose}
            aria-label="关闭搜索窗口"
            title="关闭"
          >
            ✕
          </button>
        </div>
        <input
          ref={inputRef}
          className="session-search-input"
          type="search"
          value={query}
          placeholder="搜索会话..."
          aria-label="搜索会话"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setSelectedIndex((current) => Math.min(current + 1, Math.max(0, filteredItems.length - 1)));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setSelectedIndex((current) => Math.max(0, current - 1));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              const selected = filteredItems[selectedIndex];
              if (selected) {
                handleSelect(selected);
              }
            }
          }}
        />
        <div className="session-search-controls">
          <div className="session-search-scope" role="group" aria-label="搜索范围">
            {searchScopeOptions.map((option) => (
              <button
                key={option.value}
                className={scope === option.value ? 'active' : ''}
                type="button"
                disabled={option.value === 'current-project' && !currentProjectPath}
                onClick={() => setScope(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <label className="session-search-sort">
            <span>排序</span>
            <select value={sort} onChange={(event) => setSort(event.target.value as SearchSort)}>
              {searchSortOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="session-search-results" role="listbox" aria-label="会话搜索结果">
          {filteredItems.length === 0 ? (
            <div className="session-search-empty">
              {items.length === 0 ? '暂无可搜索会话' : '没有匹配的会话'}
            </div>
          ) : (
            filteredItems.map((item, index) => {
              const projectName = getProjectDisplayName(item.project);
              const promptPreview = normalizeText(item.promptText);
              const meta = [
                projectName,
                formatSessionTime(item.session.updatedAt),
                item.session.acpSessionId ? `#${item.session.acpSessionId.slice(0, 8)}` : item.session.id
              ].filter(Boolean).join(' · ');
              return (
                <button
                  key={`${item.project.path}:${item.session.id}`}
                  className={[
                    'session-search-result',
                    index === selectedIndex ? 'selected' : '',
                    item.isActive ? 'active' : ''
                  ].filter(Boolean).join(' ')}
                  type="button"
                  role="option"
                  aria-selected={index === selectedIndex}
                  onMouseEnter={() => setSelectedIndex(index)}
                  onClick={() => handleSelect(item)}
                >
                  <span className="session-search-result-title">{item.session.title}</span>
                  <span className="session-search-result-meta">{meta}</span>
                  {promptPreview && (
                    <span className="session-search-result-preview">{promptPreview}</span>
                  )}
                </button>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}
