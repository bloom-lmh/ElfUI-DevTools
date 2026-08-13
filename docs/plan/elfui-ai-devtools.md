# ElfUI AI DevTools 实施计划

> 状态：实施中  
> 当前基线：ElfUI `0.1.0-beta.21`、DevTools Protocol v2
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

- 旧对比计划冻结保留；当前 README、fixture 和实施计划已同步 beta.21 API。
- Runtime source fallback 仍支持构造器 `__elfSource`，编译状态消费当前 Metadata v2。
- `@elfui/devtools-vite` 已接入 `onMetadata` / `onDiagnostics`、初始 endpoint 和 HMR 增量。
- 公开 npm 依赖已同步到 ElfUI beta.21；本地协议继续按 registry-first 约定实现。
- P1 的组件 ownership、模板节点级源码身份、编译诊断、导航、键盘和 ARIA 已完成并纳入测试与 Chromium 门禁。
- beta.17 已删除 Fragment API 和对应 Compiler Metadata；可选 Fragment 字段只作为 beta.15 历史输入兼容，不再是当前产品能力或验收目标。
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
- 组件结构、模板节点源码身份和 source range。
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
- [x] 在 Compiler metadata 面板显示组件 ownership、source range 和编译诊断。
- [x] 为 Metadata schema、清空旧诊断、HMR 更新和 snapshot/HMR 竞态增加测试。
- [x] 将 DevTools Protocol 升级为 v2，并提供明确不兼容错误。
- [x] 使用桌面 `elfui-echarts-demo` 完成 beta.13 真实浏览器验收，覆盖 ECharts、命名 Fragment、Inspector、数据管线与编译元数据。
- [x] 修复发布产物相对 ESM import 缺少 `.js` 后缀的问题，并以 dist 公共入口导入检查作为构建门禁。
- [x] 修复 pnpm 严格依赖布局下虚拟客户端无法解析传递依赖的问题，并增加插件包入口解析回归测试。

退出标准：

- 当前 fixture 可显示组件、源码范围和诊断。
- DevTools 不再依赖旧 API 文档推断框架能力。
- 生产构建不包含 metadata client。

浏览器验收记录（2026-07-28）：

- ECharts 看板、DevTools 启动器和面板正常渲染，浏览器无错误与警告。
- Compiler metadata 显示组件、source range 和 diagnostics。
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

阶段进展（2026-07-29）：

- 新增 `InspectorTargetSnapshot`，记录 DOM path、元素身份、组件归属和 `template-node` / `component` / `unresolved` 三档源码精度。
- Inspector 高亮具体内部元素，选择结果以 `inspector/element.select` 写入可观察 Data Pipeline 面板。
- ElfUI beta.18 继续使用全局 Symbol 定位的共享 WeakMap 作为模板节点与 closed render root 的权威存储；旧节点/host Symbol 仅作为兼容镜像，DevTools 按 registry-first 顺序读取。
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
- 模板节点能归属正确组件与原始源码范围。
- HMR 后选区可恢复或明确失效。

## P2：Visual Intent 与标注

- [x] 新增 `packages/visual-intent`。
- [x] 实现 VisualTarget、VisualIntent、Annotation schema 和序列化测试。
- [x] 实现 Overlay/Ghost/Annotation 三层画布。
- [x] 实现不修改业务 DOM 的 Ghost 移动预览，并将 target capture、move preview 和 annotation 写入 Data Pipeline。
- [x] 实现样式 Preview CSS layer。
- [x] 实现 Ghost 移动、缩放和语义关系候选。
- [x] 实现矩形、箭头、高亮和评论。
- [x] 实现 viewport/选区截图与敏感区域排除。
- [x] 实现 Visual Draft 历史、撤销、清空和会话恢复。
- [x] 页面导航、HMR 或节点消失时清理或重定位草稿。
- [x] 实现结构化 motion/transition 意图、overlay-only 预览、持久化和 HMR 重定位。

阶段进展（截至 2026-07-30）：

