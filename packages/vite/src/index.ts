import { existsSync, statSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEVTOOLS_AI_EXECUTION_CANCEL_ENDPOINT,
  DEVTOOLS_AI_EXECUTION_ENDPOINT,
  DEVTOOLS_AI_PROVIDER_CATALOG_ENDPOINT,
  DEVTOOLS_AI_SCREENSHOT_UPLOAD_ENDPOINT,
  AIProviderRegistry,
  DeterministicMockProvider,
  type AIProvider,
} from "@elfui/devtools-ai";
import {
  DEVTOOLS_COMPILER_STATE_ENDPOINT,
  DEVTOOLS_COMPILER_UPDATE_EVENT,
  DEVTOOLS_OPEN_IN_EDITOR_ENDPOINT,
  DEVTOOLS_PROTOCOL_VERSION,
  DEVTOOLS_SOURCE_READ_ENDPOINT,
  type CompilerArtifact,
  type CompilerArtifactKind,
  type CompilerStateSnapshot,
  type SourceReadRequest,
} from "@elfui/devtools-shared";
import type { IncomingMessage, ServerResponse } from "node:http";
import launchEditor from "launch-editor";
import type { Plugin } from "vite";

import {
  createProjectSourceReader,
  ProjectSourceReadError,
} from "./project-source-reader.js";
import {
  createAIGatewayMiddleware,
  type AIGatewayPatchVerificationOptions,
} from "./ai-gateway.js";

export {
  createReadonlyAIAgentTools,
  type AIAgentToolScope,
  type ReadonlyAIAgentTools,
} from "./agent-tools.js";
export {
  runAIAgentSession,
  type AIAgentSessionEvent,
  type AIAgentSessionOptions,
} from "./agent-session.js";
export {
  DEVTOOLS_COMPILER_STATE_ENDPOINT,
  DEVTOOLS_COMPILER_UPDATE_EVENT,
  DEVTOOLS_AI_EXECUTION_CANCEL_ENDPOINT,
  DEVTOOLS_AI_EXECUTION_ENDPOINT,
  DEVTOOLS_AI_PROVIDER_CATALOG_ENDPOINT,
  DEVTOOLS_AI_SCREENSHOT_UPLOAD_ENDPOINT,
  DEVTOOLS_OPEN_IN_EDITOR_ENDPOINT,
  DEVTOOLS_SOURCE_READ_ENDPOINT,
};
export {
  assembleReadonlyProviderRequest,
  createAIGatewayMiddleware,
  type AIGatewayPatchVerificationOptions,
} from "./ai-gateway.js";
export {
  applyUnifiedDiffToSources,
  createApprovedPatchApplier,
  ApprovedPatchApplicationError,
  type ApprovedPatchApplicationErrorCode,
  type ApprovedPatchApplicationRequest,
  type ApprovedPatchApplicationResult,
  type ApprovedPatchApplier,
  type ApprovedPatchApplierOptions,
  type ApprovedPatchRollbackResult,
} from "./patch-application.js";
export {
  createPatchProposalStore,
  PatchProposalError,
  unifiedDiffAffectedFiles,
  type PatchProposalStore,
} from "./patch-proposals.js";
export {
  createPatchVerificationCoordinator,
  PATCH_VERIFICATION_STEPS,
  type PatchVerificationAdapter,
  type PatchVerificationAdapterResult,
  type PatchVerificationAdapters,
  type PatchVerificationCheckResult,
  type PatchVerificationContext,
  type PatchVerificationCoordinator,
  type PatchVerificationCoordinatorOptions,
  type PatchVerificationDiagnostic,
  type PatchVerificationResult,
  type PatchVerificationStep,
} from "./patch-verification.js";

const virtualClientId = "virtual:elfui-devtools-client";
const resolvedVirtualClientId = `\0${virtualClientId}`;
const virtualClientUrl = "/@id/__x00__virtual:elfui-devtools-client";
const virtualClientAutoId = "virtual:elfui-devtools-client/auto";
const virtualClientApiId = "virtual:elfui-devtools-client/api";
const clientAutoEntry = fileURLToPath(
  import.meta.resolve("@elfui/devtools-client/auto"),
);
const clientApiEntry = fileURLToPath(
  import.meta.resolve("@elfui/devtools-client"),
);
const MAX_SOURCE_REQUEST_BYTES = 16_384;

