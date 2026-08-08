# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/) 格式，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.2.0] - 2026-08-08

### 新增

- **布局优化**：窄窗口自适应（避免横向/纵向滚动条），侧栏折叠状态持久化
- **主题系统**：浅色 / 深色切换与持久化
- **输入区优化**：内容溢出时自动增高并显示滚动条，配置与操作按钮合并为统一卡片布局
- **快捷键优化**：改善发送用户消息的键盘快捷键

### 修复

- 重启后 OMP 状态始终显示"未检测"的问题
- Fork 失败后 usageBySession 残留占位 session 条目
- Fork 后 session 标题与历史记录缺失的问题
- 窗口缩窄时出现横向与纵向滚动条的问题
- ProjectPane 会话菜单被 `overflow: hidden` 裁剪导致不可见
- ProjectPane 折叠/展开会话时滚动条位置不稳定，优化滚动条稳定性、交互细节与视觉间距
- 回合结束时冗余的消息显示
- Markdown 代码块与表格配色
- 同步 omp CLI 至 v17.2.9

## [0.1.0] - 2026-07-15

### 新增

- **三栏工作台布局**：左侧全高项目栏 + 中间对话区 + 右侧上下文栏，支持折叠/展开/拖拽调宽
- **富内容对话**：文本 + 图片粘贴/拖入发送，slash 命令面板，计划与工具调用结构化卡片渲染
- **多 session 隔离**：按 sessionId 分桶管理消息流、权限弹窗、elicitation 请求
- **session 生命周期**：新建 / 加载 / 恢复 / Fork / 关闭 / `/resume` 同步
- **VS Code 风格 diff 审查**：单栏行内增删高亮，本地 Git 分支列表查看与切换
- **ACP 协议接入**：
  - 权限审批弹窗（`session/request_permission`）
  - elicitation 表单弹窗（按钮/确认/输入框，含 plan mode 方案预览）
  - questionnaire 表单弹窗（多字段动态表单，submit/cancel/decline）
- **Config 选择器**：模型 / 模式 / 推理强度，草稿会话暂存机制
- **会话审批策略**：always-ask / write / yolo 三档运行时切换
- **项目组织**：置顶 / 取消置顶、展开/折叠、拖拽调宽、自定义显示名、移除项目
- **全局会话搜索**：`Ctrl+K` / `⌘+K` 唤起弹窗，按项目/会话/Prompt 多维度搜索
- **omp 可执行文件路径设置**：支持自定义指定 omp CLI 位置
- **SegmentSelect 统一配置段落下拉组件**
- **底栏状态指示**：执行目录路径 + diff 状态 + 保存状态