- 截图已建立 `before` / `desired` / `result`、viewport/selection、route、viewport、DPR、scroll、敏感区域排除和字节大小元数据；浏览器 capture adapter 会请求当前 Tab、裁剪目标与 Ghost 范围、遮罩 DevTools 及用户 Redact 区域并立即停止共享。
- Visual Draft 可关联多个截图 ID；矩形、箭头、高亮和评论均进入独立 Annotation Layer。
- Ghost 移动和缩放已生成独立 intent，并会记录 drop rect 周边的语义关系候选。
- Visual Draft 已有 50 步有界内存历史、Undo、Clear、schema 校验恢复 API 和 session storage 跨刷新恢复。
- Style Preview 使用独立 overlay clone 和 `style` intent，不给业务节点写属性或 inline style；样式草稿按 `templateNodeId` 跨刷新重新绑定，并刷新当前 viewport 几何。
- Ghost 移动会从 drop rect 周边命中 ElfUI 节点，生成 `inside`、`before`、`after`、`left-of`、`right-of`、`align-with` 和 `near` 语义关系候选。
- Visual Draft 使用 session storage 跨刷新恢复；恢复时保持 intent 的稳定 target ID，并通过当前组件树重新绑定模板节点。
- Visual Draft 持久化已增加 route envelope 并兼容旧 raw draft；跨路由草稿会立即失效和移除，避免把上一页面的视觉上下文带入新页面。
- 组件 mount/update/unmount、业务 DOM 替换及 viewport resize/scroll 会在短暂合并窗口后按稳定 `templateNodeId` 重定位目标并刷新几何；找不到替代节点时会删除依赖 intent，并将仍有 viewport 几何的 annotation 降级为无锚点标注。
- 草稿重定位、目标失效和页面导航失效分别写入 `visual.target.rebind`、`visual.target.invalidate` 与 `visual.draft.invalidate` Data Pipeline 记录；单元测试和真实 Chromium 门禁覆盖 HMR closed-root 重定位及业务 DOM 不变性。
- Motion Preview 以 `properties`、`trigger`、`durationMs`、`delayMs`、`easing` 和 `respectReducedMotion` 建模，不使用普通 CSS 字符串代替；预览只绘制 DevTools marker/label，并写入 `visual.motion.preview`。

退出标准：

- 所有视觉操作只改变草稿层，不修改源码。
- 业务 DOM、事件、slot 和 MutationObserver 不因 Ghost 移动被破坏。
- 草稿可以完整序列化为 Provider 无关的数据。

## P3：AI Context Builder 与会话

- [x] 实现 `AIChangeRequest` schema。
- [x] 根据选区收集最小组件、template node、binding 和源码范围。
- [x] 关联 before screenshot、desired screenshot、intents 和 annotations。
- [x] 实现上下文大小预算、脱敏和扩大范围审批。
- [x] 建立 Conversation、Message、Attachment 和引用 ID。
- [x] 实现流式文本、取消、重试和错误恢复。
- [x] 支持“解释当前页面”“给出修改方案”只读模式。
- [x] 建立 50 条视觉意图理解 fixture。

阶段进展（2026-07-29）：

