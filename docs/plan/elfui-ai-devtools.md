# ElfUI AI DevTools 实施计划

> 状态：实施中  
> 当前基线：ElfUI `0.1.0-beta.15`、DevTools Protocol v2
> 产品范围：ElfUI 开发环境中的传统 DevTools、视觉意图采集和 AI 辅助改码  
> 非目标：低代码编辑器、手势直接生成源码、任意网页编辑器、生产环境在线改码

## 一、产品定义

ElfUI AI DevTools 是传统框架 DevTools 的增强版。它先准确理解 ElfUI 应用，再让用户通过
截图、选择、临时样式、Ghost 移动、箭头和评论表达期望结果，最后由 AI 结合相关源码完成
修改。

核心闭环：

```text
ElfUI 源码
  -> beta.13 Compiler Metadata / Diagnostics
  -> Runtime / DevTools Bridge
  -> 组件树与元素 Inspector
  -> 视觉草稿、截图和标注
  -> AIChangeRequest
  -> AI Agent 生成代码 Patch
  -> 用户审核 Diff
  -> 应用 Patch、类型检查、HMR
  -> 对照视觉目标继续会话或接受结果
```

必须始终区分：

- **观察状态**：当前源码真实运行出来的页面。
- **视觉草稿**：用户通过画笔表达的期望结果，不是源码真相。
- **代码提案**：AI 根据视觉草稿生成的 Patch，未经批准不得落盘。
- **验证结果**：Patch 应用后重新编译、HMR 和运行得到的真实页面。

## 二、核心原则

1. DevTools 是观察和上下文事实源，AI 不通过截图猜测全部结构。
2. 画笔操作表达视觉意图，不直接决定 CSS、模板或布局实现。
3. 拖动不默认写入 `position: absolute`，也不直接移动业务 DOM。
4. AI 修改源码必须经过计划、Diff、批准、验证四个阶段。
5. 所有文件工具限制在 Vite 项目根目录，拒绝路径穿越和符号链接逃逸。
6. API Key 不进入 Preview 页面、业务运行时或浏览器 `localStorage`。
7. Metadata、Inspector、AI Bridge 和源码上下文只存在于开发构建。
8. 默认只向模型发送当前选区必要的截图和源码范围。
9. 模型 Provider 与代码工具解耦，切换模型不改变安全边界。
10. 第一版只适配 ElfUI，不为任意框架建立过度抽象。

### 2.1 宿主决策（已确定）

- MVP 采用 `@elfui/devtools-vite`，以页面内 DevTools 面板完成完整闭环。
- Vite Client 负责运行时、DOM 和交互；Vite Node 端负责源码、模型、Patch 和 HMR。
- 浏览器页面永远不能直接获得模型 Key 或无限制文件系统能力。
- Client、Protocol、Visual Intent 和 AI Engine 不与具体宿主耦合。
- Tauri 仅作为闭环成熟后的可选多项目控制中心，不是安装或使用前提。
- 暂不开发浏览器扩展；只有原生 DevTools 停靠成为明确需求时再评估。

### 2.2 数据管线可观察性（强制要求）

每增加一种采集或 AI 能力，必须同时在 **Data Pipeline / Protocol Lab** 中可见。用户应能查看
阶段、来源、协议版本、父子关系、诊断和完整序列化 payload，并能清空、复制、导出和重放。
不得存在只能从控制台猜测的隐藏中间结构。

## 三、当前基础审计

现有 `elfui-devtools` 已经具备：

- 版本化 RPC、能力握手和结构化错误。
- App/组件逻辑树、WeakRef 生命周期管理和多 App 基础。
- Props、Attrs、Setup、Expose 快照。
- Component、Reactivity、Events Timeline 基础。
- 页面 Inspector、Shadow DOM 遍历和组件高亮。
- 源码位置与受项目根限制的 open-in-editor。
- Vite 开发态注入，生产构建不加载客户端。
- `pnpm verify`、`pnpm test:large-tree` 与 `pnpm test:browser` 组成当前质量基线。

当前约束与下一阶段：

- 旧对比计划冻结保留；当前 README、fixture 和实施计划已同步 beta.15 API。
- Runtime source fallback 仍支持构造器 `__elfSource`，编译状态已消费 beta.15 Metadata v2。
- `@elfui/devtools-vite` 已接入 `onMetadata` / `onDiagnostics`、初始 endpoint 和 HMR 增量。
- 公开 npm 依赖已同步到 ElfUI beta.15；本地协议按 beta.15 registry-first 约定实现。
- P1 的 Fragment ownership、模板节点级源码身份、编译诊断、导航、键盘和 ARIA 已完成并纳入测试与 Chromium 门禁。
- 没有视觉意图、AI 会话、模型配置和 Patch 审核协议。

