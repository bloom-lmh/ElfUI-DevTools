import type {
  AIChangeDiagnostic,
  AIChangeFollowUpContext,
  AIChangeRequest,
  ComponentNodeSnapshot,
  ComponentDetailSnapshot,
  CompilerArtifact,
  CompilerStateSnapshot,
  DevtoolsSnapshot,
  InspectorTargetSnapshot,
  PipelineRecord,
  PipelineStateSnapshot,
  SerializedValue,
  SourceContextBlock,
  TimelineEvent,
  TimelineStatusSnapshot,
} from "@elfui/devtools-shared";
import {
  DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
  DEVTOOLS_AI_EXECUTION_SCHEMA_VERSION,
  AIConversationStore,
  countAIVisualResultReviewStatuses,
  createAIVisualResultReview,
  createAIVisualRoundDecision,
  updateAIVisualResultReview,
  type AIConversation,
  type AIConversationMode,
  type AIExecutionEvent,
  type AIMessageStatus,
  type AIPatchVerificationAudit,
  type AIProviderCatalog,
  type AIProviderCapabilities,
  type AIProviderDescriptor,
  type AIProviderSelection,
  type AIReference,
  type AIVisualResultReview,
  type AIVisualResultReviewItem,
  type AIVisualResultReviewStatus,
  type AIVisualRoundDecision,
  type AIVisualRoundDecisionAction,
  type PatchApprovalDecision,
  type PatchApplicationRollbackResult,
  type PatchProposalCatalog,
  type PatchProposalReview,
} from "@elfui/devtools-ai";
import type {
  RectSnapshot,
  ScreenshotAsset,
  ScreenshotKind,
  ScreenshotPhase,
  VisualDraft,
  VisualMotionTrigger,
} from "@elfui/devtools-visual-intent";
import type { ElfUIDevtoolsBridge } from "@elfui/devtools-runtime";

import {
  ComponentInspector,
  createInspectorTargetSnapshot,
  findTemplateNode,
} from "./index.js";
import {
  AIContextBuilder,
  createDisplayMediaScreenshotAdapter,
  ScreenshotController,
  toScreenshotMetadata,
  type ScreenshotCaptureAdapter,
} from "./context.js";
import type { DevtoolsRpcClient } from "./rpc-client.js";
import {
  openSourceInEditor,
  type OpenSourceInEditor,
  type ReadSourceContext,
} from "./source.js";
import {
  withoutSourceContent,
  type AIExecutionClient,
} from "./ai-execution.js";
import { VisualToolsController } from "./visual.js";

export const DEVTOOLS_LAYOUT_STORAGE_KEY = "elfui-devtools:layout:v2";
export const DEVTOOLS_PREFERENCES_STORAGE_KEY = "elfui-devtools:preferences:v1";
export const DEVTOOLS_AI_PROVIDER_STORAGE_KEY = "elfui-devtools:ai-provider:v1";
export const COMPONENT_TREE_VIRTUALIZE_THRESHOLD = 300;
export const COMPONENT_TREE_ROW_HEIGHT = 34;

const COMPONENT_TREE_OVERSCAN = 8;
const MAX_AI_REPLY_REFERENCES = 64;
const MAX_AI_CONVERSATIONS = 2;
const MAX_AI_MESSAGES_PER_CONVERSATION = 100;
const MAX_AI_RETENTION_AUDIT_IDS = 64;
const MAX_AI_VISUAL_ROUND_DECISIONS = 8;

const stableDiagnosticId = (
  sourceId: string,
  code: string,
  line: number,
  column: number,
  message: string,
): string => {
  const input = `${sourceId}\0${code}\0${line}\0${column}\0${message}`;
  let hash = 2_166_136_261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `diagnostic:${(hash >>> 0).toString(16).padStart(8, "0")}`;
};

type DockPosition = "floating" | "bottom" | "left" | "right";
type PanelTab = "components" | "timeline" | "compiler" | "pipeline";
type PanelTheme = "system" | "light" | "dark";
type ReadonlyAIConversationMode = Exclude<AIConversationMode, "implement">;

interface PanelLayout {
  dock: DockPosition;
  width: number;
  height: number;
}

interface PanelPreferences {
  activeTab: PanelTab;
  theme: PanelTheme;
  appId: string | null;
}

interface ResizeStart {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SelectedComponentIdentity {
  tag: string;
  sourceFile: string | null;
}

interface PanelAIExecutionState {
  executionId: string;
  messageId: string;
  requestId: string;
  status: AIMessageStatus;
  cancelRequested: boolean;
  provider?: AIProviderSelection;
}

interface PanelAIProviderSettings {
  providerId: string;
  modelId: string;
  temperature: string;
  reasoning: "" | "none" | "low" | "medium" | "high";
  maxOutputTokens: string;
  endpoint: string;
}

interface PanelPatchResultScreenshot {
  asset: ScreenshotAsset;
  requestId: string;
  proposalId: string;
  applicationId: string;
  verificationId: string;
  sourceScreenshotIds: string[];
}

const defaultLayout: PanelLayout = {
  dock: "floating",
  width: 640,
  height: 720,
};

const MAX_AI_REQUEST_HISTORY = 6;

const zhCN = {
  allApps: "全部应用",
  systemTheme: "跟随系统",
  lightTheme: "浅色主题",
  darkTheme: "深色主题",
  floating: "浮动",
  bottom: "底部",
  left: "左侧",
  right: "右侧",
  fullscreen: "全屏",
  restore: "退出全屏",
  close: "关闭",
  components: "组件",
  timeline: "时间线",
  compiler: "编译器",
  pipeline: "数据管线",
  filterComponents: "筛选组件",
  noMatchingComponents: "没有匹配的组件。",
  visualDraft: "视觉草稿",
  stylePreview: "样式预览",
  motionPreview: "过渡 / 动效",
  moveGhost: "移动（幽灵预览）",
  resizeGhost: "缩放（幽灵预览）",
  rectangle: "矩形",
  arrow: "箭头",
  highlight: "高亮",
  comment: "批注",
  redactScreenshot: "截图遮挡",
  commentPlaceholder: "为选中位置添加批注",
  cssProperty: "CSS 属性",
  desiredValue: "期望值",
  preview: "预览",
  motionProperties: "过渡属性",
  motionTrigger: "触发时机",
  motionDuration: "时长（毫秒）",
  motionDelay: "延迟（毫秒）",
  motionEasing: "缓动",
  respectReducedMotion: "遵循减少动态效果偏好",
  previewMotion: "预览过渡",
  selectElement: "请在页面中选择一个 ElfUI 元素。",
  target: "目标",
  before: "修改前",
  desired: "期望效果",
  result: "应用结果",
  viewport: "当前视口",
  targetAndDraft: "目标与草稿",
  capturing: "截图中…",
  capture: "截图",
  clearVisualDraft: "清空视觉草稿",
  undoDraft: "撤销草稿",
  prepareAIRequest: "生成 AI 修改请求",
  aiConversation: "AI 会话",
  explainMode: "解释",
  planMode: "方案",
  providerDisconnected: "尚未连接模型，当前只生成可审计的上下文请求。",
  providerReady: "Node 侧只读模拟 Provider 已连接，不会写入源码。",
  runExplain: "运行解释",
  runPlan: "生成方案",
  cancelExecution: "取消生成",
  retryExecution: "重试",
  runAgain: "再次运行",
  patchProposals: "Patch 提案审核",
  approvePatchProposal: "批准提案（不应用）",
  rejectPatchProposal: "拒绝",
  revisePatchProposal: "带评论退回",
  noAIRequest: "生成请求后可在此检查会话引用和上下文范围。",
  approveSelectedSources: "批准所选源码范围",
  preparingAIRequest: "读取最小源码范围并生成请求…",
  recentTimeline: "最近时间线",
  resume: "继续记录",
  pause: "暂停记录",
  clear: "清空",
  dataPipeline: "数据管线",
  noPipelineRecords: "暂无数据管线记录。",
  compilerMetadata: "编译元数据",
  noCompilerData:
    "暂无编译数据，请将 devtools.compiler 传给 elfuiMacroPlugin()。",
  unavailable: "不可用",
  never: "从未",
  none: "无",
  sourceUnavailable: "源码位置不可用",
  noBindingActivity: "暂无绑定活动。",
  noCompilerDiagnostics: "暂无编译诊断。",
  openInEditor: "在编辑器中打开",
} as const;

const defaultPreferences: PanelPreferences = {
  activeTab: "components",
  theme: "system",
  appId: null,
};

const isDockPosition = (value: unknown): value is DockPosition =>
  value === "floating" ||
  value === "bottom" ||
  value === "left" ||
  value === "right";

const finiteDimension = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const isPanelTab = (value: unknown): value is PanelTab =>
  value === "components" ||
  value === "timeline" ||
  value === "compiler" ||
  value === "pipeline";

const isPanelTheme = (value: unknown): value is PanelTheme =>
  value === "system" || value === "light" || value === "dark";

const readLayout = (storage: Storage | null): PanelLayout => {
  if (!storage) return { ...defaultLayout };
  try {
    const value = JSON.parse(
      storage.getItem(DEVTOOLS_LAYOUT_STORAGE_KEY) ?? "null",
    ) as Partial<PanelLayout> | null;
    return {
      dock: isDockPosition(value?.dock) ? value.dock : defaultLayout.dock,
      width: finiteDimension(value?.width, defaultLayout.width),
      height: finiteDimension(value?.height, defaultLayout.height),
    };
  } catch {
    return { ...defaultLayout };
  }
};

const readPreferences = (storage: Storage | null): PanelPreferences => {
  if (!storage) return { ...defaultPreferences };
  try {
    const value = JSON.parse(
      storage.getItem(DEVTOOLS_PREFERENCES_STORAGE_KEY) ?? "null",
    ) as Partial<PanelPreferences> | null;
    return {
      activeTab: isPanelTab(value?.activeTab)
        ? value.activeTab
        : defaultPreferences.activeTab,
      theme: isPanelTheme(value?.theme)
        ? value.theme
        : defaultPreferences.theme,
      appId: typeof value?.appId === "string" ? value.appId : null,
    };
  } catch {
    return { ...defaultPreferences };
  }
};

const storageFor = (document: Document): Storage | null => {
  try {
    return document.defaultView?.localStorage ?? null;
  } catch {
    return null;
  }
};

const sessionStorageFor = (document: Document): Storage | null => {
  try {
    return document.defaultView?.sessionStorage ?? null;
  } catch {
    return null;
  }
};

const valueText = (value: SerializedValue): string => {
  if (value.kind === "primitive") return JSON.stringify(value.value);
  if (value.kind === "object")
    return `{ ${value.entries.map(({ key, value: item }) => `${key}: ${valueText(item)}`).join(", ")} }`;
  if (value.kind === "array")
    return `[${value.items.map(valueText).join(", ")}]`;
  if (value.kind === "map" || value.kind === "set")
    return `[${value.kind}(${value.entries.length})]`;
  return "preview" in value ? value.preview : `[${value.kind}]`;
};

const styles = `
  :host {
    color-scheme: light;
    --dt-panel: #ffffff;
    --dt-header: #f8fafc;
    --dt-surface: #ffffff;
    --dt-surface-subtle: #f8fafc;
    --dt-surface-strong: #f1f5f9;
    --dt-border: #cbd5e1;
    --dt-border-muted: #e2e8f0;
    --dt-control: #ffffff;
    --dt-text: #0f172a;
    --dt-text-muted: #475569;
    --dt-text-subtle: #64748b;
    --dt-accent: #0284c7;
    --dt-accent-surface: #e0f2fe;
    --dt-accent-text: #0369a1;
    --dt-accent-strong: #0369a1;
    --dt-success-border: #16a34a;
    --dt-success-surface: #f0fdf4;
    --dt-success-text: #166534;
    --dt-warning-border: #d97706;
    --dt-warning-surface: #fffbeb;
    --dt-warning-text: #92400e;
    --dt-danger-border: #dc2626;
    --dt-danger-surface: #fef2f2;
    --dt-danger-soft: #fff1f2;
    --dt-danger-text: #991b1b;
    --dt-visual-border: #c2410c;
    --dt-visual-surface: #fff7ed;
    --dt-visual-control: #ffedd5;
    --dt-visual-input: #ffffff;
    --dt-visual-text: #9a3412;
    --dt-visual-title: #c2410c;
    --dt-focus: #0284c7;
    --dt-shadow: rgb(15 23 42 / 22%);
    --dt-launcher: rgb(255 255 255 / 94%);
    --dt-launcher-border: rgb(148 163 184 / 45%);
  }
  * { box-sizing: border-box; }
  button, select, input, textarea { font: inherit; }
  :where(button, select, input, textarea, summary, [tabindex]):focus-visible {
    outline: 2px solid var(--dt-focus);
    outline-offset: 2px;
  }
  .launcher {
    position: fixed;
    left: 50%;
    bottom: 12px;
    display: flex;
    transform: translateX(-50%);
    overflow: hidden;
    padding: 3px;
    border: 1px solid var(--dt-launcher-border);
    border-radius: 999px;
    background: var(--dt-launcher);
    box-shadow: 0 8px 28px var(--dt-shadow);
    backdrop-filter: blur(12px);
    pointer-events: auto;
  }
  .launcher button {
    display: grid;
    width: 34px;
    height: 28px;
    place-items: center;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: var(--dt-text-subtle);
    cursor: pointer;
  }
  .launcher button:hover,
  .launcher button[aria-pressed="true"] {
    background: var(--dt-accent-surface);
    color: var(--dt-accent);
  }
  .brand { font-weight: 800; letter-spacing: 0; }
  .target { font-size: 20px; line-height: 1; }
  .panel {
    position: fixed;
    display: flex;
    width: min(var(--elfui-devtools-width, 640px), calc(100vw - 40px));
    height: min(var(--elfui-devtools-height, 720px), calc(100vh - 88px));
    max-width: 100vw;
    max-height: 100vh;
    overflow: hidden;
    border: 1px solid var(--dt-border);
    border-radius: 12px;
    background: var(--dt-panel);
    color: var(--dt-text);
    box-shadow: 0 18px 48px var(--dt-shadow);
    font: 13px/1.55 ui-sans-serif, system-ui, sans-serif;
    pointer-events: auto;
  }
  .panel[data-dock="floating"] { right: 16px; bottom: 56px; }
  .panel[data-dock="bottom"] {
    right: 0;
    bottom: 0;
    left: 0;
    width: 100vw;
    height: min(var(--elfui-devtools-height, 720px), 90vh);
    border-radius: 12px 12px 0 0;
  }
  .panel[data-dock="left"],
  .panel[data-dock="right"] {
    top: 0;
    bottom: 0;
    width: min(var(--elfui-devtools-width, 640px), 90vw);
    height: 100vh;
    border-radius: 0;
  }
  .panel[data-dock="left"] { left: 0; }
  .panel[data-dock="right"] { right: 0; }
  .panel[data-fullscreen="true"] {
    inset: 0;
    width: 100vw;
    height: 100vh;
    max-width: none;
    max-height: none;
    border-radius: 0;
  }
  .panel[hidden] { display: none; }
  .resize-handle {
    position: absolute;
    z-index: 2;
    background: transparent;
    touch-action: none;
  }
  .panel[data-dock="floating"] .resize-handle {
    right: 0;
    bottom: 0;
    width: 18px;
    height: 18px;
    cursor: nwse-resize;
  }
  .panel[data-dock="bottom"] .resize-handle {
    top: 0;
    right: 0;
    left: 0;
    height: 7px;
    cursor: ns-resize;
  }
  .panel[data-dock="left"] .resize-handle {
    top: 0;
    right: 0;
    bottom: 0;
    width: 7px;
    cursor: ew-resize;
  }
  .panel[data-dock="right"] .resize-handle {
    top: 0;
    bottom: 0;
    left: 0;
    width: 7px;
    cursor: ew-resize;
  }
  .panel[data-fullscreen="true"] .resize-handle { display: none; }
  .header {
    position: sticky;
    z-index: 1;
    top: 0;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
    margin: 0 -14px 14px;
    padding: 14px 16px;
    border-bottom: 1px solid var(--dt-border);
    background: var(--dt-header);
  }
  .header strong { font-size: 15px; }
  .header-actions {
    display: grid;
    grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, .8fr) auto auto;
    align-items: center;
    gap: 7px;
  }
  .header-actions button,
  .header-actions select {
    min-width: 0;
    min-height: 32px;
    border: 1px solid var(--dt-border);
    border-radius: 5px;
    background: var(--dt-control);
    color: var(--dt-text);
  }
  .header-actions button { padding: 4px 9px; cursor: pointer; }
  .header-actions select { padding: 3px 7px; }
  .app-selector { width: 100%; }
  .close {
    border: 0 !important;
    background: transparent !important;
    color: var(--dt-text-muted);
    cursor: pointer;
  }
  .content { width: 100%; height: 100%; overflow: auto; padding: 0 14px 14px; }
  .navigation {
    display: flex;
    gap: 4px;
    margin: 0 0 14px;
    padding: 4px;
    border: 1px solid var(--dt-border);
    border-radius: 7px;
    background: var(--dt-surface-strong);
  }
  .navigation button {
    flex: 1;
    min-width: 0;
    border: 0;
    border-radius: 5px;
    min-height: 34px;
    padding: 7px 10px;
    background: transparent;
    color: var(--dt-text-muted);
    cursor: pointer;
  }
  .navigation button[aria-selected="true"] {
    background: var(--dt-accent-surface);
    color: var(--dt-accent-text);
  }
  [role="tabpanel"][hidden] { display: none; }
  .section { margin: 0 0 14px; }
  .section-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .section-title { margin: 0 0 7px; color: var(--dt-text-muted); font-size: 12px; font-weight: 700; }
  .timeline-actions { display: flex; gap: 6px; margin-bottom: 7px; }
  .timeline-actions button { min-height: 30px; border: 1px solid var(--dt-border); border-radius: 4px; padding: 4px 9px; background: var(--dt-control); color: var(--dt-text); cursor: pointer; }
  .pipeline-list { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
  .pipeline-record {
    display: block;
    width: 100%;
    border: 1px solid var(--dt-border);
    border-radius: 5px;
    padding: 5px 7px;
    background: var(--dt-surface);
    color: var(--dt-text);
    text-align: left;
    cursor: pointer;
  }
  .pipeline-record:hover,
  .pipeline-record[aria-pressed="true"] { border-color: var(--dt-accent); background: var(--dt-accent-surface); }
  .pipeline-record strong { color: var(--dt-accent-strong); }
  .pipeline-empty { margin: 0; color: var(--dt-text-subtle); }
  .pipeline-json { max-height: 360px; font-size: 12px; }
  .component-detail {
    display: grid;
    gap: 7px;
    margin-top: 9px;
    border-top: 1px solid var(--dt-border);
    padding-top: 9px;
  }
  .detail-heading { margin: 0; color: var(--dt-accent-text); font-size: 15px; }
  .detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
  .detail-block { min-width: 0; border: 1px solid var(--dt-border-muted); border-radius: 6px; padding: 6px; background: var(--dt-surface-subtle); }
  .detail-block[data-wide="true"] { grid-column: 1 / -1; }
  .detail-label { margin: 0 0 3px; color: var(--dt-text-muted); font-size: 11px; font-weight: 700; }
  .detail-value { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
  .detail-list { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
  .detail-list li { border-left: 2px solid var(--dt-border); padding-left: 6px; }
  .detail-list li[data-severity="error"] { border-color: var(--dt-danger-border); }
  .detail-list li[data-severity="warning"] { border-color: var(--dt-warning-border); }
  .detail-list small { display: block; color: var(--dt-text-muted); }
  .visual-draft { display: grid; gap: 8px; margin-top: 12px; border: 1px solid var(--dt-visual-border); border-radius: 7px; padding: 10px; background: var(--dt-visual-surface); }
  .visual-draft .section-title { color: var(--dt-visual-title); }
  .visual-draft p { margin: 0; color: var(--dt-visual-text); }
  .visual-draft select { min-width: 0; min-height: 32px; }
  .visual-style { display: grid; grid-template-columns: minmax(0, .8fr) minmax(0, 1fr) auto; gap: 5px; align-items: center; }
  .visual-motion { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; align-items: end; }
  .visual-style[hidden],
  .visual-motion[hidden] { display: none; }
  .visual-style input,
  .visual-motion input,
  .visual-motion select { min-width: 0; min-height: 32px; border: 1px solid var(--dt-visual-border); border-radius: 4px; background: var(--dt-visual-input); color: var(--dt-visual-text); padding: 5px 8px; }
  .visual-motion-field { display: grid; min-width: 0; gap: 3px; color: var(--dt-visual-title); font-size: 11px; font-weight: 700; }
  .visual-motion-field[data-wide="true"],
  .visual-motion > button,
  .visual-motion-status { grid-column: 1 / -1; }
  .visual-motion-check { display: flex; min-height: 32px; align-items: center; gap: 7px; color: var(--dt-visual-text); font-size: 12px; }
  .visual-motion-check input { min-height: 0; }
  .visual-style button,
  .visual-motion button,
  .visual-capture button,
  .visual-draft > button { min-height: 32px; border: 1px solid var(--dt-visual-border); border-radius: 4px; background: var(--dt-visual-control); color: var(--dt-visual-text); padding: 5px 9px; cursor: pointer; }
  .visual-style button:disabled,
  .visual-motion button:disabled,
  .visual-capture button:disabled,
  .visual-draft > button:disabled { cursor: not-allowed; opacity: .55; }
  .visual-style-status,
  .visual-motion-status { grid-column: 1 / -1; color: var(--dt-visual-title); font-size: 12px; overflow-wrap: anywhere; }
  .visual-capture { display: grid; grid-template-columns: 1fr 1fr auto; gap: 5px; align-items: center; }
  .visual-capture-status { grid-column: 1 / -1; color: var(--dt-visual-title); font-size: 12px; }
  .ai-conversation { display: grid; gap: 9px; margin-top: 12px; border: 1px solid var(--dt-border); border-radius: 7px; padding: 10px; background: var(--dt-surface-subtle); }
  .ai-conversation p { margin: 0; overflow-wrap: anywhere; }
  .ai-conversation-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .ai-conversation-modes { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px; min-width: 144px; }
  .ai-workflow { display: grid; gap: 6px; border: 1px solid var(--dt-border-muted); border-radius: 5px; padding: 7px; background: var(--dt-surface); }
  .ai-workflow-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .ai-workflow-title { margin: 0; color: var(--dt-text); font-size: 12px; font-weight: 700; }
  .ai-workflow-current { margin: 0; color: var(--dt-accent-strong); font-size: 11px; }
  .ai-workflow-steps { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 3px; min-width: 0; }
  .ai-workflow-step { min-width: 0; border: 1px solid var(--dt-border-muted); border-radius: 3px; padding: 4px 3px; background: var(--dt-surface-subtle); color: var(--dt-text-muted); font-size: 10px; line-height: 1.25; text-align: center; overflow-wrap: anywhere; }
  .ai-workflow-step[data-state="complete"] { border-color: var(--dt-accent); color: var(--dt-accent-text); }
  .ai-workflow-step[data-state="active"] { border-color: var(--dt-accent); background: var(--dt-accent-surface); color: var(--dt-accent-text); font-weight: 700; }
  .ai-workflow-summary { margin: 0; color: var(--dt-text-muted); font-size: 11px; overflow-wrap: anywhere; }
  .ai-conversation-modes button,
  .ai-source-approval button,
  .ai-execution-controls button { min-height: 30px; border: 1px solid var(--dt-border); border-radius: 4px; background: var(--dt-control); color: var(--dt-text); padding: 4px 8px; cursor: pointer; }
  .ai-conversation-modes button[aria-pressed="true"] { border-color: var(--dt-accent); background: var(--dt-accent-surface); color: var(--dt-accent-text); }
  .ai-provider-status { color: var(--dt-warning-text); font-size: 12px; }
  .ai-provider-config { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 7px; }
  .ai-provider-config label { display: grid; gap: 4px; min-width: 0; color: var(--dt-text-muted); font-size: 11px; }
  .ai-provider-config input,
  .ai-provider-config select { width: 100%; min-width: 0; border: 1px solid var(--dt-border); border-radius: 5px; padding: 6px 7px; background: var(--dt-control); color: var(--dt-text); }
  .ai-provider-capabilities { grid-column: 1 / -1; margin: 0; color: var(--dt-text-muted); font-size: 11px; overflow-wrap: anywhere; }
  .ai-source-read-status { color: var(--dt-accent-strong); font-size: 12px; }
  .ai-governance { display: grid; gap: 4px; border-top: 1px solid var(--dt-border-muted); padding-top: 8px; color: var(--dt-text); font-size: 12px; }
  .ai-source-approval { display: grid; gap: 6px; border-top: 1px solid var(--dt-border-muted); padding-top: 8px; }
  .ai-source-approval label { display: flex; align-items: flex-start; gap: 7px; min-width: 0; color: var(--dt-text); overflow-wrap: anywhere; }
  .ai-source-approval input { flex: 0 0 auto; margin-top: 2px; }
  .ai-source-approval button:disabled { cursor: not-allowed; opacity: .55; }
  .ai-execution-controls { display: flex; justify-content: flex-end; border-top: 1px solid var(--dt-border-muted); padding-top: 8px; }
  .ai-execution-controls button { min-width: 104px; border-color: var(--dt-accent); background: var(--dt-accent-surface); color: var(--dt-accent-text); }
  .ai-execution-controls button:disabled { cursor: wait; opacity: .65; }
  .ai-patch-proposals { display: grid; gap: 8px; border-top: 1px solid var(--dt-border-muted); padding-top: 8px; min-width: 0; }
  .ai-patch-catalog-status { color: var(--dt-accent-strong); font-size: 12px; }
  .ai-patch-card { display: grid; gap: 7px; min-width: 0; border: 1px solid var(--dt-border); border-radius: 6px; padding: 8px; background: var(--dt-surface); color: var(--dt-text); }
  .ai-patch-card h4 { margin: 0; color: var(--dt-accent-text); font-size: 13px; overflow-wrap: anywhere; }
  .ai-patch-meta { color: var(--dt-text-muted); font-size: 11px; }
  .ai-patch-card ul { margin: 0; padding-left: 18px; color: var(--dt-text); font-size: 12px; overflow-wrap: anywhere; }
  .ai-patch-card details { min-width: 0; }
  .ai-patch-card summary { cursor: pointer; color: var(--dt-text-muted); font-size: 12px; }
  .ai-patch-diff { max-height: 280px; overflow: auto; white-space: pre; overflow-wrap: normal; font-size: 11px; }
  .ai-patch-comment { width: 100%; min-width: 0; min-height: 62px; resize: vertical; border: 1px solid var(--dt-border); border-radius: 5px; padding: 6px 7px; background: var(--dt-control); color: var(--dt-text); font: inherit; }
  .ai-patch-actions { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 5px; }
  .ai-patch-actions button { min-height: 30px; min-width: 0; border: 1px solid var(--dt-border); border-radius: 4px; padding: 4px 7px; background: var(--dt-control); color: var(--dt-text); cursor: pointer; }
  .ai-patch-actions button:first-child { border-color: var(--dt-success-border); background: var(--dt-success-surface); color: var(--dt-success-text); }
  .ai-patch-actions button:last-child { border-color: var(--dt-warning-border); background: var(--dt-warning-surface); color: var(--dt-warning-text); }
  .ai-patch-actions button:disabled { cursor: not-allowed; opacity: .5; }
  .ai-patch-decision { color: var(--dt-text); font-size: 12px; }
  .ai-patch-result { display: grid; gap: 5px; border-top: 1px solid var(--dt-border-muted); padding-top: 7px; }
  .ai-patch-result p { margin: 0; color: var(--dt-text); font-size: 12px; overflow-wrap: anywhere; }
  .ai-patch-result button,
  .ai-patch-rollback { min-height: 30px; min-width: 0; border: 1px solid var(--dt-accent); border-radius: 4px; padding: 4px 7px; background: var(--dt-accent-surface); color: var(--dt-accent-text); cursor: pointer; }
  .ai-patch-result button:disabled,
  .ai-patch-rollback:disabled { cursor: wait; opacity: .6; }
  .ai-patch-comparison { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; min-width: 0; border-top: 1px solid var(--dt-border-muted); padding-top: 7px; }
  .ai-patch-comparison-title { grid-column: 1 / -1; margin: 0; color: var(--dt-accent-text); font-size: 12px; font-weight: 700; }
  .ai-patch-comparison-phase { display: grid; align-content: start; gap: 5px; min-width: 0; border: 1px solid var(--dt-border); border-radius: 5px; padding: 6px; background: var(--dt-surface-subtle); }
  .ai-patch-comparison-phase h5 { margin: 0; color: var(--dt-text); font-size: 11px; }
  .ai-patch-comparison-phase img { display: block; width: 100%; min-height: 72px; max-height: 150px; border-radius: 3px; object-fit: contain; background: var(--dt-surface-strong); }
  .ai-patch-comparison-phase p { margin: 0; color: var(--dt-text-muted); font-size: 10px; overflow-wrap: anywhere; }
  .ai-patch-comparison-missing { display: grid; min-height: 72px; place-items: center; border: 1px dashed var(--dt-border); border-radius: 3px; padding: 6px; text-align: center; color: var(--dt-text-muted); font-size: 10px; }
  .ai-visual-result-review { display: grid; gap: 6px; min-width: 0; border-top: 1px solid var(--dt-border-muted); padding-top: 7px; }
  .ai-visual-result-review-title { margin: 0; color: var(--dt-accent-text); font-size: 12px; font-weight: 700; }
  .ai-visual-result-review-summary,
  .ai-visual-result-review-guidance { margin: 0; color: var(--dt-text-muted); font-size: 11px; overflow-wrap: anywhere; }
  .ai-visual-result-review-summary[data-has-unmet="true"] { color: var(--dt-danger-text); }
  .ai-visual-result-review-list { display: grid; gap: 5px; margin: 0; padding: 0; list-style: none; }
  .ai-visual-result-review-item { display: grid; grid-template-columns: minmax(0, 1fr) minmax(112px, 145px); gap: 7px; align-items: center; min-width: 0; border-left: 3px solid var(--dt-border); border-radius: 4px; padding: 6px 7px; background: var(--dt-surface-subtle); }
  .ai-visual-result-review-item[data-status="met"] { border-left-color: var(--dt-success-border); }
  .ai-visual-result-review-item[data-status="partial"] { border-left-color: var(--dt-warning-border); }
  .ai-visual-result-review-item[data-status="unmet"] { border-left-color: var(--dt-danger-border); background: var(--dt-danger-soft); }
  .ai-visual-result-review-reference { min-width: 0; color: var(--dt-text); font-size: 11px; overflow-wrap: anywhere; }
  .ai-visual-result-review-reference strong { display: block; color: var(--dt-text); }
  .ai-visual-result-review-item select { width: 100%; min-width: 0; border: 1px solid var(--dt-border); border-radius: 4px; padding: 5px 6px; background: var(--dt-control); color: var(--dt-text); }
  .ai-visual-round-actions { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; min-width: 0; }
  .ai-visual-round-actions button { min-height: 32px; min-width: 0; border: 1px solid var(--dt-border); border-radius: 4px; padding: 5px 7px; background: var(--dt-control); color: var(--dt-text); cursor: pointer; overflow-wrap: anywhere; }
  .ai-visual-round-actions button[data-action="accept"] { border-color: var(--dt-success-border); background: var(--dt-success-surface); color: var(--dt-success-text); }
  .ai-visual-round-actions button[data-action="partial-accept"],
  .ai-visual-round-actions button[data-action="regenerate"] { border-color: var(--dt-warning-border); background: var(--dt-warning-surface); color: var(--dt-warning-text); }
  .ai-visual-round-actions button[data-action="revert"] { border-color: var(--dt-danger-border); background: var(--dt-danger-surface); color: var(--dt-danger-text); }
  .ai-visual-round-actions button:disabled { cursor: not-allowed; opacity: .48; }
  .ai-visual-round-decision { margin: 0; border-left: 3px solid var(--dt-accent); border-radius: 4px; padding: 6px 7px; background: var(--dt-accent-surface); color: var(--dt-accent-text); font-size: 11px; overflow-wrap: anywhere; }
  .ai-patch-proposals[data-round="previous"] { border: 1px solid var(--dt-border-muted); border-radius: 6px; padding: 8px; }
  .ai-round-activate { min-height: 30px; border: 1px solid var(--dt-border); border-radius: 4px; padding: 4px 7px; background: var(--dt-control); color: var(--dt-text); cursor: pointer; }
  .ai-follow-up-context { color: var(--dt-warning-text); }
  .ai-message-list { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
  .ai-message { border-left: 2px solid var(--dt-accent); padding-left: 8px; color: var(--dt-text); overflow-wrap: anywhere; }
  .ai-message small { display: block; margin-top: 3px; color: var(--dt-text-muted); }
  .ai-message .ai-message-error { color: var(--dt-danger-text); }
  .ai-message-references { display: flex; flex-wrap: wrap; gap: 5px; margin: 6px 0 0; padding: 0; list-style: none; }
  .ai-message-reference { max-width: 100%; border-color: var(--dt-accent); background: var(--dt-accent-surface); color: var(--dt-accent-text); font-size: 11px; line-height: 1.35; text-align: left; overflow-wrap: anywhere; }
  .ai-message-reference[data-reference-kind="diagnostic"] { border-color: var(--dt-warning-border); background: var(--dt-warning-surface); color: var(--dt-warning-text); }
  .source-action { margin: 8px 0 0; border: 1px solid var(--dt-accent); border-radius: 5px; padding: 4px 8px; background: var(--dt-accent-surface); color: var(--dt-accent-text); cursor: pointer; }
  .source-action:disabled { cursor: wait; opacity: .65; }
  .component-tools { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
  .component-search {
    min-width: 0;
    flex: 1;
    border: 1px solid var(--dt-border);
    border-radius: 5px;
    min-height: 32px;
    padding: 5px 8px;
    background: var(--dt-control);
    color: var(--dt-text);
  }
  .component-tree { display: grid; gap: 1px; }
  .component-tree[data-virtualized="true"] {
    position: relative;
    display: block;
    max-height: 360px;
    overflow: auto;
  }
  .component-virtual-spacer { position: relative; min-width: 100%; }
  .component-tree[data-virtualized="true"] .component-row {
    position: absolute;
    right: 0;
    left: 0;
    height: ${COMPONENT_TREE_ROW_HEIGHT}px;
  }
  .component-row { display: flex; align-items: center; min-width: 0; }
  .tree-toggle {
    flex: 0 0 22px;
    width: 22px;
    border: 0;
    padding: 3px 0;
    background: transparent;
    color: var(--dt-text-subtle);
    cursor: pointer;
  }
  .tree-toggle:disabled { cursor: default; opacity: .25; }
  .component {
    display: block;
    min-width: 0;
    flex: 1;
    padding: 4px 8px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--dt-accent-text);
    text-align: left;
    cursor: pointer;
  }
  .component:hover,
  .component[aria-pressed="true"] { background: var(--dt-accent-surface); color: var(--dt-accent-text); }
  ol { margin: 0; padding-left: 22px; color: var(--dt-text); }
  pre { margin: 8px 0 0; overflow: auto; padding: 8px; border-radius: 6px; background: var(--dt-surface-strong); color: var(--dt-text); white-space: pre-wrap; }
  :host([data-theme="dark"]) {
    color-scheme: dark;
    --dt-panel: #0f172a;
    --dt-header: #111c31;
    --dt-surface: #0f172a;
    --dt-surface-subtle: #0b1324;
    --dt-surface-strong: #020617;
    --dt-border: #334155;
    --dt-border-muted: #273449;
    --dt-control: #1e293b;
    --dt-text: #e2e8f0;
    --dt-text-muted: #94a3b8;
    --dt-text-subtle: #64748b;
    --dt-accent: #0ea5e9;
    --dt-accent-surface: #082f49;
    --dt-accent-text: #bae6fd;
    --dt-accent-strong: #7dd3fc;
    --dt-success-border: #22c55e;
    --dt-success-surface: #052e16;
    --dt-success-text: #bbf7d0;
    --dt-warning-border: #f59e0b;
    --dt-warning-surface: #451a03;
    --dt-warning-text: #fde68a;
    --dt-danger-border: #f87171;
    --dt-danger-surface: #450a0a;
    --dt-danger-soft: #1f1018;
    --dt-danger-text: #fecaca;
    --dt-visual-border: #7c2d12;
    --dt-visual-surface: #1c1917;
    --dt-visual-control: #431407;
    --dt-visual-input: #0c0a09;
    --dt-visual-text: #fed7aa;
    --dt-visual-title: #fdba74;
    --dt-focus: #38bdf8;
    --dt-shadow: rgb(0 0 0 / 42%);
    --dt-launcher: rgb(15 23 42 / 94%);
    --dt-launcher-border: rgb(71 85 105 / 70%);
  }
  @media (prefers-color-scheme: dark) {
    :host([data-theme="system"]) {
      color-scheme: dark;
      --dt-panel: #0f172a;
      --dt-header: #111c31;
      --dt-surface: #0f172a;
      --dt-surface-subtle: #0b1324;
      --dt-surface-strong: #020617;
      --dt-border: #334155;
      --dt-border-muted: #273449;
      --dt-control: #1e293b;
      --dt-text: #e2e8f0;
      --dt-text-muted: #94a3b8;
      --dt-text-subtle: #64748b;
      --dt-accent: #0ea5e9;
      --dt-accent-surface: #082f49;
      --dt-accent-text: #bae6fd;
      --dt-accent-strong: #7dd3fc;
      --dt-success-border: #22c55e;
      --dt-success-surface: #052e16;
      --dt-success-text: #bbf7d0;
      --dt-warning-border: #f59e0b;
      --dt-warning-surface: #451a03;
      --dt-warning-text: #fde68a;
      --dt-danger-border: #f87171;
      --dt-danger-surface: #450a0a;
      --dt-danger-soft: #1f1018;
      --dt-danger-text: #fecaca;
      --dt-visual-border: #7c2d12;
      --dt-visual-surface: #1c1917;
      --dt-visual-control: #431407;
      --dt-visual-input: #0c0a09;
      --dt-visual-text: #fed7aa;
      --dt-visual-title: #fdba74;
      --dt-focus: #38bdf8;
      --dt-shadow: rgb(0 0 0 / 42%);
      --dt-launcher: rgb(15 23 42 / 94%);
      --dt-launcher-border: rgb(71 85 105 / 70%);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      scroll-behavior: auto !important;
      transition-duration: 0.01ms !important;
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
    }
  }
  @media (max-width: 560px) {
    .panel[data-dock="floating"] {
      right: 6px;
      bottom: 52px;
      width: calc(100vw - 12px);
      height: min(var(--elfui-devtools-height, 720px), calc(100dvh - 64px));
    }
    .content { padding: 0 10px 10px; }
    .header { align-items: stretch; gap: 8px; margin: 0 -10px 10px; padding: 11px 12px; }
    .header-actions {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    }
    .header-actions .app-selector { grid-column: 1 / -1; }
    .header-actions button { min-width: 0; }
    .navigation button { padding-inline: 5px; }
    .visual-style,
    .visual-motion,
    .visual-capture { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
    .visual-style button,
    .visual-motion > button,
    .visual-capture button { grid-column: 1 / -1; }
    .ai-provider-config { grid-template-columns: minmax(0, 1fr); }
    .ai-provider-capabilities { grid-column: auto; }
    .ai-workflow-steps { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .ai-patch-actions { grid-template-columns: minmax(0, 1fr); }
    .ai-patch-comparison { grid-template-columns: minmax(0, 1fr); }
    .ai-patch-comparison-title { grid-column: auto; }
    .ai-visual-result-review-item { grid-template-columns: minmax(0, 1fr); }
    .ai-visual-round-actions { grid-template-columns: minmax(0, 1fr); }
    .detail-grid { grid-template-columns: 1fr; }
    .detail-block[data-wide="true"] { grid-column: auto; }
  }
`;

export class DevtoolsPanel {
  private readonly host: HTMLDivElement;
  private readonly shadow: ShadowRoot;
  private readonly panel: HTMLDivElement;
  private readonly content: HTMLDivElement;
  private readonly resizeHandle: HTMLDivElement;
  private readonly panelToggle: HTMLButtonElement;
  private readonly inspectorToggle: HTMLButtonElement;
  private readonly visualToggle: HTMLButtonElement;
  private readonly inspector: ComponentInspector;
  private readonly visualTools: VisualToolsController;
  private readonly aiContext: AIContextBuilder;
  private readonly aiConversations = new AIConversationStore({
    maxConversations: MAX_AI_CONVERSATIONS,
    maxMessagesPerConversation: MAX_AI_MESSAGES_PER_CONVERSATION,
  });
  private readonly screenshots: ScreenshotController | null;
  private selectedId: string | null = null;
  private selectedTarget: InspectorTargetSnapshot | null = null;
  private selectedTemplateNodeId: string | null = null;
  private selectedIdentity: SelectedComponentIdentity | null = null;
  private selectedPipelineId: string | null = null;
  private selectedCompilerSourceId: string | null = null;
  private componentQuery = "";
  private readonly collapsedComponentIds = new Set<string>();
  private readonly componentParentIds = new Map<string, string | null>();
  private visible = false;
  private readonly stop: () => void;
  private readonly stopPipeline: () => void;
  private renderGeneration = 0;
  private renderQueued = false;
  private selectionRecoveryTimer: number | null = null;
  private readonly storage: Storage | null;
  private readonly sessionStorage: Storage | null;
  private dock: DockPosition;
  private panelWidth: number;
  private panelHeight: number;
  private activeTab: PanelTab;
  private theme: PanelTheme;
  private selectedAppId: string | null;
  private fullscreen = false;
  private resizeStart: ResizeStart | null = null;
  private screenshotPhase: ScreenshotPhase = "before";
  private screenshotKind: ScreenshotKind = "viewport";
  private screenshotStatus = "";
  private capturingScreenshot = false;
  private aiConversationMode: ReadonlyAIConversationMode = "explain";
  private aiDraftId: string | null = null;
  private readonly aiConversationIds = new Map<
    ReadonlyAIConversationMode,
    string
  >();
  private readonly aiRequests = new Map<
    ReadonlyAIConversationMode,
    AIChangeRequest
  >();
  private readonly aiRequestHistory = new Map<
    ReadonlyAIConversationMode,
    AIChangeRequest[]
  >();
  private readonly approvedSourceIds = new Set<string>();
  private readonly selectedSourceApprovals = new Set<string>();
  private latestCompilerState: CompilerStateSnapshot | null = null;
  private preparingAIRequest = false;
  private sourceReadStatus = "";
  private aiPreparationGeneration = 0;
  private aiExecutionGeneration = 0;
  private nextAIExecutionId = 1;
  private readonly aiExecutionStates = new Map<
    ReadonlyAIConversationMode,
    PanelAIExecutionState
  >();
  private aiProviderCatalog: AIProviderCatalog | null = null;
  private aiProviderCatalogError = "";
  private readonly aiPatchCatalogs = new Map<string, PatchProposalCatalog>();
  private readonly aiPatchCatalogStatus = new Map<string, string>();
  private readonly aiPatchVerifications = new Map<
    string,
    AIPatchVerificationAudit
  >();
  private readonly aiPatchRollbacks = new Map<
    string,
    PatchApplicationRollbackResult
  >();
  private readonly aiPatchResultScreenshots = new Map<
    string,
    PanelPatchResultScreenshot
  >();
  private readonly aiVisualResultReviews = new Map<
    string,
    AIVisualResultReview
  >();
  private readonly aiVisualRoundDecisions = new Map<
    string,
    AIVisualRoundDecision[]
  >();
  private readonly aiPatchResultCapturePending = new Set<string>();
  private readonly aiPatchRollbackPending = new Set<string>();
  private readonly aiPatchCatalogLoading = new Set<string>();
  private readonly aiPatchDecisionPending = new Set<string>();
  private readonly aiPatchComments = new Map<string, string>();
  private aiProviderSettings: PanelAIProviderSettings = {
    providerId: "",
    modelId: "",
    temperature: "",
    reasoning: "",
    maxOutputTokens: "",
    endpoint: "",
  };