- `AIContextBuilder` 会冻结当前 Visual Draft，去重目标源码引用，合并页面、项目和安全约束，并生成 Provider 无关的 `AIChangeRequest`。
- 面板可通过 “Prepare AI request” 显式冻结上下文；该动作只写入 `ai.context.bundle` 和 `ai.request.create` Pipeline 记录，不联系模型、不写文件。
- 截图二进制由内存资产控制器持有，Pipeline 和 AI 请求协议仅引用可审计元数据；Provider Adapter 后续按截图 ID 解析实际附件。
- 上下文治理协议已实现源码块、源码字符、截图字节和用户文本预算；常见 Key、Token、Bearer 和私钥会在进入请求/Pipeline 前脱敏。
- 默认只包含当前 VisualTarget 关联源码；额外 sourceId 未批准时会以 `AI_CONTEXT_APPROVAL_REQUIRED` 诊断和 omission 留在 Data Pipeline，显式批准后才可进入请求。
- 预算超限、allowedFiles 拒绝和脱敏均有结构化 governance payload 与诊断；面板会显示 budget/usage、redaction、omission、已批准和待审批 sourceId。
- Compiler State 中不属于当前 VisualTarget 的 sourceId 只作为无内容候选进入治理；用户勾选并批准后才会重建请求，审批和重建动作都写入 Data Pipeline。
- 新增 `@elfui/devtools-ai`，提供 explain/plan/implement 会话、Message/Attachment、VisualTarget/Intent/源码/诊断/Patch 稳定引用、有界会话存储、只读执行事件协议和确定性模拟 Provider；当前包不依赖 Provider SDK。
- 会话存储限制会话数和单会话消息数，消息淘汰时清理孤立附件，并支持 pending/streaming/completed/cancelled/failed 状态，为后续流式取消与重试保留稳定协议。
- 面板已接入 explain/plan 分段会话视图，保存当前 `AIChangeRequest` 的 context attachment、消息和稳定引用；用户显式运行后可消费 Node 流、取消执行、重试失败或取消的执行，并显示 pending/streaming/completed/cancelled/failed 状态。
- Vite 开发服务已提供 capability token 保护的 `source.readRanges` 等价 endpoint：只接受 Compiler State 中的 sourceId，canonicalize 后必须位于项目根，单文件不超过 1 MB，单次最多返回 200 行和 12,000 字符。
- Client 只读取当前 VisualTarget 或用户已批准的 sourceId；读取成功/失败都进入 Data Pipeline，失败会降级为引用，成功内容继续经过预算和脱敏。
- 只读执行时 Client 会删除 `AIChangeRequest.sourceContext[].content`；Vite Node Gateway 根据 Compiler State、项目根、VisualTarget、显式批准范围和预算独立重读并再次脱敏源码，浏览器只接收带连续序号的 started/text-delta/completed/cancelled/failed 审计事件。
- Node Gateway 当前只连接确定性模拟 Provider，不持有 API Key、不访问外部模型、不提供 implement 或文件写入；同页面 capability token 仍只作为开发态纵深防御，不视为对业务页面的强安全隔离。
- `summarizeAIChangeRequest()` 会确定性复述目标 ID、tag/text、component/sourceId/templateNodeId/range、几何、关系、style、resize、remove/duplicate、motion timing 和 annotation；模拟 Provider 直接消费同一摘要。
- `fixtures/visual-intent-understanding/cases.json` 固定包含 50 条数据：10 style、10 move/relation、8 resize、4 remove/duplicate、10 motion、8 annotation/source-reference。测试要求 ID 唯一、分布不漂移，并逐条断言期望事实同时出现在直接摘要和 Provider 输出中。
- `pnpm verify` 已通过 20 个测试文件、115 项测试；真实 Chromium 门禁已覆盖请求生成、源码审批、Node 重新装配与脱敏、只读流式解释、motion 精确复述、无秘密回显及 HMR 重定位。
- Playwright CLI 已在 1440×1000 和 390×844 视口完成人工截图检查，覆盖 motion 控件、overlay 和 AI 输出；最新产物位于 `output/playwright/motion-*.png`。

退出标准：

- 不输入长篇视觉描述，也能让模型准确复述用户目标。
- 模型能引用正确目标元素和源码文件。
- 默认上下文不包含项目外文件、环境变量和无关源码。

## P4：Provider 与模型配置

- [x] 定义 Provider Adapter 和 capability negotiation。
- [x] 实现 OpenAI-compatible Provider。
- [x] 再实现至少一个非兼容 Provider，验证抽象没有绑定单一厂商。
- [x] 实现模型列表、手动 Model ID 和能力提示。
- [x] 实现 temperature、reasoning、max output 和 endpoint 配置。
- [x] API Key 仅由本地安全后端持有。
- [x] 支持文本/图片/tool call/structured output 降级。
- [x] 增加模拟 Provider、流式乱序、限流、超时和断线测试。

阶段进展（截至 2026-07-29）：

- 已定义 Provider/Model descriptor、公开设置、required/preferred capability requirements 和
  supported/downgraded/rejected negotiation；只读请求始终要求文本，有截图时偏好 image input。
- `AIProviderRegistry` 支持默认 Provider、显式 Provider/Model、手动 Model ID 能力和 descriptor
  白名单复制；Provider 切换不会修改 `AIChangeRequest`。
- Gateway 只接受 model、endpoint、temperature、reasoning 和 max output 等白名单公开设置，拒绝
  `apiKey` 等额外字段；Provider 错误回传前再次脱敏。
- `OpenAICompatibleProvider` 使用 Responses SSE，处理 `response.output_text.delta` 和
  `response.completed`；API Key 仅保存在 Node Provider 闭包，支持注入 fetch、endpoint、超时和截图解析器。
- `AnthropicMessagesProvider` 使用 Anthropic Messages 风格协议，验证 Provider 抽象不依赖 Responses SSE；
  支持文本流、图片输入、公开采样设置、超时以及鉴权/429/网络/不完整流错误。
- Node Gateway 提供 token 保护、`no-store` 的只读 Provider catalog；只返回白名单 descriptor、模型和能力，
  不返回 Key。Client 支持 Provider 选择、模型列表、手动 Model ID、能力提示以及公开设置的 session state。