export interface ElfUIDevtoolsViteOptions {
  enabled?: boolean;
  editor?: string;
  openInEditor?: (file: string, line: number, column: number) => void;
  readonlyAIProvider?: AIProvider;
  readonlyAIProviders?: readonly AIProvider[];
  readonlyAIDefaultProviderId?: string;
  patchVerification?: AIGatewayPatchVerificationOptions;
}

export interface ElfUIDevtoolsCompilerHooks {
  onMetadata(metadata: unknown, id: string): void;
  onDiagnostics(diagnostics: readonly unknown[], id: string): void;
}

export interface ElfUIDevtoolsVitePlugin extends Plugin {
  /**
   * Pass this object to `elfuiMacroPlugin()` so compiler metadata and
   * diagnostics can be observed without compiling the source twice.
   */
  compiler: ElfUIDevtoolsCompilerHooks;
}

export interface CompilerArtifactStore {
  readonly compiler: ElfUIDevtoolsCompilerHooks;
  snapshot(): CompilerStateSnapshot;
  onArtifact(listener: (artifact: CompilerArtifact) => void): () => void;
}

type DevtoolsMiddleware = (
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
) => void;

const send = (
  response: ServerResponse,
  statusCode: number,
  body = "",
): void => {
  response.statusCode = statusCode;
  response.end(body);
};

const sendJson = (
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void => {
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  send(response, statusCode, JSON.stringify(body));
};

const cloneForTransport = (value: unknown): unknown => {
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch (error) {
    return {
      serializationError:
        error instanceof Error ? error.message : String(error),
    };
  }
};

export const createCompilerArtifactStore = (
  now: () => number = Date.now,
): CompilerArtifactStore => {
  const artifacts = new Map<string, CompilerArtifact>();
  const listeners = new Set<(artifact: CompilerArtifact) => void>();
  const sourceIds = new Map<string, string>();
  let revision = 0;
  const capture = (
    kind: CompilerArtifactKind,
    payload: unknown,
    id: string,
  ): void => {
    const record =
      payload !== null && typeof payload === "object"
        ? (payload as Record<string, unknown>)
        : null;
    const firstDiagnostic =
      kind === "diagnostics" && Array.isArray(payload)
        ? payload.find(
            (value): value is Record<string, unknown> =>
              value !== null && typeof value === "object",
          )
        : null;
    const sourceId =
      (typeof record?.sourceId === "string" ? record.sourceId : null) ??
      (typeof firstDiagnostic?.sourceId === "string"
        ? firstDiagnostic.sourceId
        : null) ??
      sourceIds.get(id) ??
      id;
    if (kind === "metadata") sourceIds.set(id, sourceId);
    const artifact: CompilerArtifact = {
      revision: ++revision,
      capturedAt: now(),
      id,
      sourceId,
      kind,
      payload: cloneForTransport(payload),
    };
    artifacts.set(`${kind}:${sourceId}`, artifact);
    for (const listener of listeners) listener(artifact);
  };
  return {
    compiler: {
      onMetadata: (metadata, id) => capture("metadata", metadata, id),
      onDiagnostics: (diagnostics, id) =>
        capture("diagnostics", diagnostics, id),
    },
    snapshot: () => ({
      protocolVersion: DEVTOOLS_PROTOCOL_VERSION,
      revision,
      artifacts: [...artifacts.values()].sort(
        (left, right) => left.revision - right.revision,
      ),
    }),
    onArtifact: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};

const isInsideRoot = (root: string, file: string): boolean => {
  const pathFromRoot = relative(root, file);
  return (
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
};

const positiveInteger = (value: string | null): number => {
  const parsed = Number.parseInt(value ?? "1", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
};

const hasAccessToken = (
  request: IncomingMessage,
  accessToken: string,
): boolean => {
  const provided = request.headers["x-elfui-devtools-token"];
  if (typeof provided !== "string") return false;
  const expectedBytes = Buffer.from(accessToken);
  const providedBytes = Buffer.from(provided);
  return (
    expectedBytes.length === providedBytes.length &&
    timingSafeEqual(expectedBytes, providedBytes)
  );
};

const readJsonBody = (request: IncomingMessage): Promise<SourceReadRequest> =>
  new Promise((resolveBody, rejectBody) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > MAX_SOURCE_REQUEST_BYTES)
        rejectBody(new Error("Source read request is too large"));
    });
    request.on("end", () => {
      try {
        resolveBody(JSON.parse(body) as SourceReadRequest);
      } catch {
        rejectBody(new Error("Source read request is not valid JSON"));
      }
    });
    request.on("error", rejectBody);
  });

