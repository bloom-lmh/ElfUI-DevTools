# ElfUI AI DevTools 当前交接

> 文档状态：持续更新  
> 最后更新：2026-07-30  
> 当前阶段：P7 AI 工作流状态已完成，下一步收束 Provider/历史层级与 Diff Drawer  
> 主计划：[`../plan/elfui-ai-devtools.md`](../plan/elfui-ai-devtools.md)

## 1. 目标

ElfUI AI DevTools 是 ElfUI 开发环境中的 AI 增强型 DevTools。它不是低代码编辑器，也不是给传统
DevTools 附加一个聊天框。产品目标是解决“很难用语言准确描述视觉修改”这一核心问题：

1. 先从 ElfUI Compiler Metadata、Runtime、组件树、模板节点、源码范围和 Diagnostics 中取得稳定事实。
2. 用户直接在真实页面上的虚拟画布完成选择、移动、缩放、样式、动效、标注和截图等操作。
3. DevTools 将这些操作冻结为 Provider 无关、可审计的 `AIChangeRequest`，准确引用目标元素、模板节点、
   源码和视觉关系。
4. AI 基于结构化请求生成可审核的修改方案和 `PatchProposal`。
5. 用户批准后，Node 侧才允许写入源码，并执行 formatter、typecheck、scoped tests、HMR 和运行时诊断。
6. 最终通过 before / desired / result 对照继续同一轮视觉会话。

必须始终保持以下边界：

- 虚拟画布只表达期望，不直接修改业务 DOM 或源码。
- 移动意图记录目标、容器和 `inside` / `before` / `after` 等关系，不机械生成绝对定位。
- Visual Intent 必须引用稳定的组件、模板节点和源码身份，不能只靠 class、文案或 DOM 猜测。
- 未经用户批准，AI 不能写文件；批准后仍需校验项目根、文件范围和文件 hash。
- API Key、无限制文件能力和完整敏感源码只能存在于 Node 侧，不能进入 Preview、RPC、Pipeline 或
  浏览器存储。
- 采集、上下文、AI 请求、Patch 和验证过程必须写入 Data Pipeline，保持可见和可审计。
- MVP 宿主是 Vite 页面内插件；浏览器扩展和 Tauri 不是当前前置条件。

当前仓库与版本基线：

- Framework：`E:\dev_projects\elfui-official\elfui`，当前基线 `0.1.0-beta.21`
- Docs：`E:\dev_projects\elfui-official\elfui-docs`
- DevTools：`E:\dev_projects\elfui-official\elfui-devtools`
- DevTools Protocol：v2

## 2. 已经做的工作

### P0：协议和可观测性地基

- 已完成 Protocol v2、RPC、能力握手、结构化错误和 Data Pipeline。
- 已完成 App/组件逻辑树、状态快照、生命周期、事件、响应式 Timeline。
- 已接入 Compiler Metadata、Diagnostics、Vite 初始快照和 HMR 增量。
- 已实现受项目根限制的 open-in-editor 和开发态注入。

### P1：AI-ready 传统 DevTools

- 已完成任意 ElfUI 模板节点 Inspector、组件树、搜索、折叠和详情联动。
- 已完成 open/closed Shadow Root 开发态观察通道。
- 已完成 HMR 选区恢复/失效、键盘与 ARIA、主题和面板状态持久化。
- 已完成 5,000 节点性能预算与真实 Chromium 门禁。

### P2：Visual Intent 与虚拟画布

- 已新增 `@elfui/devtools-visual-intent`，实现 `VisualTarget`、`VisualIntent`、Annotation 和
  Screenshot schema。
- 已完成 Overlay/Ghost/Annotation、移动、缩放、样式预览、截图和敏感区域遮罩。
- 所有预览均保持业务 DOM 不变，并把关键操作写入 Data Pipeline。
- 已完成 Visual Draft 历史、Undo、Clear、session storage、路由失效、HMR/DOM 重绑定。
- 已完成结构化 motion intent：`properties`、`trigger`、`durationMs`、`delayMs`、`easing`、
  `respectReducedMotion`；预览只绘制 DevTools overlay，不写业务 `transition`。

### P3：AI Context Builder 与只读会话

- 已实现 `AIContextBuilder` 和 Provider 无关的 `AIChangeRequest`。
- 已完成最小源码读取、显式额外 sourceId 审批、项目根限制、预算、脱敏和 omission/diagnostic。
- 浏览器提交执行前会移除源码正文；Node Gateway 根据 Compiler State 和批准范围重新读取、校验并脱敏。
- 已新增 `@elfui/devtools-ai`，包含 explain/plan/implement 会话模型、消息、附件、稳定引用、
  有界存储和孤立附件清理。