## 四、包与模块边界

保持现有 monorepo，不再维护独立 `elfui-ai-brush` 项目。

```text
packages/shared
  DevTools RPC、基础 ID、序列化、协议协商、PipelineRecord

packages/runtime
  App/组件/响应式观察、DOM 与运行时节点关联

packages/vite
  beta.13 metadata/diagnostics 接入、开发服务器、受限源码与 Agent 端点

packages/client
  传统 DevTools 面板、Inspector、视觉工具栏、AI 会话与 Diff UI

packages/visual-intent            # 新增
  VisualTarget、VisualIntent、Annotation、截图与草稿状态

packages/ai                       # 新增
  Provider Adapter、Context Builder、Agent Loop、Patch Proposal 协议
```

第一阶段不要拆分多个 Provider 包。等公共接口稳定后，再考虑
`@elfui/devtools-provider-*`。

## 五、三层协议

不要把所有能力塞进一个巨大协议，保持三层：

### 5.1 Compiler Metadata Protocol

由 ElfUI Framework 提供：

- `MacroComponentMetadata` schema v2。
- Props、Events、Slots、Expose、Models、Options。
- Fragment ownership、identity 和 source range。
- `onMetadata(metadata, id)`。
- `onDiagnostics(diagnostics, id)`。
- Compiler/Core/Vite Plugin protocol version。

### 5.2 DevTools Observation Protocol

描述当前正在运行的应用：

- App 和逻辑组件树。
- 组件状态、属性和生命周期。
- DOM/runtime node 与 source node 的关联。
- Binding/effect 因果关系。
- 编译器与运行时诊断。
- HMR revision 和连接状态。

### 5.3 AI Authoring Protocol

描述用户的目标和 AI 提案：

- VisualTarget。
- VisualIntent。
- Annotation。
- Screenshot Asset。
- AIChangeRequest。
- Conversation。
- PatchProposal。
- Approval。
- VerificationResult。

AI Authoring Protocol 只能引用 Observation Protocol 中的稳定 ID，不复制另一套组件树。

## 六、核心数据结构

### 6.1 源码目标

```ts
interface SourceNodeReference {
  sourceId: string;
  component?: string;
  fragment?: string;
  templateNodeId?: string;
  range: {
    start: number;
    end: number;
    line: number;
    column: number;
  };
}
```

### 6.2 视觉目标

```ts
interface VisualTarget {
  id: string;
  runtimeNodeId: string;
  componentId: string;
  source?: SourceNodeReference;
  tag: string;
  role?: string;
  textPreview?: string;
  geometry: RectSnapshot;
  computedStyle: Record<string, string>;
  props?: Record<string, unknown>;
  bindings?: BindingSummary[];
}
```

### 6.3 视觉意图

```ts
type VisualIntent =
  | {
      id: string;
      type: "style";
      targetId: string;
      before: Record<string, string>;
      desired: Record<string, string>;
    }
  | {
      id: string;
      type: "move";
      targetId: string;
      before: RectSnapshot;
      desired: RectSnapshot;
      relations: VisualRelation[];
    }
  | {
      id: string;
      type: "resize";
      targetId: string;
      before: RectSnapshot;
      desired: RectSnapshot;
    }
  | {
      id: string;
      type: "remove" | "duplicate";
      targetId: string;
    };
```

移动同时记录几何和语义关系：

```ts
interface VisualRelation {
  type:
    | "inside"
    | "before"
    | "after"
    | "left-of"
    | "right-of"
    | "align-with"
    | "near";
  targetId: string;
}
```

### 6.4 标注

```ts
interface VisualAnnotation {
  id: string;
  type: "comment" | "rectangle" | "arrow" | "highlight";
  targetIds: string[];
  text?: string;
  geometry?: RectSnapshot;
  from?: Point;
  to?: Point;
  createdAt: number;
}
```

标注优先锚定节点；无法锚定时才保留 viewport 坐标。

### 6.5 AI 修改请求