export const createSourceReadMiddleware = (
  root: string,
  getSnapshot: () => CompilerStateSnapshot,
  accessToken: string,
): DevtoolsMiddleware => {
  const readSource = createProjectSourceReader(root, getSnapshot);
  return (request, response, next) => {
    const url = new URL(request.url ?? "/", "http://elfui.local");
    if (url.pathname !== DEVTOOLS_SOURCE_READ_ENDPOINT) {
      next();
      return;
    }
    if (request.method !== "POST") {
      send(response, 405, "Source reads require POST");
      return;
    }
    if (!hasAccessToken(request, accessToken)) {
      send(response, 403, "Invalid DevTools source capability");
      return;
    }
    void readJsonBody(request)
      .then((input) => {
        try {
          sendJson(response, 200, readSource(input));
        } catch (error) {
          send(
            response,
            error instanceof ProjectSourceReadError ? error.statusCode : 500,
            error instanceof Error
              ? error.message
              : "Failed to read source context",
          );
        }
      })
      .catch((error: unknown) => {
        send(
          response,
          error instanceof Error &&
            error.message === "Source read request is too large"
            ? 413
            : 400,
          error instanceof Error
            ? error.message
            : "Invalid source read request",
        );
      });
  };
};

export const createOpenInEditorMiddleware = (
  root: string,
  options: ElfUIDevtoolsViteOptions = {},
): DevtoolsMiddleware => {
  const projectRoot = resolve(root);
  const open =
    options.openInEditor ??
    ((file: string, line: number, column: number) => {
      const target = `${file}:${line}:${column}`;
      const onError = (fileName: string, errorMessage: string | null): void => {
        console.warn(
          `[ElfUI DevTools] Failed to open ${fileName}: ${errorMessage ?? "Unknown editor error"}`,
        );
      };
      if (options.editor) launchEditor(target, options.editor, onError);
      else launchEditor(target, onError);
    });

  return (request, response, next) => {
    const url = new URL(request.url ?? "/", "http://elfui.local");
    if (url.pathname !== DEVTOOLS_OPEN_IN_EDITOR_ENDPOINT) {
      next();
      return;
    }

    const requestedFile = url.searchParams.get("file");
    if (!requestedFile) {
      send(response, 400, "Missing source file");
      return;
    }

    const sourceFile = resolve(projectRoot, requestedFile);
    if (!isInsideRoot(projectRoot, sourceFile)) {
      send(response, 403, "Source file is outside the Vite project root");
      return;
    }
    try {
      if (!existsSync(sourceFile) || !statSync(sourceFile).isFile()) {
        send(response, 404, "Source file does not exist");
        return;
      }
      open(
        sourceFile,
        positiveInteger(url.searchParams.get("line")),
        positiveInteger(url.searchParams.get("column")),
      );
      send(response, 204);
    } catch (error) {
      send(
        response,
        500,
        error instanceof Error ? error.message : String(error),
      );
    }
  };
};

export const createCompilerStateMiddleware = (
  getSnapshot: () => CompilerStateSnapshot,
): DevtoolsMiddleware => {
  return (request, response, next) => {
    const url = new URL(request.url ?? "/", "http://elfui.local");
    if (url.pathname !== DEVTOOLS_COMPILER_STATE_ENDPOINT) {
      next();
      return;
    }
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    send(response, 200, JSON.stringify(getSnapshot()));
  };
};