- 已完成只读执行事件：started、text-delta、completed、cancelled、failed。
- 已完成 explain/plan 流式输出、取消、重试、失败恢复、HMR 重绑定和 Pipeline 审计。
- P3 默认使用确定性 Mock Provider；P4 虽已提供外部适配器，但默认配置仍不读取 API Key、不访问真实模型，
  implement 执行和文件写入也仍未开放。
- `summarizeAIChangeRequest()` 可稳定复述 target ID、tag/text、component/sourceId/templateNodeId/range、
  几何、关系、style、resize、remove/duplicate、motion 和 annotation。
- 已建立 50 条视觉意图理解 fixture：
  - 10 条 style
  - 10 条 move/relation
  - 8 条 resize
  - 4 条 remove/duplicate
  - 10 条 motion
  - 8 条 annotation/source-reference

### P4：Provider Adapter（已完成退出审计）

- 已定义 `AIProviderCapabilities`、Provider/Model descriptor、公开设置、required/preferred
  requirements 和 supported/downgraded/rejected capability negotiation。
- 已实现 `AIProviderRegistry`，支持默认 Provider、显式 Provider/Model、手动 Model ID 能力和安全的
  descriptor 白名单复制。
- Gateway 已支持公开 Provider 选择与设置校验；`apiKey` 等非白名单字段会在调用 Provider 前被拒绝。
- Provider 切换不修改 `AIChangeRequest`；Node 会根据请求内容自行推导能力需求。
- 已实现 OpenAI-compatible Responses SSE Provider：
  - 处理 `response.output_text.delta` 和 `response.completed`
  - 支持 Node 私有 API Key getter、注入 fetch、endpoint、超时和可选 screenshot resolver
  - 支持 temperature、reasoning 和 max output 的已校验传递
  - 支持 HTTP 鉴权错误、429、连接失败、超时、乱序、断线和不完整流的结构化错误
- Provider Key 只保存在 Node Provider 闭包中；descriptor、Client 请求、Pipeline 和错误文本不包含明文 Key。
- Vite 插件已支持 `readonlyAIProviders` 和 `readonlyAIDefaultProviderId`，旧的单 Provider 选项仍可使用。
- 当前默认仍为本地确定性 Mock Provider，不会自行读取环境变量或访问外部模型。
- 已实现非 OpenAI-compatible 的 `AnthropicMessagesProvider`，使用 Messages 风格请求和事件协议；模拟测试覆盖
  文本流、图片输入、temperature、max output、timeout、鉴权错误、429、网络失败和不完整流。
- Gateway 已提供 token 保护、`no-store` 的只读 Provider catalog endpoint；返回安全复制的 descriptor、模型和
  capability，不返回 Key 或 Provider 私有配置。
- Client 已接入 Provider 选择、模型列表、手动 Model ID、能力提示、temperature、reasoning、max output 与
  endpoint；公开配置保存在专用 session state，重试会冻结上一轮 Provider 选择。
- Provider-neutral 流协议已支持 text delta、tool call、structured output 和 completed；Gateway 对工具名、参数、
  JSON 值与单事件大小进行校验。只读模式会审计 tool call，但绝不执行工具。
- 截图二进制通过独立、token 保护、`no-store` 的上传 endpoint 进入 Node；Node 校验 MIME、Base64、字节数、
  尺寸、白名单元数据及请求一致性，并以 32MB/64 项为上限在内存中临时保存。
- Provider 通过 Node 注入的受限 resolver 按 screenshot ID 读取二进制；`AIChangeRequest`、执行请求、Pipeline
  和会话附件仍只包含截图元数据或大小摘要。
- P4 退出标准全部通过：Provider 切换不修改 `AIChangeRequest`；不支持 image/tool/structured output 时 UI
  有明确提示；明文 Key 不进入 Client、Preview、RPC、Pipeline、descriptor 或错误文本。

### 最近验证结果

2026-07-29 的最新 P5 收口与 P6 轮次决策增量验证结果：

- `pnpm verify` 通过。
- Format、ESLint、Typecheck、六个 workspace 包构建和 dist ESM import 检查通过。
- Vitest 共 31 个测试文件、182 项测试通过；由于宿主机存在 300 多个旧 Chrome 自动化进程，本轮最终
  `pnpm verify` 使用 `VITEST_MAX_WORKERS=1` 限制并发。
