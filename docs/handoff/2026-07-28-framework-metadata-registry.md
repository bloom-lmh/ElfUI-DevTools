# ElfUI DevTools 交接：框架元数据 WeakMap 协议

日期：2026-07-28

接手范围：后续 DevTools 功能、测试和提交由 DevTools 线程负责；框架主线程不再继续修改 DevTools 实现。

## 1. 产品目标：用户最终想做什么

目标不是做一个普通的组件检查器，也不是低代码编辑器，而是分两层建设：

1. 先完成真正适配 ElfUI 的传统 DevTools，包括组件树、状态详情、Inspector、源码定位、Timeline、编译诊断、HMR、Shadow DOM 和大项目性能。
2. 在稳定的传统 DevTools 上增加 AI Visual DevTools：用户直接在页面上截图、选择、标注、移动、缩放和评论，用视觉操作表达“希望改成什么样”。这些操作只形成草稿和结构化意图，不直接修改业务 DOM 或源码。
3. DevTools 把目标节点、源码位置、截图、标注、期望布局、约束和会话消息组合成 Provider 无关的中间数据，再交给 AI 生成可审核的代码补丁。
4. 用户批准补丁后才允许写入源码，并执行格式化、类型检查、测试、HMR 和运行时诊断，最后提供修改前、期望效果和实际结果的对照。

产品形态当前确定为 Vite 页面内插件优先，不先做 Tauri。未来只有页面内闭环验证成功后，才考虑浏览器扩展或桌面客户端。

用户特别要求：每一次采集到的目标、标注、视觉意图、AI 请求和补丁结构都必须在 Data Pipeline 面板中可见，便于理解数据流、审计问题并参与产品设计。

明确边界：

- 画笔、移动和缩放只是表达修改意图，不直接改源码。
- AI 不能未经批准写文件。
- DevTools 必须复用框架 compiler/runtime 的稳定组件、模板节点和源码标识，不能另猜一套 DOM 映射。
- DevTools 和所有调试元数据必须从生产构建中剔除。

## 2. 当前已经做到什么程度

### P0：可观测性和协议地基，已完成

- ElfUI runtime 已提供 app/component 生命周期、状态、事件和响应式因果数据。
- Compiler Metadata v2 已提供组件、命名 Fragment、模板节点、源码范围和诊断。
- Protocol v2、RPC、Data Pipeline、Vite 注入和安全的 open-in-editor 已建立。
- 桌面 ECharts Demo 已完成真实浏览器集成验证。

### P1：AI-ready 传统 DevTools，大部分核心能力已完成

- Inspector 已能选择 ElfUI 组件内部任意模板节点，并关联组件、Fragment 和源码范围。
- 组件树已支持搜索、折叠、选中联动和 Props/Attrs/Setup/Expose/Source 详情。
- HMR 已支持选区恢复；无法恢复时产生明确失效记录。
- open Shadow Root 和框架开发态 closed Shadow Root 通道已经接入。
- 超过 300 行的组件树自动虚拟化，并有 5,000 节点性能预算测试。
- Timeline、Compiler metadata、Diagnostics 和序列化 Pipeline 数据已经可见。

P1 仍需完成：

- 导航、App selector、主题和最后 Tab 持久化。
- Bindings/Diagnostics 等更完整的组件详情整合。
- 键盘检查模式、焦点管理和完整 ARIA。
- HMR、closed Shadow Root 和 Inspector 性能的真实 Chromium E2E。

### P2 及以后：尚未开始正式实现

- VisualTarget、VisualIntent、Annotation 数据结构。
- Overlay/Ghost/Annotation 三层画布和截图工具。
- AI 会话、模型配置和 Provider Adapter。
- PatchProposal、批准、改码、验证、回滚和结果对照闭环。

不要跳过 P1 收尾直接接模型 API。稳定的节点—组件—源码关联是后续 AI 改码可信度的基础。

## 3. 当前未提交工作

