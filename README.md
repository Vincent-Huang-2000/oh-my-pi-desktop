# oh-my-pi Desktop

oh-my-pi 的桌面客户端，指挥你的Ai模型去干活吧！

你只需要负责描述需求，agent 负责执行：它会在 `omp acp` 子进程中读写文件、运行命令、审查 diff、管理 Git 分支。每个敏感操作都会先征求你的同意，所有改动看得见、可回退。

当前版本 `0.1.0`，面向 Windows 平台。

## 功能特性

- **三栏工作台**：左侧项目管理、中间对话、右侧代码审查与终端输出
- **对话驱动编码**：文本 + 图片输入，slash 命令面板，计划与工具调用卡片
- **多会话并行**：同时推进多个任务，消息与审批弹窗互不干扰
- **会话管理**：新建、恢复、复制（Fork）、关闭，`Ctrl+K` 全局搜索历史会话
- **代码审查**：VS Code 风格 diff 高亮，本地 Git 分支查看与切换
- **安全可控**：敏感操作先征求同意，审批策略三档可选，模型与推理强度随时切换

## 前置依赖

- **Node.js** >= 22.12.0（Electron 42 要求）
- **omp CLI**（已在 `v17.2.9` 上验证）— [oh-my-pi](https://github.com/can1357/oh-my-pi) 的命令行工具，需确保 `omp acp --help` 可正常执行。当前桌面端使用的omp非原版omp，后续会考虑开源。原版omp ACP存在一些问题。原版omp能使用，但在PLAN模式下可能存在问题。

## 快速开始

```bash
# 安装依赖
npm install

# 启动开发模式（Vite dev server + Electron）
npm run dev
```

开发模式下 Vite 在 `127.0.0.1:5173` 提供热更新，Electron 窗口自动加载该地址。

```bash
# 构建生产产物
npm run build

# 运行构建后的应用
npm start

# 打包 Windows 便携版
npm run dist:win
```

## 架构

```
┌──────────────┐  preload bridge  ┌──────────────────┐
│   Renderer   │ ───────────────► │  Main process    │
│  (React 19)  │ ◄─────────────── │  (NodeNext TS)   │
│  App.tsx     │  agent:event     │  agentService.ts │
└──────────────┘                  └────────┬─────────┘
                                           │ spawn('omp', ['acp'])
                                           ▼
                                  ┌──────────────────┐
                                  │  omp acp child   │
                                  │  stdio JSON 行    │
                                  └──────────────────┘
```

- **主进程**：管理 agent 子进程生命周期、权限审批、状态持久化（JSON 文件）
- **渲染进程**：React 19 三栏 UI，通过 34 个 IPC 通道与主进程通信
- **agent 子进程**：`omp acp`，通过 stdio JSON-RPC 与主进程交互

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面框架 | Electron 42 |
| 前端 | React 19 + TypeScript 5.9 |
| 构建 | Vite 7 |
| Markdown 渲染 | react-markdown + remark-gfm + rehype-highlight |
| 打包 | electron-builder（Windows portable） |

## 目录结构

```
src/
├── electron/                 # 主进程
│   ├── main.ts               # 应用入口
│   ├── window.ts             # BrowserWindow 工厂
│   ├── preload.ts            # contextBridge（34 invoke + 1 事件通道）
│   ├── ipc.ts                # IPC handler 注册
│   ├── agentService.ts       # agent 子进程管理与 JSON-RPC 解析
│   ├── agentPlan.ts          # ACP plan 事件解析
│   ├── agentQuestionnaire.ts # ACP questionnaire 表单处理
│   ├── agentUtils.ts         # agent 辅助工具
│   ├── agentTypes.ts         # agent 类型定义
│   ├── state.ts              # JSON 持久化
│   ├── command.ts            # 通用子进程执行器
│   └── types.ts              # 主进程类型定义
├── renderer/                 # 渲染层
│   ├── main.tsx              # React 入口
│   ├── App.tsx               # 根组件（三栏布局 + 状态管理）
│   ├── components/           # UI 组件（TopBar / ProjectPane / ChatWorkspace / 各弹窗等，同名 .css 配套）
│   ├── hooks/                # 业务逻辑 hooks（useAppCore / useAgentEvents / useSessionLifecycle 等）
│   ├── lib/                  # 纯逻辑模块（slashCommands / paneLayout / attachments / messageMerge 等）
│   ├── highlight-themes/     # 代码高亮主题
│   ├── types.ts              # 渲染层类型定义
│   ├── utils.ts              # 工具函数
│   ├── diffParser.ts         # Git diff 解析器
│   └── styles.css            # 全局样式
└── vite-env.d.ts             # 跨进程共享类型（需与 electron/types.ts 同步维护）
```

## 开发

```bash
npm run dev       # 开发模式
npm run build     # 类型检查 + 构建
npm start         # 运行构建产物
npm run preview   # 仅渲染层预览
```

修改公共类型时注意：`src/electron/types.ts` 与 `src/vite-env.d.ts` 中的同名类型需同步更新。

## 许可证

本项目基于 [MIT 协议](LICENSE) 开源。