- `pnpm test:browser` 通过，共 44 条真实 Chromium 检查。
- 5,000 节点虚拟化与搜索预算通过，并已纳入全量测试。
- 新增测试覆盖 Provider/Model 选择、vision 降级、强制能力拒绝、公开设置边界、
  `AIChangeRequest` 不变、秘密字段拒绝、Provider 错误脱敏、Provider catalog、Anthropic Messages 文本流、
  Responses SSE 分块、图片装配、tool/structured 事件、独立截图上传、元数据篡改/缺失、乱序、429、超时、
  断线和不完整流。
- P5 新增测试覆盖有界应用事务、显式/幂等回滚、formatter 后 hash 刷新、固定验证顺序、必需适配器缺失、
  HMR 超时、诊断脱敏、Provider 批准元数据隔离、默认不开放写入工具、批准后成功写入及 typecheck 失败回滚。
- Provider 配置 UI 已完成真实浏览器验证；1440x1000 桌面双列和 390x844 移动单列均未出现横向溢出、
  遮挡或控件截断：
  - `output/playwright/provider-config-desktop.png`
  - `output/playwright/provider-config-mobile.png`
- PatchProposal 审核 UI 已完成真实浏览器验证；Plan、假设、影响文件、验证计划、完整 Diff、批准状态和
  “文件未应用”审计在 1440x1000 与 390x844 视口均可读：
  - `output/playwright/patch-proposal-approved-desktop.png`
  - `output/playwright/patch-proposal-approved-mobile.png`
- Patch 应用与验证 UI 已完成真实浏览器验证；“已应用并验证”、固定检查摘要和用户撤销入口在
  1440x1000 与 390x844 视口均可读，未出现横向溢出、遮挡或控件重叠：
  - `output/playwright/patch-verification-verified-desktop.png`
  - `output/playwright/patch-verification-verified-mobile.png`
- P6 result screenshot 状态已完成真实浏览器验证；结果元数据、重新捕获和用户撤销入口在 1440x1000 与
  390x844 视口均可读：
  - `output/playwright/result-screenshot-desktop.png`
  - `output/playwright/result-screenshot-mobile.png`
- P6 before / desired / result 对照已完成真实浏览器验证；桌面端按三列显示，移动端按单列堆叠，阶段、
  截图 ID、范围和尺寸均可读且没有横向溢出：
  - `output/playwright/screenshot-comparison-desktop.png`
  - `output/playwright/screenshot-comparison-mobile.png`
- P6 显式结果核对已完成真实浏览器验证；未满足状态、稳定 intent ID、目标源码和核对控件在桌面与移动端
  均可读：
  - `output/playwright/visual-result-review-desktop.png`
  - `output/playwright/visual-result-review-mobile.png`
- P6 第二轮视觉修改已完成真实浏览器验证；第二轮关联、三张截图摘要、当前请求与上一轮 Patch/结果在桌面与
  移动端均可读，且历史轮次可重新激活：
  - `output/playwright/visual-follow-up-desktop.png`
  - `output/playwright/visual-follow-up-mobile.png`
- P6 AI 回复引用已完成真实浏览器验证；意图、文件和诊断引用在桌面与移动端均以可点击芯片显示，移动端会
  自动换行且没有横向溢出；annotation 引用和失效引用路径由单元测试覆盖：
  - `output/playwright/ai-reply-references-desktop.png`
  - `output/playwright/ai-reply-references-mobile.png`
- 1440x1000 桌面和 390x844 移动视口截图已人工检查：
  - `output/playwright/motion-controls-desktop.png`
  - `output/playwright/motion-ai-desktop.png`
  - `output/playwright/motion-controls-mobile.png`
  - `output/playwright/motion-ai-mobile.png`
  - `output/playwright/motion-overlay-mobile.png`
- 截图验证发现并修复了三个真实问题：
  - HMR 位置比较误用精确 CSS 小数字符串。
  - demo reload 复用上一轮 Visual Draft。
  - Inspector overlay 在窄屏遮挡面板。

### P5：Agent Gateway（已完成退出审计）

- 已新增 Agent Protocol v1，固定 `project.search`、`source.readRanges`、`source.readFile`、`patch.prepare`、
  `patch.applyApproved`、checks、HMR 和 diagnostics 共 10 个工具名称；不接受任意 shell 工具或命令。
- 已定义并校验 `PatchProposal`、`PatchApproval`、affected files、SHA-256 base file hashes、统一 Diff、风险和
  结构化验证计划；文件、hash 和验证 scope 必须完全对应。
