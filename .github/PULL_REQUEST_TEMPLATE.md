## 改动说明

<!-- 简要描述本次 PR 做了什么 -->

## 改动类型

- [ ] Bug 修复
- [ ] 新功能
- [ ] 重构
- [ ] 文档
- [ ] 其他

## 自检清单

- [ ] `npm run build` 通过（tsc 类型检查 + vite 打包）
- [ ] `npm run dev` 启动后核心功能正常（消息流、权限弹窗、elicitation、diff 审查、config 选择器、slash 命令面板等）
- [ ] workspace 切换后 agent 在新目录下执行
- [ ] 多 session 隔离正常（消息/权限/elicitation 不串）
- [ ] 如果修改了 `src/electron/types.ts`，已同步更新 `src/vite-env.d.ts`
- [ ] 如果修改了 IPC 通道，已同步更新 `src/electron/ipc.ts` + `src/electron/preload.ts` + `src/vite-env.d.ts`

## 截图 / 录屏

<!-- UI 改动请附上前后对比截图 -->