```ts
interface AIChangeRequest {
  schemaVersion: 1;
  id: string;
  conversationId: string;
  project: ProjectContextSummary;
  page: PageContextSummary;
  targets: VisualTarget[];
  intents: VisualIntent[];
  annotations: VisualAnnotation[];
  sourceContext: SourceContextBlock[];
  userMessage?: string;
  constraints: {
    preserveResponsiveLayout: boolean;
    preserveAccessibility: boolean;
    preservePublicAPI: boolean;
    allowedFiles?: string[];
  };
}
```

### 6.6 AI 提案与验证

```ts
interface PatchProposal {
  id: string;
  requestId: string;
  summary: string;
  assumptions: string[];
  affectedFiles: string[];
  unifiedDiff: string;
  validationPlan: ValidationStep[];
  risk: "low" | "medium" | "high";
}

interface VerificationResult {
  proposalId: string;
  format: CheckResult;
  typecheck: CheckResult;
  build?: CheckResult;
  hmr: CheckResult;
  runtimeDiagnostics: DevtoolsDiagnostic[];
  resultScreenshot?: AssetReference;
}
```

## 七、视觉工具规则

第一版工具栏：

```text
[选择] [画笔] [样式] [移动] [缩放] [矩形] [箭头] [评论] [截图]
[撤销草稿] [清空] [与 AI 对话] [让 AI 实现]
```

规则：

- **选择**：建立 VisualTarget，不改变页面。
- **画笔/样式**：使用独立 Preview CSS layer，仅产生 `style` intent。
- **移动**：使用 Ghost/Overlay，记录 desired rect 和关系，不直接移动业务 DOM。
- **缩放**：记录期望尺寸和约束，不写 inline width/height。
- **矩形/箭头/评论**：只进入 Annotation Layer。
- **截图**：保存完整 viewport 或选区裁剪，并记录 route、viewport、DPR 和 scroll。
- **撤销草稿**：只撤销 Visual Intent，不操作 Git 或源码。
- **让 AI 实现**：冻结当前上下文，生成 `AIChangeRequest`。

## 八、模型与 Agent 架构

### 8.1 Provider Adapter

```ts
interface AIProvider {
  id: string;
  listModels(): Promise<ModelInfo[]>;
  stream(request: ProviderRequest): AsyncIterable<AIEvent>;
  supports(capability: ModelCapability): boolean;
}
```

模型能力至少包括：

- text。
- vision。
- tool calling。
- structured output。
- streaming。
- context window。

首批 Provider：

- OpenAI。
- Anthropic。
- Gemini。
- OpenAI-compatible。
- 本地兼容服务。

MVP 允许使用一个模型完成规划和改码；稳定后再支持“视觉理解模型 + 编码模型”路由。

### 8.2 凭据安全

- Preview 和业务页面永远拿不到 API Key。
- Vite Client 只持有短期 session token。
- API Key 由本地 Node 服务、环境变量或未来系统安全存储管理。
- 日志、错误、截图 metadata 和 RPC 不得回显完整 Key。
- 发送截图和源码前显示 Provider、模型和上下文范围。

### 8.3 本地代码工具

模型不能直接拥有系统 Shell。Agent Gateway 提供受限工具：

```text
project.search
source.readRanges
source.readFile
patch.prepare
patch.applyApproved
checks.format
checks.typecheck
checks.testScoped
hmr.wait
diagnostics.read
```

所有路径 canonicalize 后必须位于项目根。`patch.applyApproved` 必须引用仍有效的
PatchProposal、文件 hash 和用户批准记录。

## 九、分阶段实施

## P0：beta.13 对齐与计划收口

- [x] 确定 Vite 插件为 MVP 宿主，Tauri 后置。
- [x] 建立 Protocol v2 PipelineRecord、pipeline RPC 和首个 Data Pipeline 面板。
- [x] 升级当前文档和真实编译 fixture 到 `@elfui/core@0.1.0-beta.13`。
- [x] 当前 README、代码和 fixture 不再使用旧 `html` tagged template 或旧生命周期 API；历史对比计划保持冻结。
- [x] `@elfui/devtools-vite` 接入 `onMetadata` / `onDiagnostics`，通过 endpoint 初始同步并由 HMR 推送增量。
- [x] 建立 Metadata v2 当前状态索引，使用 `sourceId` 作为文件主键。
- [x] 在 Compiler metadata 面板显示组件、Fragment ownership、source range 和编译诊断。
- [x] 为 Metadata schema、清空旧诊断、HMR 更新和 snapshot/HMR 竞态增加测试。
- [x] 将 DevTools Protocol 升级为 v2，并提供明确不兼容错误。
- [x] 使用桌面 `elfui-echarts-demo` 完成 beta.13 真实浏览器验收，覆盖 ECharts、命名 Fragment、Inspector、数据管线与编译元数据。
- [x] 修复发布产物相对 ESM import 缺少 `.js` 后缀的问题，并以 dist 公共入口导入检查作为构建门禁。
- [x] 修复 pnpm 严格依赖布局下虚拟客户端无法解析传递依赖的问题，并增加插件包入口解析回归测试。