- Provider-neutral 流协议现支持 text delta、tool call、structured output 和 completed；只读模式只传输、审计
  tool call，不执行任何工具。结构化输出经过 JSON 值校验和 64KB 单事件上限。
- 截图二进制通过独立、token 保护、`no-store` 的 endpoint 上传；Node 校验 MIME、Base64、字节数、尺寸、
  元数据白名单和一致性，并以 32MB/64 项上限临时存储。`AIChangeRequest` 和执行正文仍只携带元数据。
- 模拟测试已覆盖分块 SSE、Anthropic 文本流、图片装配、tool/structured 事件、乱序、429、超时、断线、
  无完成事件、秘密字段拒绝、catalog 脱敏、截图元数据篡改/缺失和错误脱敏。
- `pnpm verify` 已通过 23 个测试文件、138 项测试；真实 Chromium 20 条门禁通过。
- 1440x1000 与 390x844 的 Provider 配置截图已人工检查，桌面双列和移动单列均无溢出或遮挡：
  - `output/playwright/provider-config-desktop.png`
  - `output/playwright/provider-config-mobile.png`
- P4 退出审计通过：Provider 切换不改变 `AIChangeRequest`；不支持 image/tool/structured output 时目录和 UI
  给出明确提示；Client、Preview、RPC、Pipeline 和 descriptor 均无法读取明文 Key。

退出标准：

- 切换 Provider 不改变 `AIChangeRequest` 和 Patch 协议。
- 不支持 vision/tool calling 的模型会得到明确能力提示。
- 客户端和 Preview 无法读取明文 Key。

## P5：AI Agent、Diff 与改码闭环

- [x] 实现受限 Agent Gateway 和 workspace root 校验。
- [x] 实现 source/search/read 工具。
- [x] 实现 PatchProposal、文件 hash 和统一 Diff。
- [x] AI 先返回计划和假设，再生成 Patch。
- [x] 实现批准、拒绝和“带评论退回修改”。
- [x] 应用前检查文件未被外部修改。
- [x] 应用后执行 formatter、typecheck 和 scoped tests。
- [x] 等待 HMR，收集 Runtime/Compiler diagnostics。
- [x] 失败时恢复原文件并保留诊断。
- [x] 支持基于 Git 或原内容快照的用户级撤销。

阶段进展（截至 2026-07-29）：

- 已定义 Agent Protocol v1：固定 10 个工具名称，拒绝 `shell.exec` 等任意工具；每个工具使用独立的有界参数
  schema，不接受原始 shell 命令。
- 已定义 `PatchProposal`、`PatchApproval`、精确 `baseFileHashes`、风险和结构化验证计划；affected files、hash
  映射和 validation scopes 必须完全一致，项目路径拒绝绝对路径、`..` 与反斜杠。
- Vite Node 已实现只读 `project.search`、`source.readRanges` 和 `source.readFile`：只能访问 Compiler State 中且
  当前请求已批准的 sourceId，复用项目根/符号链接逃逸防护，并执行脱敏、结果数、文件数与字符预算。
- 源码读取由 Node 对完整文件计算 SHA-256；只读 Proposal store 会解析并校验统一 Diff 的文件头、hunk 行数、
  affected files 顺序、批准 scope 和实际基线 hash，返回不可变副本且不写文件。
- 当前提案层只允许修改现有文本文件；rename、copy、create、delete、binary diff、绝对路径和路径穿越均被拒绝。
- 已建立请求级 Agent session：Provider tool call 必须通过 Agent Protocol 白名单和参数 schema；每轮重新绑定
  当前 `AIChangeRequest` 的批准源码范围，并限制 8 轮、20 次调用、单轮 8 次调用及 Provider/工具结果字符预算。
- Gateway 已接入 `project.search`、`source.readRanges`、`source.readFile` 和 `patch.prepare`；工具结果只在 Node 与
  Provider 间传递，浏览器和 Data Pipeline 只接收不含源码正文的调用状态摘要。`patch.prepare` 会进入只读
  Proposal store，并校验当前批准范围、统一 Diff 和真实基线 hash，仍不写文件。
- Node 会从执行模式和 `AIChangeRequest` 自行推导 tool calling、structured output 与 image input 偏好，不接受
  浏览器声明能力；无工具能力的 Provider 会得到明确降级结果。