  public constructor(
    private readonly bridge: ElfUIDevtoolsBridge,
    private readonly document: Document = window.document,
    private readonly rpc?: DevtoolsRpcClient,
    private readonly openSource: OpenSourceInEditor = openSourceInEditor,
    screenshotAdapter?: ScreenshotCaptureAdapter,
    private readonly sourceReader?: ReadSourceContext,
    private readonly aiExecutor?: AIExecutionClient,
  ) {
    this.storage = storageFor(document);
    this.sessionStorage = sessionStorageFor(document);
    const layout = readLayout(this.storage);
    this.dock = layout.dock;
    this.panelWidth = layout.width;
    this.panelHeight = layout.height;
    const preferences = readPreferences(this.storage);
    this.activeTab = preferences.activeTab;
    this.theme = preferences.theme;
    this.selectedAppId = preferences.appId;
    this.host = document.createElement("div");
    this.host.dataset.elfuiDevtools = "host";
    this.host.dataset.theme = this.theme;
    this.host.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;pointer-events:none";
    this.shadow = this.host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = styles;
    const launcher = document.createElement("div");
    launcher.className = "launcher";
    launcher.dataset.elfuiDevtools = "launcher";

    this.panelToggle = document.createElement("button");
    this.panelToggle.className = "brand";
    this.panelToggle.type = "button";
    this.panelToggle.textContent = "E";
    this.panelToggle.title = "打开或关闭 ElfUI DevTools";
    this.panelToggle.setAttribute("aria-label", "Toggle ElfUI DevTools");
    this.panelToggle.onclick = () => this.setVisible(!this.visible);

    this.inspectorToggle = document.createElement("button");
    this.inspectorToggle.className = "target";
    this.inspectorToggle.type = "button";
    this.inspectorToggle.textContent = "⌖";
    this.inspectorToggle.title = "打开或关闭组件检查器";
    this.inspectorToggle.setAttribute(
      "aria-label",
      "Toggle Component Inspector",
    );
    this.inspectorToggle.setAttribute(
      "aria-keyshortcuts",
      "Control+Shift+C Meta+Shift+C",
    );
    this.inspectorToggle.onclick = () => {
      if (this.inspector.enabled) this.inspector.disable();
      else this.inspector.enable();
      this.syncControls();
    };
    this.visualToggle = document.createElement("button");
    this.visualToggle.className = "visual";
    this.visualToggle.type = "button";
    this.visualToggle.textContent = "✎";
    this.visualToggle.title = "打开或关闭视觉草稿";
    this.visualToggle.setAttribute("aria-label", "Toggle Visual Draft");
    this.visualToggle.setAttribute(
      "aria-keyshortcuts",
      "Control+Shift+V Meta+Shift+V",
    );
    this.visualToggle.onclick = () => {
      if (this.visualTools.enabled) this.visualTools.disable();
      else this.visualTools.enable();
      this.setVisible(true);
      this.syncControls();
      this.scheduleRender();
    };
    launcher.append(this.panelToggle, this.inspectorToggle, this.visualToggle);

    this.panel = document.createElement("div");
    this.panel.className = "panel";
    this.panel.lang = "zh-CN";
    this.panel.dataset.elfuiDevtools = "panel";
    this.panel.setAttribute("role", "dialog");
    this.panel.setAttribute("aria-label", "ElfUI DevTools");
    this.panel.setAttribute("aria-modal", "false");
    this.panel.hidden = true;
    this.content = document.createElement("div");
    this.content.className = "content";
    this.resizeHandle = document.createElement("div");
    this.resizeHandle.className = "resize-handle";
    this.resizeHandle.dataset.elfuiDevtools = "resize-handle";
    this.resizeHandle.tabIndex = 0;
    this.resizeHandle.setAttribute("role", "separator");
    this.resizeHandle.setAttribute("aria-label", "Resize ElfUI DevTools");
    this.resizeHandle.onpointerdown = (event) => this.startResize(event);
    this.resizeHandle.onkeydown = (event) => this.resizeWithKeyboard(event);
    this.panel.append(this.content, this.resizeHandle);
    this.applyLayout();

    this.shadow.append(style, launcher, this.panel);
    document.body.appendChild(this.host);
    document.defaultView?.addEventListener("pointermove", this.onPointerMove);
    document.defaultView?.addEventListener("pointerup", this.onPointerUp);

    this.inspector = new ComponentInspector(bridge, {
      document,
      onSelect: (id, target) => this.selectComponent(id, "inspector", target),
      onEnabledChange: () => this.syncControls(),
    });
    this.visualTools = new VisualToolsController(bridge, {
      document,
      storage: sessionStorageFor(document),
      onDraftChange: () => this.scheduleRender(),
    });
    this.aiContext = new AIContextBuilder(bridge, this.visualTools, {
      document,
    });
    const captureAdapter =
      screenshotAdapter ??
      createDisplayMediaScreenshotAdapter({
        document,
      });
    this.screenshots = captureAdapter
      ? new ScreenshotController(bridge, this.visualTools, captureAdapter, {
          document,
        })
      : null;
    this.document.addEventListener("keydown", this.onDocumentKeyDown, true);
    this.stop = bridge.on(() => this.scheduleRender());
    this.stopPipeline = bridge.onPipeline(() => this.scheduleRender());
    this.syncControls();
    this.render();
    void this.loadAIProviderCatalog();
  }

  public get opened(): boolean {
    return this.visible;
  }

  public dispose(): void {
    this.cancelActiveAIExecutions();
    this.stop();
    this.stopPipeline();
    if (this.selectionRecoveryTimer !== null)
      this.document.defaultView?.clearTimeout(this.selectionRecoveryTimer);
    this.inspector.dispose();
    this.visualTools.dispose();
    this.screenshots?.clear();
    this.document.removeEventListener("keydown", this.onDocumentKeyDown, true);
    this.document.defaultView?.removeEventListener(
      "pointermove",
      this.onPointerMove,
    );
    this.document.defaultView?.removeEventListener(
      "pointerup",
      this.onPointerUp,
    );
    this.host.remove();
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.resizeStart || this.fullscreen) return;
    const deltaX = event.clientX - this.resizeStart.x;
    const deltaY = event.clientY - this.resizeStart.y;
    if (this.dock === "right")
      this.setPanelSize(this.resizeStart.width - deltaX, this.panelHeight);
    else if (this.dock === "left")
      this.setPanelSize(this.resizeStart.width + deltaX, this.panelHeight);
    else if (this.dock === "bottom")
      this.setPanelSize(this.panelWidth, this.resizeStart.height - deltaY);
    else
      this.setPanelSize(
        this.resizeStart.width + deltaX,
        this.resizeStart.height + deltaY,
      );
  };

  private readonly onPointerUp = (): void => {
    this.resizeStart = null;
  };