退出标准：

- beta.13 fixture 可显示组件、Fragment 和诊断。
- DevTools 不再依赖旧 API 文档推断框架能力。
- 生产构建不包含 metadata client。

浏览器验收记录（2026-07-28）：

- ECharts 看板、DevTools 启动器和面板正常渲染，浏览器无错误与警告。
- Compiler metadata 显示 `SummaryCard` Fragment、owner component、source range 和 diagnostics。
- 源码变更后 endpoint revision 与 HMR 增量同步正常。
- Inspector 点选页面标题后生成 `target-snapshot · inspector/element.select` 管线记录，并关联到模板节点源码位置。

## P1：AI-ready 传统 DevTools

- [x] 完成导航、App selector、主题、最后 Tab 持久化。
- [x] 完成组件树折叠、搜索、选中联动和详情面板。
- [x] 为大规模组件树增加基础虚拟化。
- [x] Inspector 支持任意可定位模板元素，不局限 Custom Element host。
- [x] 建立 template node/source range/runtime node 的开发态关联。
- [x] 支持既有与后续创建的 open Shadow Root 观察边界。
- [x] 为 closed Shadow Root 建立框架级可观察通道。
- [x] 展示 Props、Attrs、Setup、Expose、Bindings、Source、Diagnostics。
- [x] 完成键盘检查模式、焦点管理和 ARIA。
- [x] 增加真实 Chromium E2E 门禁（`pnpm test:browser`）。
- [x] 增加 5,000 节点性能 fixture 和预算门禁。

阶段进展（2026-07-28）：

- 新增 `InspectorTargetSnapshot`，记录 DOM path、元素身份、组件归属和 `template-node` / `component` / `unresolved` 三档源码精度。
- Inspector 高亮具体内部元素，选择结果以 `inspector/element.select` 写入可观察 Data Pipeline 面板。
- ElfUI beta.15 使用全局 Symbol 定位的共享 WeakMap 作为模板节点与 closed render root 的权威存储；beta.14 节点/host Symbol 仅作为兼容镜像，DevTools 按 registry-first 顺序读取。
- 静态提升树通过开发态 clone helper 保留每个节点的 Symbol 信息；生产宏组件 bundle 已验证不包含标记字符串或 helper。
- 生成器使用紧凑位置参数传递调试信息；100 组件生产 codegen 为 200.5 KB min / 2.47 KB gzip / 1.09 KB Brotli，开发 codegen 另设 250 KB min 上限。
- 兼容扫描会递归进入既有 open Shadow Root，解决 DevTools 晚于组件挂载时只发现外层应用的问题。
- 桌面 ECharts fixture 真实验收显示 `<elf-app>` 与 `<elf-dashboard>` 两级组件，元素选择具备 `template-node` 精度，浏览器无错误或警告。
- 组件树按逻辑父子关系渲染，支持折叠、祖先保留搜索、选中态和 Props/Attrs/Setup/Expose/Source 详情联动。
- HMR 卸载/重挂事件按微任务合并；同 tag 与 source 的唯一替代组件会恢复组件和模板节点选区，无替代或多候选时会写入明确的 `selection.invalidate` 管线记录。
- closed Shadow Root 通过 `Symbol.for("elfui.devtools.render-root-registry")` 建立仅开发态权威通道，并兼容旧 host Symbol；Inspector 与兼容扫描可以进入，生产 Vite bundle 验证不包含两个 registry key。
- 组件树超过 300 行自动启用固定行高虚拟化；搜索和祖先展开改为迭代算法，5,000 节点 fixture 对初次渲染、实际 DOM 行数与搜索耗时设预算。
- 面板已增加 Components/Timeline/Compiler/Pipeline 导航、App selector、system/light/dark 主题和最后 Tab/App/主题持久化。
- Inspector hover 的布局读取已合并到 animation frame；`pnpm test:browser` 使用真实 Chromium 自动验证 25 次同步 hover 只触发 1 次布局读取，并覆盖 registry-only closed root 点选和 HMR `selection.restore`。
- 自动化真实 Chromium 门禁由 `fixtures/p1-browser-gate` 和 `scripts/verify-browser-gate.mjs` 提供。

