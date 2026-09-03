import { describe, expect, it } from 'vitest';
import type { ElicitationField, ElicitationRequest } from '../types';
import { getElicitationResultText } from '../lib/elicitationText';
import { buildAskElicitationContent } from './ElicitationModal.js';

const multiSelectFields: ElicitationField[] = [
  {
    name: 'q0',
    type: 'array',
    title: '启用功能',
    otherFieldName: 'q0__other',
    options: [
      { value: 'auth', label: '认证' },
      { value: 'search', label: '搜索' },
    ],
  },
];

const multiSelectRequest: ElicitationRequest = {
  requestId: 'ask-multi',
  message: '选择需要启用的功能',
  fields: multiSelectFields,
  kind: 'question',
};

describe('AskElicitationForm submission', () => {
  it('同时提交多选项与自定义回答，并在历史记录中显示两者', () => {
    const content = buildAskElicitationContent(
      multiSelectFields,
      { q0: ['auth', 'search'] },
      { q0__other: '  审计  ' },
    );

    expect(content).toEqual({ q0: ['auth', 'search'], q0__other: '审计' });
    expect(getElicitationResultText(multiSelectRequest, 'accept', content)).toBe(
      '已提交：启用功能：auth、search、审计',
    );
  });

  it('保持单选的自定义回答与候选项互斥', () => {
    const fields: ElicitationField[] = [
      {
        name: 'q0',
        type: 'string',
        title: '存储方案',
        otherFieldName: 'q0__other',
        options: [{ value: 'SQLite', label: 'SQLite' }],
      },
    ];

    expect(
      buildAskElicitationContent(fields, { q0: 'SQLite' }, { q0__other: '自定义存储' }),
    ).toEqual({ q0__other: '自定义存储' });
  });
});