- 已为全部 10 个 Agent 工具发布唯一、Provider-safe 的下划线 wire name、说明和 JSON Schema；适配器将
  wire name 双向映射为内部固定工具名，模型无法借此扩展工具白名单。
- OpenAI-compatible Responses 已映射 function tool 定义、`function_call` 历史、`function_call_output` 结果和
  `response.output_item.done` 调用事件；Anthropic Messages 已映射 `input_schema`、`tool_use`、`tool_result`、
  `input_json_delta` 和工具块结束事件。两者都通过显式 `supportsToolCalling` 开启能力，并用注入 `fetch` 的
  模拟请求验证，不需要真实 Key 或外网模型。
- Agent session 会把历次调用与结果作为有序 exchange 保留并传给下一轮 Provider；外部请求可以恢复完整工具
  上下文，Node 内部仍执行调用 ID 去重、轮次、次数和字符预算限制。
- Node 已提供 token 保护、`no-store` 的 PatchProposal catalog 与 decision endpoint；浏览器只提交 request/proposal
  ID、decision 和可选 comment，不能提交或伪造 Proposal 正文、Diff、批准文件或 hash。
- Proposal ID 与内容不可变；相同内容重试幂等，不同内容复用 ID 会被拒绝。批准时 Node 会重新读取文件并复核
  SHA-256，再从已存 Proposal 派生精确 approved files/hash；拒绝和带评论退回不会生成任何批准范围。
- Plan UI 会先显示 summary、assumptions、影响文件、验证计划和完整统一 Diff，再提供批准、拒绝和带评论退回；
  退回按钮要求非空评论，所有决策都是终态并写入 Data Pipeline，批准状态明确显示“尚未应用”。
- 已实现 Node-only `createApprovedPatchApplier`：应用前再次验证 request/proposal/approval ID、精确批准文件、批准
  hash、当前 Compiler source scope 和实际 SHA-256；统一 Diff 必须逐行匹配当前源码上下文，多 hunk 应用保留
  原始 LF/CRLF 与末尾换行。
- 多文件写入会保留原内容快照，并在任一写入或写后 hash 校验失败时按逆序恢复已尝试文件；回滚后再次校验
  原始 hash。测试覆盖成功应用、伪造 approval ID/hash、批准后外部修改、第二文件写入失败和完整恢复。
- 应用事务现在保留有界的原始内容快照、before/after hash 和 application ID；formatter 修改后会重新计算并冻结
  after hash。回滚前会复核当前 after hash，拒绝覆盖外部后续修改，并支持同一 application ID 的幂等调用。
- 已实现 Node-only `PatchVerificationCoordinator`，固定按 format、typecheck、test-scoped、可选 build、HMR、
  diagnostics 顺序运行显式配置的适配器。默认要求除 build 外的所有步骤，Proposal validation plan 还能增加
  必需步骤；模型不能提交命令、改变顺序或跳过必需检查。
- 验证适配器具有固定超时、AbortSignal、输出字符上限、诊断条数上限和秘密脱敏。任一必需步骤失败、抛错、
  超时或缺少配置都会自动调用同一应用事务回滚，并向 Provider 返回不含源码正文的检查、诊断和回滚摘要。
- Vite 插件新增可选 `patchVerification` Node 配置。只有显式配置验证适配器、当前模式为 plan、Node store 已存在
  同 request 的用户批准且 Provider 协商支持 tool calling 时，Gateway 才会把 `patch.applyApproved` 加入本次
  Agent `availableTools`；默认配置即使已有批准也继续保持只读。
- Provider 只收到 Node 派生的 proposal/approval/request ID、摘要和影响文件；OpenAI-compatible 与 Anthropic
  adapter 都会映射 `patch_apply_approved`，并明确要求模型在验证结果返回前不得声称成功。checks、HMR 和
  diagnostics 不作为可拆分工具开放，避免模型跳过固定验证顺序。
- Gateway 集成测试已覆盖“准备提案 → ID-only 批准 → 后续 plan 调用批准应用 → 固定验证 → 成功写入”，以及
  typecheck 失败后恢复原文件；同时验证默认配置不开放应用工具、批准元数据逐轮隔离复制、浏览器流不泄露
  源码正文。
- 已定义浏览器安全的 `patch-verification` 事件，并在 Data Pipeline 记录 application/verification/proposal/
  request ID、文件路径、before/after/restored hash、固定检查摘要、HMR、受限 diagnostics 和回滚状态；事件
  有严格字段、数量和字符上限，不包含源码正文或 Provider 私有数据。