本仓库当前存在一批已经实现但尚未提交的改动：

- 组件树搜索、折叠、选中联动和详情面板。
- HMR 组件选区恢复与明确失效记录。
- closed Shadow Root Inspector/adapter 支持。
- 超过 300 行的组件树虚拟化。
- 5,000 节点性能 fixture 与 `pnpm test:large-tree` 预算门禁。
- ElfUI 开发依赖对齐 `0.1.0-beta.14`。
- README 与 `docs/plan/elfui-ai-devtools.md` 状态同步。

交接时的验证基线：`pnpm verify` 全部通过，共 11 个测试文件、48 项测试。

请先检查 `git status` 和 diff，不要覆盖或重复实现这些未提交改动。

## 4. beta.14 原生 select 问题

框架 beta.14 曾直接对模板节点执行：

```ts
Object.defineProperty(node, Symbol.for("elfui.devtools.template-node"), {
  value: metadata,
});
```

`happy-dom@20.10.6` 的原生 `<select>` 会在该调用中抛错。框架已改为共享 WeakMap
作为权威存储，节点 Symbol 属性仅作为 best-effort 兼容镜像，失败不会影响渲染。

## 5. beta.15 开发态 registry 协议

### 模板节点

```ts
const registry = globalThis[
  Symbol.for("elfui.devtools.template-node-registry")
] as Pick<WeakMap<Node, TemplateNodeDebugInfo>, "get" | "set"> | undefined;

const metadata = registry?.get(node);
```

读取优先级必须是：

1. `template-node-registry` WeakMap。
2. 旧的 `node[Symbol.for("elfui.devtools.template-node")]` 兼容镜像。
3. 未解析。

需要修改：

- `packages/client/src/index.ts` 中的 `templateNodeDebugInfo()`。
- `packages/client/src/index.ts` 中的 `findTemplateNode()`。

### closed Shadow Root

```ts
const registry = globalThis[
  Symbol.for("elfui.devtools.render-root-registry")
] as Pick<WeakMap<HTMLElement, ShadowRoot>, "get" | "set"> | undefined;

const root = registry?.get(host);
```

读取优先级必须是：

1. `render-root-registry` WeakMap。
2. 旧的 `host[Symbol.for("elfui.devtools.render-root")]` 兼容镜像。
3. `host.shadowRoot`。
4. 无 Shadow Root 时使用 host。

需要修改 `packages/runtime/src/elfui-adapter.ts` 中的 `getElfUIRenderRoot()`。

不要导入 `@elfui/runtime/internal` 获取 registry；DevTools 与框架保持协议级解耦，并通过全局 Symbol
在多个 runtime 副本之间共享 WeakMap。

## 6. 必须补充的 DevTools 测试

- 模拟节点 Symbol `defineProperty` 失败时，Inspector 仍能通过 registry 读取模板元数据。
- `findTemplateNode()` 能从 registry 找到目标模板节点。
- closed root 只有 registry、没有 host Symbol 镜像时，adapter 和 Inspector 仍能进入。
- registry 不存在时继续兼容 beta.14 的节点 Symbol 元数据。
- 生产 Vite 构建不包含两个 registry key。

## 7. beta.15 发布后的接手顺序

框架发布 beta.15 后：

1. 升级本仓库的 `@elfui/core` 和 `@elfui/vite-plugin` 到相同版本。
2. 执行 `pnpm verify` 与 `pnpm test:large-tree`。
3. 使用真实 Chromium 验证 HMR 选区恢复和 closed Shadow Root 点选。
4. 再提交本仓库当前未提交工作。
5. 完成 P1 真实浏览器门禁，再进入 Visual Intent/Annotation 的 P2 实现。

框架侧回归文件：

- `packages/runtime/src/__tests__/devtools-happy-dom.spec.ts`
- `docs/bugs/2026-07-28-v0.1.0-beta.14-happy-dom-template-metadata.md`
