import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

export default tseslint.config(
  // 全局忽略目录
  { ignores: ['dist', 'dist-electron', 'release', 'node_modules'] },

  // 基础 JS 推荐规则（所有源文件）
  { extends: [js.configs.recommended], files: ['src/**/*.{ts,tsx}'] },

  // TypeScript 非类型感知推荐规则
  ...tseslint.configs.recommended.map((c) => ({ ...c, files: ['src/**/*.{ts,tsx}'] })),

  // TypeScript 类型感知规则（显式指定两个 tsconfig 以覆盖渲染进程和主进程）
  ...tseslint.configs.recommendedTypeChecked.map((c) => ({ ...c, files: ['src/**/*.{ts,tsx}'] })),
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json', './tsconfig.electron.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // 模板字面量拼接字符串在项目中大量使用（JSON 解析、IPC 数据处理）
      '@typescript-eslint/restrict-template-expressions': 'off',
      // no-unsafe-* 规则降为 warn：存量代码中 JSON 解析和 IPC 数据缺少完整类型标注
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      // 允许未使用的变量以 _ 前缀标记（有意保留的参数/解构）
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },

  // === 渲染进程（React + Browser）===
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.flat.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
    languageOptions: { globals: globals.browser },
  },

  // === 主进程（Node）===
  {
    files: ['src/electron/**/*.ts'],
    languageOptions: { globals: globals.node },
  },

  // === 类型声明 ===
  {
    files: ['src/vite-env.d.ts'],
    rules: { '@typescript-eslint/no-empty-interface': 'off' },
  },
);