- 已实现只读 `project.search`、`source.readRanges`、`source.readFile`：仅访问 Compiler State 中且当前请求批准的
  sourceId，继续复用项目根和符号链接逃逸防护，并执行脱敏、文件数、结果数和字符预算。
- 源码读取由 Node 对完整文件计算 SHA-256；Proposal store 会严格解析统一 Diff 的文件头与 hunk 行数，并把
  Diff files、affected files、批准 scope 和真实基线 hash 做完全交叉校验。存储和读取都返回不可变副本。
- 当前提案层只允许修改现有文本文件；rename/copy/create/delete/binary diff、绝对路径与路径穿越都会被拒绝。
- 已建立请求级 Agent session 和 Provider-neutral tool loop：每个 tool call 都重新通过 Agent Protocol 白名单、
  参数 schema、当前 `AIChangeRequest` 批准范围和 workspace root 校验；限制 8 轮、20 次调用、单轮 8 次调用，
  并分别限制 Provider 输出和工具结果字符预算。
- Gateway 已接入 `project.search`、`source.readRanges`、`source.readFile` 与 `patch.prepare`；完整工具结果只在
  Node 与 Provider 之间传递，Client 和 Data Pipeline 仅接收不含源码正文的调用状态摘要。
- `patch.prepare` 已接入只读 Proposal store；集成测试覆盖“读取批准源码 → 使用真实 hash 准备 PatchProposal →
  Provider 继续输出”的三轮流程，并验证源码秘密不进入浏览器、文件内容不发生变化。
- plan 模式的 tool calling/structured output 偏好和截图 image input 偏好由 Node 根据执行模式与
  `AIChangeRequest` 自行推导，不信任浏览器声明。
- 全部 10 个工具都已有唯一的下划线 wire name、说明和 JSON Schema；Provider 事件会反向映射为内部固定名称，
  未知名称仍由 Agent Protocol 拒绝。
- OpenAI-compatible Responses 已接入 function tools、`function_call/function_call_output` 历史与
  `response.output_item.done`；Anthropic Messages 已接入 `input_schema`、`tool_use/tool_result` 和流式
  `input_json_delta`。两套适配器均通过注入 `fetch` 的请求体与 SSE 模拟测试，不依赖真实 Key 或外网模型。
- Agent session 现在向下一轮 Provider 传递全部有序 tool exchange，而不只传上一轮结果；多轮源码读取、提案
  准备和后续说明可以保持调用 ID 与结果关系。
- Gateway 已提供 token 保护、`no-store` 的 PatchProposal catalog 与 decision endpoint。浏览器只提交 Proposal ID、
  request ID、decision 和可选 comment，无法提交或伪造 Proposal 正文、Diff、批准文件或 hash。
- Proposal ID 与内容不可变；相同内容重试幂等，不同内容复用 ID 会失败。Node 在批准时重新校验当前 SHA-256，
  并从已存 Proposal 派生精确 approved files/hash；批准、拒绝和带评论退回都是终态。
- Plan UI 会按 summary、assumptions、影响文件、验证计划、完整统一 Diff 的顺序展示提案；退回修改要求非空
  评论。决策写入 Data Pipeline，并明确记录 `applied: false`。
- 真实 Chromium 已走通“Plan → source.readFile → patch.prepare → Proposal 审核 → 评论 → 批准”，同时断言
  批准前后 `src/BrowserGate.ts` 字节完全一致且不存在 `patch.apply` Pipeline 记录。
- 已实现 Node-only `createApprovedPatchApplier`：重新验证 request/proposal/approval ID、精确批准文件、批准 hash、
  Compiler source scope 和磁盘 SHA-256，并逐行匹配统一 Diff 上下文；多 hunk 会保留 LF/CRLF 和末尾换行。
- 多文件应用会保留原内容快照；任一写入或写后 hash 校验失败时按逆序恢复所有已尝试文件，并复核原始 hash。
  测试覆盖成功应用、伪造 approval ID/hash、批准后外部修改、第二文件写入失败和完整恢复。
- 应用事务使用有界内存保存原内容、before/after hash 和 application ID。formatter 修改后会刷新 after hash；
  回滚前复核当前 after hash，拒绝覆盖外部后续修改，并对同一 application ID 保持幂等。
- 已实现 Node-only `PatchVerificationCoordinator`，固定执行 format、typecheck、test-scoped、可选 build、HMR、
  diagnostics；模型不能传入命令、改变顺序或跳过必需步骤。适配器具有固定超时、输出/诊断上限和秘密脱敏。
