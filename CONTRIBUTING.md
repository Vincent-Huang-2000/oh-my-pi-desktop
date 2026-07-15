# 贡献指南

感谢你考虑为 oh-my-pi Desktop 贡献代码！本文档说明如何参与开发、提交 Issue 和 Pull Request。

## 开发环境搭建

```bash
# 要求 Node.js >= 22.12.0
node -v

# 克隆仓库
git clone https://github.com/Vincent-Huang-2000/oh-my-pi-desktop.git
cd oh-my-pi-desktop

# 安装依赖
npm install

# 启动开发模式
npm run dev
```

开发模式下，Vite 在 `127.0.0.1:5173` 提供热更新，Electron 窗口自动加载该地址。

此外还需要安装 [oh-my-pi](https://github.com/can1357/oh-my-pi) 的 `omp` CLI 工具，确保 `omp acp --help` 可正常执行。

## 提 Issue

在提交 Issue 前，请先搜索已有 Issue 确认没有重复。

- **Bug 报告**：使用 Bug Report 模板，提供复现步骤、期望行为、实际行为和环境信息
- **功能请求**：使用 Feature Request 模板，描述使用场景和期望效果
- **其他问题**：自由格式，尽量提供上下文

## 提 Pull Request

1. Fork 本仓库并创建分支
2. 遵循下方代码风格规范编写代码
3. 通过"修改后自检清单"中的所有检查项
4. 提交 PR，使用 PR 模板填写说明

### 代码风格

项目当前没有 lint / format 工具，靠人工一致性维护。请遵循以下约定：

| 规则 | 说明 |
|---|---|
| 缩进 | 2 空格 |
| 引号 | 单引号 |
| 分号 | 使用分号 |
| 尾随逗号 | 使用尾随逗号 |
| 组件声明 | `function` 声明 + 具名导出（仅 `App.tsx` 用 `export default`） |
| 类型别名 | `type`，不用 `interface`（`vite-env.d.ts` 中的 `Window` 除外） |
| 文件名 | 组件 PascalCase（`ChatWorkspace.tsx`），工具/类型 camelCase（`utils.ts`） |
| CSS 类名 | BEM 风格，连字符分隔（`.project-title.active`） |
| 注释 | 中文注释，保持必要注释不删除已有注释 |

### 修改后自检清单

项目目前没有自动化测试。提交 PR 前请逐项验证：

1. `npm run build` 通过（涵盖 tsc 类型检查 + vite 打包）
2. `npm run dev` 启动后核心功能正常：选 workspace → 创建 session → 发消息 → agent 回复；权限弹窗可审批；elicitation / questionnaire 弹窗可交互；diff 审查面板可查看；模型/模式/推理强度选择器可切换；approval profile 可切换；slash 命令面板可唤起；图片粘贴/拖入可发送
3. **workspace 切换**：在项目 A 发消息 → 切到项目 B → 发消息，确认 agent 在 B 目录下执行
4. **多 session 隔离**：开两个 session 来回切换，消息流/权限/elicitation 不串
5. **session 生命周期**：加载 / 恢复 / Fork / 关闭 / `/resume` 同步正常
6. **项目置顶**：置顶后固定在顶部，排序不受 `lastOpenedAt` 影响
7. **侧栏布局**：左栏全高、折叠/展开/拖拽正常，左边缘热区预览侧栏正常

**类型同步提醒**：如果修改了 `src/electron/types.ts`，必须同步修改 `src/vite-env.d.ts` 的同名类型。如果修改了 IPC 通道，必须同步修改 `src/electron/ipc.ts` + `src/electron/preload.ts` + `src/vite-env.d.ts`。

## 当前基础设施状态

| 项目 | 状态 |
|---|---|
| 自动化测试 | 无 |
| Lint / Format | 无 |
| CI / CD | 无 |
| 代码风格 | 人工维护 |

欢迎为以上任意一项贡献基础设施。