退出标准：

- 在 elfui-docs Demo 中点选元素能定位准确组件和源码范围。
- Fragment 内节点能归属外层组件与原始 Fragment。
- HMR 后选区可恢复或明确失效。

## P2：Visual Intent 与标注

- [ ] 新增 `packages/visual-intent`。
- [x] 实现 VisualTarget、VisualIntent、Annotation schema 和序列化测试。
- [x] 实现 Overlay/Ghost/Annotation 三层画布。
- [x] 实现不修改业务 DOM 的 Ghost 移动预览，并将 target capture、move preview 和 annotation 写入 Data Pipeline。
- [ ] 实现样式 Preview CSS layer。
- [ ] 实现 Ghost 移动、缩放和语义关系候选。
- [ ] 实现矩形、箭头、高亮和评论。
- [ ] 实现 viewport/选区截图与敏感区域排除。
- [ ] 实现 Visual Draft 历史、撤销、清空和会话恢复。
- [ ] 页面导航、HMR 或节点消失时清理或重定位草稿。

阶段进展（2026-07-28）：

- 截图已建立 `before` / `desired` / `result`、viewport/selection、route、viewport、DPR、scroll、敏感区域排除和字节大小元数据；实际浏览器捕获通过可注入 adapter 隔离，二进制不会直接写入 Data Pipeline。
- Visual Draft 可关联多个截图 ID；矩形、箭头和高亮已进入独立 Annotation Layer，评论和实际截图 UI 仍待完成。

退出标准：

- 所有视觉操作只改变草稿层，不修改源码。
- 业务 DOM、事件、slot 和 MutationObserver 不因 Ghost 移动被破坏。
- 草稿可以完整序列化为 Provider 无关的数据。

## P3：AI Context Builder 与会话

- [x] 实现 `AIChangeRequest` schema。
- [x] 根据选区收集最小组件、Fragment、binding 和源码范围。
- [x] 关联 before screenshot、desired screenshot、intents 和 annotations。
- [ ] 实现上下文大小预算、脱敏和扩大范围审批。
- [ ] 建立 Conversation、Message、Attachment 和引用 ID。
- [ ] 实现流式文本、取消、重试和错误恢复。
- [ ] 支持“解释当前页面”“给出修改方案”只读模式。
- [ ] 建立 50 条视觉意图理解 fixture。

阶段进展（2026-07-28）：

- `AIContextBuilder` 会冻结当前 Visual Draft，去重目标源码引用，合并页面、项目和安全约束，并生成 Provider 无关的 `AIChangeRequest`。
- 面板可通过 “Prepare AI request” 显式冻结上下文；该动作只写入 `ai.context.bundle` 和 `ai.request.create` Pipeline 记录，不联系模型、不写文件。
- 截图二进制由内存资产控制器持有，Pipeline 和 AI 请求协议仅引用可审计元数据；Provider Adapter 后续按截图 ID 解析实际附件。

退出标准：

- 不输入长篇视觉描述，也能让模型准确复述用户目标。
- 模型能引用正确目标元素和源码文件。
- 默认上下文不包含项目外文件、环境变量和无关源码。

## P4：Provider 与模型配置

- [ ] 定义 Provider Adapter 和 capability negotiation。
- [ ] 实现 OpenAI-compatible Provider。
- [ ] 再实现至少一个非兼容 Provider，验证抽象没有绑定单一厂商。
- [ ] 实现模型列表、手动 Model ID 和能力提示。
- [ ] 实现 temperature、reasoning、max output 和 endpoint 配置。
- [ ] API Key 仅由本地安全后端持有。
- [ ] 支持文本/图片/tool call/structured output 降级。
- [ ] 增加模拟 Provider、流式乱序、限流、超时和断线测试。

退出标准：

- 切换 Provider 不改变 `AIChangeRequest` 和 Patch 协议。
- 不支持 vision/tool calling 的模型会得到明确能力提示。
- 客户端和 Preview 无法读取明文 Key。

## P5：AI Agent、Diff 与改码闭环