- 任一必需验证失败、抛错、超时或缺少适配器都会自动恢复同一事务的原文件，并保留安全的检查、诊断和回滚
  摘要；formatter 已产生的变化也包含在回滚范围内。
- Vite 插件已提供可选 `patchVerification` Node 配置。只有显式配置验证适配器、plan 模式、同 request 存在
  Node 记录的用户批准且 Provider 支持 tool calling 时，`patch.applyApproved` 才进入该次 Agent
  `availableTools`；默认配置在批准后仍保持只读。
- Provider 只接收 Node 派生的 proposal/approval/request ID、摘要和影响文件。OpenAI-compatible 与 Anthropic
  都已映射 `patch_apply_approved`；完整工具结果只在同一 Node 会话返回 Provider。
- 已定义浏览器安全的 `patch-verification` 事件。Client 和 Data Pipeline 只记录 application/verification/
  proposal/request ID、文件路径、before/after/restored hash、固定检查摘要、HMR、受限 diagnostics 和回滚状态，
  不记录源码正文或 Provider 私有数据。
- Proposal UI 已区分“已批准（尚未应用）”“已应用并验证”“验证失败（已回滚）”和“已由用户撤销”；批准动作
  本身仍不写文件，用户必须再次显式执行已批准 Patch。
- Gateway 会阻止同一 Proposal 的并发或重复应用；成功验证后不再向后续 Provider 会话提供该 Patch，只有完成
  用户撤销后才重新开放显式执行。
- 已实现 token 保护的 ID-only 用户撤销 endpoint。浏览器只提交 application/verification/proposal/request ID；
  Node 只允许撤销当前已验证事务，撤销前复核 after hash，外部编辑会返回 409 且不会被覆盖。撤销成功后可以
  在新的 hash 校验下重新应用。
- Gateway 集成测试和真实 Chromium 已覆盖批准后的成功写入、Vite watcher/HMR、用户撤销、撤销后重试和
  typecheck 失败自动回滚，并验证默认配置不开放写入工具、浏览器审计不泄露源码正文。

### P6：结果对照与多轮视觉会话（已完成）

- 已复用现有 `ScreenshotPhase` 的 `result` 类型，在 Patch 验证成功后提供显式“捕获结果截图”入口；需要用户
  手势的浏览器不会在异步验证事件中擅自弹出屏幕共享提示。
- result screenshot 会关联 request/proposal/application/verification ID，以及原请求中 before / desired
  screenshot ID；关联记录以 `visual.result.capture` 写入 verification 阶段的 Data Pipeline。
- Pipeline 只保存 screenshot 元数据、关联 ID 和字节大小摘要，不保存 data URL 或二进制正文。
- result screenshot 与 desired Visual Draft 分离保存，不会把应用结果误写成用户期望；重新捕获会替换当前
  verification 的结果资产，新的 Patch verification 会清除旧的当前结果关联。
- Proposal UI 会显示 result phase、截图范围、尺寸、截图 ID 和关联的 before / desired 数量，并提供重新捕获。
- Proposal UI 已新增三阶段截图对照：只展示 result 所属请求中与 `sourceScreenshotIds` 对应的最新 before /
  desired 和当前 result，避免跨轮串图；本地二进制被释放或某阶段未捕获时显示明确缺失态。
- 对照图片的数据 URL 只用于当前 Preview DOM 渲染；Data Pipeline 仍只保存截图元数据、关联 ID 和字节摘要。
- 桌面端对照为三列，390px 移动端切换为单列堆叠，没有横向溢出。
- 单元测试覆盖 detached result capture、稳定关联、三张图片渲染与二进制正文隔离；真实 Chromium 覆盖
  before/desired 捕获和 verified Patch 三阶段对照。
- `@elfui/devtools-ai` 已新增 Provider 无关的 `AIVisualResultReview`，将每个 intent 和非 redaction annotation
  绑定为 `unreviewed`、`met`、`partial` 或 `unmet`；redaction 只用于截图隐私，不作为实现目标。
- 结果截图捕获后会创建与 request/proposal/application/verification/result screenshot 全部关联的核对记录；
  重新捕获结果截图会建立新的核对证据并重置旧状态。
- 当前状态来源是用户显式核对，而不是让 Node 自动检查冒充视觉判断。UI 会高亮未满足和部分满足项，并明确
  提示“自动检查通过不等于视觉目标已经满足”。
- 创建和更新以 `visual.result.review.created` / `visual.result.review.updated` 进入 verification Pipeline，
  只记录稳定引用、状态和关联 ID，不记录截图 data URL 或 annotation 文本。