  private readonly onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (
      event.key.toLowerCase() === "c" &&
      event.shiftKey &&
      (event.ctrlKey || event.metaKey)
    ) {
      event.preventDefault();
      if (this.inspector.enabled) this.inspector.disable();
      else this.inspector.enable();
      return;
    }
    if (
      event.key.toLowerCase() === "v" &&
      event.shiftKey &&
      (event.ctrlKey || event.metaKey)
    ) {
      event.preventDefault();
      if (this.visualTools.enabled) this.visualTools.disable();
      else this.visualTools.enable();
      this.setVisible(true);
      this.syncControls();
      this.scheduleRender();
      return;
    }
    if (event.key === "Escape" && this.visible && !this.inspector.enabled) {
      event.preventDefault();
      this.setVisible(false);
    }
  };

  private startResize(event: PointerEvent): void {
    if (this.fullscreen) return;
    event.preventDefault();
    this.resizeHandle.focus();
    this.resizeStart = {
      x: event.clientX,
      y: event.clientY,
      width: this.panelWidth,
      height: this.panelHeight,
    };
  }

  private resizeWithKeyboard(event: KeyboardEvent): void {
    if (this.fullscreen) return;
    const step = event.shiftKey ? 40 : 16;
    let width = this.panelWidth;
    let height = this.panelHeight;
    if (event.key === "ArrowLeft") width -= step;
    else if (event.key === "ArrowRight") width += step;
    else if (event.key === "ArrowUp") height += step;
    else if (event.key === "ArrowDown") height -= step;
    else return;
    event.preventDefault();
    this.setPanelSize(width, height);
  }

  private setPanelSize(width: number, height: number): void {
    const viewportWidth = this.document.defaultView?.innerWidth ?? 1280;
    const viewportHeight = this.document.defaultView?.innerHeight ?? 720;
    this.panelWidth = Math.round(
      Math.min(Math.max(width, 320), Math.max(320, viewportWidth - 16)),
    );
    this.panelHeight = Math.round(
      Math.min(Math.max(height, 240), Math.max(240, viewportHeight - 16)),
    );
    this.applyLayout();
    this.persistLayout();
  }

  private setDock(dock: DockPosition): void {
    this.dock = dock;
    this.applyLayout();
    this.persistLayout();
  }

  private setFullscreen(fullscreen: boolean): void {
    this.fullscreen = fullscreen;
    this.applyLayout();
    this.render();
  }

  private applyLayout(): void {
    this.panel.dataset.dock = this.dock;
    this.panel.dataset.fullscreen = String(this.fullscreen);
    this.panel.style.setProperty(
      "--elfui-devtools-width",
      `${this.panelWidth}px`,
    );
    this.panel.style.setProperty(
      "--elfui-devtools-height",
      `${this.panelHeight}px`,
    );
  }

  private persistLayout(): void {
    try {
      this.storage?.setItem(
        DEVTOOLS_LAYOUT_STORAGE_KEY,
        JSON.stringify({
          dock: this.dock,
          width: this.panelWidth,
          height: this.panelHeight,
        } satisfies PanelLayout),
      );
    } catch {
      // Storage can be disabled by browser privacy settings.
    }
  }

  private persistPreferences(): void {
    try {
      this.storage?.setItem(
        DEVTOOLS_PREFERENCES_STORAGE_KEY,
        JSON.stringify({
          activeTab: this.activeTab,
          theme: this.theme,
          appId: this.selectedAppId,
        } satisfies PanelPreferences),
      );
    } catch {
      // Storage can be disabled by browser privacy settings.
    }
  }

  private setActiveTab(tab: PanelTab, focus = false): void {
    this.activeTab = tab;
    this.persistPreferences();
    this.render();
    if (focus)
      this.shadow
        .querySelector<HTMLButtonElement>(`[data-devtools-tab="${tab}"]`)
        ?.focus();
  }

  private clearComponentSelection(): void {
    this.selectedId = null;
    this.selectedTarget = null;
    this.selectedTemplateNodeId = null;
    this.selectedIdentity = null;
    this.clearSelectionRecoveryTimer();
  }

  private setVisible(visible: boolean): void {
    this.visible = visible;
    this.panel.hidden = !visible;
    this.syncControls();
    if (!visible) {
      this.panelToggle.focus();
      return;
    }
    queueMicrotask(() => {
      if (!this.visible) return;
      this.shadow
        .querySelector<HTMLButtonElement>(
          `[data-devtools-tab="${this.activeTab}"]`,
        )
        ?.focus();
    });
  }

  private devtoolsExcludedRegions(): RectSnapshot[] {
    const regions: RectSnapshot[] = [];
    for (const element of [
      this.shadow.querySelector<HTMLElement>("[data-elfui-devtools=launcher]"),
      this.panel.hidden ? null : this.panel,
    ]) {
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      regions.push({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      });
    }
    return regions;
  }

  private visualScreenshotSelection(draft: VisualDraft): RectSnapshot | null {
    const target = draft.targets.at(-1);
    if (!target) return null;
    const intent = [...draft.intents]
      .reverse()
      .find((candidate) => candidate.targetId === target.id);
    const desired =
      intent?.type === "move" || intent?.type === "resize"
        ? intent.desired
        : target.geometry;
    const left = Math.min(target.geometry.x, desired.x);
    const top = Math.min(target.geometry.y, desired.y);
    const right = Math.max(
      target.geometry.x + target.geometry.width,
      desired.x + desired.width,
    );
    const bottom = Math.max(
      target.geometry.y + target.geometry.height,
      desired.y + desired.height,
    );
    const padding = 16;
    const view = this.document.defaultView;
    const x = Math.max(0, left - padding);
    const y = Math.max(0, top - padding);
    return {
      x,
      y,
      width: Math.max(
        1,
        Math.min(view?.innerWidth ?? right + padding, right + padding) - x,
      ),
      height: Math.max(
        1,
        Math.min(view?.innerHeight ?? bottom + padding, bottom + padding) - y,
      ),
    };
  }

  private async captureVisualScreenshot(): Promise<void> {
    if (!this.screenshots || this.capturingScreenshot) return;
    const draft = this.visualTools.getDraft();
    const selection =
      this.screenshotKind === "selection"
        ? this.visualScreenshotSelection(draft)
        : undefined;
    if (this.screenshotKind === "selection" && !selection) {
      this.screenshotStatus = "截图前请先选择一个视觉目标。";
      this.render();
      return;
    }
    this.capturingScreenshot = true;
    this.screenshotStatus = "请选择当前浏览器标签页进行截图…";
    this.render();
    try {
      const asset = await this.screenshots.capture(
        this.screenshotPhase,
        this.screenshotKind,
        {
          ...(selection ? { selection } : {}),
          excludedRegions: [
            ...this.devtoolsExcludedRegions(),
            ...draft.annotations.flatMap((annotation) =>
              annotation.type === "redaction" && annotation.geometry
                ? [{ ...annotation.geometry }]
                : [],
            ),
          ],
        },
      );
      const phase = asset.phase === "before" ? zhCN.before : zhCN.desired;
      const kind =
        asset.kind === "viewport" ? zhCN.viewport : zhCN.targetAndDraft;
      this.screenshotStatus = `已截取${phase}的${kind} · ${asset.width}×${asset.height}`;
    } catch (error) {
      const cancelled =
        error instanceof DOMException && error.name === "NotAllowedError";
      const message = cancelled
        ? "已取消截图。"
        : error instanceof Error
          ? error.message
          : String(error);
      this.screenshotStatus = message;
      this.bridge.recordPipeline({
        taskId: this.visualTools.id,
        stage: "visual-intent",
        source: "visual-tools",
        kind: "visual.screenshot.error",
        summary: message,
        payload: {
          phase: this.screenshotPhase,
          kind: this.screenshotKind,
          error: message,
        },
      });
    } finally {
      this.capturingScreenshot = false;
      this.render();
    }
  }

  private retainCurrentScreenshotAssets(): void {
    this.screenshots?.retainAssets([
      ...this.visualTools.getDraft().screenshotIds,
      ...Array.from(
        this.aiPatchResultScreenshots.values(),
        (result) => result.asset.id,
      ),
    ]);
  }

  private async capturePatchResultScreenshot(
    request: AIChangeRequest,
    verification: AIPatchVerificationAudit,
  ): Promise<void> {
    if (
      !this.screenshots ||
      verification.status !== "verified" ||
      verification.requestId !== request.id ||
      this.aiPatchResultCapturePending.has(verification.verificationId)
    )
      return;
    const draft = this.visualTools.getDraft();
    const selection =
      this.screenshotKind === "selection"
        ? this.visualScreenshotSelection(draft)
        : undefined;
    if (this.screenshotKind === "selection" && !selection) {
      this.sourceReadStatus = "捕获结果截图前请先选择一个仍然有效的视觉目标。";
      this.render();
      return;
    }
    this.aiPatchResultCapturePending.add(verification.verificationId);
    this.sourceReadStatus = "请选择当前浏览器标签页以捕获应用结果…";
    this.render();
    try {
      const captured = await this.screenshots.capture(
        "result",
        this.screenshotKind,
        {
          ...(selection ? { selection } : {}),
          excludedRegions: [
            ...this.devtoolsExcludedRegions(),
            ...draft.annotations.flatMap((annotation) =>
              annotation.type === "redaction" && annotation.geometry
                ? [{ ...annotation.geometry }]
                : [],
            ),
          ],
          attachToDraft: false,
        },
      );
      const result: PanelPatchResultScreenshot = {
        asset: toScreenshotMetadata(captured),
        requestId: request.id,
        proposalId: verification.proposalId,
        applicationId: verification.applicationId,
        verificationId: verification.verificationId,
        sourceScreenshotIds: request.screenshots
          .filter(
            (screenshot) =>
              screenshot.phase === "before" || screenshot.phase === "desired",
          )
          .map((screenshot) => screenshot.id),
      };
      this.aiPatchResultScreenshots.set(verification.proposalId, result);
      const visualReview = createAIVisualResultReview({
        request,
        proposalId: verification.proposalId,
        applicationId: verification.applicationId,
        verificationId: verification.verificationId,
        resultScreenshotId: result.asset.id,
      });
      this.aiVisualResultReviews.set(verification.proposalId, visualReview);
      this.aiVisualRoundDecisions.delete(verification.proposalId);
      this.retainCurrentScreenshotAssets();
      this.sourceReadStatus =
        `已捕获 ${verification.proposalId} 的${zhCN.result}截图 · ` +
        `${captured.width}×${captured.height}。`;
      this.bridge.recordPipeline({
        taskId: request.id,
        stage: "verification",
        source: "visual-tools",
        kind: "visual.result.capture",
        summary: `Captured result screenshot for verified Patch ${verification.proposalId}`,
        payload: result,
      });
      this.bridge.recordPipeline({
        taskId: request.id,
        stage: "verification",
        source: "visual-tools",
        kind: "visual.result.review.created",
        summary: `Created an explicit visual result review for ${verification.proposalId}`,
        payload: {
          reviewId: visualReview.id,
          requestId: visualReview.requestId,
          proposalId: visualReview.proposalId,
          applicationId: visualReview.applicationId,
          verificationId: visualReview.verificationId,
          resultScreenshotId: visualReview.resultScreenshotId,
          itemCount: visualReview.items.length,
        },
      });
    } catch (error) {
      const cancelled =
        error instanceof DOMException && error.name === "NotAllowedError";
      const message = cancelled
        ? "已取消结果截图。"
        : error instanceof Error
          ? error.message
          : String(error);
      this.sourceReadStatus = message;
      this.bridge.recordPipeline({
        taskId: request.id,
        stage: "verification",
        source: "visual-tools",
        kind: "visual.result.error",
        summary: `Failed to capture result screenshot for verified Patch ${verification.proposalId}`,
        payload: {
          requestId: request.id,
          proposalId: verification.proposalId,
          applicationId: verification.applicationId,
          verificationId: verification.verificationId,
          phase: "result",
          kind: this.screenshotKind,
        },
        diagnostics: [
          {
            severity: "error",
            code: cancelled
              ? "RESULT_SCREENSHOT_CANCELLED"
              : "RESULT_SCREENSHOT_FAILED",
            message,
          },
        ],
      });
    } finally {
      this.aiPatchResultCapturePending.delete(verification.verificationId);
      this.render();
    }
  }

  private selectComponent(
    id: string,
    selectionSource: "inspector" | "component-tree" | "ai-reference",
    target?: InspectorTargetSnapshot,
  ): void {
    this.activeTab = "components";
    this.selectedId = id;
    this.selectedTarget = target ?? null;
    this.selectedTemplateNodeId = target?.templateNodeId ?? null;
    let parentId = this.componentParentIds.get(id) ?? null;
    while (parentId) {
      this.collapsedComponentIds.delete(parentId);
      parentId = this.componentParentIds.get(parentId) ?? null;
    }
    const detail = this.bridge.getComponentDetail(id);
    if (this.selectedAppId && detail && detail.appId !== this.selectedAppId)
      this.selectedAppId = detail.appId;
    this.selectedIdentity = detail
      ? { tag: detail.tag, sourceFile: detail.source?.file ?? null }
      : null;
    const record = this.bridge.recordPipeline({
      stage: "target-snapshot",
      source: "inspector",
      kind: target ? "element.select" : "component.select",
      summary: detail
        ? `${detail.displayName} selected from ${selectionSource}`
        : `${id} selected from ${selectionSource}`,
      payload: {
        selectionSource,
        component: detail,
        ...(target ? { target } : {}),
      },
    });
    this.selectedPipelineId = record.id;
    this.persistPreferences();
    this.setVisible(true);
    this.render();
  }

  private syncControls(): void {
    this.panelToggle.setAttribute("aria-pressed", String(this.visible));
    this.inspectorToggle.setAttribute(
      "aria-pressed",
      String(this.inspector?.enabled ?? false),
    );
    this.visualToggle.setAttribute(
      "aria-pressed",
      String(this.visualTools?.enabled ?? false),
    );
  }

  private render(): void {
    const generation = ++this.renderGeneration;
    if (this.rpc) {
      void this.renderFromRpc(generation);
      return;
    }
    const snapshot = this.bridge.getSnapshot();
    this.reconcileSelection(snapshot.components);
    this.renderView(
      snapshot,
      this.selectedId ? this.bridge.getComponentDetail(this.selectedId) : null,
      this.bridge.getTimelineStatus(),
      this.bridge.getTimeline(),
      this.bridge.getPipelineState(),
      this.bridge.getCompilerState(),
    );
  }

  private scheduleRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    queueMicrotask(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  private reconcileSelection(
    components: readonly ComponentNodeSnapshot[],
  ): void {
    if (!this.selectedId || !this.selectedIdentity) return;
    const current = components.find((node) => node.id === this.selectedId);
    if (current) {
      this.clearSelectionRecoveryTimer();
      this.refreshSelectedTarget(current.id);
      return;
    }

    const replacements = components.filter(
      (node) =>
        node.tag === this.selectedIdentity?.tag &&
        (!this.selectedIdentity.sourceFile ||
          node.source?.file === this.selectedIdentity.sourceFile),
    );
    if (replacements.length === 1) {
      const previousId = this.selectedId;
      const replacement = replacements[0]!;
      this.selectedId = replacement.id;
      this.clearSelectionRecoveryTimer();
      this.refreshSelectedTarget(replacement.id);
      const record = this.bridge.recordPipeline({
        stage: "target-snapshot",
        source: "runtime",
        kind: "selection.restore",
        summary: `${replacement.displayName} selection restored after HMR`,
        payload: {
          previousComponentId: previousId,
          componentId: replacement.id,
          target: this.selectedTarget,
        },
      });
      this.selectedPipelineId = record.id;
      return;
    }

    if (this.selectionRecoveryTimer !== null) return;
    this.selectionRecoveryTimer =
      this.document.defaultView?.setTimeout(() => {
        this.selectionRecoveryTimer = null;
        const staleId = this.selectedId;
        const identity = this.selectedIdentity;
        this.selectedId = null;
        this.selectedTarget = null;
        this.selectedTemplateNodeId = null;
        this.selectedIdentity = null;
        const record = this.bridge.recordPipeline({
          stage: "target-snapshot",
          source: "runtime",
          kind: "selection.invalidate",
          summary: identity
            ? `${identity.tag} selection invalidated after HMR`
            : "Component selection invalidated after HMR",
          payload: {
            componentId: staleId,
            reason:
              replacements.length > 1
                ? "ambiguous-replacement"
                : "component-removed",
          },
        });
        this.selectedPipelineId = record.id;
        this.scheduleRender();
      }, 80) ?? null;
  }

  private refreshSelectedTarget(componentId: string): void {
    const templateNodeId = this.selectedTemplateNodeId;
    if (!templateNodeId) return;
    const host = this.bridge.getComponentHost(componentId);
    const element = host ? findTemplateNode(host, templateNodeId) : null;
    if (!host || !element) {
      this.selectedTarget = null;
      this.selectedTemplateNodeId = null;
      const record = this.bridge.recordPipeline({
        stage: "target-snapshot",
        source: "runtime",
        kind: "selection.invalidate",
        summary: "Template-node selection invalidated after HMR",
        payload: {
          componentId,
          templateNodeId,
          reason: "template-node-removed",
          componentSelectionPreserved: true,
        },
      });
      this.selectedPipelineId = record.id;
      return;
    }
    this.selectedTarget = createInspectorTargetSnapshot(
      this.bridge,
      componentId,
      element,
      host,
    );
  }

  private clearSelectionRecoveryTimer(): void {
    if (this.selectionRecoveryTimer === null) return;
    this.document.defaultView?.clearTimeout(this.selectionRecoveryTimer);
    this.selectionRecoveryTimer = null;
  }

  private async renderFromRpc(generation: number): Promise<void> {
    const [snapshot, timeline, pipeline, compiler] = await Promise.all([
      this.rpc!.getSnapshot(),
      this.rpc!.getTimeline(),
      this.rpc!.getPipeline(),
      this.rpc!.getCompilerState(),
    ]);
    const detail = this.selectedId
      ? await this.rpc!.getComponentDetail(this.selectedId)
      : null;
    if (generation !== this.renderGeneration) return;
    this.renderView(
      snapshot,
      detail,
      timeline.status,
      timeline.events,
      pipeline,
      compiler,
    );
  }

  private renderView(
    snapshot: DevtoolsSnapshot,
    detail: ComponentDetailSnapshot | null,
    timelineStatus: TimelineStatusSnapshot,
    timelineEvents: readonly TimelineEvent[],
    pipelineState: PipelineStateSnapshot,
    compilerState: CompilerStateSnapshot,
  ): void {
    this.latestCompilerState = compilerState;
    this.content.replaceChildren();
    if (
      this.selectedAppId &&
      !snapshot.apps.some((app) => app.id === this.selectedAppId)
    ) {
      this.selectedAppId = null;
      this.persistPreferences();
    }
    const componentNodes = this.selectedAppId
      ? snapshot.components.filter(
          (component) => component.appId === this.selectedAppId,
        )
      : snapshot.components;
    const visibleDetail =
      detail && componentNodes.some((component) => component.id === detail.id)
        ? detail
        : null;

    const header = this.document.createElement("div");
    header.className = "header";
    const title = this.document.createElement("strong");
    title.textContent = `ElfUI DevTools (${componentNodes.length})`;
    const headerActions = this.document.createElement("div");
    headerActions.className = "header-actions";
    const appSelector = this.document.createElement("select");
    appSelector.className = "app-selector";
    appSelector.setAttribute("aria-label", "Select ElfUI app");
    const allApps = this.document.createElement("option");
    allApps.value = "";
    allApps.textContent = `${zhCN.allApps} (${snapshot.apps.length})`;
    appSelector.append(allApps);
    for (const app of snapshot.apps) {
      const option = this.document.createElement("option");
      option.value = app.id;
      option.textContent = app.label;
      appSelector.append(option);
    }
    appSelector.value = this.selectedAppId ?? "";
    appSelector.onchange = () => {
      this.selectedAppId = appSelector.value || null;
      if (
        this.selectedId &&
        !snapshot.components.some(
          (component) =>
            component.id === this.selectedId &&
            (!this.selectedAppId || component.appId === this.selectedAppId),
        )
      )
        this.clearComponentSelection();
      this.persistPreferences();
      this.render();
    };
    const theme = this.document.createElement("select");
    theme.setAttribute("aria-label", "DevTools theme");
    for (const [value, label] of [
      ["system", zhCN.systemTheme],
      ["light", zhCN.lightTheme],
      ["dark", zhCN.darkTheme],
    ] as const) {
      const option = this.document.createElement("option");
      option.value = value;
      option.textContent = label;
      theme.append(option);
    }
    theme.value = this.theme;
    theme.onchange = () => {
      if (!isPanelTheme(theme.value)) return;
      this.theme = theme.value;
      this.host.dataset.theme = this.theme;
      this.persistPreferences();
    };
    const dock = this.document.createElement("select");
    dock.setAttribute("aria-label", "Dock position");
    for (const [value, label] of [
      ["floating", zhCN.floating],
      ["bottom", zhCN.bottom],
      ["left", zhCN.left],
      ["right", zhCN.right],
    ] as const) {
      const option = this.document.createElement("option");
      option.value = value;
      option.textContent = label;
      dock.appendChild(option);
    }
    dock.value = this.dock;
    dock.onchange = () => {
      if (isDockPosition(dock.value)) this.setDock(dock.value);
    };
    const fullscreen = this.document.createElement("button");
    fullscreen.type = "button";
    fullscreen.textContent = this.fullscreen ? zhCN.restore : zhCN.fullscreen;
    fullscreen.setAttribute(
      "aria-label",
      this.fullscreen ? "Exit fullscreen" : "Enter fullscreen",
    );
    fullscreen.onclick = () => this.setFullscreen(!this.fullscreen);
    const close = this.document.createElement("button");
    close.className = "close";
    close.type = "button";
    close.textContent = zhCN.close;
    close.onclick = () => this.setVisible(false);
    headerActions.append(appSelector, theme, dock, fullscreen, close);
    header.append(title, headerActions);
    this.content.append(header);

    const navigation = this.document.createElement("nav");
    navigation.className = "navigation";
    navigation.setAttribute("role", "tablist");
    navigation.setAttribute("aria-label", "DevTools views");
    const panelTabs = [
      ["components", zhCN.components],
      ["timeline", zhCN.timeline],
      ["compiler", zhCN.compiler],
      ["pipeline", zhCN.pipeline],
    ] as const;
    for (const [tab, label] of panelTabs) {
      const button = this.document.createElement("button");
      button.type = "button";
      button.id = `elfui-devtools-tab-${tab}`;
      button.dataset.devtoolsTab = tab;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", String(tab === this.activeTab));
      button.setAttribute("aria-controls", `elfui-devtools-view-${tab}`);
      button.tabIndex = tab === this.activeTab ? 0 : -1;
      button.textContent = label;
      button.onclick = () => this.setActiveTab(tab, true);
      button.onkeydown = (event) => {
        const currentIndex = panelTabs.findIndex(
          ([candidate]) => candidate === tab,
        );
        let nextIndex: number | null = null;
        if (event.key === "ArrowLeft")
          nextIndex = (currentIndex - 1 + panelTabs.length) % panelTabs.length;
        else if (event.key === "ArrowRight")
          nextIndex = (currentIndex + 1) % panelTabs.length;
        else if (event.key === "Home") nextIndex = 0;
        else if (event.key === "End") nextIndex = panelTabs.length - 1;
        if (nextIndex === null) return;
        event.preventDefault();
        this.setActiveTab(panelTabs[nextIndex]![0], true);
      };
      navigation.append(button);
    }
    this.content.append(navigation);

    const components = this.document.createElement("section");
    components.className = "section";
    components.id = "elfui-devtools-view-components";
    components.dataset.elfuiDevtools = "components-view";
    components.setAttribute("role", "tabpanel");
    components.setAttribute("aria-labelledby", "elfui-devtools-tab-components");
    components.hidden = this.activeTab !== "components";
    const componentTools = this.document.createElement("div");
    componentTools.className = "component-tools";
    const componentsTitle = this.document.createElement("p");
    componentsTitle.className = "section-title";
    componentsTitle.textContent = zhCN.components;
    const componentSearch = this.document.createElement("input");
    componentSearch.className = "component-search";
    componentSearch.type = "search";
    componentSearch.placeholder = zhCN.filterComponents;
    componentSearch.value = this.componentQuery;
    componentSearch.setAttribute("aria-label", "Filter components");
    componentTools.append(componentsTitle, componentSearch);
    components.append(componentTools);
    const componentTree = this.document.createElement("div");
    componentTree.className = "component-tree";
    componentTree.dataset.elfuiDevtools = "component-tree";
    componentTree.setAttribute("role", "tree");
    componentTree.setAttribute("aria-label", "ElfUI component tree");
    components.append(componentTree);

    const nodeById = new Map(componentNodes.map((node) => [node.id, node]));
    this.componentParentIds.clear();
    for (const node of componentNodes)
      this.componentParentIds.set(node.id, node.parentId);
    const roots = componentNodes.filter(
      (node) => !node.parentId || !nodeById.has(node.parentId),
    );
    type VisibleComponentRow = {
      node: ComponentNodeSnapshot;
      depth: number;
    };
    let visibleRows: VisibleComponentRow[] = [];
    let virtualSpacer: HTMLDivElement | null = null;
    const componentButton = (id: string): HTMLButtonElement | undefined =>
      Array.from(
        componentTree.querySelectorAll<HTMLButtonElement>(
          "button[data-component-id]",
        ),
      ).find((candidate) => candidate.dataset.componentId === id);
    const focusVisibleComponent = (index: number): void => {
      const target = visibleRows[index];
      if (!target) return;
      let button = componentButton(target.node.id);
      if (!button && componentTree.dataset.virtualized === "true") {
        componentTree.scrollTop = index * COMPONENT_TREE_ROW_HEIGHT;
        componentTree.dispatchEvent(new Event("scroll"));
        button = componentButton(target.node.id);
      }
      button?.focus();
    };
    const restoreComponentFocus = (id: string): void => {
      queueMicrotask(() => componentButton(id)?.focus());
    };

    const createComponentRow = ({
      node,
      depth,
    }: VisibleComponentRow): HTMLDivElement => {
      const row = this.document.createElement("div");
      row.className = "component-row";
      row.setAttribute("role", "presentation");
      row.style.paddingLeft = `${depth * 14}px`;
      const toggle = this.document.createElement("button");
      toggle.className = "tree-toggle";
      toggle.type = "button";
      const collapsed = this.collapsedComponentIds.has(node.id);
      toggle.textContent = node.children.length ? (collapsed ? "▸" : "▾") : "·";
      toggle.disabled = node.children.length === 0;
      toggle.tabIndex = -1;
      toggle.setAttribute(
        "aria-label",
        `${collapsed ? "Expand" : "Collapse"} <${node.tag}>`,
      );
      toggle.onclick = () => {
        if (collapsed) this.collapsedComponentIds.delete(node.id);
        else this.collapsedComponentIds.add(node.id);
        renderComponentRows();
      };
      const button = this.document.createElement("button");
      button.className = "component";
      button.type = "button";
      button.dataset.componentId = node.id;
      button.textContent = `<${node.tag}>`;
      button.setAttribute("role", "treeitem");
      button.setAttribute("aria-level", String(depth + 1));
      button.setAttribute("aria-selected", String(node.id === this.selectedId));
      if (node.children.length)
        button.setAttribute("aria-expanded", String(!collapsed));
      button.setAttribute("aria-pressed", String(node.id === this.selectedId));
      button.tabIndex =
        node.id === this.selectedId ||
        (!this.selectedId && visibleRows[0]?.node.id === node.id)
          ? 0
          : -1;
      button.onclick = () => this.selectComponent(node.id, "component-tree");
      button.onkeydown = (event) => {
        const index = visibleRows.findIndex(
          (entry) => entry.node.id === node.id,
        );
        if (event.key === "ArrowDown") {
          event.preventDefault();
          focusVisibleComponent(index + 1);
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          focusVisibleComponent(index - 1);
        } else if (event.key === "Home") {
          event.preventDefault();
          focusVisibleComponent(0);
        } else if (event.key === "End") {
          event.preventDefault();
          focusVisibleComponent(visibleRows.length - 1);
        } else if (event.key === "ArrowRight" && node.children.length) {
          event.preventDefault();
          if (collapsed) {
            this.collapsedComponentIds.delete(node.id);
            renderComponentRows();
            restoreComponentFocus(node.id);
          } else if (visibleRows[index + 1]?.depth === depth + 1) {
            focusVisibleComponent(index + 1);
          }
        } else if (event.key === "ArrowLeft") {
          if (node.children.length && !collapsed) {
            event.preventDefault();
            this.collapsedComponentIds.add(node.id);
            renderComponentRows();
            restoreComponentFocus(node.id);
          } else if (node.parentId) {
            event.preventDefault();
            const parentIndex = visibleRows.findIndex(
              (entry) => entry.node.id === node.parentId,
            );
            focusVisibleComponent(parentIndex);
          }
        }
      };
      row.append(toggle, button);
      return row;
    };

    const renderVirtualWindow = (): void => {
      if (!virtualSpacer) return;
      virtualSpacer.replaceChildren();
      const viewportHeight = componentTree.clientHeight || 280;
      const start = Math.max(
        0,
        Math.floor(componentTree.scrollTop / COMPONENT_TREE_ROW_HEIGHT) -
          COMPONENT_TREE_OVERSCAN,
      );
      const end = Math.min(
        visibleRows.length,
        Math.ceil(
          (componentTree.scrollTop + viewportHeight) /
            COMPONENT_TREE_ROW_HEIGHT,
        ) + COMPONENT_TREE_OVERSCAN,
      );
      const fragment = this.document.createDocumentFragment();
      for (let index = start; index < end; index += 1) {
        const row = createComponentRow(visibleRows[index]!);
        row.style.top = `${index * COMPONENT_TREE_ROW_HEIGHT}px`;
        fragment.append(row);
      }
      virtualSpacer.append(fragment);
      componentTree.dataset.renderedRows = String(end - start);
    };

    const renderComponentRows = (): void => {
      componentTree.replaceChildren();
      const query = this.componentQuery.trim().toLowerCase();
      const includedIds = new Set<string>();
      if (query) {
        for (const node of componentNodes) {
          if (
            !node.tag.toLowerCase().includes(query) &&
            !node.displayName.toLowerCase().includes(query) &&
            !node.id.toLowerCase().includes(query)
          )
            continue;
          let current: ComponentNodeSnapshot | undefined = node;
          while (current && !includedIds.has(current.id)) {
            includedIds.add(current.id);
            current = current.parentId
              ? nodeById.get(current.parentId)
              : undefined;
          }
        }
      }

      visibleRows = [];
      const stack = roots
        .slice()
        .reverse()
        .map((node) => ({ node, depth: 0 }));
      const visited = new Set<string>();
      while (stack.length) {
        const entry = stack.pop()!;
        if (visited.has(entry.node.id)) continue;
        visited.add(entry.node.id);
        if (query && !includedIds.has(entry.node.id)) continue;
        visibleRows.push(entry);
        if (!query && this.collapsedComponentIds.has(entry.node.id)) continue;
        for (
          let index = entry.node.children.length - 1;
          index >= 0;
          index -= 1
        ) {
          const child = nodeById.get(entry.node.children[index]!);
          if (child) stack.push({ node: child, depth: entry.depth + 1 });
        }
      }

      const virtualized =
        visibleRows.length >= COMPONENT_TREE_VIRTUALIZE_THRESHOLD;
      componentTree.dataset.virtualized = String(virtualized);
      if (virtualized) {
        virtualSpacer = this.document.createElement("div");
        virtualSpacer.className = "component-virtual-spacer";
        virtualSpacer.style.height = `${visibleRows.length * COMPONENT_TREE_ROW_HEIGHT}px`;
        componentTree.append(virtualSpacer);
        renderVirtualWindow();
      } else {
        virtualSpacer = null;
        const fragment = this.document.createDocumentFragment();
        for (const row of visibleRows) fragment.append(createComponentRow(row));
        componentTree.append(fragment);
        componentTree.dataset.renderedRows = String(visibleRows.length);
      }
      if (!visibleRows.length) {
        const empty = this.document.createElement("p");
        empty.className = "pipeline-empty";
        empty.textContent = zhCN.noMatchingComponents;
        componentTree.append(empty);
      }
    };
    componentSearch.oninput = () => {
      this.componentQuery = componentSearch.value;
      componentTree.scrollTop = 0;
      renderComponentRows();
    };
    componentTree.onscroll = renderVirtualWindow;
    renderComponentRows();
    const visualDraft = this.visualTools.getDraft();
    if (
      this.visualTools.enabled ||
      visualDraft.targets.length ||
      visualDraft.intents.length ||
      visualDraft.annotations.length ||
      visualDraft.screenshotIds.length
    ) {
      const visualSection = this.document.createElement("section");
      visualSection.className = "visual-draft";
      visualSection.dataset.elfuiDevtools = "visual-draft";
      const visualTitle = this.document.createElement("p");
      visualTitle.className = "section-title";
      visualTitle.textContent = zhCN.visualDraft;
      const visualSummary = this.document.createElement("p");
      visualSummary.textContent = `${visualDraft.targets.length} 个目标 · ${visualDraft.intents.length} 项修改意图 · ${visualDraft.annotations.length} 条标注 · ${visualDraft.screenshotIds.length} 张截图`;
      const visualTool = this.document.createElement("select");
      visualTool.setAttribute("aria-label", "Visual draft tool");
      for (const [value, label] of [
        ["style", zhCN.stylePreview],
        ["motion", zhCN.motionPreview],
        ["move", zhCN.moveGhost],
        ["resize", zhCN.resizeGhost],
        ["rectangle", zhCN.rectangle],
        ["arrow", zhCN.arrow],
        ["highlight", zhCN.highlight],
        ["comment", zhCN.comment],
        ["redaction", zhCN.redactScreenshot],
      ] as const) {
        const option = this.document.createElement("option");
        option.value = value;
        option.textContent = label;
        visualTool.append(option);
      }
      visualTool.value = this.visualTools.selectedTool;
      visualTool.onchange = () => {
        if (
          visualTool.value === "style" ||
          visualTool.value === "motion" ||
          visualTool.value === "move" ||
          visualTool.value === "resize" ||
          visualTool.value === "rectangle" ||
          visualTool.value === "arrow" ||
          visualTool.value === "highlight" ||
          visualTool.value === "comment" ||
          visualTool.value === "redaction"
        ) {
          this.visualTools.setTool(visualTool.value);
          this.scheduleRender();
        }
      };
      const visualComment = this.document.createElement("input");
      visualComment.className = "component-search";
      visualComment.type = "text";
      visualComment.placeholder = zhCN.commentPlaceholder;
      visualComment.setAttribute("aria-label", "Visual annotation comment");
      visualComment.value = this.visualTools.selectedCommentText;
      visualComment.disabled = this.visualTools.selectedTool !== "comment";
      visualComment.oninput = () =>
        this.visualTools.setCommentText(visualComment.value);
      const styleControls = this.document.createElement("div");
      styleControls.className = "visual-style";
      styleControls.hidden = this.visualTools.selectedTool !== "style";
      const styleProperty = this.document.createElement("input");
      styleProperty.type = "text";
      styleProperty.placeholder = zhCN.cssProperty;
      styleProperty.setAttribute("aria-label", "Style preview CSS property");
      styleProperty.value = this.visualTools.selectedStyleProperty;
      styleProperty.disabled = this.visualTools.selectedTool !== "style";
      styleProperty.oninput = () =>
        this.visualTools.setStyleProperty(styleProperty.value);
      const styleValue = this.document.createElement("input");
      styleValue.type = "text";
      styleValue.placeholder = zhCN.desiredValue;
      styleValue.setAttribute("aria-label", "Style preview CSS value");
      styleValue.value = this.visualTools.selectedStyleValue;
      styleValue.disabled = this.visualTools.selectedTool !== "style";
      styleValue.oninput = () => {
        this.visualTools.setStyleValue(styleValue.value);
        previewStyle.disabled =
          !this.visualTools.selectedStyleTargetId || !styleValue.value.trim();
      };
      const previewStyle = this.document.createElement("button");
      previewStyle.type = "button";
      previewStyle.textContent = zhCN.preview;
      previewStyle.setAttribute("aria-label", "Preview selected element style");
      previewStyle.disabled =
        this.visualTools.selectedTool !== "style" ||
        !this.visualTools.selectedStyleTargetId ||
        !this.visualTools.selectedStyleValue;
      previewStyle.onclick = () => {
        this.visualTools.previewSelectedStyle();
        this.scheduleRender();
      };
      styleControls.append(styleProperty, styleValue, previewStyle);
      if (
        this.visualTools.selectedTool === "style" &&
        !this.visualTools.selectedStyleTargetId
      ) {
        const styleStatus = this.document.createElement("p");
        styleStatus.className = "visual-style-status";
        styleStatus.setAttribute("role", "status");
        styleStatus.textContent = zhCN.selectElement;
        styleControls.append(styleStatus);
      } else if (this.visualTools.selectedStyleTargetId) {
        const styleStatus = this.document.createElement("p");
        styleStatus.className = "visual-style-status";
        styleStatus.setAttribute("role", "status");
        styleStatus.textContent = `${zhCN.target}：${this.visualTools.selectedStyleTargetId}`;
        styleControls.append(styleStatus);
      }
      const motionControls = this.document.createElement("div");
      motionControls.className = "visual-motion";
      motionControls.hidden = this.visualTools.selectedTool !== "motion";
      const motionPropertiesField = this.document.createElement("label");
      motionPropertiesField.className = "visual-motion-field";
      motionPropertiesField.dataset.wide = "true";
      motionPropertiesField.textContent = zhCN.motionProperties;
      const motionProperties = this.document.createElement("input");
      motionProperties.type = "text";
      motionProperties.placeholder = "opacity, transform";
      motionProperties.setAttribute("aria-label", "Motion CSS properties");
      motionProperties.value = this.visualTools.selectedMotionProperties;
      motionProperties.disabled = this.visualTools.selectedTool !== "motion";
      motionPropertiesField.append(motionProperties);
      const motionTriggerField = this.document.createElement("label");
      motionTriggerField.className = "visual-motion-field";
      motionTriggerField.textContent = zhCN.motionTrigger;
      const motionTrigger = this.document.createElement("select");
      motionTrigger.setAttribute("aria-label", "Motion trigger");
      for (const [value, label] of [
        ["state-change", "状态变化"],
        ["enter", "进入"],
        ["exit", "离开"],
        ["hover", "悬停"],
        ["focus", "聚焦"],
        ["press", "按下"],
      ] as const) {
        const option = this.document.createElement("option");
        option.value = value;
        option.textContent = label;
        motionTrigger.append(option);
      }
      motionTrigger.value = this.visualTools.selectedMotionTrigger;
      motionTrigger.disabled = this.visualTools.selectedTool !== "motion";
      motionTriggerField.append(motionTrigger);
      const motionEasingField = this.document.createElement("label");
      motionEasingField.className = "visual-motion-field";
      motionEasingField.textContent = zhCN.motionEasing;
      const motionEasing = this.document.createElement("select");
      motionEasing.setAttribute("aria-label", "Motion easing");
      const easingOptions = [
        "ease",
        "ease-in",
        "ease-out",
        "ease-in-out",
        "linear",
        "cubic-bezier(0.2, 0, 0, 1)",
      ];
      if (!easingOptions.includes(this.visualTools.selectedMotionEasing))
        easingOptions.push(this.visualTools.selectedMotionEasing);
      for (const value of easingOptions) {
        const option = this.document.createElement("option");
        option.value = value;
        option.textContent = value;
        motionEasing.append(option);
      }
      motionEasing.value = this.visualTools.selectedMotionEasing;
      motionEasing.disabled = this.visualTools.selectedTool !== "motion";
      motionEasingField.append(motionEasing);
      const motionDurationField = this.document.createElement("label");
      motionDurationField.className = "visual-motion-field";
      motionDurationField.textContent = zhCN.motionDuration;
      const motionDuration = this.document.createElement("input");
      motionDuration.type = "number";
      motionDuration.min = "0";
      motionDuration.max = "60000";
      motionDuration.step = "10";
      motionDuration.setAttribute("aria-label", "Motion duration milliseconds");
      motionDuration.value = String(this.visualTools.selectedMotionDurationMs);
      motionDuration.disabled = this.visualTools.selectedTool !== "motion";
      motionDurationField.append(motionDuration);
      const motionDelayField = this.document.createElement("label");
      motionDelayField.className = "visual-motion-field";
      motionDelayField.textContent = zhCN.motionDelay;
      const motionDelay = this.document.createElement("input");
      motionDelay.type = "number";
      motionDelay.min = "0";
      motionDelay.max = "60000";
      motionDelay.step = "10";
      motionDelay.setAttribute("aria-label", "Motion delay milliseconds");
      motionDelay.value = String(this.visualTools.selectedMotionDelayMs);
      motionDelay.disabled = this.visualTools.selectedTool !== "motion";
      motionDelayField.append(motionDelay);
      const reducedMotionLabel = this.document.createElement("label");
      reducedMotionLabel.className = "visual-motion-check";
      const reducedMotion = this.document.createElement("input");
      reducedMotion.type = "checkbox";
      reducedMotion.setAttribute("aria-label", "Respect reduced motion");
      reducedMotion.checked =
        this.visualTools.selectedMotionRespectReducedMotion;
      reducedMotion.disabled = this.visualTools.selectedTool !== "motion";
      reducedMotionLabel.append(reducedMotion, zhCN.respectReducedMotion);
      const previewMotion = this.document.createElement("button");
      previewMotion.type = "button";
      previewMotion.textContent = zhCN.previewMotion;
      previewMotion.setAttribute(
        "aria-label",
        "Preview selected element motion",
      );
      const syncMotionPreviewState = (): void => {
        previewMotion.disabled =
          this.visualTools.selectedTool !== "motion" ||
          !this.visualTools.selectedMotionTargetId ||
          !motionProperties.value.trim() ||
          !motionEasing.value.trim();
      };
      motionProperties.oninput = () => {
        this.visualTools.setMotionProperties(motionProperties.value);
        syncMotionPreviewState();
      };
      motionTrigger.onchange = () =>
        this.visualTools.setMotionTrigger(
          motionTrigger.value as VisualMotionTrigger,
        );
      motionEasing.onchange = () => {
        this.visualTools.setMotionEasing(motionEasing.value);
        syncMotionPreviewState();
      };
      motionDuration.oninput = () =>
        this.visualTools.setMotionDurationMs(Number(motionDuration.value));
      motionDelay.oninput = () =>
        this.visualTools.setMotionDelayMs(Number(motionDelay.value));
      reducedMotion.onchange = () =>
        this.visualTools.setMotionRespectReducedMotion(reducedMotion.checked);
      previewMotion.onclick = () => {
        this.visualTools.previewSelectedMotion();
        this.scheduleRender();
      };
      syncMotionPreviewState();
      motionControls.append(
        motionPropertiesField,
        motionTriggerField,
        motionEasingField,
        motionDurationField,
        motionDelayField,
        reducedMotionLabel,
        previewMotion,
      );
      const motionStatus = this.document.createElement("p");
      motionStatus.className = "visual-motion-status";
      motionStatus.setAttribute("role", "status");
      motionStatus.textContent = this.visualTools.selectedMotionTargetId
        ? `${zhCN.target}：${this.visualTools.selectedMotionTargetId}`
        : zhCN.selectElement;
      motionControls.append(motionStatus);
      const screenshotControls = this.document.createElement("div");
      screenshotControls.className = "visual-capture";
      const screenshotPhase = this.document.createElement("select");
      screenshotPhase.setAttribute("aria-label", "Screenshot phase");
      for (const [value, label] of [
        ["before", zhCN.before],
        ["desired", zhCN.desired],
      ] as const) {
        const option = this.document.createElement("option");
        option.value = value;
        option.textContent = label;
        screenshotPhase.append(option);
      }
      screenshotPhase.value = this.screenshotPhase;
      screenshotPhase.onchange = () => {
        if (
          screenshotPhase.value === "before" ||
          screenshotPhase.value === "desired"
        )
          this.screenshotPhase = screenshotPhase.value;
      };
      const screenshotKind = this.document.createElement("select");
      screenshotKind.setAttribute("aria-label", "Screenshot area");
      for (const [value, label] of [
        ["viewport", zhCN.viewport],
        ["selection", zhCN.targetAndDraft],
      ] as const) {
        const option = this.document.createElement("option");
        option.value = value;
        option.textContent = label;
        screenshotKind.append(option);
      }
      screenshotKind.value = this.screenshotKind;
      screenshotKind.onchange = () => {
        if (
          screenshotKind.value === "viewport" ||
          screenshotKind.value === "selection"
        )
          this.screenshotKind = screenshotKind.value;
      };
      const captureScreenshot = this.document.createElement("button");
      captureScreenshot.type = "button";
      captureScreenshot.textContent = this.capturingScreenshot
        ? zhCN.capturing
        : zhCN.capture;
      captureScreenshot.setAttribute("aria-label", "Capture visual screenshot");
      captureScreenshot.title = this.screenshots
        ? "浏览器将请求共享当前标签页。"
        : "当前浏览器不支持标签页截图。";
      captureScreenshot.disabled =
        !this.screenshots ||
        this.capturingScreenshot ||
        (this.screenshotKind === "selection" &&
          visualDraft.targets.length === 0);
      captureScreenshot.onclick = () => void this.captureVisualScreenshot();
      screenshotControls.append(
        screenshotPhase,
        screenshotKind,
        captureScreenshot,
      );
      if (this.screenshotStatus) {
        const screenshotStatus = this.document.createElement("p");
        screenshotStatus.className = "visual-capture-status";
        screenshotStatus.setAttribute("role", "status");
        screenshotStatus.textContent = this.screenshotStatus;
        screenshotControls.append(screenshotStatus);
      }
      const clearVisual = this.document.createElement("button");
      clearVisual.type = "button";
      clearVisual.textContent = zhCN.clearVisualDraft;
      clearVisual.setAttribute("aria-label", "Clear visual draft");
      clearVisual.onclick = () => {
        this.visualTools.clear();
        this.resetAIConversationState();
        this.render();
      };
      const undoVisual = this.document.createElement("button");
      undoVisual.type = "button";
      undoVisual.textContent = zhCN.undoDraft;
      undoVisual.setAttribute("aria-label", "Undo visual draft change");
      undoVisual.disabled = !this.visualTools.canUndo;
      undoVisual.onclick = () => {
        this.visualTools.undo();
        this.retainCurrentScreenshotAssets();
      };
      const prepareAIRequest = this.document.createElement("button");
      prepareAIRequest.type = "button";
      prepareAIRequest.textContent = this.preparingAIRequest
        ? zhCN.preparingAIRequest
        : zhCN.prepareAIRequest;
      prepareAIRequest.title =
        "将当前视觉草稿整理为与模型无关的修改请求，此操作不会调用任何模型。";
      prepareAIRequest.setAttribute("aria-label", "Prepare AI change request");
      prepareAIRequest.disabled =
        this.preparingAIRequest ||
        (visualDraft.targets.length === 0 &&
          visualDraft.intents.length === 0 &&
          visualDraft.annotations.length === 0 &&
          visualDraft.screenshotIds.length === 0);
      prepareAIRequest.onclick = () => {
        void this.prepareAIConversationRequest(visualDraft, "prepare");
      };
      visualSection.append(
        visualTitle,
        visualSummary,
        visualTool,
        styleControls,
        motionControls,
        visualComment,
        screenshotControls,
        prepareAIRequest,
        undoVisual,
        clearVisual,
      );
      components.append(visualSection);
      if (this.aiRequests.size > 0)
        components.append(this.renderAIConversation(visualDraft));
    }
    this.content.append(components);

    const timelineSection = this.document.createElement("section");
    timelineSection.className = "section";
    timelineSection.id = "elfui-devtools-view-timeline";
    timelineSection.setAttribute("role", "tabpanel");
    timelineSection.setAttribute(
      "aria-labelledby",
      "elfui-devtools-tab-timeline",
    );
    timelineSection.hidden = this.activeTab !== "timeline";
    const timelineHeading = this.document.createElement("div");
    timelineHeading.className = "section-heading";
    const timelineTitle = this.document.createElement("p");
    timelineTitle.className = "section-title";
    const statusParts = [
      timelineStatus.aggregatedEvents
        ? `已聚合 ${timelineStatus.aggregatedEvents} 条`
        : "",
      timelineStatus.droppedEvents
        ? `已丢弃 ${timelineStatus.droppedEvents} 条`
        : "",
    ].filter(Boolean);
    timelineTitle.textContent = `${zhCN.recentTimeline}${statusParts.length ? `（${statusParts.join("，")}）` : ""}`;
    const timelineActions = this.document.createElement("div");
    timelineActions.className = "timeline-actions";
    const pause = this.document.createElement("button");
    pause.type = "button";
    pause.textContent = timelineStatus.paused ? zhCN.resume : zhCN.pause;
    pause.setAttribute(
      "aria-label",
      timelineStatus.paused ? "Resume timeline" : "Pause timeline",
    );
    pause.onclick = () => {
      if (this.rpc) {
        void this.rpc
          .setTimelinePaused(!timelineStatus.paused)
          .then(() => this.render());
      } else {
        this.bridge.setTimelinePaused(!timelineStatus.paused);
        this.render();
      }
    };
    const clear = this.document.createElement("button");
    clear.type = "button";
    clear.textContent = zhCN.clear;
    clear.setAttribute("aria-label", "Clear timeline");
    clear.onclick = () => {
      if (this.rpc) {
        void this.rpc.clearTimeline().then(() => this.render());
      } else {
        this.bridge.clearTimeline();
        this.render();
      }
    };
    timelineActions.append(pause, clear);
    timelineHeading.append(timelineTitle, timelineActions);
    const timeline = this.document.createElement("ol");
    timeline.dataset.elfuiDevtools = "timeline";
    for (const event of timelineEvents.slice(-20).reverse()) {
      const item = this.document.createElement("li");
      item.textContent = `${event.layer}:${event.type} — ${event.summary}`;
      timeline.append(item);
    }
    timelineSection.append(timelineHeading, timeline);
    this.content.append(timelineSection);

    const compilerSection = this.renderCompilerState(compilerState);
    compilerSection.id = "elfui-devtools-view-compiler";
    compilerSection.setAttribute("role", "tabpanel");
    compilerSection.setAttribute(
      "aria-labelledby",
      "elfui-devtools-tab-compiler",
    );
    compilerSection.hidden = this.activeTab !== "compiler";
    const pipelineSection = this.renderPipeline(pipelineState);
    pipelineSection.id = "elfui-devtools-view-pipeline";
    pipelineSection.setAttribute("role", "tabpanel");
    pipelineSection.setAttribute(
      "aria-labelledby",
      "elfui-devtools-tab-pipeline",
    );
    pipelineSection.hidden = this.activeTab !== "pipeline";

    if (!visibleDetail) return;
    const detailNode = this.document.createElement("section");
    detailNode.className = "component-detail";
    detailNode.dataset.elfuiDevtools = "component-detail";
    detailNode.setAttribute("aria-label", "Component details");
    const detailHeading = this.document.createElement("h3");
    detailHeading.className = "detail-heading";
    detailHeading.textContent = visibleDetail.displayName;
    const detailGrid = this.document.createElement("div");
    detailGrid.className = "detail-grid";
    const source = visibleDetail.source
      ? `${visibleDetail.source.file}:${visibleDetail.source.line}:${visibleDetail.source.column}`
      : zhCN.unavailable;

    const appendDetailValue = (
      label: string,
      value: string,
      wide = false,
    ): void => {
      const block = this.document.createElement("section");
      block.className = "detail-block";
      if (wide) block.dataset.wide = "true";
      const title = this.document.createElement("h4");
      title.className = "detail-label";
      title.textContent = label;
      const content = this.document.createElement("pre");
      content.className = "detail-value";
      content.textContent = value;
      block.append(title, content);
      detailGrid.append(block);
    };

    appendDetailValue("属性 (Props)", valueText(visibleDetail.props));
    appendDetailValue("HTML 属性", valueText(visibleDetail.attrs));
    appendDetailValue("初始化 (Setup)", valueText(visibleDetail.setup));
    appendDetailValue("公开成员 (Expose)", valueText(visibleDetail.exposed));
    appendDetailValue("源码", source, true);
    appendDetailValue(
      "生命周期",
      [
        `更新次数：${visibleDetail.lifecycle.updateCount}`,
        `最后更新：${visibleDetail.lifecycle.lastUpdatedAt ?? zhCN.never}`,
        `错误：${
          visibleDetail.lifecycle.error
            ? valueText(visibleDetail.lifecycle.error)
            : zhCN.none
        }`,
      ].join("\n"),
      true,
    );

    const bindingsBlock = this.document.createElement("section");
    bindingsBlock.className = "detail-block";
    bindingsBlock.dataset.wide = "true";
    const bindingsTitle = this.document.createElement("h4");
    bindingsTitle.className = "detail-label";
    bindingsTitle.textContent = `绑定 (${visibleDetail.bindings.length})`;
    const bindings = this.document.createElement("ul");
    bindings.className = "detail-list";
    bindings.setAttribute("aria-label", "Component bindings");
    for (const binding of visibleDetail.bindings) {
      const item = this.document.createElement("li");
      const location = binding.source
        ? `${binding.source.file}:${binding.source.line}:${binding.source.column}`
        : zhCN.sourceUnavailable;
      item.textContent = binding.name;
      const metadata = this.document.createElement("small");
      metadata.textContent = `${location} · 运行 ${binding.runCount} 次 · 触发 ${binding.triggerCount} 次${
        binding.lastDuration === null ? "" : ` · ${binding.lastDuration}ms`
      }`;
      item.append(metadata);
      bindings.append(item);
    }
    if (!visibleDetail.bindings.length) {
      const empty = this.document.createElement("li");
      empty.textContent = zhCN.noBindingActivity;
      bindings.append(empty);
    }
    bindingsBlock.append(bindingsTitle, bindings);
    detailGrid.append(bindingsBlock);

    const diagnosticsBlock = this.document.createElement("section");
    diagnosticsBlock.className = "detail-block";
    diagnosticsBlock.dataset.wide = "true";
    const diagnosticsTitle = this.document.createElement("h4");
    diagnosticsTitle.className = "detail-label";
    diagnosticsTitle.textContent = `诊断 (${visibleDetail.diagnostics.length})`;
    const diagnostics = this.document.createElement("ul");
    diagnostics.className = "detail-list";
    diagnostics.setAttribute("aria-label", "Component diagnostics");
    for (const diagnostic of visibleDetail.diagnostics) {
      const item = this.document.createElement("li");
      item.dataset.severity = diagnostic.severity;
      item.textContent = `${diagnostic.code}: ${diagnostic.message}`;
      const context = [
        diagnostic.source
          ? `${diagnostic.source.file}:${diagnostic.source.line}:${diagnostic.source.column}`
          : "",
        diagnostic.hint ?? "",
      ].filter(Boolean);
      if (context.length) {
        const metadata = this.document.createElement("small");
        metadata.textContent = context.join(" · ");
        item.append(metadata);
      }
      diagnostics.append(item);
    }
    if (!visibleDetail.diagnostics.length) {
      const empty = this.document.createElement("li");
      empty.textContent = zhCN.noCompilerDiagnostics;
      diagnostics.append(empty);
    }
    diagnosticsBlock.append(diagnosticsTitle, diagnostics);
    detailGrid.append(diagnosticsBlock);
    detailNode.append(detailHeading, detailGrid);
    components.append(detailNode);
    if (visibleDetail.source) {
      const sourceLocation = visibleDetail.source;
      const openButton = this.document.createElement("button");
      openButton.className = "source-action";
      openButton.type = "button";
      openButton.textContent = zhCN.openInEditor;
      openButton.setAttribute("aria-label", "Open component source in editor");
      openButton.onclick = () => {
        openButton.disabled = true;
        void this.openSource(sourceLocation)
          .catch((error: unknown) => {
            openButton.title =
              error instanceof Error ? error.message : String(error);
          })
          .finally(() => {
            openButton.disabled = false;
          });
      };
      detailNode.append(openButton);
    }
  }

  private renderPipeline(state: PipelineStateSnapshot): HTMLElement {
    const section = this.document.createElement("section");
    section.className = "section";
    section.dataset.elfuiDevtools = "pipeline";

    const heading = this.document.createElement("div");
    heading.className = "section-heading";
    const title = this.document.createElement("p");
    title.className = "section-title";
    title.textContent = `${zhCN.dataPipeline} (${state.records.length}${state.droppedRecords ? `，已淘汰 ${state.droppedRecords} 条` : ""})`;
    const clear = this.document.createElement("button");
    clear.type = "button";
    clear.textContent = zhCN.clear;
    clear.setAttribute("aria-label", "Clear data pipeline");
    clear.onclick = () => {
      this.selectedPipelineId = null;
      if (this.rpc) {
        void this.rpc.clearPipeline().then(() => this.render());
      } else {
        this.bridge.clearPipeline();
        this.render();
      }
    };
    const actions = this.document.createElement("div");
    actions.className = "timeline-actions";
    actions.append(clear);
    heading.append(title, actions);
    section.append(heading);

    if (state.records.length === 0) {
      const empty = this.document.createElement("p");
      empty.className = "pipeline-empty";
      empty.textContent = zhCN.noPipelineRecords;
      section.append(empty);
      this.content.append(section);
      return section;
    }

    const selected: PipelineRecord =
      state.records.find((record) => record.id === this.selectedPipelineId) ??
      state.records.at(-1)!;
    const list = this.document.createElement("ul");
    list.className = "pipeline-list";
    for (const record of state.records.slice(-12).reverse()) {
      const item = this.document.createElement("li");
      const button = this.document.createElement("button");
      button.type = "button";
      button.className = "pipeline-record";
      button.dataset.pipelineRecordId = record.id;
      button.setAttribute("aria-pressed", String(record.id === selected.id));
      const stage = this.document.createElement("strong");
      stage.textContent = record.stage;
      button.append(
        stage,
        this.document.createTextNode(
          ` · ${record.source}/${record.kind}\n${record.summary}`,
        ),
      );
      button.onclick = () => {
        this.selectedPipelineId = record.id;
        this.render();
      };
      item.append(button);
      list.append(item);
    }
    section.append(list);

    const payload = this.document.createElement("pre");
    payload.className = "pipeline-json";
    payload.dataset.elfuiDevtools = "pipeline-json";
    payload.textContent = JSON.stringify(selected, null, 2);
    section.append(payload);
    this.content.append(section);
    return section;
  }

  private resetAIConversationState(): void {
    this.cancelActiveAIExecutions();
    this.aiPreparationGeneration += 1;
    this.aiExecutionGeneration += 1;
    this.preparingAIRequest = false;
    this.sourceReadStatus = "";
    this.aiConversations.clear();
    this.aiConversationIds.clear();
    this.aiRequests.clear();
    this.aiRequestHistory.clear();
    this.aiExecutionStates.clear();
    this.aiPatchCatalogs.clear();
    this.aiPatchCatalogStatus.clear();
    this.aiPatchVerifications.clear();
    this.aiPatchRollbacks.clear();
    this.aiPatchResultScreenshots.clear();
    this.aiVisualResultReviews.clear();
    this.aiVisualRoundDecisions.clear();
    this.aiPatchResultCapturePending.clear();
    this.aiPatchRollbackPending.clear();
    this.aiPatchCatalogLoading.clear();
    this.aiPatchDecisionPending.clear();
    this.aiPatchComments.clear();
    this.approvedSourceIds.clear();
    this.selectedSourceApprovals.clear();
    this.aiDraftId = null;
    this.retainCurrentScreenshotAssets();
  }

  private retainedAIRequestIds(): Set<string> {
    return new Set([
      ...Array.from(this.aiRequests.values(), (request) => request.id),
      ...Array.from(this.aiRequestHistory.values()).flatMap((requests) =>
        requests.map((request) => request.id),
      ),
    ]);
  }

  private pruneAIConversationAudit(
    previousRequestIds: ReadonlySet<string>,
    taskId: string,
  ): void {
    const retainedRequestIds = this.retainedAIRequestIds();
    const knownRequestIds = new Set(previousRequestIds);
    const proposalRequestIds = new Map<string, string>();
    const rememberProposal = (proposalId: string, requestId: string): void => {
      knownRequestIds.add(requestId);
      proposalRequestIds.set(proposalId, requestId);
    };

    for (const [requestId, catalog] of this.aiPatchCatalogs) {
      knownRequestIds.add(requestId);
      for (const review of catalog.proposals)
        rememberProposal(review.proposal.id, review.proposal.requestId);
    }
    for (const requestId of this.aiPatchCatalogStatus.keys())
      knownRequestIds.add(requestId);
    for (const [proposalId, verification] of this.aiPatchVerifications)
      rememberProposal(proposalId, verification.requestId);
    for (const [proposalId, rollback] of this.aiPatchRollbacks)
      rememberProposal(proposalId, rollback.requestId);
    for (const [proposalId, result] of this.aiPatchResultScreenshots)
      rememberProposal(proposalId, result.requestId);
    for (const [proposalId, review] of this.aiVisualResultReviews)
      rememberProposal(proposalId, review.requestId);
    for (const [proposalId, decisions] of this.aiVisualRoundDecisions) {
      const requestId = decisions.at(-1)?.requestId;
      if (requestId) rememberProposal(proposalId, requestId);
    }

    const evictedRequestIds = [...knownRequestIds].filter(
      (requestId) => !retainedRequestIds.has(requestId),
    );
    const retainedProposalIds = new Set(
      [...proposalRequestIds].flatMap(([proposalId, requestId]) =>
        retainedRequestIds.has(requestId) ? [proposalId] : [],
      ),
    );
    const knownProposalIds = new Set([
      ...proposalRequestIds.keys(),
      ...this.aiPatchComments.keys(),
      ...this.aiPatchDecisionPending,
    ]);
    const evictedProposalIds = [...knownProposalIds].filter(
      (proposalId) => !retainedProposalIds.has(proposalId),
    );
    const releasedResultScreenshotIds = evictedProposalIds.flatMap(
      (proposalId) => {
        const result = this.aiPatchResultScreenshots.get(proposalId);
        return result ? [result.asset.id] : [];
      },
    );

    for (const requestId of evictedRequestIds) {
      this.aiPatchCatalogs.delete(requestId);
      this.aiPatchCatalogStatus.delete(requestId);
      this.aiPatchCatalogLoading.delete(requestId);
    }
    for (const proposalId of evictedProposalIds) {
      this.aiPatchVerifications.delete(proposalId);
      this.aiPatchRollbacks.delete(proposalId);
      this.aiPatchResultScreenshots.delete(proposalId);
      this.aiVisualResultReviews.delete(proposalId);
      this.aiVisualRoundDecisions.delete(proposalId);
      this.aiPatchComments.delete(proposalId);
      this.aiPatchDecisionPending.delete(proposalId);
    }

    const retainedVerificationIds = new Set([
      ...Array.from(
        this.aiPatchVerifications.values(),
        (verification) => verification.verificationId,
      ),
      ...Array.from(
        this.aiPatchResultScreenshots.values(),
        (result) => result.verificationId,
      ),
      ...Array.from(
        this.aiVisualResultReviews.values(),
        (review) => review.verificationId,
      ),
    ]);
    for (const verificationId of this.aiPatchResultCapturePending)
      if (!retainedVerificationIds.has(verificationId))
        this.aiPatchResultCapturePending.delete(verificationId);

    const retainedApplicationIds = new Set([
      ...Array.from(
        this.aiPatchVerifications.values(),
        (verification) => verification.applicationId,
      ),
      ...Array.from(
        this.aiPatchRollbacks.values(),
        (rollback) => rollback.applicationId,
      ),
      ...Array.from(
        this.aiVisualResultReviews.values(),
        (review) => review.applicationId,
      ),
    ]);
    for (const applicationId of this.aiPatchRollbackPending)
      if (!retainedApplicationIds.has(applicationId))
        this.aiPatchRollbackPending.delete(applicationId);

    if (
      evictedRequestIds.length === 0 &&
      evictedProposalIds.length === 0 &&
      releasedResultScreenshotIds.length === 0
    )
      return;
    this.retainCurrentScreenshotAssets();
    this.bridge.recordPipeline({
      taskId,
      stage: "ai-request",
      source: "ai",
      kind: "ai.conversation.retention",
      summary:
        `Evicted ${evictedRequestIds.length} request audit(s), ` +
        `${evictedProposalIds.length} Patch audit(s), and ` +
        `${releasedResultScreenshotIds.length} detached result screenshot(s)`,
      payload: {
        schemaVersion: 1,
        policy: {
          maxConversations: MAX_AI_CONVERSATIONS,
          maxMessagesPerConversation: MAX_AI_MESSAGES_PER_CONVERSATION,
          maxRequestHistoryPerMode: MAX_AI_REQUEST_HISTORY,
          maxDecisionsPerProposal: MAX_AI_VISUAL_ROUND_DECISIONS,
        },
        retainedRequestIds: [...retainedRequestIds].slice(
          0,
          MAX_AI_RETENTION_AUDIT_IDS,
        ),
        evictedRequestIds: evictedRequestIds.slice(
          0,
          MAX_AI_RETENTION_AUDIT_IDS,
        ),
        evictedProposalIds: evictedProposalIds.slice(
          0,
          MAX_AI_RETENTION_AUDIT_IDS,
        ),
        releasedResultScreenshotIds: releasedResultScreenshotIds.slice(
          0,
          MAX_AI_RETENTION_AUDIT_IDS,
        ),
        sourceContentPersisted: false,
        screenshotDataPersisted: false,
      },
    });
  }

  private ensureAIConversation(draft: VisualDraft): AIConversation {
    const existingId = this.aiConversationIds.get(this.aiConversationMode);
    const existing = existingId
      ? this.aiConversations.getConversation(existingId)
      : null;
    if (existing) return existing;
    const conversation = this.aiConversations.createConversation({
      id: `conversation:${draft.id}:${this.aiConversationMode}`,
      mode: this.aiConversationMode,
      title:
        this.aiConversationMode === "explain" ? "解释视觉草稿" : "规划视觉修改",
    });
    this.aiConversationIds.set(this.aiConversationMode, conversation.id);
    this.bridge.recordPipeline({
      taskId: conversation.id,
      stage: "ai-request",
      source: "ai",
      kind: "ai.conversation.create",
      summary: `Created read-only ${conversation.mode} conversation`,
      payload: {
        conversationId: conversation.id,
        mode: conversation.mode,
        providerConnected: Boolean(this.aiExecutor),
      },
    });
    return conversation;
  }

  private sourceContextCandidates(draft: VisualDraft): SourceContextBlock[] {
    const candidates = new Map<string, SourceContextBlock>();
    for (const target of draft.targets) {
      if (!target.source) continue;
      const key =
        target.source.templateNodeId ??
        `${target.source.sourceId}:${target.source.component ?? ""}:${target.source.fragment ?? ""}`;
      candidates.set(`target:${key}`, {
        id: `source-context:${key}`,
        sourceId: target.source.sourceId,
        ...(target.source.component
          ? { component: target.source.component }
          : {}),
        ...(target.source.fragment ? { fragment: target.source.fragment } : {}),
        ...(target.source.templateNodeId
          ? { templateNodeId: target.source.templateNodeId }
          : {}),
        ...(target.source.range ? { range: { ...target.source.range } } : {}),
      });
    }
    const selectedSourceIds = new Set(
      [...candidates.values()].map((candidate) => candidate.sourceId),
    );
    const compilerSourceIds = [
      ...new Set(
        (this.latestCompilerState?.artifacts ?? []).map(
          (artifact) => artifact.sourceId,
        ),
      ),
    ].sort();
    for (const sourceId of compilerSourceIds) {
      if (selectedSourceIds.has(sourceId)) continue;
      candidates.set(`compiler:${sourceId}`, {
        id: `source-context:compiler:${sourceId}`,
        sourceId,
      });
    }
    return [...candidates.values()];
  }

  private async readSourceContextCandidates(
    draft: VisualDraft,
  ): Promise<SourceContextBlock[]> {
    const candidates = this.sourceContextCandidates(draft);
    const readableSourceIds = new Set([
      ...draft.targets.flatMap((target) =>
        target.source ? [target.source.sourceId] : [],
      ),
      ...this.approvedSourceIds,
    ]);
    const readable = candidates.filter((candidate) =>
      readableSourceIds.has(candidate.sourceId),
    );
    if (readable.length === 0) {
      this.sourceReadStatus = "当前请求没有可读取的源码范围。";
      return candidates;
    }
    if (!this.sourceReader) {
      this.sourceReadStatus = "源码读取适配器不可用，当前请求仅保留源码引用。";
      return candidates;
    }

    let loaded = 0;
    let failed = 0;
    const enriched = await Promise.all(
      candidates.map(async (candidate) => {
        if (!readableSourceIds.has(candidate.sourceId)) return candidate;
        const sourceRange = candidate.range
          ? {
              startLine: Math.max(1, candidate.range.line - 5),
              endLine: (candidate.range.endLine ?? candidate.range.line) + 5,
            }
          : undefined;
        try {
          const result = await this.sourceReader!({
            sourceId: candidate.sourceId,
            ...(sourceRange ? { range: sourceRange } : {}),
          });
          loaded += 1;
          this.bridge.recordPipeline({
            taskId: this.aiDraftId ?? draft.id,
            stage: "context-bundle",
            source: "context-builder",
            kind: "ai.context.source.read",
            summary: `Read ${result.characterCount} characters from ${result.sourceId}`,
            payload: {
              sourceId: result.sourceId,
              range: result.range,
              characterCount: result.characterCount,
              totalLines: result.totalLines,
              truncated: result.truncated,
            },
          });
          return { ...candidate, content: result.content };
        } catch (error) {
          failed += 1;
          this.bridge.recordPipeline({
            taskId: this.aiDraftId ?? draft.id,
            stage: "context-bundle",
            source: "context-builder",
            kind: "ai.context.source.read-failed",
            summary: `Failed to read ${candidate.sourceId}`,
            payload: { sourceId: candidate.sourceId },
            diagnostics: [
              {
                severity: "warning",
                code: "AI_SOURCE_READ_FAILED",
                message:
                  error instanceof Error
                    ? error.message
                    : "Unknown source read error",
              },
            ],
          });
          return candidate;
        }
      }),
    );
    this.sourceReadStatus =
      failed > 0
        ? `已读取 ${loaded} 个最小源码片段，${failed} 个读取失败并降级为引用。`
        : `已读取 ${loaded} 个最小源码片段；内容仍受预算和脱敏规则约束。`;
    return enriched;
  }

  private referencesForRequest(request: AIChangeRequest): AIReference[] {
    const references: AIReference[] = [];
    const fileIds = new Set<string>();
    for (const target of request.targets)
      references.push({
        kind: "visual-target",
        id: target.id,
        label: target.inspector.element.tag,
      });
    for (const target of request.targets) {
      const sourceId = target.source?.sourceId ?? target.inspector.sourceId;
      if (sourceId) fileIds.add(sourceId);
    }
    for (const intent of request.intents)
      references.push({ kind: "visual-intent", id: intent.id });
    for (const annotation of request.annotations)
      references.push({ kind: "annotation", id: annotation.id });
    for (const screenshot of request.screenshots)
      references.push({
        kind: "screenshot",
        id: screenshot.id,
        label: `${screenshot.phase}/${screenshot.kind}`,
      });
    for (const source of request.sourceContext) {
      fileIds.add(source.sourceId);
      references.push({
        kind: "source",
        id: source.id,
        label: source.sourceId,
      });
    }
    for (const sourceId of fileIds)
      references.push({ kind: "file", id: sourceId, label: sourceId });
    for (const diagnostic of request.diagnostics ?? [])
      references.push({
        kind: "diagnostic",
        id: diagnostic.id,
        label: `${diagnostic.severity} · ${diagnostic.code}`,
      });
    return references;
  }

  private diagnosticsForDraft(draft: VisualDraft): AIChangeDiagnostic[] {
    const diagnostics = new Map<string, AIChangeDiagnostic>();
    for (const target of draft.targets) {
      const detail = this.bridge.getComponentDetail(target.componentId);
      if (!detail) continue;
      for (const diagnostic of detail.diagnostics) {
        const sourceId =
          diagnostic.source?.file ??
          target.source?.sourceId ??
          target.inspector.sourceId;
        if (!sourceId) continue;
        const line = diagnostic.source?.line ?? 1;
        const column = diagnostic.source?.column ?? 1;
        const id = stableDiagnosticId(
          sourceId,
          diagnostic.code,
          line,
          column,
          diagnostic.message,
        );
        if (diagnostics.has(id)) continue;
        diagnostics.set(id, {
          id,
          severity: diagnostic.severity,
          code: diagnostic.code,
          message: diagnostic.message,
          sourceId,
          ...(diagnostic.source ? { source: { ...diagnostic.source } } : {}),
        });
      }
    }
    return [...diagnostics.values()];
  }

  private async loadAIProviderCatalog(): Promise<void> {
    if (!this.aiExecutor?.listProviders) return;
    try {
      const catalog = await this.aiExecutor.listProviders();
      this.aiProviderCatalog = catalog;
      let saved: Partial<PanelAIProviderSettings> | null = null;
      try {
        saved = JSON.parse(
          this.sessionStorage?.getItem(DEVTOOLS_AI_PROVIDER_STORAGE_KEY) ??
            "null",
        ) as Partial<PanelAIProviderSettings> | null;
      } catch {
        saved = null;
      }
      const provider =
        catalog.providers.find(
          (candidate) => candidate.id === saved?.providerId,
        ) ??
        catalog.providers.find(
          (candidate) => candidate.id === catalog.defaultProviderId,
        ) ??
        catalog.providers[0];
      if (provider) {
        this.aiProviderSettings = {
          providerId: provider.id,
          modelId:
            typeof saved?.modelId === "string" && saved.modelId
              ? saved.modelId
              : provider.defaultModelId,
          temperature:
            typeof saved?.temperature === "string" ? saved.temperature : "",
          reasoning:
            saved?.reasoning === "none" ||
            saved?.reasoning === "low" ||
            saved?.reasoning === "medium" ||
            saved?.reasoning === "high"
              ? saved.reasoning
              : "",
          maxOutputTokens:
            typeof saved?.maxOutputTokens === "string"
              ? saved.maxOutputTokens
              : "",
          endpoint: typeof saved?.endpoint === "string" ? saved.endpoint : "",
        };
      }
      this.aiProviderCatalogError = "";
    } catch (error) {
      this.aiProviderCatalogError =
        error instanceof Error ? error.message : "Provider 目录读取失败";
    }
    this.render();
  }

  private persistAIProviderSettings(): void {
    try {
      this.sessionStorage?.setItem(
        DEVTOOLS_AI_PROVIDER_STORAGE_KEY,
        JSON.stringify(this.aiProviderSettings),
      );
    } catch {
      // Session storage can be disabled by browser privacy settings.
    }
  }

  private selectedAIProvider(): AIProviderDescriptor | undefined {
    return this.aiProviderCatalog?.providers.find(
      (provider) => provider.id === this.aiProviderSettings.providerId,
    );
  }

  private selectedAIProviderCapabilities(): AIProviderCapabilities | null {
    const provider = this.selectedAIProvider();
    if (!provider) return null;
    const model = provider.models.find(
      (candidate) => candidate.id === this.aiProviderSettings.modelId,
    );
    return { ...provider.capabilities, ...model?.capabilities };
  }

  private currentAIProviderSelection(): AIProviderSelection | undefined {
    const provider = this.selectedAIProvider();
    if (!provider) return undefined;
    const temperature = Number(this.aiProviderSettings.temperature);
    const maxOutputTokens = Number(this.aiProviderSettings.maxOutputTokens);
    return {
      providerId: provider.id,
      settings: {
        modelId: this.aiProviderSettings.modelId || provider.defaultModelId,
        ...(this.aiProviderSettings.endpoint
          ? { endpoint: this.aiProviderSettings.endpoint }
          : {}),
        ...(this.aiProviderSettings.temperature && Number.isFinite(temperature)
          ? { temperature }
          : {}),
        ...(this.aiProviderSettings.reasoning
          ? { reasoning: this.aiProviderSettings.reasoning }
          : {}),
        ...(this.aiProviderSettings.maxOutputTokens &&
        Number.isSafeInteger(maxOutputTokens)
          ? { maxOutputTokens }
          : {}),
      },
    };
  }

  private cancelActiveAIExecutions(): void {
    if (!this.aiExecutor) return;
    for (const state of this.aiExecutionStates.values()) {
      if (state.status !== "pending" && state.status !== "streaming") continue;
      void this.aiExecutor.cancel(state.executionId).catch(() => undefined);
    }
  }

  private recordAIExecutionEvent(
    request: AIChangeRequest,
    event: AIExecutionEvent,
  ): void {
    const isPatchVerification = event.type === "patch-verification";
    this.bridge.recordPipeline({
      taskId: request.id,
      stage: isPatchVerification ? "verification" : "provider-request",
      source: isPatchVerification ? "verification" : "provider",
      kind: isPatchVerification
        ? `patch.verification.${event.verification.status}`
        : `ai.execution.${event.type}`,
      summary: isPatchVerification
        ? event.verification.status === "verified"
          ? `Patch ${event.verification.proposalId} applied and verified`
          : `Patch ${event.verification.proposalId} failed verification and was rolled back`
        : `AI execution ${event.executionId} ${event.type}`,
      payload:
        event.type === "text-delta"
          ? {
              executionId: event.executionId,
              sequence: event.sequence,
              characterCount: event.text.length,
            }
          : event.type === "reference"
            ? {
                executionId: event.executionId,
                sequence: event.sequence,
                reference: event.reference,
              }
            : event.type === "tool-call"
              ? {
                  executionId: event.executionId,
                  sequence: event.sequence,
                  callId: event.call.id,
                  name: event.call.name,
                  argumentCharacters: event.call.arguments.length,
                }
              : event.type === "structured-output"
                ? {
                    executionId: event.executionId,
                    sequence: event.sequence,
                    outputCharacters: JSON.stringify(event.value).length,
                  }
                : event.type === "tool-result"
                  ? {
                      executionId: event.executionId,
                      sequence: event.sequence,
                      callId: event.callId,
                      name: event.name,
                      status: event.status,
                      outputCharacters: event.outputCharacters,
                      ...(event.error ? { error: event.error } : {}),
                    }
                  : event.type === "patch-verification"
                    ? {
                        executionId: event.executionId,
                        sequence: event.sequence,
                        ...event.verification,
                      }
                    : event,
      ...(event.type === "patch-verification" &&
      event.verification.diagnostics.length > 0
        ? {
            diagnostics: event.verification.diagnostics.map((diagnostic) => ({
              severity: diagnostic.severity,
              code: diagnostic.code ?? "PATCH_VERIFICATION_DIAGNOSTIC",
              message: diagnostic.message,
            })),
          }
        : event.type === "failed"
          ? {
              diagnostics: [
                {
                  severity: "error" as const,
                  code: event.error.code,
                  message: event.error.message,
                },
              ],
            }
          : {}),
    });
  }

  private async executeAIConversation(
    request: AIChangeRequest,
    retryOf?: PanelAIExecutionState,
  ): Promise<void> {
    if (!this.aiExecutor) return;
    const conversationId = this.aiConversationIds.get(this.aiConversationMode);
    if (!conversationId) return;
    const current = this.aiExecutionStates.get(this.aiConversationMode);
    if (
      current &&
      (current.status === "pending" || current.status === "streaming")
    )
      return;

    const executionId = `ai-execution:${request.id}:${this.aiConversationMode}:${this.nextAIExecutionId++}`;
    const message = this.aiConversations.appendMessage(conversationId, {
      role: "assistant",
      status: "pending",
      references: [],
    });
    const providerSelection =
      retryOf?.provider ?? this.currentAIProviderSelection();
    const state: PanelAIExecutionState = {
      executionId,
      messageId: message.id,
      requestId: request.id,
      status: "pending",
      cancelRequested: false,
      ...(providerSelection ? { provider: providerSelection } : {}),
    };
    this.aiExecutionStates.set(this.aiConversationMode, state);
    const mode = this.aiConversationMode;
    const generation = this.aiExecutionGeneration;
    this.bridge.recordPipeline({
      taskId: request.id,
      stage: "provider-request",
      source: "provider",
      kind: retryOf ? "ai.execution.retry" : "ai.execution.start",
      summary: `${retryOf ? "Retrying" : "Starting"} read-only ${mode} execution`,
      payload: {
        executionId,
        conversationId,
        messageId: message.id,
        requestId: request.id,
        mode,
        provider: state.provider ?? "node-gateway-default",
        ...(retryOf ? { retryOfExecutionId: retryOf.executionId } : {}),
      },
    });
    this.render();

    try {
      if (this.aiExecutor.uploadScreenshots && this.screenshots) {
        const requestedScreenshotIds = new Set(
          request.screenshots.map((screenshot) => screenshot.id),
        );
        const screenshotAssets = this.screenshots
          .getAssets()
          .filter((asset) => requestedScreenshotIds.has(asset.id));
        await this.aiExecutor.uploadScreenshots(screenshotAssets);
        if (screenshotAssets.length > 0)
          this.bridge.recordPipeline({
            taskId: request.id,
            stage: "provider-request",
            source: "provider",
            kind: "ai.screenshot.upload",
            summary: `Uploaded ${screenshotAssets.length} bounded screenshot assets to Node`,
            payload: {
              executionId,
              screenshotIds: screenshotAssets.map((asset) => asset.id),
              byteLength: screenshotAssets.reduce(
                (total, asset) => total + asset.byteLength,
                0,
              ),
            },
          });
      }
      for await (const event of this.aiExecutor.execute({
        schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
        executionId,
        conversationId,
        assistantMessageId: message.id,
        mode,
        changeRequest: withoutSourceContent(request),
        ...(state.provider ? { provider: state.provider } : {}),
        ...(retryOf ? { retryOfExecutionId: retryOf.executionId } : {}),
      })) {
        const active = this.aiExecutionStates.get(mode);
        if (
          generation !== this.aiExecutionGeneration ||
          active?.executionId !== executionId
        )
          return;
        this.recordAIExecutionEvent(request, event);
        if (event.type === "started") {
          active.status = "streaming";
          this.aiConversations.updateMessage(conversationId, message.id, {
            status: "streaming",
          });
          this.sourceReadStatus =
            `${event.providerId}/${event.modelId ?? "default"} · Node Gateway 已装配 ${event.context.sourceBlocks} 个源码片段、` +
            `${event.context.sourceCharacters} 字符；脱敏 ${event.context.redactions} 处。`;
          if (event.negotiation?.notices.length)
            this.sourceReadStatus += ` ${event.negotiation.notices.map((notice) => notice.message).join(" ")}`;
        } else if (event.type === "text-delta") {
          active.status = "streaming";
          this.aiConversations.updateMessage(conversationId, message.id, {
            appendContent: event.text,
            status: "streaming",
          });
        } else if (event.type === "reference") {
          active.status = "streaming";
          const currentMessage = this.aiConversations
            .getConversation(conversationId)
            ?.messages.find((candidate) => candidate.id === message.id);
          const references = currentMessage?.references ?? [];
          const key = `${event.reference.kind}:${event.reference.id}`;
          if (
            references.length < MAX_AI_REPLY_REFERENCES &&
            !references.some(
              (reference) => `${reference.kind}:${reference.id}` === key,
            )
          )
            this.aiConversations.updateMessage(conversationId, message.id, {
              references: [...references, event.reference],
              status: "streaming",
            });
        } else if (event.type === "tool-call") {
          active.status = "streaming";
          this.sourceReadStatus = `Provider 请求受限工具 ${event.call.name}；正在等待 Node 范围校验。`;
        } else if (event.type === "tool-result") {
          active.status = "streaming";
          this.sourceReadStatus =
            event.status === "completed"
              ? event.name === "patch.applyApproved"
                ? "Node 已完成批准 Patch 的应用事务，正在读取验证结果。"
                : `Node 已在批准范围内完成只读工具 ${event.name}。`
              : `受限工具 ${event.name} 失败：${event.error?.message ?? "未知错误"}`;
          if (event.status === "completed" && event.name === "patch.prepare")
            void this.loadPatchProposalCatalog(request.id);
        } else if (event.type === "patch-verification") {
          active.status = "streaming";
          const previousResult = this.aiPatchResultScreenshots.get(
            event.verification.proposalId,
          );
          if (
            previousResult &&
            previousResult.verificationId !== event.verification.verificationId
          ) {
            this.aiPatchResultScreenshots.delete(event.verification.proposalId);
            this.aiVisualResultReviews.delete(event.verification.proposalId);
            this.aiVisualRoundDecisions.delete(event.verification.proposalId);
            this.retainCurrentScreenshotAssets();
          }
          const previousReview = this.aiVisualResultReviews.get(
            event.verification.proposalId,
          );
          if (
            previousReview &&
            previousReview.verificationId !== event.verification.verificationId
          ) {
            this.aiVisualResultReviews.delete(event.verification.proposalId);
            this.aiVisualRoundDecisions.delete(event.verification.proposalId);
          }
          this.aiPatchVerifications.set(
            event.verification.proposalId,
            event.verification,
          );
          this.aiPatchRollbacks.delete(event.verification.proposalId);
          this.sourceReadStatus =
            event.verification.status === "verified"
              ? `Patch ${event.verification.proposalId} 已应用，并通过 ${event.verification.checks.filter((check) => check.status === "passed").length} 项 Node 验证。`
              : `Patch ${event.verification.proposalId} 在 ${event.verification.failedStep ?? "verification"} 阶段失败，原文件已恢复。`;
        } else if (event.type === "structured-output") {
          active.status = "streaming";
          this.aiConversations.updateMessage(conversationId, message.id, {
            appendContent: `\n\n${JSON.stringify(event.value, null, 2)}`,
            status: "streaming",
          });
        } else if (event.type === "completed") {
          active.status = "completed";
          const completedMessage = this.aiConversations.updateMessage(
            conversationId,
            message.id,
            {
              status: "completed",
              error: null,
            },
          );
          this.bridge.recordPipeline({
            taskId: request.id,
            stage: "provider-request",
            source: "provider",
            kind: "ai.execution.result",
            summary: `Stored completed read-only ${mode} result`,
            payload: {
              executionId,
              conversationId,
              messageId: completedMessage.id,
              requestId: request.id,
              mode,
              content: completedMessage.content,
              references: completedMessage.references,
            },
          });
          if (mode === "plan") void this.loadPatchProposalCatalog(request.id);
        } else if (event.type === "cancelled") {
          active.status = "cancelled";
          this.aiConversations.updateMessage(conversationId, message.id, {
            status: "cancelled",
          });
        } else {
          active.status = "failed";
          this.aiConversations.updateMessage(conversationId, message.id, {
            status: "failed",
            error: event.error,
          });
        }
        this.render();
      }
    } catch (error) {
      const active = this.aiExecutionStates.get(mode);
      if (
        generation !== this.aiExecutionGeneration ||
        active?.executionId !== executionId
      )
        return;
      const messageText =
        error instanceof Error ? error.message : "Unknown AI transport error";
      active.status = "failed";
      this.aiConversations.updateMessage(conversationId, message.id, {
        status: "failed",
        error: {
          code: "AI_EXECUTION_TRANSPORT_FAILED",
          message: messageText,
          retryable: true,
        },
      });
      this.bridge.recordPipeline({
        taskId: request.id,
        stage: "provider-request",
        source: "provider",
        kind: "ai.execution.transport-failed",
        summary: `AI execution ${executionId} transport failed`,
        payload: { executionId, requestId: request.id },
        diagnostics: [
          {
            severity: "error",
            code: "AI_EXECUTION_TRANSPORT_FAILED",
            message: messageText,
          },
        ],
      });
      this.render();
    }
  }

  private async cancelAIExecution(
    request: AIChangeRequest,
    state: PanelAIExecutionState,
  ): Promise<void> {
    if (
      !this.aiExecutor ||
      (state.status !== "pending" && state.status !== "streaming") ||
      state.cancelRequested
    )
      return;
    state.cancelRequested = true;
    this.bridge.recordPipeline({
      taskId: request.id,
      stage: "provider-request",
      source: "provider",
      kind: "ai.execution.cancel-request",
      summary: `Cancelling AI execution ${state.executionId}`,
      payload: {
        executionId: state.executionId,
        requestId: request.id,
      },
    });
    this.render();
    try {
      await this.aiExecutor.cancel(state.executionId);
    } catch (error) {
      state.cancelRequested = false;
      this.sourceReadStatus =
        error instanceof Error ? `取消失败：${error.message}` : "取消失败。";
      this.render();
    }
  }

  private async loadPatchProposalCatalog(requestId: string): Promise<void> {
    if (
      !this.aiExecutor?.listPatchProposals ||
      this.aiPatchCatalogLoading.has(requestId)
    )
      return;
    this.aiPatchCatalogLoading.add(requestId);
    this.aiPatchCatalogStatus.set(requestId, "正在读取 Node Patch 提案…");
    this.render();
    try {
      const catalog = await this.aiExecutor.listPatchProposals(requestId);
      if (!this.retainedAIRequestIds().has(requestId)) return;
      this.aiPatchCatalogs.set(requestId, catalog);
      this.aiPatchCatalogStatus.set(
        requestId,
        catalog.proposals.length > 0
          ? `Node 已返回 ${catalog.proposals.length} 个不可变 PatchProposal。`
          : "当前请求尚无 PatchProposal。",
      );
    } catch (error) {
      if (this.retainedAIRequestIds().has(requestId))
        this.aiPatchCatalogStatus.set(
          requestId,
          error instanceof Error
            ? `Patch 提案读取失败：${error.message}`
            : "Patch 提案读取失败。",
        );
    } finally {
      this.aiPatchCatalogLoading.delete(requestId);
      this.render();
    }
  }

  private async decidePatchProposal(
    request: AIChangeRequest,
    review: PatchProposalReview,
    decision: PatchApprovalDecision,
  ): Promise<void> {
    if (
      !this.aiExecutor?.decidePatchProposal ||
      review.status !== "pending" ||
      this.aiPatchDecisionPending.has(review.proposal.id)
    )
      return;
    const comment = this.aiPatchComments.get(review.proposal.id)?.trim();
    if (decision === "revise" && !comment) return;
    this.aiPatchDecisionPending.add(review.proposal.id);
    this.aiPatchCatalogStatus.set(
      request.id,
      `正在提交 ${review.proposal.id} 的用户决策…`,
    );
    this.render();
    try {
      const decided = await this.aiExecutor.decidePatchProposal({
        schemaVersion: DEVTOOLS_AI_EXECUTION_SCHEMA_VERSION,
        proposalId: review.proposal.id,
        requestId: request.id,
        decision,
        ...(comment ? { comment } : {}),
      });
      const catalog = this.aiPatchCatalogs.get(request.id);
      if (catalog)
        this.aiPatchCatalogs.set(request.id, {
          ...catalog,
          proposals: catalog.proposals.map((candidate) =>
            candidate.proposal.id === decided.proposal.id ? decided : candidate,
          ),
        });
      const approval = decided.decisions.at(-1)!;
      this.aiPatchCatalogStatus.set(
        request.id,
        decision === "approve"
          ? "提案已批准，但尚未应用到文件。"
          : decision === "reject"
            ? "提案已拒绝，文件保持不变。"
            : "提案已带评论退回，等待 AI 生成新的 Proposal ID。",
      );
      this.bridge.recordPipeline({
        taskId: request.id,
        stage: "patch-proposal",
        source: "patch-engine",
        kind: `ai.patch.proposal.${decision}`,
        summary: `Recorded ${decision} decision for ${review.proposal.id}`,
        payload: {
          requestId: request.id,
          proposalId: review.proposal.id,
          approvalId: approval.id,
          decision,
          status: decided.status,
          approvedFiles: approval.approvedFiles,
          approvedFileHashes: approval.approvedFileHashes,
          ...(approval.comment ? { comment: approval.comment } : {}),
          applied: false,
        },
      });
    } catch (error) {
      this.aiPatchCatalogStatus.set(
        request.id,
        error instanceof Error
          ? `Patch 决策失败：${error.message}`
          : "Patch 决策失败。",
      );
    } finally {
      this.aiPatchDecisionPending.delete(review.proposal.id);
      this.render();
    }
  }

  private async rollbackPatchApplication(
    request: AIChangeRequest,
    verification: AIPatchVerificationAudit,
    visualReview?: AIVisualResultReview,
  ): Promise<void> {
    if (
      !this.aiExecutor?.rollbackPatchApplication ||
      verification.status !== "verified" ||
      verification.requestId !== request.id ||
      this.aiPatchRollbackPending.has(verification.applicationId)
    )
      return;
    this.aiPatchRollbackPending.add(verification.applicationId);
    this.sourceReadStatus = `正在撤销 ${verification.proposalId} 的已验证应用…`;
    this.render();
    try {
      const rollback = await this.aiExecutor.rollbackPatchApplication({
        schemaVersion: DEVTOOLS_AI_AGENT_SCHEMA_VERSION,
        applicationId: verification.applicationId,
        verificationId: verification.verificationId,
        proposalId: verification.proposalId,
        requestId: verification.requestId,
      });
      this.aiPatchRollbacks.set(rollback.proposalId, rollback);
      this.sourceReadStatus = `Patch ${rollback.proposalId} 已恢复 ${rollback.files.length} 个文件；再次执行前仍会重新校验批准 hash。`;
      this.bridge.recordPipeline({
        taskId: request.id,
        stage: "verification",
        source: "patch-engine",
        kind: "patch.rollback.user",
        summary: `User rolled back verified Patch ${rollback.proposalId}`,
        payload: rollback,
      });
      const decisionReview =
        visualReview ?? this.aiVisualResultReviews.get(verification.proposalId);
      if (decisionReview)
        this.recordVisualRoundDecision(decisionReview, "revert");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Patch 撤销失败。";
      this.sourceReadStatus = message;
      this.bridge.recordPipeline({
        taskId: request.id,
        stage: "verification",
        source: "patch-engine",
        kind: "patch.rollback.failed",
        summary: `Failed to roll back verified Patch ${verification.proposalId}`,
        payload: {
          applicationId: verification.applicationId,
          verificationId: verification.verificationId,
          proposalId: verification.proposalId,
          requestId: verification.requestId,
        },
        diagnostics: [
          {
            severity: "error",
            code: "PATCH_ROLLBACK_FAILED",
            message,
          },
        ],
      });
    } finally {
      this.aiPatchRollbackPending.delete(verification.applicationId);
      this.render();
    }
  }

  private async prepareAIConversationRequest(
    draft: VisualDraft,
    reason: "prepare" | "scope-approval" | "follow-up" | "regenerate",
    followUp?: AIChangeFollowUpContext,
  ): Promise<void> {
    if (this.preparingAIRequest) return;
    if ((reason === "follow-up" || reason === "regenerate") && !followUp)
      return;
    if (this.aiDraftId !== draft.id) {
      this.resetAIConversationState();
      this.aiDraftId = draft.id;
    }
    const previousRequestIds = this.retainedAIRequestIds();
    const generation = ++this.aiPreparationGeneration;
    this.preparingAIRequest = true;
    this.sourceReadStatus = "正在读取已获准的最小源码范围…";
    this.render();
    try {
      const sourceContext = await this.readSourceContextCandidates(draft);
      if (generation !== this.aiPreparationGeneration) return;
      const conversation = this.ensureAIConversation(draft);
      const request = this.aiContext.build({
        conversationId: conversation.id,
        sourceContext,
        diagnostics: this.diagnosticsForDraft(draft),
        approvedSourceIds: [...this.approvedSourceIds],
        ...(this.screenshots
          ? { screenshots: this.screenshots.getAssets() }
          : {}),
        ...(followUp
          ? {
              followUp,
              additionalScreenshotIds: [followUp.resultScreenshotId],
            }
          : {}),
      });
      const attachment = this.aiConversations.addAttachment(conversation.id, {
        id: `attachment:context:${request.id}`,
        kind: "context",
        referenceId: request.id,
        name: "AIChangeRequest",
        mimeType: "application/json",
      });
      const message = this.aiConversations.appendMessage(conversation.id, {
        role: "user",
        status: "completed",
        content:
          reason === "scope-approval"
            ? "已批准所选源码范围，并重新冻结当前视觉草稿的上下文。"
            : reason === "regenerate"
              ? `上一轮结果已经回退；请针对 ${followUp?.references.length ?? 0} 项视觉目标重新生成方案。`
              : reason === "follow-up"
                ? `继续处理上一轮 ${followUp?.references.length ?? 0} 项未满足或部分满足的视觉目标。`
                : this.aiConversationMode === "explain"
                  ? "解释当前视觉草稿涉及的界面结构与修改影响。"
                  : "基于当前视觉草稿整理可审核的实现方案。",
        attachmentIds: [attachment.id],
        references: this.referencesForRequest(request),
      });
      if (reason === "follow-up" || reason === "regenerate") {
        const previousRequest = this.aiRequests.get(this.aiConversationMode);
        if (previousRequest) {
          const history = [
            ...(this.aiRequestHistory.get(this.aiConversationMode) ?? []),
            previousRequest,
          ].slice(-MAX_AI_REQUEST_HISTORY);
          this.aiRequestHistory.set(this.aiConversationMode, history);
        }
      }
      this.aiRequests.set(this.aiConversationMode, request);
      this.pruneAIConversationAudit(previousRequestIds, request.id);
      if (this.aiConversationMode === "plan")
        void this.loadPatchProposalCatalog(request.id);
      this.selectedSourceApprovals.clear();
      this.bridge.recordPipeline({
        taskId: request.id,
        stage: "ai-request",
        source: "ai",
        kind: "ai.conversation.message",
        summary: `Added ${this.aiConversationMode} context message to ${conversation.id}`,
        payload: {
          conversationId: conversation.id,
          mode: this.aiConversationMode,
          requestId: request.id,
          attachment,
          message,
          providerConnected: Boolean(this.aiExecutor),
        },
      });
      if (request.followUp)
        this.bridge.recordPipeline({
          taskId: request.id,
          stage: "ai-request",
          source: "visual-tools",
          kind: "ai.context.follow-up",
          summary: `Prepared a visual follow-up with ${request.followUp.references.length} unresolved references`,
          payload: request.followUp,
        });
    } catch (error) {
      if (generation !== this.aiPreparationGeneration) return;
      this.sourceReadStatus =
        error instanceof Error
          ? `请求生成失败：${error.message}`
          : "请求生成失败。";
      this.bridge.recordPipeline({
        taskId: this.aiDraftId ?? draft.id,
        stage: "ai-request",
        source: "ai",
        kind: "ai.request.failed",
        summary: "Failed to prepare AI change request",
        payload: { draftId: draft.id },
        diagnostics: [
          {
            severity: "error",
            code: "AI_REQUEST_PREPARE_FAILED",
            message:
              error instanceof Error ? error.message : "Unknown request error",
          },
        ],
      });
    } finally {
      if (generation === this.aiPreparationGeneration) {
        this.preparingAIRequest = false;
        this.render();
      }
    }
  }

  private renderAIProviderConfiguration(): HTMLElement | null {
    if (!this.aiExecutor) return null;
    const container = this.document.createElement("div");
    container.className = "ai-provider-config";
    container.dataset.elfuiDevtools = "ai-provider-config";
    if (!this.aiProviderCatalog) {
      const status = this.document.createElement("p");
      status.className = "ai-provider-capabilities";
      status.textContent =
        this.aiProviderCatalogError || "正在读取 Provider 目录…";
      container.append(status);
      return container;
    }
    const provider = this.selectedAIProvider();
    if (!provider) return container;

    const providerLabel = this.document.createElement("label");
    providerLabel.append(this.document.createTextNode("Provider"));
    const providerSelect = this.document.createElement("select");
    providerSelect.setAttribute("aria-label", "AI provider");
    for (const descriptor of this.aiProviderCatalog.providers) {
      const option = this.document.createElement("option");
      option.value = descriptor.id;
      option.textContent = descriptor.label;
      option.selected = descriptor.id === provider.id;
      providerSelect.append(option);
    }
    providerSelect.onchange = () => {
      const next = this.aiProviderCatalog?.providers.find(
        (candidate) => candidate.id === providerSelect.value,
      );
      if (!next) return;
      this.aiProviderSettings.providerId = next.id;
      this.aiProviderSettings.modelId = next.defaultModelId;
      this.aiProviderSettings.temperature = "";
      this.aiProviderSettings.reasoning = "";
      this.aiProviderSettings.endpoint = "";
      this.persistAIProviderSettings();
      this.render();
    };
    providerLabel.append(providerSelect);

    const modelLabel = this.document.createElement("label");
    modelLabel.append(this.document.createTextNode("Model ID"));
    const modelInput = this.document.createElement("input");
    modelInput.setAttribute("aria-label", "AI model ID");
    modelInput.setAttribute("list", "elfui-ai-provider-models");
    modelInput.value = this.aiProviderSettings.modelId;
    modelInput.onchange = () => {
      this.aiProviderSettings.modelId =
        modelInput.value.trim() || provider.defaultModelId;
      this.persistAIProviderSettings();
      this.render();
    };
    const models = this.document.createElement("datalist");
    models.id = "elfui-ai-provider-models";
    for (const model of provider.models) {
      const option = this.document.createElement("option");
      option.value = model.id;
      option.label = model.label;
      models.append(option);
    }
    modelLabel.append(modelInput, models);
    container.append(providerLabel, modelLabel);

    const capabilities = this.selectedAIProviderCapabilities();
    const addInput = (
      labelText: string,
      ariaLabel: string,
      value: string,
      onValue: (value: string) => void,
      options: {
        type?: string;
        min?: string;
        max?: string;
        disabled?: boolean;
        placeholder?: string;
      } = {},
    ): void => {
      const label = this.document.createElement("label");
      label.append(this.document.createTextNode(labelText));
      const input = this.document.createElement("input");
      input.type = options.type ?? "text";
      input.setAttribute("aria-label", ariaLabel);
      input.value = value;
      input.disabled = options.disabled ?? false;
      if (options.min) input.min = options.min;
      if (options.max) input.max = options.max;
      if (options.placeholder) input.placeholder = options.placeholder;
      input.onchange = () => {
        onValue(input.value.trim());
        this.persistAIProviderSettings();
      };
      label.append(input);
      container.append(label);
    };
    addInput(
      "Temperature",
      "AI temperature",
      this.aiProviderSettings.temperature,
      (value) => {
        this.aiProviderSettings.temperature = value;
      },
      {
        type: "number",
        min: "0",
        max: "2",
        disabled: capabilities?.temperature !== true,
        placeholder: "Provider 默认值",
      },
    );

    const reasoningLabel = this.document.createElement("label");
    reasoningLabel.append(this.document.createTextNode("Reasoning"));
    const reasoning = this.document.createElement("select");
    reasoning.setAttribute("aria-label", "AI reasoning effort");
    reasoning.disabled = capabilities?.reasoning !== true;
    for (const [value, label] of [
      ["", "Provider 默认值"],
      ["none", "None"],
      ["low", "Low"],
      ["medium", "Medium"],
      ["high", "High"],
    ] as const) {
      const option = this.document.createElement("option");
      option.value = value;
      option.textContent = label;
      option.selected = value === this.aiProviderSettings.reasoning;
      reasoning.append(option);
    }
    reasoning.onchange = () => {
      this.aiProviderSettings.reasoning = reasoning.value as
        | ""
        | "none"
        | "low"
        | "medium"
        | "high";
      this.persistAIProviderSettings();
    };
    reasoningLabel.append(reasoning);
    container.append(reasoningLabel);

    addInput(
      "Max output",
      "AI max output tokens",
      this.aiProviderSettings.maxOutputTokens,
      (value) => {
        this.aiProviderSettings.maxOutputTokens = value;
      },
      {
        type: "number",
        min: "1",
        max: "1000000",
        placeholder: "Provider 默认值",
      },
    );
    addInput(
      "Endpoint",
      "AI endpoint",
      this.aiProviderSettings.endpoint,
      (value) => {
        this.aiProviderSettings.endpoint = value;
      },
      {
        disabled: provider.allowsEndpointOverride !== true,
        placeholder:
          provider.allowsEndpointOverride === true
            ? "https://…"
            : "由 Node 配置",
      },
    );

    const capabilityText = this.document.createElement("p");
    capabilityText.className = "ai-provider-capabilities";
    capabilityText.setAttribute("role", "status");
    capabilityText.textContent = capabilities
      ? [
          `文本 ${capabilities.text ? "支持" : "不支持"}`,
          `图片 ${capabilities.imageInput ? "支持" : "降级"}`,
          `工具 ${capabilities.toolCalling ? "支持" : "降级"}`,
          `结构化输出 ${capabilities.structuredOutput ? "支持" : "降级"}`,
        ].join(" · ")
      : "自定义 Model ID 使用 Provider 默认能力声明。";
    container.append(capabilityText);
    return container;
  }

  private renderPatchScreenshotComparison(
    request: AIChangeRequest,
    result: PanelPatchResultScreenshot,
  ): HTMLElement {
    const comparison = this.document.createElement("section");
    comparison.className = "ai-patch-comparison";
    comparison.dataset.elfuiDevtools = "ai-patch-comparison";
    comparison.setAttribute("aria-label", "Patch screenshot comparison");
    const title = this.document.createElement("p");
    title.className = "ai-patch-comparison-title";
    title.textContent = "修改结果对照";
    comparison.append(title);

    const linkedSourceIds = new Set(result.sourceScreenshotIds);
    const inputScreenshotFor = (
      phase: Extract<ScreenshotPhase, "before" | "desired">,
    ): ScreenshotAsset | null =>
      [...request.screenshots]
        .reverse()
        .find(
          (asset) => asset.phase === phase && linkedSourceIds.has(asset.id),
        ) ?? null;
    const phases: ReadonlyArray<{
      phase: ScreenshotPhase;
      label: string;
      asset: ScreenshotAsset | null;
    }> = [
      {
        phase: "before",
        label: zhCN.before,
        asset: inputScreenshotFor("before"),
      },
      {
        phase: "desired",
        label: zhCN.desired,
        asset: inputScreenshotFor("desired"),
      },
      { phase: "result", label: zhCN.result, asset: result.asset },
    ];

    for (const phase of phases) {
      const slot = this.document.createElement("div");
      slot.className = "ai-patch-comparison-phase";
      slot.dataset.elfuiDevtools = `ai-patch-comparison-${phase.phase}`;
      slot.dataset.phase = phase.phase;
      const heading = this.document.createElement("h5");
      heading.textContent = phase.label;
      slot.append(heading);
      if (!phase.asset) {
        const missing = this.document.createElement("div");
        missing.className = "ai-patch-comparison-missing";
        missing.textContent = `本轮未捕获${phase.label}截图`;
        slot.append(missing);
        comparison.append(slot);
        continue;
      }
      const captured = this.screenshots?.getAsset(phase.asset.id);
      if (captured) {
        const image = this.document.createElement("img");
        image.alt = `${phase.label}截图 ${phase.asset.id}`;
        image.src = captured.dataUrl;
        slot.append(image);
      } else {
        const unavailable = this.document.createElement("div");
        unavailable.className = "ai-patch-comparison-missing";
        unavailable.textContent = "截图元数据可用，本地图片已释放";
        slot.append(unavailable);
      }
      const metadata = this.document.createElement("p");
      metadata.textContent =
        `${phase.asset.kind} · ${phase.asset.width}×${phase.asset.height} · ` +
        phase.asset.id;
      slot.append(metadata);
      comparison.append(slot);
    }
    return comparison;
  }

  private describeVisualResultReviewItem(
    request: AIChangeRequest,
    item: AIVisualResultReviewItem,
  ): { title: string; detail: string } {
    if (item.kind === "visual-intent") {
      const intent = request.intents.find(
        (candidate) => candidate.id === item.referenceId,
      );
      if (!intent)
        return {
          title: `修改意图 · ${item.referenceId}`,
          detail: "原始意图已不在当前请求中",
        };
      const target = request.targets.find(
        (candidate) => candidate.id === intent.targetId,
      );
      const typeLabel: Record<typeof intent.type, string> = {
        style: "样式",
        move: "移动",
        resize: "缩放",
        motion: "动效",
        remove: "移除",
        duplicate: "复制",
      };
      return {
        title: `${typeLabel[intent.type]}意图 · ${intent.id}`,
        detail:
          `目标 ${target?.inspector.element.tag ?? intent.targetId}` +
          (target?.source?.sourceId ? ` · ${target.source.sourceId}` : ""),
      };
    }
    const annotation = request.annotations.find(
      (candidate) => candidate.id === item.referenceId,
    );
    if (!annotation)
      return {
        title: `视觉标注 · ${item.referenceId}`,
        detail: "原始标注已不在当前请求中",
      };
    const typeLabel: Record<typeof annotation.type, string> = {
      comment: "批注",
      rectangle: "矩形",
      arrow: "箭头",
      highlight: "高亮",
      redaction: "截图遮挡",
    };
    return {
      title: `${typeLabel[annotation.type]}标注 · ${annotation.id}`,
      detail:
        annotation.text?.trim() ||
        (annotation.targetIds.length > 0
          ? `关联 ${annotation.targetIds.length} 个视觉目标`
          : "无文字说明"),
    };
  }

  private updateVisualResultReview(
    request: AIChangeRequest,
    result: PanelPatchResultScreenshot,
    item: AIVisualResultReviewItem,
    status: AIVisualResultReviewStatus,
  ): void {
    const current = this.aiVisualResultReviews.get(result.proposalId);
    if (
      !current ||
      current.requestId !== request.id ||
      current.applicationId !== result.applicationId ||
      current.verificationId !== result.verificationId ||
      current.resultScreenshotId !== result.asset.id ||
      this.latestVisualRoundDecision(current)
    )
      return;
    const previous = current.items.find(
      (candidate) =>
        candidate.kind === item.kind &&
        candidate.referenceId === item.referenceId,
    );
    if (!previous || previous.status === status) return;
    const updated = updateAIVisualResultReview(
      current,
      { kind: item.kind, referenceId: item.referenceId },
      status,
    );
    this.aiVisualResultReviews.set(result.proposalId, updated);
    this.bridge.recordPipeline({
      taskId: request.id,
      stage: "verification",
      source: "visual-tools",
      kind: "visual.result.review.updated",
      summary: `Marked ${item.kind} ${item.referenceId} as ${status}`,
      payload: {
        reviewId: updated.id,
        requestId: updated.requestId,
        proposalId: updated.proposalId,
        applicationId: updated.applicationId,
        verificationId: updated.verificationId,
        resultScreenshotId: updated.resultScreenshotId,
        reference: {
          kind: item.kind,
          id: item.referenceId,
        },
        status,
        reviewedBy: "user",
      },
    });
    this.render();
  }

  private latestVisualRoundDecision(
    review: AIVisualResultReview,
  ): AIVisualRoundDecision | null {
    return (
      this.aiVisualRoundDecisions
        .get(review.proposalId)
        ?.filter((decision) => decision.reviewId === review.id)
        .at(-1) ?? null
    );
  }

  private recordVisualRoundDecision(
    review: AIVisualResultReview,
    action: AIVisualRoundDecisionAction,
  ): AIVisualRoundDecision {
    const decisions = this.aiVisualRoundDecisions.get(review.proposalId) ?? [];
    const existing = decisions.find(
      (decision) =>
        decision.reviewId === review.id && decision.action === action,
    );
    if (existing) return existing;
    const decision = createAIVisualRoundDecision(review, action);
    this.aiVisualRoundDecisions.set(
      review.proposalId,
      [...decisions, decision].slice(-MAX_AI_VISUAL_ROUND_DECISIONS),
    );
    this.bridge.recordPipeline({
      taskId: review.requestId,
      stage: "verification",
      source: "visual-tools",
      kind: `visual.result.decision.${action}`,
      summary: `Recorded ${action} decision for visual result ${review.proposalId}`,
      payload: decision,
    });
    return decision;
  }

  private followUpContextForReview(
    review: AIVisualResultReview,
  ): AIChangeFollowUpContext | null {
    const references = review.items.flatMap((item) =>
      item.status === "partial" || item.status === "unmet"
        ? [
            {
              kind: item.kind,
              id: item.referenceId,
              status: item.status,
            },
          ]
        : [],
    );
    if (references.length === 0) return null;
    return {
      previousRequestId: review.requestId,
      proposalId: review.proposalId,
      applicationId: review.applicationId,
      verificationId: review.verificationId,
      reviewId: review.id,
      resultScreenshotId: review.resultScreenshotId,
      references,
    };
  }

  private followUpContextForDecision(
    review: AIVisualResultReview,
    decision: AIVisualRoundDecision,
  ): AIChangeFollowUpContext | null {
    const references = decision.unresolvedReferences.flatMap((reference) =>
      reference.status === "partial" || reference.status === "unmet"
        ? [
            {
              kind: reference.kind,
              id: reference.id,
              status: reference.status,
            },
          ]
        : [],
    );
    if (references.length === 0) return null;
    return {
      previousRequestId: review.requestId,
      proposalId: review.proposalId,
      applicationId: review.applicationId,
      verificationId: review.verificationId,
      reviewId: review.id,
      resultScreenshotId: review.resultScreenshotId,
      references,
    };
  }

  private continueVisualRound(
    review: AIVisualResultReview,
    action: "partial-accept" | "regenerate",
  ): void {
    try {
      const decision =
        this.latestVisualRoundDecision(review)?.action === action
          ? this.latestVisualRoundDecision(review)!
          : this.recordVisualRoundDecision(review, action);
      const followUp = this.followUpContextForDecision(review, decision);
      if (!followUp) return;
      void this.prepareAIConversationRequest(
        this.visualTools.getDraft(),
        action === "regenerate" ? "regenerate" : "follow-up",
        followUp,
      );
    } catch (error) {
      this.sourceReadStatus =
        error instanceof Error
          ? `视觉轮次决策失败：${error.message}`
          : "视觉轮次决策失败。";
      this.render();
    }
  }

  private renderVisualResultReview(
    request: AIChangeRequest,
    result: PanelPatchResultScreenshot,
    userRollback?: PatchApplicationRollbackResult,
  ): HTMLElement | null {
    const review = this.aiVisualResultReviews.get(result.proposalId);
    if (
      !review ||
      review.requestId !== request.id ||
      review.applicationId !== result.applicationId ||
      review.verificationId !== result.verificationId ||
      review.resultScreenshotId !== result.asset.id
    )
      return null;
    const section = this.document.createElement("section");
    section.className = "ai-visual-result-review";
    section.dataset.elfuiDevtools = "ai-visual-result-review";
    section.setAttribute("aria-label", "Visual intent result review");
    const title = this.document.createElement("p");
    title.className = "ai-visual-result-review-title";
    title.textContent = "意图与标注核对";
    const counts = countAIVisualResultReviewStatuses(review);
    const summary = this.document.createElement("p");
    summary.className = "ai-visual-result-review-summary";
    summary.dataset.elfuiDevtools = "ai-visual-result-review-summary";
    summary.dataset.hasUnmet = String(counts.unmet + counts.partial > 0);
    summary.setAttribute("role", "status");
    summary.textContent =
      `待核对 ${counts.unreviewed} · 未满足 ${counts.unmet} · ` +
      `部分满足 ${counts.partial} · 已满足 ${counts.met}`;
    const guidance = this.document.createElement("p");
    guidance.className = "ai-visual-result-review-guidance";
    guidance.textContent =
      "请根据三阶段截图逐项确认；Node 自动检查通过不等于视觉目标已经满足。";
    section.append(title, summary, guidance);
    const latestDecision = this.latestVisualRoundDecision(review);
    const reviewLocked = Boolean(latestDecision || userRollback);

    const list = this.document.createElement("ul");
    list.className = "ai-visual-result-review-list";
    for (const item of review.items) {
      const row = this.document.createElement("li");
      row.className = "ai-visual-result-review-item";
      row.dataset.elfuiDevtools = "ai-visual-result-review-item";
      row.dataset.referenceKind = item.kind;
      row.dataset.referenceId = item.referenceId;
      row.dataset.status = item.status;
      const reference = this.document.createElement("span");
      reference.className = "ai-visual-result-review-reference";
      const description = this.describeVisualResultReviewItem(request, item);
      const referenceTitle = this.document.createElement("strong");
      referenceTitle.textContent = description.title;
      reference.append(
        referenceTitle,
        this.document.createTextNode(description.detail),
      );
      const status = this.document.createElement("select");
      status.setAttribute(
        "aria-label",
        `Review ${item.kind} ${item.referenceId}`,
      );
      for (const [value, label] of [
        ["unreviewed", "待核对"],
        ["met", "已满足"],
        ["partial", "部分满足"],
        ["unmet", "未满足"],
      ] as const) {
        const option = this.document.createElement("option");
        option.value = value;
        option.textContent = label;
        option.selected = value === item.status;
        status.append(option);
      }
      status.disabled = reviewLocked;
      status.onchange = () => {
        if (
          status.value === "unreviewed" ||
          status.value === "met" ||
          status.value === "partial" ||
          status.value === "unmet"
        )
          this.updateVisualResultReview(request, result, item, status.value);
      };
      row.append(reference, status);
      list.append(row);
    }
    if (review.items.length === 0) {
      const empty = this.document.createElement("li");
      empty.className = "ai-visual-result-review-guidance";
      empty.textContent = "本轮没有需要核对的修改意图或非遮挡标注。";
      list.append(empty);
    }
    section.append(list);
    const followUp = this.followUpContextForReview(review);
    const isCurrentRequest =
      this.aiRequests.get(this.aiConversationMode)?.id === request.id;
    const resultAssetAvailable = Boolean(
      this.screenshots?.getAsset(review.resultScreenshotId),
    );
    const verification = this.aiPatchVerifications.get(result.proposalId);

    if (!latestDecision && !userRollback) {
      const actions = this.document.createElement("div");
      actions.className = "ai-visual-round-actions";
      actions.dataset.elfuiDevtools = "ai-visual-round-actions";

      const accept = this.document.createElement("button");
      accept.type = "button";
      accept.dataset.action = "accept";
      accept.textContent = "接受本轮结果";
      accept.setAttribute(
        "aria-label",
        `Accept visual result ${result.proposalId}`,
      );
      accept.disabled =
        !isCurrentRequest ||
        counts.unreviewed > 0 ||
        counts.partial > 0 ||
        counts.unmet > 0;
      accept.title = isCurrentRequest
        ? "所有视觉目标明确标记为已满足后，接受本轮结果。"
        : "请先切换到此轮再记录接受决策。";
      accept.onclick = () => {
        this.recordVisualRoundDecision(review, "accept");
        this.sourceReadStatus = `已接受 ${result.proposalId} 的视觉结果；文件保持当前已验证状态。`;
        this.render();
      };

      const partial = this.document.createElement("button");
      partial.type = "button";
      partial.dataset.action = "partial-accept";
      partial.textContent = followUp
        ? `部分接受并继续 ${followUp.references.length} 项`
        : "部分接受并继续";
      partial.setAttribute(
        "aria-label",
        `Partially accept visual result ${result.proposalId}`,
      );
      partial.disabled =
        !isCurrentRequest ||
        this.preparingAIRequest ||
        !resultAssetAvailable ||
        counts.unreviewed > 0 ||
        counts.met === 0 ||
        !followUp;
      partial.title =
        "保留已满足的结果，并把未满足或部分满足的稳定引用与 result screenshot 带入下一轮。";
      partial.onclick = () =>
        this.continueVisualRound(review, "partial-accept");

      const revert = this.document.createElement("button");
      revert.type = "button";
      revert.dataset.action = "revert";
      revert.textContent = this.aiPatchRollbackPending.has(result.applicationId)
        ? "正在回退…"
        : "回退本轮结果";
      revert.setAttribute(
        "aria-label",
        `Revert visual result ${result.proposalId}`,
      );
      revert.disabled =
        !isCurrentRequest ||
        !this.aiExecutor?.rollbackPatchApplication ||
        verification?.status !== "verified" ||
        verification.requestId !== request.id ||
        this.aiPatchRollbackPending.has(result.applicationId);
      revert.title =
        "通过 Node 事务恢复应用前文件；回退成功后才记录视觉轮次决策。";
      revert.onclick = () => {
        if (verification)
          void this.rollbackPatchApplication(request, verification, review);
      };
      actions.append(accept, partial, revert);
      section.append(actions);
    }

    if (latestDecision) {
      const label: Record<AIVisualRoundDecisionAction, string> = {
        accept: "已接受",
        "partial-accept": "已部分接受",
        revert: "已回退",
        regenerate: "已请求重新生成",
      };
      const audit = this.document.createElement("p");
      audit.className = "ai-visual-round-decision";
      audit.dataset.elfuiDevtools = "ai-visual-round-decision";
      audit.dataset.action = latestDecision.action;
      audit.textContent =
        `${label[latestDecision.action]} · 已接受 ${latestDecision.acceptedReferences.length} 项 · ` +
        `待处理 ${latestDecision.unresolvedReferences.length} 项 · ${latestDecision.id}`;
      section.append(audit);
    }

    if (
      latestDecision &&
      (latestDecision.action === "accept" ||
        latestDecision.action === "partial-accept") &&
      !userRollback
    ) {
      const actions = this.document.createElement("div");
      actions.className = "ai-visual-round-actions";
      actions.dataset.elfuiDevtools = "ai-visual-round-actions";
      const revert = this.document.createElement("button");
      revert.type = "button";
      revert.dataset.action = "revert";
      revert.textContent = this.aiPatchRollbackPending.has(result.applicationId)
        ? "正在回退…"
        : "回退本轮结果";
      revert.setAttribute(
        "aria-label",
        `Revert visual result ${result.proposalId}`,
      );
      revert.disabled =
        !isCurrentRequest ||
        !this.aiExecutor?.rollbackPatchApplication ||
        verification?.status !== "verified" ||
        verification.requestId !== request.id ||
        this.aiPatchRollbackPending.has(result.applicationId);
      revert.title =
        "接受决策保留在审计历史中；Node 回退成功后会追加回退决策。";
      revert.onclick = () => {
        if (verification)
          void this.rollbackPatchApplication(request, verification, review);
      };
      actions.append(revert);
      section.append(actions);
    }

    const canRegenerate =
      Boolean(userRollback) &&
      isCurrentRequest &&
      resultAssetAvailable &&
      !this.preparingAIRequest &&
      (!latestDecision ||
        latestDecision.action === "revert" ||
        latestDecision.action === "regenerate");
    if (
      (userRollback &&
        (!latestDecision || latestDecision.action === "revert")) ||
      (latestDecision?.action === "regenerate" && isCurrentRequest)
    ) {
      const actions = this.document.createElement("div");
      actions.className = "ai-visual-round-actions";
      actions.dataset.elfuiDevtools = "ai-visual-round-actions";
      const regenerate = this.document.createElement("button");
      regenerate.type = "button";
      regenerate.dataset.action = "regenerate";
      regenerate.textContent =
        latestDecision?.action === "regenerate"
          ? "重试重新生成"
          : `重新生成 ${review.items.length} 项视觉目标`;
      regenerate.setAttribute(
        "aria-label",
        `Regenerate visual result ${result.proposalId}`,
      );
      regenerate.disabled = !canRegenerate;
      regenerate.title =
        "保留 Visual Draft 和结果证据，使用新的 AIChangeRequest 重新生成方案。";
      regenerate.onclick = () => this.continueVisualRound(review, "regenerate");
      actions.append(regenerate);
      section.append(actions);
    }
    return section;
  }

  private activateAIRequestRound(request: AIChangeRequest): void {
    const mode = this.aiConversationMode;
    const current = this.aiRequests.get(mode);
    if (!current || current.id === request.id) return;
    const history = this.aiRequestHistory.get(mode) ?? [];
    if (!history.some((candidate) => candidate.id === request.id)) return;
    this.aiRequestHistory.set(
      mode,
      [
        ...history.filter((candidate) => candidate.id !== request.id),
        current,
      ].slice(-MAX_AI_REQUEST_HISTORY),
    );
    this.aiRequests.set(mode, request);
    this.selectedSourceApprovals.clear();
    this.sourceReadStatus = `已切换到请求 ${request.id}；Visual Draft 与其他轮次记录保持不变。`;
    this.bridge.recordPipeline({
      taskId: request.id,
      stage: "ai-request",
      source: "ai",
      kind: "ai.conversation.round.select",
      summary: `Selected historical AI request ${request.id}`,
      payload: {
        conversationId: request.conversationId,
        mode,
        requestId: request.id,
        previousActiveRequestId: current.id,
      },
    });
    this.render();
  }

  private renderPatchProposalCatalog(
    request: AIChangeRequest,
    previousRound = false,
  ): HTMLElement | null {
    if (
      this.aiConversationMode !== "plan" ||
      !this.aiExecutor?.listPatchProposals
    )
      return null;
    const section = this.document.createElement("section");
    section.className = "ai-patch-proposals";
    section.dataset.elfuiDevtools = "ai-patch-proposals";
    section.dataset.round = previousRound ? "previous" : "current";
    const title = this.document.createElement("p");
    title.className = "section-title";
    title.textContent = previousRound
      ? "上一轮 Patch 与结果"
      : zhCN.patchProposals;
    section.append(title);
    const status = this.document.createElement("p");
    status.className = "ai-patch-catalog-status";
    status.dataset.elfuiDevtools = "ai-patch-catalog-status";
    status.setAttribute("role", "status");
    status.textContent =
      this.aiPatchCatalogStatus.get(request.id) ??
      "正在等待 Node 生成可审核 PatchProposal。";
    section.append(status);
    if (previousRound) {
      const activate = this.document.createElement("button");
      activate.type = "button";
      activate.className = "ai-round-activate";
      activate.textContent = "切换到此轮";
      activate.setAttribute("aria-label", `Activate AI request ${request.id}`);
      activate.onclick = () => this.activateAIRequestRound(request);
      section.append(activate);
    }
    const catalog = this.aiPatchCatalogs.get(request.id);
    if (!catalog || catalog.proposals.length === 0) return section;

    for (const review of catalog.proposals) {
      const proposal = review.proposal;
      const verification = this.aiPatchVerifications.get(proposal.id);
      const userRollback = this.aiPatchRollbacks.get(proposal.id);
      const resultCandidate = this.aiPatchResultScreenshots.get(proposal.id);
      const resultScreenshot =
        verification &&
        resultCandidate?.verificationId === verification.verificationId
          ? resultCandidate
          : null;
      const card = this.document.createElement("article");
      card.className = "ai-patch-card";
      card.dataset.elfuiDevtools = "ai-patch-proposal";
      card.dataset.proposalId = proposal.id;
      const heading = this.document.createElement("h4");
      heading.textContent = proposal.summary;
      const meta = this.document.createElement("p");
      meta.className = "ai-patch-meta";
      const reviewStatus =
        review.status === "pending"
          ? "待审核"
          : review.status === "approved"
            ? userRollback
              ? "已由用户撤销"
              : verification?.status === "verified"
                ? "已应用并验证"
                : verification?.status === "rolled-back"
                  ? "验证失败（已回滚）"
                  : "已批准（尚未应用）"
            : review.status === "rejected"
              ? "已拒绝"
              : "已退回修改";
      meta.textContent = `${proposal.id} · ${reviewStatus} · 风险 ${proposal.risk}`;
      card.append(heading, meta);

      const assumptionsTitle = this.document.createElement("p");
      assumptionsTitle.className = "ai-patch-meta";
      assumptionsTitle.textContent = "计划假设";
      const assumptions = this.document.createElement("ul");
      for (const assumption of proposal.assumptions.length > 0
        ? proposal.assumptions
        : ["无额外假设。"])
        assumptions.append(
          Object.assign(this.document.createElement("li"), {
            textContent: assumption,
          }),
        );
      card.append(assumptionsTitle, assumptions);

      const filesTitle = this.document.createElement("p");
      filesTitle.className = "ai-patch-meta";
      filesTitle.textContent = "影响文件与验证计划";
      const files = this.document.createElement("ul");
      for (const file of proposal.affectedFiles)
        files.append(
          Object.assign(this.document.createElement("li"), {
            textContent: file,
          }),
        );
      for (const step of proposal.validationPlan)
        files.append(
          Object.assign(this.document.createElement("li"), {
            textContent: `${step.required ? "必须" : "可选"} · ${step.kind}${step.files ? ` · ${step.files.join(", ")}` : ""}`,
          }),
        );
      card.append(filesTitle, files);

      const diffDetails = this.document.createElement("details");
      diffDetails.open = review.status === "pending";
      const diffSummary = this.document.createElement("summary");
      diffSummary.textContent = `统一 Diff · ${proposal.unifiedDiff.length} 字符`;
      const diff = this.document.createElement("pre");
      diff.className = "ai-patch-diff";
      diff.dataset.elfuiDevtools = "ai-patch-diff";
      diff.textContent = proposal.unifiedDiff;
      diffDetails.append(diffSummary, diff);
      card.append(diffDetails);

      if (review.status === "pending" && this.aiExecutor.decidePatchProposal) {
        const comment = this.document.createElement("textarea");
        comment.className = "ai-patch-comment";
        comment.value = this.aiPatchComments.get(proposal.id) ?? "";
        comment.placeholder = "拒绝原因可选；退回修改时必须填写具体评论。";
        comment.setAttribute(
          "aria-label",
          `Patch proposal comment ${proposal.id}`,
        );
        const actions = this.document.createElement("div");
        actions.className = "ai-patch-actions";
        const pending = this.aiPatchDecisionPending.has(proposal.id);
        const approve = this.document.createElement("button");
        approve.type = "button";
        approve.textContent = zhCN.approvePatchProposal;
        approve.setAttribute(
          "aria-label",
          `Approve patch proposal ${proposal.id}`,
        );
        approve.disabled = pending;
        approve.onclick = () => {
          void this.decidePatchProposal(request, review, "approve");
        };
        const reject = this.document.createElement("button");
        reject.type = "button";
        reject.textContent = zhCN.rejectPatchProposal;
        reject.setAttribute(
          "aria-label",
          `Reject patch proposal ${proposal.id}`,
        );
        reject.disabled = pending;
        reject.onclick = () => {
          void this.decidePatchProposal(request, review, "reject");
        };
        const revise = this.document.createElement("button");
        revise.type = "button";
        revise.textContent = zhCN.revisePatchProposal;
        revise.setAttribute(
          "aria-label",
          `Revise patch proposal ${proposal.id}`,
        );
        revise.disabled = pending || comment.value.trim().length === 0;
        revise.onclick = () => {
          void this.decidePatchProposal(request, review, "revise");
        };
        comment.oninput = () => {
          this.aiPatchComments.set(proposal.id, comment.value);
          revise.disabled =
            this.aiPatchDecisionPending.has(proposal.id) ||
            comment.value.trim().length === 0;
        };
        actions.append(approve, reject, revise);
        card.append(comment, actions);
      } else if (review.decisions.length > 0) {
        const decision = review.decisions.at(-1)!;
        const audit = this.document.createElement("p");
        audit.className = "ai-patch-decision";
        audit.textContent =
          `${decision.id} · ${decision.decision}${decision.comment ? ` · ${decision.comment}` : ""} · ` +
          (verification?.status === "verified"
            ? userRollback
              ? `用户已撤销 · ${userRollback.applicationId}`
              : `已应用并验证 · ${verification.verificationId}`
            : verification?.status === "rolled-back"
              ? `验证失败并回滚 · ${verification.failedStep ?? "verification"}`
              : "文件未应用");
        card.append(audit);
      }
      if (verification) {
        const verificationDetails = this.document.createElement("details");
        verificationDetails.className = "ai-patch-verification";
        verificationDetails.dataset.elfuiDevtools = "ai-patch-verification";
        const verificationSummary = this.document.createElement("summary");
        verificationSummary.textContent =
          verification.status === "verified"
            ? `验证通过 · ${verification.verificationId}`
            : `验证失败并回滚 · ${verification.failedStep ?? "verification"}`;
        const checks = this.document.createElement("ul");
        for (const check of verification.checks)
          checks.append(
            Object.assign(this.document.createElement("li"), {
              textContent: `${check.step} · ${check.status} · ${check.summary}`,
            }),
          );
        const files = this.document.createElement("ul");
        for (const file of verification.files)
          files.append(
            Object.assign(this.document.createElement("li"), {
              textContent:
                `${file.sourceId} · ${file.beforeHash.slice(0, 8)} → ${file.afterHash.slice(0, 8)}` +
                (file.restoredHash
                  ? ` · restored ${file.restoredHash.slice(0, 8)}`
                  : ""),
            }),
          );
        verificationDetails.append(verificationSummary, checks, files);
        if (verification.diagnostics.length > 0) {
          const diagnostics = this.document.createElement("ul");
          for (const diagnostic of verification.diagnostics)
            diagnostics.append(
              Object.assign(this.document.createElement("li"), {
                textContent: `${diagnostic.severity} · ${diagnostic.code ?? diagnostic.step} · ${diagnostic.message}`,
              }),
            );
          verificationDetails.append(diagnostics);
        }
        card.append(verificationDetails);
      }
      if (
        verification?.status === "verified" &&
        (this.screenshots || resultScreenshot)
      ) {
        const result = this.document.createElement("div");
        result.className = "ai-patch-result";
        result.dataset.elfuiDevtools = "ai-patch-result";
        if (resultScreenshot) {
          const metadata = this.document.createElement("p");
          metadata.dataset.elfuiDevtools = "ai-patch-result-screenshot";
          metadata.textContent =
            `${zhCN.result}截图 · ${resultScreenshot.asset.kind} · ` +
            `${resultScreenshot.asset.width}×${resultScreenshot.asset.height} · ` +
            `${resultScreenshot.asset.id} · 关联 ${resultScreenshot.sourceScreenshotIds.length} 张 before/desired 截图`;
          result.append(metadata);
        }
        if (!userRollback && this.screenshots) {
          const captureResult = this.document.createElement("button");
          captureResult.type = "button";
          const pending = this.aiPatchResultCapturePending.has(
            verification.verificationId,
          );
          captureResult.textContent = pending
            ? "正在捕获结果…"
            : resultScreenshot
              ? "重新捕获结果截图"
              : "捕获结果截图";
          captureResult.setAttribute(
            "aria-label",
            `Capture patch result screenshot ${proposal.id}`,
          );
          captureResult.title =
            "使用视觉草稿当前的截图范围捕获已验证 Patch 的页面结果。";
          captureResult.disabled = pending;
          captureResult.onclick = () => {
            void this.capturePatchResultScreenshot(request, verification);
          };
          result.append(captureResult);
        }
        card.append(result);
      }
      let hasVisualRoundReview = false;
      if (resultScreenshot) {
        card.append(
          this.renderPatchScreenshotComparison(request, resultScreenshot),
        );
        const visualReview = this.renderVisualResultReview(
          request,
          resultScreenshot,
          userRollback,
        );
        if (visualReview) {
          hasVisualRoundReview = true;
          card.append(visualReview);
        }
      }
      if (
        verification?.status === "verified" &&
        !userRollback &&
        !hasVisualRoundReview &&
        this.aiExecutor.rollbackPatchApplication
      ) {
        const rollback = this.document.createElement("button");
        rollback.type = "button";
        rollback.className = "ai-patch-rollback";
        rollback.textContent = this.aiPatchRollbackPending.has(
          verification.applicationId,
        )
          ? "正在撤销…"
          : "撤销已应用 Patch";
        rollback.setAttribute(
          "aria-label",
          `Rollback patch application ${proposal.id}`,
        );
        rollback.disabled = this.aiPatchRollbackPending.has(
          verification.applicationId,
        );
        rollback.onclick = () => {
          void this.rollbackPatchApplication(request, verification);
        };
        card.append(rollback);
      } else if (userRollback) {
        const rollbackAudit = this.document.createElement("p");
        rollbackAudit.className = "ai-patch-decision";
        rollbackAudit.textContent = `${userRollback.applicationId} · 用户撤销 · 已恢复 ${userRollback.files.length} 个文件`;
        card.append(rollbackAudit);
      }
      section.append(card);
    }
    return section;
  }

  private requestsForAIReference(
    currentRequest: AIChangeRequest,
  ): AIChangeRequest[] {
    const requests = [
      currentRequest,
      ...this.aiRequests.values(),
      ...[...this.aiRequestHistory.values()].flat(),
    ];
    const seen = new Set<string>();
    return requests.filter((request) => {
      if (seen.has(request.id)) return false;
      seen.add(request.id);
      return true;
    });
  }

  private traceAIReference(
    reference: AIReference,
    currentRequest: AIChangeRequest,
  ): void {
    const requests = this.requestsForAIReference(currentRequest);
    let traced = false;
    let sourceLocation:
      | {
          file: string;
          line: number;
          column: number;
          endLine?: number;
          endColumn?: number;
        }
      | undefined;
    const selectTarget = (
      request: AIChangeRequest,
      targetId: string | undefined,
    ): boolean => {
      if (!targetId) return false;
      const target = request.targets.find(
        (candidate) => candidate.id === targetId,
      );
      if (!target) return false;
      this.selectComponent(
        target.componentId,
        "ai-reference",
        target.inspector,
      );
      return true;
    };

    for (const request of requests) {
      if (reference.kind === "visual-intent") {
        const intent = request.intents.find(
          (candidate) => candidate.id === reference.id,
        );
        if (intent && selectTarget(request, intent.targetId)) {
          traced = true;
          break;
        }
      } else if (reference.kind === "annotation") {
        const annotation = request.annotations.find(
          (candidate) => candidate.id === reference.id,
        );
        if (annotation) {
          traced = selectTarget(request, annotation.targetIds[0]);
          if (!traced) traced = true;
          break;
        }
      } else if (reference.kind === "file") {
        const source = request.sourceContext.find(
          (candidate) => candidate.sourceId === reference.id,
        );
        const target = request.targets.find(
          (candidate) =>
            candidate.source?.sourceId === reference.id ||
            candidate.inspector.sourceId === reference.id,
        );
        sourceLocation = source?.range ??
          target?.source?.range ??
          target?.inspector.source ?? {
            file: reference.id,
            line: 1,
            column: 1,
          };
        traced = true;
        break;
      } else if (reference.kind === "diagnostic") {
        const diagnostic = request.diagnostics?.find(
          (candidate) => candidate.id === reference.id,
        );
        if (diagnostic) {
          sourceLocation =
            diagnostic.source ??
            (diagnostic.sourceId
              ? { file: diagnostic.sourceId, line: 1, column: 1 }
              : undefined);
          const target = diagnostic.sourceId
            ? request.targets.find(
                (candidate) =>
                  candidate.source?.sourceId === diagnostic.sourceId ||
                  candidate.inspector.sourceId === diagnostic.sourceId,
              )
            : undefined;
          if (target)
            this.selectComponent(
              target.componentId,
              "ai-reference",
              target.inspector,
            );
          traced = true;
          break;
        }
      }
    }

    this.bridge.recordPipeline({
      taskId: currentRequest.id,
      stage: "provider-request",
      source: "ai",
      kind: traced ? "ai.reference.trace" : "ai.reference.trace-missing",
      summary: `${traced ? "Traced" : "Could not trace"} AI reply reference ${reference.kind}:${reference.id}`,
      payload: {
        requestId: currentRequest.id,
        reference,
        traced,
      },
    });
    if (sourceLocation)
      void this.openSource(sourceLocation).catch((error: unknown) => {
        this.sourceReadStatus =
          error instanceof Error ? error.message : String(error);
        this.render();
      });
    else if (!traced) {
      this.sourceReadStatus = `引用已失效：${reference.kind}/${reference.id}`;
      this.render();
    }
  }

  private renderAIWorkflowStatus(request: AIChangeRequest | null): HTMLElement {
    type AIWorkflowStage =
      | "draft"
      | "request"
      | "proposal"
      | "approval"
      | "verification"
      | "review";
    const stages = [
      ["draft", "草稿"],
      ["request", "请求"],
      ["proposal", "方案"],
      ["approval", "批准"],
      ["verification", "验证"],
      ["review", "视觉核对"],
    ] as const;
    let currentStage: AIWorkflowStage = "draft";
    let summary = "先在视觉草稿中选择目标，再生成 Provider 无关的 AI 请求。";
    if (request) {
      currentStage = "request";
      summary = `已冻结请求 ${request.id}，可检查上下文范围并运行只读会话。`;
      const execution = this.aiExecutionStates.get(this.aiConversationMode);
      const catalog = this.aiPatchCatalogs.get(request.id);
      const reviews = catalog?.proposals ?? [];
      const verification = reviews
        .map((review) => this.aiPatchVerifications.get(review.proposal.id))
        .find(Boolean);
      const result = reviews
        .map((review) => this.aiPatchResultScreenshots.get(review.proposal.id))
        .find(Boolean);
      if (result) {
        currentStage = "review";
        summary = "结果截图已关联，正在等待用户核对视觉目标。";
      } else if (verification) {
        currentStage = "verification";
        summary = `Patch 已进入 ${verification.status} 状态，等待验证结果和运行时反馈。`;
      } else if (
        reviews.some((review) => review.status === "approved") &&
        reviews.some((review) => review.status === "pending")
      ) {
        currentStage = "approval";
        summary = `已有 ${reviews.filter((review) => review.status === "approved").length} 个提案获批，仍有提案待审核。`;
      } else if (reviews.some((review) => review.status === "approved")) {
        currentStage = "approval";
        summary = "提案已获批，下一步需要显式执行并验证，不会自动写入源码。";
      } else if (reviews.length > 0) {
        currentStage = "proposal";
        summary = `Node 已返回 ${reviews.length} 个 PatchProposal，等待用户检查 Diff 和假设。`;
      } else if (
        execution?.status === "pending" ||
        execution?.status === "streaming"
      ) {
        currentStage = "proposal";
        summary = "Provider 正在生成只读输出，完成后会显示方案或解释。";
      }
    }
    const stageIndex = stages.findIndex(([stage]) => stage === currentStage);
    const container = this.document.createElement("div");
    container.className = "ai-workflow";
    container.dataset.elfuiDevtools = "ai-workflow";
    container.dataset.stage = currentStage;
    container.setAttribute("aria-label", "AI workflow status");
    const heading = this.document.createElement("div");
    heading.className = "ai-workflow-heading";
    const title = this.document.createElement("p");
    title.className = "ai-workflow-title";
    title.textContent = "AI 工作流";
    const current = this.document.createElement("p");
    current.className = "ai-workflow-current";
    current.textContent = `当前阶段：${stages[stageIndex]?.[1] ?? stages[0][1]}`;
    heading.append(title, current);
    const steps = this.document.createElement("div");
    steps.className = "ai-workflow-steps";
    steps.setAttribute("role", "list");
    for (const [index, [stage, label]] of stages.entries()) {
      const step = this.document.createElement("div");
      step.className = "ai-workflow-step";
      step.dataset.state =
        index < stageIndex
          ? "complete"
          : index === stageIndex
            ? "active"
            : "upcoming";
      step.dataset.stage = stage;
      step.setAttribute("role", "listitem");
      step.textContent = label;
      steps.append(step);
    }
    const summaryNode = this.document.createElement("p");
    summaryNode.className = "ai-workflow-summary";
    summaryNode.setAttribute("role", "status");
    summaryNode.setAttribute("aria-live", "polite");
    summaryNode.textContent = summary;
    container.append(heading, steps, summaryNode);
    return container;
  }

  private renderAIConversation(draft: VisualDraft): HTMLElement {
    const section = this.document.createElement("section");
    section.className = "ai-conversation";
    section.dataset.elfuiDevtools = "ai-conversation";
    const header = this.document.createElement("div");
    header.className = "ai-conversation-header";
    const title = this.document.createElement("p");
    title.className = "section-title";
    title.textContent = zhCN.aiConversation;
    const modes = this.document.createElement("div");
    modes.className = "ai-conversation-modes";
    modes.setAttribute("role", "group");
    modes.setAttribute("aria-label", "AI conversation mode");
    for (const [mode, label] of [
      ["explain", zhCN.explainMode],
      ["plan", zhCN.planMode],
    ] as const) {
      const button = this.document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.setAttribute("aria-label", `AI conversation mode ${mode}`);
      button.setAttribute(
        "aria-pressed",
        String(this.aiConversationMode === mode),
      );
      button.onclick = () => {
        if (this.aiConversationMode === mode) return;
        this.aiConversationMode = mode;
        this.selectedSourceApprovals.clear();
        this.bridge.recordPipeline({
          taskId:
            this.aiRequests.get(mode)?.id ??
            this.aiConversationIds.get(mode) ??
            draft.id,
          stage: "ai-request",
          source: "ai",
          kind: "ai.conversation.mode.select",
          summary: `Selected read-only ${mode} conversation mode`,
          payload: { mode, providerConnected: Boolean(this.aiExecutor) },
        });
        this.render();
      };
      modes.append(button);
    }
    header.append(title, modes);
    section.append(header);

    const request = this.aiRequests.get(this.aiConversationMode) ?? null;
    section.append(this.renderAIWorkflowStatus(request));
    const providerConfiguration = this.renderAIProviderConfiguration();
    if (providerConfiguration) section.append(providerConfiguration);
    const providerStatus = this.document.createElement("p");
    providerStatus.className = "ai-provider-status";
    providerStatus.setAttribute("role", "status");
    providerStatus.textContent = this.aiExecutor
      ? this.selectedAIProvider()
        ? `${this.selectedAIProvider()!.label} 已由 Node Gateway 注册；只读模式不会写入源码。`
        : zhCN.providerReady
      : zhCN.providerDisconnected;
    section.append(providerStatus);
    if (this.sourceReadStatus) {
      const sourceReadStatus = this.document.createElement("p");
      sourceReadStatus.className = "ai-source-read-status";
      sourceReadStatus.dataset.elfuiDevtools = "ai-source-read-status";
      sourceReadStatus.setAttribute("role", "status");
      sourceReadStatus.textContent = this.sourceReadStatus;
      section.append(sourceReadStatus);
    }

    const conversationId = this.aiConversationIds.get(this.aiConversationMode);
    const conversation = conversationId
      ? this.aiConversations.getConversation(conversationId)
      : null;
    if (!conversation || !request) {
      const empty = this.document.createElement("p");
      empty.className = "pipeline-empty";
      empty.textContent = zhCN.noAIRequest;
      section.append(empty);
      return section;
    }

    const governance = this.document.createElement("div");
    governance.className = "ai-governance";
    governance.dataset.elfuiDevtools = "ai-context-governance";
    const requestId = this.document.createElement("p");
    requestId.textContent = `请求：${request.id}`;
    const usage = this.document.createElement("p");
    usage.textContent =
      `源码 ${request.governance.usage.sourceBlocks}/${request.governance.budget.maxSourceBlocks} 块，` +
      `${request.governance.usage.sourceCharacters}/${request.governance.budget.maxSourceCharacters} 字符 · ` +
      `截图 ${request.governance.usage.screenshotCount} 张，` +
      `${request.governance.usage.screenshotBytes}/${request.governance.budget.maxScreenshotBytes} 字节 · ` +
      `用户文本 ${request.governance.usage.userMessageCharacters}/${request.governance.budget.maxUserMessageCharacters} 字符`;
    const redactionCount = request.governance.redactions.reduce(
      (total, redaction) => total + redaction.replacements,
      0,
    );
    const governanceSummary = this.document.createElement("p");
    governanceSummary.textContent =
      `脱敏 ${redactionCount} 处 · 省略 ${request.governance.omissions.length} 项 · ` +
      `已批准 ${request.governance.approvedSourceIds.length} 个额外 sourceId`;
    governance.append(requestId, usage, governanceSummary);
    if (request.followUp) {
      const followUp = this.document.createElement("p");
      followUp.className = "ai-follow-up-context";
      followUp.dataset.elfuiDevtools = "ai-follow-up-context";
      const unmet = request.followUp.references.filter(
        (reference) => reference.status === "unmet",
      ).length;
      const partial = request.followUp.references.length - unmet;
      followUp.textContent =
        `第二轮视觉请求 · 未满足 ${unmet} · 部分满足 ${partial} · ` +
        `上一请求 ${request.followUp.previousRequestId} · result ${request.followUp.resultScreenshotId}`;
      governance.append(followUp);
    }
    section.append(governance);

    if (request.governance.pendingSourceApprovals.length > 0) {
      const approval = this.document.createElement("div");
      approval.className = "ai-source-approval";
      approval.dataset.elfuiDevtools = "ai-source-approval";
      const approvalTitle = this.document.createElement("p");
      approvalTitle.textContent = "待批准的额外源码范围";
      approval.append(approvalTitle);
      const approve = this.document.createElement("button");
      approve.type = "button";
      approve.textContent = zhCN.approveSelectedSources;
      approve.setAttribute("aria-label", "Approve selected source context");
      approve.disabled = this.selectedSourceApprovals.size === 0;
      for (const sourceId of request.governance.pendingSourceApprovals) {
        const label = this.document.createElement("label");
        const checkbox = this.document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = this.selectedSourceApprovals.has(sourceId);
        checkbox.setAttribute("aria-label", `Approve source ${sourceId}`);
        checkbox.onchange = () => {
          if (checkbox.checked) this.selectedSourceApprovals.add(sourceId);
          else this.selectedSourceApprovals.delete(sourceId);
          approve.disabled = this.selectedSourceApprovals.size === 0;
        };
        label.append(checkbox, this.document.createTextNode(sourceId));
        approval.append(label);
      }
      approve.onclick = () => {
        const approved = request.governance.pendingSourceApprovals.filter(
          (sourceId) => this.selectedSourceApprovals.has(sourceId),
        );
        if (approved.length === 0) return;
        for (const sourceId of approved) this.approvedSourceIds.add(sourceId);
        this.bridge.recordPipeline({
          taskId: request.id,
          stage: "context-bundle",
          source: "context-builder",
          kind: "ai.context.approval",
          summary: `Approved ${approved.length} additional source IDs`,
          payload: {
            requestId: request.id,
            conversationId: conversation.id,
            approvedSourceIds: approved,
          },
        });
        void this.prepareAIConversationRequest(
          draft,
          "scope-approval",
          request.followUp,
        );
      };
      approval.append(approve);
      section.append(approval);
    }

    if (this.aiExecutor) {
      const controls = this.document.createElement("div");
      controls.className = "ai-execution-controls";
      controls.dataset.elfuiDevtools = "ai-execution-controls";
      const state = this.aiExecutionStates.get(this.aiConversationMode);
      const stateMatchesRequest = state?.requestId === request.id;
      const active =
        stateMatchesRequest &&
        (state.status === "pending" || state.status === "streaming");
      const run = this.document.createElement("button");
      run.type = "button";
      if (active) {
        run.textContent = state.cancelRequested
          ? "正在取消…"
          : zhCN.cancelExecution;
        run.setAttribute("aria-label", "Cancel AI execution");
        run.disabled = state.cancelRequested;
        run.onclick = () => {
          void this.cancelAIExecution(request, state);
        };
      } else {
        const retry =
          stateMatchesRequest &&
          (state.status === "failed" || state.status === "cancelled");
        const patchCatalog = this.aiPatchCatalogs.get(request.id);
        const pendingApprovedPatch =
          this.aiConversationMode === "plan" &&
          patchCatalog?.proposals.some(
            (review) =>
              review.status === "approved" &&
              (this.aiPatchRollbacks.has(review.proposal.id) ||
                this.aiPatchVerifications.get(review.proposal.id)?.status !==
                  "verified"),
          );
        const rolledBackApprovedPatch =
          this.aiConversationMode === "plan" &&
          patchCatalog?.proposals.some(
            (review) =>
              review.status === "approved" &&
              (this.aiPatchRollbacks.has(review.proposal.id) ||
                this.aiPatchVerifications.get(review.proposal.id)?.status ===
                  "rolled-back"),
          );
        run.textContent = retry
          ? zhCN.retryExecution
          : pendingApprovedPatch
            ? rolledBackApprovedPatch
              ? "重试已批准 Patch"
              : "继续执行已批准 Patch"
            : stateMatchesRequest && state.status === "completed"
              ? zhCN.runAgain
              : this.aiConversationMode === "explain"
                ? zhCN.runExplain
                : zhCN.runPlan;
        run.setAttribute(
          "aria-label",
          retry ? "Retry AI execution" : "Run AI execution",
        );
        run.onclick = () => {
          void this.executeAIConversation(request, retry ? state : undefined);
        };
      }
      controls.append(run);
      section.append(controls);
    }

    const patchCatalog = this.renderPatchProposalCatalog(request);
    if (patchCatalog) section.append(patchCatalog);
    const requestHistory =
      this.aiRequestHistory.get(this.aiConversationMode) ?? [];
    for (const previousRequest of [...requestHistory].reverse()) {
      const previousCatalog = this.renderPatchProposalCatalog(
        previousRequest,
        true,
      );
      if (previousCatalog) section.append(previousCatalog);
    }

    const messages = this.document.createElement("ol");
    messages.className = "ai-message-list";
    messages.dataset.elfuiDevtools = "ai-conversation-messages";
    for (const message of conversation.messages) {
      const item = this.document.createElement("li");
      item.className = "ai-message";
      item.dataset.messageId = message.id;
      item.dataset.messageRole = message.role;
      item.dataset.messageStatus = message.status;
      const body = this.document.createElement("p");
      body.textContent = message.content;
      const metadata = this.document.createElement("small");
      metadata.textContent =
        `${message.role} · ${message.status} · ` +
        `${message.references.length} 个稳定引用 · ${message.attachmentIds.length} 个附件`;
      item.append(body, metadata);
      if (message.role === "assistant" && message.references.length > 0) {
        const references = this.document.createElement("ul");
        references.className = "ai-message-references";
        references.dataset.elfuiDevtools = "ai-message-references";
        for (const reference of message.references) {
          const referenceItem = this.document.createElement("li");
          const button = this.document.createElement("button");
          button.type = "button";
          button.className = "ai-message-reference";
          button.dataset.referenceKind = reference.kind;
          button.dataset.referenceId = reference.id;
          button.setAttribute(
            "aria-label",
            `Trace AI reference ${reference.kind} ${reference.id}`,
          );
          const kindLabel =
            reference.kind === "visual-intent"
              ? "意图"
              : reference.kind === "annotation"
                ? "标注"
                : reference.kind === "file"
                  ? "文件"
                  : reference.kind === "diagnostic"
                    ? "诊断"
                    : "引用";
          button.textContent = `${kindLabel} · ${reference.label ?? reference.id}`;
          button.title = reference.id;
          button.onclick = () => this.traceAIReference(reference, request);
          referenceItem.append(button);
          references.append(referenceItem);
        }
        item.append(references);
      }
      if (message.error) {
        const error = this.document.createElement("small");
        error.className = "ai-message-error";
        error.textContent = `${message.error.code}：${message.error.message}`;
        item.append(error);
      }
      messages.append(item);
    }
    section.append(messages);
    return section;
  }

  private renderCompilerState(state: CompilerStateSnapshot): HTMLElement {
    const section = this.document.createElement("section");
    section.className = "section";
    section.dataset.elfuiDevtools = "compiler-state";
    const title = this.document.createElement("p");
    title.className = "section-title";
    title.textContent = `${zhCN.compilerMetadata} (${state.artifacts.length} 项，版本 ${state.revision})`;
    section.append(title);

    if (state.artifacts.length === 0) {
      const empty = this.document.createElement("p");
      empty.className = "pipeline-empty";
      empty.textContent = zhCN.noCompilerData;
      section.append(empty);
      this.content.append(section);
      return section;
    }

    const metadata = new Map<string, CompilerArtifact>();
    const diagnostics = new Map<string, CompilerArtifact>();
    for (const artifact of state.artifacts) {
      const target = artifact.kind === "metadata" ? metadata : diagnostics;
      target.set(artifact.sourceId, artifact);
    }
    const sourceIds = [...new Set([...metadata.keys(), ...diagnostics.keys()])];
    const selectedSourceId =
      sourceIds.find(
        (sourceId) => sourceId === this.selectedCompilerSourceId,
      ) ?? sourceIds[0]!;
    const list = this.document.createElement("ul");
    list.className = "pipeline-list";
    for (const sourceId of sourceIds) {
      const metadataArtifact = metadata.get(sourceId);
      const diagnosticsArtifact = diagnostics.get(sourceId);
      const metadataValue =
        metadataArtifact?.payload !== null &&
        typeof metadataArtifact?.payload === "object"
          ? (metadataArtifact.payload as Record<string, unknown>)
          : null;
      const componentCount = Array.isArray(metadataValue?.components)
        ? metadataValue.components.length
        : 0;
      const diagnosticCount = Array.isArray(diagnosticsArtifact?.payload)
        ? diagnosticsArtifact.payload.length
        : 0;
      const item = this.document.createElement("li");
      const button = this.document.createElement("button");
      button.type = "button";
      button.className = "pipeline-record";
      button.dataset.compilerSourceId = sourceId;
      button.setAttribute(
        "aria-pressed",
        String(sourceId === selectedSourceId),
      );
      const source = this.document.createElement("strong");
      source.textContent = sourceId;
      button.append(
        source,
        this.document.createTextNode(
          `\n${componentCount} 个组件 · ${diagnosticCount} 条诊断`,
        ),
      );
      button.onclick = () => {
        this.selectedCompilerSourceId = sourceId;
        this.render();
      };
      item.append(button);
      list.append(item);
    }
    section.append(list);

    const detail = this.document.createElement("pre");
    detail.className = "pipeline-json";
    detail.dataset.elfuiDevtools = "compiler-json";
    detail.textContent = JSON.stringify(
      {
        sourceId: selectedSourceId,
        metadata: metadata.get(selectedSourceId) ?? null,
        diagnostics: diagnostics.get(selectedSourceId) ?? null,
      },
      null,
      2,
    );
    section.append(detail);
    this.content.append(section);
    return section;
  }
}
