# P7 产品化 UI 审计

> 审计日期：2026-07-29  
> 最近落实：2026-07-30  
> 审计对象：Vite 页面内 ElfUI DevTools  
> 模式：保留式产品重构  
> 设计参数：`DESIGN_VARIANCE 3`、`MOTION_INTENSITY 2`、`VISUAL_DENSITY 8`

## 1. 产品判断

这是面向 ElfUI 框架作者的高密度开发工具，不是营销页、低代码编辑器或通用聊天应用。界面应接近浏览器
DevTools 和 IDE：结构稳定、状态明确、键盘优先、信息密度高，同时保持 Visual Draft 与业务页面的清晰边界。

本轮不更换信息架构，不引入新的 UI 框架，也不改动现有 `data-elfui-devtools`、ARIA、Pipeline kind 和安全协议。
优先通过语义 token、状态层级、焦点、主题和响应式规则做渐进式产品化。

## 2. 当前基础

### 应保留

- Components、Timeline、Compiler、Pipeline 四个主视图及其键盘 tab 行为。
- App、主题、停靠、全屏和关闭等宿主控制。
- Visual Draft 的橙色语义、AI/Pipeline 的蓝色语义，以及成功、警告、失败状态颜色。
- Inspector、Visual Draft、AI、Patch、verification 和 visual review 的稳定 `data-*` 选择器。
- 640×720 浮动面板、左右/底部停靠和 390px 单列响应式能力。
- 用户批准后才写文件，以及 Patch、验证、回滚、结果核对的现有顺序。

### 当前可验证能力

- Header、Tab、Tree、Dialog 和 Resize Handle 已有基础 ARIA 语义。
- Tab 支持左右方向键、Home 和 End。
- Inspector 和 Visual Draft 有快捷键。
- 主题、停靠位置、当前 App 和主视图会保存。
- AI 会话具备 loading、empty、error、cancelled、failed、completed 和 retry 状态。
- 真实 Chromium 已覆盖 390×844 与 1440×1000 的主要多轮流程。

## 3. 缺口与风险

| 优先级 | 区域       | 当前问题                                                                                  | 产品风险                                                 | 完成标准                                                                                      |
| ------ | ---------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| P0     | 主题       | CSS 主要写死为暗色，仅少量选择器有亮色覆盖，AI、Patch、review 在亮色主题中仍是暗色岛      | 亮色主题名义可选但视觉层级不完整                         | 所有主要表面、文字、边框、控件和状态使用语义 token，亮暗主题均通过截图检查                    |
| P0     | 键盘焦点   | 面板没有统一 `:focus-visible` 样式                                                        | 键盘用户无法可靠判断焦点                                 | 所有 button、select、input、textarea、summary、treeitem 和 resize handle 有一致的高对比焦点环 |
| P0     | 状态反馈   | 多个局部状态散落在 Provider、source、Patch 和 verification 区域，缺少贯穿工作流的当前位置 | 用户难以判断当前处于草稿、请求、方案、应用、验证还是核对 | AI 区显示稳定的工作流状态，状态变化不依赖颜色单独表达                                         |
| P1     | 启动工具栏 | `E`、`⌖`、`✎` 仅靠 glyph 和 tooltip，命中面积为 34×28                                     | 初次使用不易理解，触控目标偏小                           | 统一 36px 以上命中区、可见 active 状态、可理解 tooltip/ARIA，保持三入口结构                   |
| P1     | Header     | 5 个控制项紧密排列且没有可见标签，移动端占两行                                            | 配置层级压过主任务                                       | 保留全部能力，将低频设置收束到明确的宿主设置区域，移动端不挤压标题                            |
| P1     | AI Panel   | Provider 配置、治理、执行、Patch、截图、核对和消息位于同一长滚动流                        | 高频动作与低频配置竞争注意力                             | Provider 配置可折叠，当前执行/审批动作优先，历史轮次与消息具有稳定分组                        |
| P1     | Diff       | Diff 位于 Proposal 内部 `details`，最大高度 280px，并嵌套横向滚动                         | 长 Diff 审核上下文不足，移动端操作拥挤                   | 建立不修改协议的 Diff Drawer，支持文件/摘要上下文、关闭、焦点恢复和移动端全屏                 |
| P1     | 缩放       | 只有面板尺寸，没有 UI 密度或文字缩放设置                                                  | 高 DPI 和小屏下可读性受限                                | 提供有界缩放档位并保存；布局和命中区不因缩放溢出                                              |
| P1     | 减少动画   | 没有统一的 `prefers-reduced-motion` UI 规则                                               | 后续状态过渡容易产生无障碍回归                           | 所有非必要过渡在 reduce 下禁用；Visual Intent 的 reduced-motion 语义保持不变                  |
| P2     | 状态播报   | 多处 `role="status"` 在重渲染时被整体替换，没有统一 live region                           | 屏幕阅读器可能漏掉长流程状态                             | 只对关键、去重后的状态使用稳定 live region，避免重复播报文本流                                |
| P2     | 视觉回归   | 当前截图覆盖业务流程，但还没有主题、缩放、空/错/加载状态矩阵                              | 产品化改动缺少稳定视觉基线                               | 建立桌面/移动、亮/暗、默认/减少动画的关键状态截图矩阵                                         |

## 4. 实施顺序

1. 建立面板语义颜色、字体、间距、圆角和焦点 token，完整修复亮暗主题。
2. 增加统一焦点环和减少动画规则，并补键盘/主题真实浏览器门禁。
3. 增加 AI 工作流状态条，明确草稿、请求、方案、批准、验证和核对状态。
4. 收束 Provider 配置和历史轮次层级，保持现有稳定选择器和执行协议。
5. 实现 Diff Drawer，先复用现有不可变 Proposal 数据，不改变 Patch 审批请求。
6. 产品化 launcher、Header 和缩放设置。
7. 建立视觉回归矩阵、长时间运行/内存门禁和安全审计。
8. 完成 Vite 页面内 Alpha 的发布配置和使用文档。

## 5. 第一批验收范围

第一批先处理主题与焦点，因为它们影响所有现有功能但不改变协议：

- `system`、`light`、`dark` 三种主题继续兼容原存储结构。
- 暗色外观不发生非预期层级退化。
- 亮色下 AI、Patch、Diff、截图对照、review 和消息不再保留暗色背景。
- 键盘焦点在暗色和亮色下都清晰，且不改变鼠标点击后的视觉噪声。
- `prefers-reduced-motion: reduce` 下禁用面板非必要过渡。
- 1440×1000 和 390×844 亮暗主题截图通过人工检查。
- `pnpm verify` 与 `pnpm test:browser` 全部通过。

## 6. 第二批验收结果：AI 工作流状态

- 已增加草稿、请求、方案、批准、验证和视觉核对六阶段状态条。
- 当前阶段由既有 request、execution、Patch catalog、verification 和 result screenshot 派生，不新增或修改
  Provider、Patch、approval、verification 协议字段。
- 状态不仅依赖颜色：同时显示阶段文本、完整步骤列表、稳定 `data-stage` 和 `aria-live` 摘要。
- 桌面使用 6 列，390px 移动端改为 3×2，亮色和暗色均无横向溢出。
- `VITEST_MAX_WORKERS=1 pnpm verify` 通过 31 个文件、182 项测试；`pnpm test:browser` 通过 47 条真实
  Chromium 检查。
- 人工检查截图：
  - `output/playwright/p7-workflow-light-desktop.png`
  - `output/playwright/p7-workflow-dark-desktop.png`
  - `output/playwright/p7-workflow-light-mobile.png`
  - `output/playwright/p7-workflow-dark-mobile.png`