- `AIChangeRequest.followUp` 会携带上一轮 request/proposal/application/verification/review/result screenshot
  关联和未满足/部分满足的稳定引用；Node 会重新验证这些引用确实属于当前 Visual Draft，并拒绝外来、重复、
  已满足或越界引用。
- 第二轮请求保留原 Visual Draft 的 before / desired screenshot IDs，只把 detached result screenshot 作为第三张
  AI 输入截图加入请求；Pipeline 和会话记录继续只保留元数据，二进制仍经 Node-only screenshot resolver 读取。
- UI 提供显式“继续修改”入口并展示第二轮治理摘要；本地保存最多 6 轮请求，上一轮完整 Patch、验证、结果核对
  和撤销入口继续可见且可切换，不会在轮次切换时丢弃 Visual Draft。
- Provider 摘要会复述未满足项的稳定 ID、状态和 result screenshot ID；真实 Chromium 已验证第二轮执行、历史
  轮次切换、旧 Patch 撤销、撤销后重试和失败自动回滚仍能工作。
- `AIChangeRequest` 可携带最多 50 条、总计最多 20,000 字符的诊断上下文；Client 与 Node 都会限制来源范围并
  脱敏，超范围或超预算诊断只留下 omission/redaction 审计。
- Assistant message 不再预填当前请求的全部引用。Node 只会从 Provider 实际输出中识别当前 assembled request
  已存在的 intent、annotation、file 和 diagnostic ID，再发出 `ai.execution.reference`；外来或臆造 ID 不会成为
  可点击引用，Provider 自由文本也不能伪造引用标签。
- 回复引用会以有界芯片显示；intent/annotation 会追踪回 Visual Draft 目标，file/diagnostic 会定位已批准源码
  位置，追踪结果以 `ai.reference.trace` / `ai.reference.trace-missing` 写入 Pipeline。
- `@elfui/devtools-ai` 已新增 Provider 无关的 `AIVisualRoundDecision`，支持 `accept`、`partial-accept`、
  `revert` 和 `regenerate`，并关联 request/proposal/application/verification/review/result screenshot。
- 接受要求所有核对项均明确为 `met`；部分接受要求不存在待核对项，并且同时存在已满足和未解决项。记录决策后
  核对控件锁定，旧轮次仍可切换查看。
- 部分接受只把 `partial` / `unmet` 稳定引用带入新请求；接受不会再次写文件。回退复用 P5 Node 文件事务，
  只有原内容恢复成功后才记录 `visual.result.decision.revert`。
- 回退后可重新生成：全部原核对项会作为 `unmet` 带入新的 `AIChangeRequest`，同时保留 Visual Draft、三阶段
  截图关联和旧轮次审计；准备失败时仍可显式重试。
- 每个 proposal 最多保留 8 条轮次决策；新 result screenshot 或新 verification 会清除旧证据对应的决策。
  `visual.result.decision.*` 只记录动作、稳定引用状态和关联 ID，不保存图片二进制、源码正文或 annotation 文本。
- Client 会话存储明确限制为 2 个模式、每会话 100 条消息、每模式 6 轮请求和每 proposal 8 条决策；消息淘汰
  会删除孤立附件，请求淘汰会同步清理 Patch catalog、verification、rollback、result screenshot、review、
  decision、comment 和待处理集合。
- 异步 Patch catalog 返回前会重新确认 request 仍在保留集合中，防止迟到响应把已淘汰状态重新插入内存。
- 请求替换或历史容量淘汰会写入 `ai.conversation.retention`；该记录只含容量策略、稳定 request/proposal/
  screenshot ID，并明确标记不持久化源码正文和截图数据。结果截图失去所有保留关联后会从 Client 资产集合释放。
- Node 侧 execution 限制 50 项、screenshot 限制 64 项/32MB、proposal 限制 50 项，application transaction
  默认限制 20 项；只淘汰已经回滚的事务，仍可撤销的活动事务达到容量时失败关闭，避免静默丢失恢复能力。
- 会话审计保留边界已由单元测试和真实 Chromium 覆盖；`VITEST_MAX_WORKERS=1 pnpm verify` 通过 31 个测试
  文件、182 项测试，`pnpm test:browser` 通过 46 条真实 Chromium 检查。
- 真实 Chromium 已覆盖部分接受、第二轮执行、历史轮次切换、正式回退和重新生成入口；桌面与移动截图已人工
  检查，稳定 ID 正常换行且没有横向溢出、遮挡或控件重叠：
  - `output/playwright/visual-round-decisions-desktop.png`
  - `output/playwright/visual-round-decisions-mobile.png`

