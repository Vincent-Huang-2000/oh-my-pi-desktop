/** @type {import('stylelint').Config} */
export default {
  extends: ['stylelint-config-standard'],
  rules: {
    // 关闭降序优先级检查：BEM 风格的 modifier / state 类不可避免地会触发
    'no-descending-specificity': null,
    // 关闭 vendor-prefix 检查：Electron 内置 Chromium，不需要 -webkit- 前缀，
    // 且 --fix 无视 ignoreProperties 仍会产生重复声明
    'property-no-vendor-prefix': null,
    // 允许 BEM modifier（plan-in_progress, tool-switch_mode）和外部库类名（hljs-*）
    'selector-class-pattern': [
      '^([a-z][a-z0-9]*)(-[a-z0-9]+)*$|^hljs-|^plan-[a-z_]+$|^tool-[a-z_]+$',
      { resolveNestedSelectors: true },
    ],
    // 项目大量使用 ::-webkit-scrollbar 等非标准伪元素
    'selector-pseudo-element-no-unknown': [
      true,
      {
        ignorePseudoElements: [
          'input-placeholder',
          'thumb',
          'track',
          'scrollbar',
          'scrollbar-thumb',
          'scrollbar-track',
        ],
      },
    ],
  },
};