- Proposal UI 已区分“已批准（尚未应用）”“已应用并验证”“验证失败（已回滚）”和“已由用户撤销”；批准动作
  仍不写文件，用户必须通过独立的后续 Plan 执行入口应用 Patch。
- Gateway 会拒绝同一 Proposal 的并发和重复应用；成功验证后不再向后续 Provider 会话提供该 Patch，用户撤销
  成功后才重新开放。
- 已实现 token 保护的 ID-only 用户撤销 endpoint。Node 只允许撤销当前已验证事务，撤销前复核 after hash；
  外部编辑会得到 409 且不会被覆盖，成功撤销后可以在新的 hash 校验下重新应用。
- 真实 Vite fixture 的受控验证适配器会读取实际文件、执行固定 format/typecheck/test-scoped/HMR/diagnostics
  链并等待真实 Vite watcher；第二次应用会故意触发 typecheck 失败，以验证自动回滚不会留下半应用 Patch。
- P5 退出审计时 `pnpm verify` 已通过 29 个测试文件、170 项测试，真实 Chromium 33 条门禁通过；覆盖 Node
  多轮 tool loop、Proposal 审核、批准后显式应用、Vite watcher/HMR、浏览器安全审计、用户撤销、撤销后重试
  和失败自动回滚。1440x1000 与 390x844 的审批和验证截图均已人工检查：
  - `output/playwright/patch-proposal-approved-desktop.png`
  - `output/playwright/patch-proposal-approved-mobile.png`
  - `output/playwright/patch-verification-verified-desktop.png`
  - `output/playwright/patch-verification-verified-mobile.png`

退出标准：

- AI 无法绕过批准直接写文件。
- 修改范围超出批准文件时请求失效。
- 应用成功后页面刷新并可继续同一视觉会话。
- 失败不会留下半应用 Patch。

## P6：结果对照与多轮视觉会话

- [x] 捕获应用 Patch 后的 result screenshot。
- [x] 在 UI 中并排显示 before、desired、result。
- [x] 显示未满足的 annotation 和 intent。
- [x] 用户可保留草稿继续第二轮 AI 修改。
- [x] AI 回复引用具体 intent、annotation、file 和 diagnostic。
- [x] 建立接受、部分接受、回退和重新生成流程。
- [x] 记录会话审计，但默认不保存完整敏感源码。

阶段进展（截至 2026-07-29）：

- Patch 验证成功后，Proposal UI 会提供显式 result screenshot 捕获入口；浏览器需要用户手势时不会在异步验证
  事件中自动触发屏幕共享提示。
- result screenshot 关联 request/proposal/application/verification ID 和原请求中的 before / desired
  screenshot ID，并以 `visual.result.capture` 写入 verification 阶段的 Data Pipeline。
- Pipeline 只记录 screenshot 元数据、关联 ID 和字节大小摘要，不记录 data URL 或二进制正文。
- result screenshot 与 desired Visual Draft 分离保存；捕获结果不会改变原视觉草稿的 screenshot IDs，
  重新捕获会替换当前 verification 的结果关联。
- Proposal UI 已显示 result phase、截图范围、尺寸、截图 ID、before / desired 关联数和重新捕获入口。
- Proposal UI 已按 result 的稳定关联显示 before、desired、result 三阶段图片；缺失阶段和本地图片已释放
  都有明确提示，且不会从其他请求或验证轮次借用截图。
- 三阶段图片只在 Preview DOM 使用本地 data URL；Pipeline 和会话记录仍只保留元数据与关联 ID。
- 已新增 Provider 无关的 `AIVisualResultReview`，对 request 中每个 intent 和非 redaction annotation 建立
  `unreviewed` / `met` / `partial` / `unmet` 状态；结果重新捕获会重置旧证据对应的核对。
- 当前由用户根据三阶段截图显式核对，不把 formatter/typecheck/HMR 通过误当成视觉目标已满足。状态更新会
  以稳定引用和关联 ID 进入 Pipeline，不包含截图 data URL 或 annotation 文本。
- `AIChangeRequest.followUp` 会携带上一轮 request/proposal/application/verification/review/result screenshot
  关联和未满足/部分满足的稳定引用；Node 会基于当前请求重新校验引用归属、状态、数量与结果截图关联。
- 第二轮请求保持 Visual Draft 及 before / desired screenshot IDs 不变，只将 detached result screenshot 作为
  第三张 AI 输入截图加入；Provider 摘要会复述稳定引用、状态和 result screenshot ID。