### P7：产品化与稳定化（主题、焦点和工作流状态已完成）

- 已完成第一轮产品 UI 审计，明确保留式重构边界、P0/P1/P2 缺口和实施顺序，详见
  [`../audits/p7-product-ui.md`](../audits/p7-product-ui.md)。
- 现有 Components、Timeline、Compiler、Pipeline 信息架构、ARIA、快捷键、稳定 `data-*` 选择器、Patch/
  verification 协议和安全边界均保持不变。
- 面板主要表面、控件、AI/Patch/review 状态和 Visual Draft 已改用语义颜色 token；`system` 主题现在真正跟随
  `prefers-color-scheme`，显式 light/dark 继续兼容原有偏好存储。
- 亮色主题已覆盖 AI 会话、Provider、治理、Patch、三阶段截图、视觉 review、消息引用和状态按钮，不再出现
  亮色页面中残留整块暗色区的混合主题。
- 已加入统一 `:focus-visible` 焦点环和 `prefers-reduced-motion: reduce` 规则；这只控制 DevTools UI，
  不改变 Visual Intent 的 `respectReducedMotion` 字段。
- AI Panel 已增加六阶段工作流状态条，明确草稿、请求、方案、批准、验证和视觉核对的当前位置。状态只从现有
  request、execution、Patch catalog、verification 和 result screenshot 派生，未改动 Provider、Patch 或验证协议；
  同时提供稳定 `data-stage`、列表语义和 `aria-live` 摘要。
- 真实 Chromium 新增主题、键盘焦点和 AI 工作流状态检查，当前门禁为 47 项；单线程 `pnpm verify` 仍为 31 个文件、
  182 项测试。
- 亮暗主题截图已人工检查，包含 1440×1000 和 390×844：
  - `output/playwright/p7-light-desktop.png`
  - `output/playwright/p7-dark-desktop.png`
  - `output/playwright/p7-light-mobile.png`
  - `output/playwright/p7-dark-mobile.png`
- AI 工作流状态条已在滚入实际视区后单独完成亮暗主题截图检查；桌面为 6 列，390×844 移动端为 3×2，
  没有横向溢出或控件重叠：
  - `output/playwright/p7-workflow-light-desktop.png`
  - `output/playwright/p7-workflow-dark-desktop.png`
  - `output/playwright/p7-workflow-light-mobile.png`
  - `output/playwright/p7-workflow-dark-mobile.png`

## 3. 未做的工作（将要做的）

### 当前优先级：P7 产品化与稳定化

按以下顺序推进，不改变 P0-P6 已验证的协议与安全边界：

1. 将 Provider 配置和历史轮次从长滚动流中分层，保持现有稳定选择器和执行协议。
2. 实现不改变 Patch 协议的 Diff Drawer，支持焦点恢复、移动端全屏和长 Diff 审核。
3. 增加面板缩放、快捷键/触控命中区和完整视觉回归矩阵。
4. 增加长时间运行、内存、大项目与安全威胁模型/依赖审计。
5. 完成 Vite 页面内 Alpha 的发布配置、使用文档和退出门禁。
6. 收集真实使用反馈后，再决定是否评估浏览器扩展或 Tauri；它们不是 Alpha 前置条件。

### P5-P7

- P5：已完成受限 Agent Gateway、`PatchProposal`、Diff、用户批准、文件 hash、写入、检查、HMR 和回滚。
- P6：已完成 before / desired / result 对照、未满足意图提示、多轮视觉会话、轮次决策和有界审计。
- P7：已完成主题、语义 token、焦点、减少动画和 AI 工作流状态；待完成 Provider/历史分层、Diff Drawer、
  缩放、完整视觉回归、长期运行/内存、安全审计、Alpha 发布和可选宿主评估。

## 4. 当前问题

### 实现缺口

- OpenAI-compatible Provider 已实现但未作为默认 Provider，也不会自动读取环境变量；实际使用仍需在
  Vite Node 配置中显式构造 Provider 和 Key getter。
- Provider-neutral tool loop 和两种原生协议映射已经完成；出于能力协商安全，OpenAI-compatible 与 Anthropic
  的 tool calling 默认仍关闭，Vite Node 配置必须显式设置 `supportsToolCalling: true` 或为选定模型声明对应
  capability，DevTools 不会根据模型名称猜测能力。
- Proposal catalog、Client 审批 UI、决策记录、验证结果视图和用户撤销已经完成；批准动作本身仍只记录批准，
  不自动写文件。只有显式 `patchVerification` Node 配置下的后续 plan Agent 会话可以调用
  `patch.applyApproved`，implement 模式和普通浏览器请求仍不能直接写源码。