- [ ] 实现受限 Agent Gateway 和 workspace root 校验。
- [ ] 实现 source/search/read 工具。
- [ ] 实现 PatchProposal、文件 hash 和统一 Diff。
- [ ] AI 先返回计划和假设，再生成 Patch。
- [ ] 实现批准、拒绝和“带评论退回修改”。
- [ ] 应用前检查文件未被外部修改。
- [ ] 应用后执行 formatter、typecheck 和 scoped tests。
- [ ] 等待 HMR，收集 Runtime/Compiler diagnostics。
- [ ] 失败时恢复原文件并保留诊断。
- [ ] 支持基于 Git 或原内容快照的用户级撤销。

退出标准：

- AI 无法绕过批准直接写文件。
- 修改范围超出批准文件时请求失效。
- 应用成功后页面刷新并可继续同一视觉会话。
- 失败不会留下半应用 Patch。

## P6：结果对照与多轮视觉会话

- [ ] 捕获应用 Patch 后的 result screenshot。
- [ ] 在 UI 中并排显示 before、desired、result。
- [ ] 显示未满足的 annotation 和 intent。
- [ ] 用户可保留草稿继续第二轮 AI 修改。
- [ ] AI 回复引用具体 intent、annotation、file 和 diagnostic。
- [ ] 建立接受、部分接受、回退和重新生成流程。
- [ ] 记录会话审计，但默认不保存完整敏感源码。

退出标准：

- 用户能通过“画 → AI 改 → 看结果 → 再画”完成连续修改。
- 每轮修改和视觉目标之间具有可追踪关系。

## P7：产品化与可选宿主

- [ ] 完成工具栏、AI Panel、Diff Drawer 和状态反馈。
- [ ] 支持亮色、暗色、缩放、快捷键和减少动画。
- [ ] 建立视觉回归、长时间运行、内存和大项目测试。
- [ ] 完成安全威胁模型和依赖审计。
- [ ] 发布 Vite 页面内 Alpha。
- [ ] 根据真实使用决定是否增加浏览器扩展或 Tauri 独立客户端。

Tauri 不是 MVP 前置条件。只有 Vite 页面内闭环证明有价值后，才评估独立客户端。

## 十、测试与门禁

每个阶段必须包含：

- Schema JSON 往返与版本兼容测试。
- 协议非法输入和权限拒绝测试。
- 单元测试。
- 真实 ElfUI fixture。
- Chromium 浏览器 E2E。
- 生产排除验证。

关键安全测试：

- 项目根路径穿越。
- 符号链接逃逸。
- API Key 泄漏。
- 未批准 Patch。
- Patch 生成后文件发生变化。
- AI 请求读取无关敏感文件。
- Preview 页面伪造 Agent 请求。

关键性能预算：

- Inspector hover 合并到 animation frame。
- 5,000 节点树不做每帧全量扫描。
- Screenshot 和源码上下文按需生成。
- DevTools 关闭时不采集 Visual Intent 或 AI payload。
- Timeline 和 Conversation 使用有界存储。

## 十一、里程碑

| 版本          | 范围        | 用户价值                             |
| ------------- | ----------- | ------------------------------------ |
| `0.1.0-alpha` | P0–P1       | beta.13 可用的传统 ElfUI DevTools    |
| `0.2.0-alpha` | P2          | 可截图、标注和表达视觉目标           |
| `0.3.0-alpha` | P3–P4       | 可与多种模型进行视觉上下文会话       |
| `0.4.0-beta`  | P5          | AI 能在批准后修改源码并完成 HMR 验证 |
| `0.5.0-beta`  | P6          | 多轮视觉目标与结果对照闭环           |
| `1.0.0`       | P7 + 稳定化 | 安全、可持续使用的 ElfUI AI DevTools |

## 十二、立即执行顺序

P0 与 P1 已完成。提交当前已验证工作后推进 P2；不提前接入模型 API 或代码 Agent：

1. 建立 template node/source range/runtime node 的关联协议与最小 fixture。（已完成）
2. 将 Inspector 从 Custom Element host 扩展到任意可定位模板元素。（已完成）
3. 完成组件树搜索、折叠、选中联动和详情面板。（已完成）
4. 增加 HMR 后选区恢复/失效规则。（已完成）
5. 增加 5,000 节点性能 fixture，并落实组件树性能预算。（已完成）
6. 运行 `pnpm test:browser`，通过真实 Chromium 验证 closed Shadow Root、HMR 选区恢复与 Inspector hover animation-frame 合并预算。（已完成）

提交当前 P1 工作并完成浏览器门禁复核后，开始截图标注和 Visual Intent；模型 API 与代码 Agent 仍保持在后续阶段。