- UI 提供显式继续修改入口和第二轮治理摘要，并以最多 6 轮的本地历史保留上一轮完整 Patch、验证、结果核对
  与撤销入口；切换轮次不会丢弃 Visual Draft。
- `AIChangeRequest` 可携带有界、脱敏且受批准源码范围限制的诊断上下文。Assistant message 不再预填请求中的
  全部引用；Node 只从 Provider 实际输出中识别 assembled request 中存在的 intent、annotation、file 和
  diagnostic ID，再发送 `ai.execution.reference`，不接受 Provider 自由标签或外来 ID。
- 回复引用在 UI 中以可点击芯片显示；intent/annotation 可追踪 Visual Draft 目标，file/diagnostic 可定位批准
  源码位置，追踪成功与失效都会写入有界 Pipeline 审计。
- 已新增 Provider 无关的 `AIVisualRoundDecision`，将 `accept`、`partial-accept`、`revert` 和 `regenerate`
  与 request/proposal/application/verification/review/result screenshot 完整关联。接受要求所有项目均明确满足；
  部分接受要求核对完成且同时存在已满足和未解决项。
- 部分接受只把未满足或部分满足的稳定引用带入新请求；接受本身不写文件。回退复用 Node 文件事务，并且只在
  原内容恢复成功后写入决策审计；回退后重新生成会建立新的 `AIChangeRequest`，同时保留 Visual Draft 和旧结果证据。
- 每个 proposal 最多保留 8 条轮次决策；重新捕获结果或收到新的 verification 会淘汰旧证据对应的决策。Pipeline
  只记录关联 ID、动作和稳定引用状态，不包含 screenshot data URL、源码正文或 annotation 文本。
- Client 会话明确限制为 2 个模式、每会话 100 条消息、每模式 6 轮请求和每 proposal 8 条决策；消息淘汰会
  清理孤立附件，请求淘汰会同步清理 Patch catalog、verification、rollback、result screenshot、review、
  decision 和待处理状态，迟到的异步 catalog 响应不能重新挂回已失效请求。
- `ai.conversation.retention` 只记录容量策略、保留/淘汰的 request/proposal/screenshot 稳定 ID，并明确标记
  `sourceContentPersisted: false` 与 `screenshotDataPersisted: false`；源码正文和 data URL 不进入该审计。
- Node 侧 execution、screenshot、proposal 和 application transaction 均已有独立有界存储：已回滚事务可按
  容量淘汰，仍可撤销的活动事务满载时失败关闭；服务重启会明确终止内存截图与撤销能力，不伪装成持久审计仓库。
- `pnpm verify` 在受控单 worker 下已通过 31 个测试文件、182 项测试；真实 Chromium 46 条门禁通过。
  1440x1000 与 390x844
  result 状态和三阶段对照截图已人工检查，无横向溢出、遮挡或控件重叠：
  - `output/playwright/result-screenshot-desktop.png`
  - `output/playwright/result-screenshot-mobile.png`
  - `output/playwright/screenshot-comparison-desktop.png`
  - `output/playwright/screenshot-comparison-mobile.png`
  - `output/playwright/visual-result-review-desktop.png`
  - `output/playwright/visual-result-review-mobile.png`
  - `output/playwright/visual-follow-up-desktop.png`
  - `output/playwright/visual-follow-up-mobile.png`
  - `output/playwright/ai-reply-references-desktop.png`
  - `output/playwright/ai-reply-references-mobile.png`
  - `output/playwright/visual-round-decisions-desktop.png`
  - `output/playwright/visual-round-decisions-mobile.png`

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

阶段进展（截至 2026-07-29）：

- 已完成第一轮产品 UI 审计，保留现有 Components、Timeline、Compiler、Pipeline 信息架构、ARIA、快捷键、
  稳定选择器和安全协议；审计记录在 `docs/audits/p7-product-ui.md`。
- 面板主要表面、控件、AI/Patch/review 状态和 Visual Draft 已统一使用语义颜色 token；`system` 主题会跟随
  `prefers-color-scheme`，显式 light/dark 仍兼容原有偏好存储。
- 已补全亮色主题对 AI、Patch、截图对照、review、消息和控件的覆盖，避免亮色页面残留暗色区块。
- 已加入统一 `:focus-visible` 焦点环和 `prefers-reduced-motion: reduce` 样式规则，不改变 Visual Intent
  中 `respectReducedMotion` 的语义。