- formatter、typecheck、scoped tests、HMR 和 diagnostics 当前由项目在 Vite Node 配置中提供受限适配器；
  DevTools 没有内置任意 shell 或模型可控命令，也不会猜测项目命令。
- 当前统一 Diff 明确不支持新增、删除、重命名、复制或二进制文件；在安全应用和回滚闭环稳定前保持此限制。
- Agent 工具结果中的源码只允许回传给同一 Node 请求内的 Provider；浏览器事件仅包含 call ID、工具名、状态、
  输出字符数、脱敏错误和有界验证审计。后续新增 P6 UI 时不得把完整工具结果或源码正文写入 Pipeline。
- 截图资产只在当前 Vite Node 进程内存中临时保存，限制为 32MB/64 项；服务重启或被淘汰后必须由 Client
  重新上传，不能把它当成持久资产仓库。
- 已验证应用的原内容快照与用户撤销能力目前保存在当前 Vite Node 进程的有界内存中；服务重启后旧事务不能
  再通过 DevTools 撤销。P6/P7 需要决定是否增加 Git 集成或可恢复事务日志。
- P6 的统一保留/淘汰规则已经完成。Client 状态会随 Visual Draft 重置、页面/节点失效和容量淘汰清理；Node
  截图、执行、Proposal 和应用事务都是进程内有界状态。Data Pipeline 本身仍是当前页面内存审计，不是跨进程
  的合规日志或持久恢复仓库；若 P7 需要服务重启后恢复，必须另行设计脱敏事务日志或 Git 集成。
- 当前宿主机存在 300 多个由其他任务遗留的 Chrome 自动化进程。默认并发的 `pnpm verify` 曾出现一次 V8
  `Out of memory: HashMap::Initialize` / `spawn UNKNOWN`；代码用例没有断言失败。随后
  `VITEST_MAX_WORKERS=1 pnpm verify` 完整通过 31 个文件、182 项测试，`pnpm test:browser` 也完整通过
  47 条真实 Chromium 检查。继续测试时应关闭本任务创建的临时 Playwright session，避免放大宿主进程压力。
- 浏览器门禁 fixture 会在验证过程中真实写入并回滚同一个测试源码；多个浏览器 session 同时连接同一长驻服务时
  会互相干扰 HMR/hash 检查。正式门禁应保持单 session/单服务隔离；截图验证只截取 DevTools dialog，不把并发
  session 产生的页面级临时失败当作产品结果。

### 安全与架构风险

- API Key 必须只进入 Node Provider 的闭包或服务端配置，不能进入 Client bundle、Preview DOM、RPC、
  Data Pipeline、Provider descriptor、错误文本或浏览器存储。
- Node 必须根据 `AIChangeRequest` 自行推导 vision/tool/structured-output 需求，不能信任浏览器声明能力。
- 同页面 capability token 只能降低裸接口误用风险；Client 与业务页面仍在同一 JavaScript realm，
  不能把它当成强安全隔离。
- Provider 切换不得改变 `AIChangeRequest` 或未来的 Patch 协议。

### 仓库与版本问题

- 当前工作区有大量未提交的 P2/P3 改动以及新增文件。接手后必须先运行 `git status --short` 和
  `git diff --stat`；不得 reset、checkout、覆盖或重复实现现有工作。
- Framework 与 DevTools 开发依赖为 `0.1.0-beta.21`；Docs 发布依赖已对齐 `0.1.0-beta.21`，且本地 Docs
  开发优先使用 Framework dist。Docs 版本升级不属于当前 DevTools 写入范围。
- beta.17 已删除 `fragment`、`defineFragment()` 和相应 Compiler Metadata。P4 及后续不得继续把
  Fragment 当作 beta.18 的当前能力，只可在解析层保留必要的旧输入兼容。
- OpenAI 官方 Docs MCP 已通过
  `codex mcp add openaiDeveloperDocs --url https://developers.openai.com/mcp` 添加，但当前任务通常需要
  重启 Codex 后才会暴露对应工具；重启前只能使用 OpenAI 官方域名文档作为回退来源。

### 交接维护要求

- 每次开始工作先读本文件、主计划并检查 Git 状态。
- 每完成一个可验证阶段，立即更新“已做工作”“未做工作”和“当前问题”。
- 计划复选框只有在实现、自动化测试、真实 Chromium 门禁和必要截图都通过后才能勾选。
- 交接内容只记录可复现事实、失败命令和剩余风险，不写未经验证的完成声明。
