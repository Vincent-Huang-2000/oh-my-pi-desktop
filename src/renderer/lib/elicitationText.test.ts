import { describe, expect, it } from 'vitest';
import type { ElicitationRequest } from '../types';
import {
  formatElicitationResult,
  getElicitationResult,
  getElicitationResultText,
} from './elicitationText';

const textRequest: ElicitationRequest = {
  requestId: 'ask-text',
  message: '只做了这一步',
  fields: [{ name: 'value', type: 'string' }],
  kind: 'question',
};

describe('elicitation result formatting', () => {
  it('将状态和与问题相同的自由文本回答分开保存', () => {
    expect(getElicitationResult(textRequest, 'accept', { value: '只做了这一步' })).toEqual({
      label: '已提交',
      answer: '只做了这一步',
    });
    expect(getElicitationResultText(textRequest, 'accept', { value: '只做了这一步' })).toBe(
      '已提交：只做了这一步',
    );
  });

  it('保留以问题开头的自由文本回答', () => {
    const answer = '只做了这一步，然后补充了验证';
    expect(getElicitationResult(textRequest, 'accept', { value: answer })).toEqual({
      label: '已提交',
      answer,
    });
  });

  it('将结构化多字段回答汇总为状态和答案', () => {
    const request: ElicitationRequest = {
      requestId: 'ask-multiple',
      message: '请选择方案',
      fields: [
        { name: 'storage', type: 'string', title: '存储' },
        { name: 'cache', type: 'boolean', title: '缓存' },
      ],
      kind: 'question',
    };
    expect(getElicitationResult(request, 'accept', { storage: 'SQLite', cache: true })).toEqual({
      label: '已提交',
      answer: '存储：SQLite；缓存：true',
    });
  });

  it('没有结构化回答的历史记录保持原样显示', () => {
    expect(formatElicitationResult('已提交：旧回答')).toBe('已提交：旧回答');
  });
});