- AI Panel 已增加 Provider 无关的六阶段工作流状态条：草稿、请求、方案、批准、验证、视觉核对。状态由现有
  request、execution、不可变 Patch catalog、verification 和 result screenshot 派生，不改变 Patch/verification
  协议；状态条同时提供稳定 `data-stage`、列表语义和 `aria-live` 摘要。
- 真实 Chromium 门禁新增主题/键盘焦点和 AI 工作流状态检查，当前为 47 项；1440×1000 与 390×844 的亮/暗
  截图已人工
  检查：
  - `output/playwright/p7-light-desktop.png`
  - `output/playwright/p7-dark-desktop.png`
  - `output/playwright/p7-light-mobile.png`
  - `output/playwright/p7-dark-mobile.png`
  - `output/playwright/p7-workflow-light-desktop.png`
  - `output/playwright/p7-workflow-dark-desktop.png`
  - `output/playwright/p7-workflow-light-mobile.png`
  - `output/playwright/p7-workflow-dark-mobile.png`

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
| `0.1.0-alpha` | P0–P1       | beta.21 可用的传统 ElfUI DevTools    |
| `0.2.0-alpha` | P2          | 可截图、标注和表达视觉目标           |
| `0.3.0-alpha` | P3–P4       | 可与多种模型进行视觉上下文会话       |
| `0.4.0-beta`  | P5          | AI 能在批准后修改源码并完成 HMR 验证 |
| `0.5.0-beta`  | P6          | 多轮视觉目标与结果对照闭环           |
| `1.0.0`       | P7 + 稳定化 | 安全、可持续使用的 ElfUI AI DevTools |

## 十二、立即执行顺序

P0 至 P6 已完成退出审计。当前进入 P7 产品化与稳定化：

1. 对齐 ElfUI beta.21，移除 Fragment 作为当前能力的计划、fixture 和 UI 假设，仅保留旧输入兼容。（已完成）
2. 复核 `pnpm verify`、`pnpm test:large-tree` 与真实 Chromium `pnpm test:browser`。（已完成）
3. 实现上下文大小预算、脱敏和扩大范围审批。（已完成）
4. 建立 Conversation、Message、Attachment、稳定引用 ID 和只读会话视图。（已完成）
5. 建立受项目根和批准范围限制的最小源码读取协议。（已完成）
6. 将只读解释/方案执行移入 Node 侧，定义流式取消、重试和错误恢复。（已完成）
7. 补充 motion/transition 视觉意图及对应序列化、Pipeline 和交互测试。（已完成）
8. 建立 50 条视觉意图理解 fixture，验证稳定目标、意图和源码引用复述。（已完成）
9. 定义 P4 Provider Adapter、capability negotiation、模型配置和异常流；凭据只进入 Node。（已完成）
10. 进入 P5：先定义受限工具、`PatchProposal` 与批准协议，不提前开放文件写入。（已完成）
11. 实现 `patch.applyApproved`、固定检查链、HMR、diagnostics 和失败回滚；每一步继续复核批准记录与文件
    hash。（已完成）
12. 将安全的应用/验证/回滚摘要写入 Data Pipeline，再实现用户级撤销和真实浏览器成功/失败/HMR 场景。
    （已完成）
13. 进入 P6：捕获并关联 result screenshot，保持 desired Visual Draft 不变。（已完成）
14. 实现 before / desired / result 对照。（已完成）
15. 实现未满足 intent / annotation 提示。（已完成）
16. 保留 Visual Draft 继续第二轮 AI 修改，并携带未满足项的稳定引用。（已完成）
17. 让 AI 回复显式引用具体 intent、annotation、file 和 diagnostic，并补充可追踪的引用 UI。（已完成）
18. 建立接受、部分接受、回退和重新生成流程。（已完成）
19. 补齐会话审计的保留/淘汰边界，完成 P6 退出审计。（已完成）
20. 进入 P7：先盘点现有工具栏、AI Panel、Diff/验证视图和响应式状态反馈，建立产品化 UI 缺口清单。（已完成）
21. 用语义 token、主题、焦点和减少动画规则完成第一轮低风险产品化，并由真实 Chromium 和亮暗截图验证。（已完成）
22. 增加 AI 工作流状态条，明确草稿、请求、方案、批准、验证和视觉核对的当前位置。（已完成）
23. 收束 Provider 配置与历史轮次层级，并实现 Diff Drawer，不改变 Patch/verification 协议。