export const createDevtoolsVirtualClient = (
  sourceAccessToken = "",
  aiAccessToken = "",
): string => `
import {
  createAIExecutionClient,
  createSourceContextReader,
  ingestCompilerArtifact,
  ingestCompilerSnapshot,
  installElfUIDevtools
} from ${JSON.stringify(virtualClientApiId)};

installElfUIDevtools({
  aiExecutor: createAIExecutionClient(${JSON.stringify(aiAccessToken)}),
  sourceReader: createSourceContextReader(${JSON.stringify(sourceAccessToken)})
});

const syncElfUICompilerState = async () => {
  try {
    const response = await fetch(${JSON.stringify(DEVTOOLS_COMPILER_STATE_ENDPOINT)}, {
      cache: "no-store"
    });
    if (!response.ok) throw new Error(\`HTTP \${response.status}\`);
    ingestCompilerSnapshot(await response.json());
  } catch (error) {
    console.warn("[ElfUI DevTools] Failed to load compiler state", error);
  }
};

void syncElfUICompilerState();
if (import.meta.hot) {
  import.meta.hot.on(
    ${JSON.stringify(DEVTOOLS_COMPILER_UPDATE_EVENT)},
    (artifact) => ingestCompilerArtifact(artifact)
  );
}
`;

export const createDevtoolsBootstrap = () => [
  {
    tag: "script",
    attrs: { type: "module", src: virtualClientUrl },
    injectTo: "body" as const,
  },
];

export const elfuiDevtools = (
  options: ElfUIDevtoolsViteOptions = {},
): ElfUIDevtoolsVitePlugin => {
  const compilerStore = createCompilerArtifactStore();
  const sourceAccessToken = randomBytes(24).toString("base64url");
  const aiAccessToken = randomBytes(24).toString("base64url");
  const readonlyAIProviders = options.readonlyAIProviders ?? [
    options.readonlyAIProvider ?? new DeterministicMockProvider(),
  ];
  const readonlyAIProviderRegistry = new AIProviderRegistry(
    readonlyAIProviders,
    options.readonlyAIDefaultProviderId,
  );
  let stopBroadcast: (() => void) | null = null;
  const plugin: Plugin = {
    name: "elfui-devtools",
    apply: "serve",
    configureServer(server) {
      if (options.enabled === false) return;
      server.middlewares.use(
        createOpenInEditorMiddleware(server.config.root, options),
      );
      server.middlewares.use(
        createCompilerStateMiddleware(() => compilerStore.snapshot()),
      );
      server.middlewares.use(
        createSourceReadMiddleware(
          server.config.root,
          () => compilerStore.snapshot(),
          sourceAccessToken,
        ),
      );
      server.middlewares.use(
        createAIGatewayMiddleware(
          server.config.root,
          () => compilerStore.snapshot(),
          aiAccessToken,
          readonlyAIProviderRegistry,
          Date.now,
          options.patchVerification,
        ),
      );
      stopBroadcast?.();
      stopBroadcast = compilerStore.onArtifact((artifact) => {
        server.ws.send({
          type: "custom",
          event: DEVTOOLS_COMPILER_UPDATE_EVENT,
          data: artifact,
        });
      });
      server.httpServer?.once("close", () => {
        stopBroadcast?.();
        stopBroadcast = null;
      });
    },
    resolveId(id) {
      if (id === virtualClientId) return resolvedVirtualClientId;
      if (id === virtualClientAutoId) return clientAutoEntry;
      if (id === virtualClientApiId) return clientApiEntry;
      return undefined;
    },
    load(id) {
      return id === resolvedVirtualClientId
        ? createDevtoolsVirtualClient(sourceAccessToken, aiAccessToken)
        : undefined;
    },
    transformIndexHtml: () => {
      if (options.enabled === false) return [];
      return createDevtoolsBootstrap();
    },
  };
  const compiler =
    options.enabled === false
      ? {
          onMetadata: () => undefined,
          onDiagnostics: () => undefined,
        }
      : compilerStore.compiler;
  return Object.assign(plugin, { compiler });
};
