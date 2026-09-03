import { describe, expect, it } from 'vitest';
import { getPayloadElicitationFields } from './utils.js';

describe('getPayloadElicitationFields', () => {
  it('保留 v18 Ask 的单选、多选、默认项与自定义回答字段', () => {
    expect(
      getPayloadElicitationFields({
        requestedSchema: {
          properties: {
            q0: {
              type: 'string',
              title: '存储方案',
              description: '请选择一个方案',
              oneOf: [
                { const: 'SQLite', title: 'SQLite', description: '本地文件' },
                { const: 'PostgreSQL', title: 'PostgreSQL', description: '服务端数据库' },
              ],
              default: 'SQLite',
            },
            q0__other: { type: 'string', title: 'Other (type your own)' },
            q1: {
              type: 'array',
              title: '启用功能',
              items: {
                anyOf: [
                  { const: 'auth', title: '认证' },
                  { const: 'search', title: '搜索' },
                ],
              },
            },
            q1__other: { type: 'string', title: 'Other (type your own)' },
          },
        },
      }),
    ).toEqual([
      {
        name: 'q0',
        type: 'string',
        title: '存储方案',
        description: '请选择一个方案',
        defaultValue: 'SQLite',
        otherFieldName: 'q0__other',
        options: [
          { value: 'SQLite', label: 'SQLite', description: '本地文件' },
          { value: 'PostgreSQL', label: 'PostgreSQL', description: '服务端数据库' },
        ],
      },
      {
        name: 'q1',
        type: 'array',
        title: '启用功能',
        otherFieldName: 'q1__other',
        options: [
          { value: 'auth', label: '认证' },
          { value: 'search', label: '搜索' },
        ],
      },
    ]);
  });

  it('兼容 items.enum 多选候选项', () => {
    expect(
      getPayloadElicitationFields({
        requestedSchema: {
          properties: {
            q0: {
              type: 'array',
              title: '启用功能',
              items: { enum: ['auth', 'search'] },
            },
          },
        },
      }),
    ).toEqual([
      {
        name: 'q0',
        type: 'array',
        title: '启用功能',
        options: [
          { value: 'auth', label: 'auth' },
          { value: 'search', label: 'search' },
        ],
      },
    ]);
  });

  it('保留元素均为字符串的数组默认值', () => {
    expect(
      getPayloadElicitationFields({
        requestedSchema: {
          properties: {
            q0: {
              type: 'array',
              items: { enum: ['auth', 'search'] },
              default: ['auth', 'search'],
            },
          },
        },
      }),
    ).toEqual([
      {
        name: 'q0',
        type: 'array',
        defaultValue: ['auth', 'search'],
        options: [
          { value: 'auth', label: 'auth' },
          { value: 'search', label: 'search' },
        ],
      },
    ]);
  });

  it('保留 boolean false 默认值', () => {
    expect(
      getPayloadElicitationFields({
        requestedSchema: {
          properties: {
            q0: { type: 'boolean', default: false },
          },
        },
      }),
    ).toEqual([{ name: 'q0', type: 'boolean', defaultValue: false }]);
  });

  it('保留没有候选项的 Ask 自定义回答字段', () => {
    expect(
      getPayloadElicitationFields({
        requestedSchema: {
          properties: {
            q0__other: { type: 'string', title: 'Other (type your own)' },
          },
        },
      }),
    ).toEqual([
      {
        name: 'q0__other',
        type: 'string',
        title: 'Other (type your own)',
      },
    ]);
  });

  it('兼容旧版单字段 elicitation', () => {
    expect(
      getPayloadElicitationFields({
        requestedSchema: {
          properties: {
            value: { type: 'boolean', description: '确认执行' },
          },
        },
      }),
    ).toEqual([
      {
        name: 'value',
        type: 'boolean',
        description: '确认执行',
      },
    ]);
  });
});
