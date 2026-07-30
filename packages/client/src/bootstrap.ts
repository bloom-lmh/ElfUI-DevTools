import {
  createDevtoolsBridge,
  createInPageDevtoolsTransport,
  installElfUIAdapter,
  installGlobalDevtoolsBridge,
  type ElfUIDevtoolsBridge,
} from "@elfui/devtools-runtime";
import {
  DEVTOOLS_PROTOCOL_VERSION,
  type CompilerArtifact,
  type CompilerStateSnapshot,
} from "@elfui/devtools-shared";

import { DevtoolsPanel } from "./panel.js";
import type { AIExecutionClient } from "./ai-execution.js";
import { DevtoolsRpcClient } from "./rpc-client.js";
import type { ReadSourceContext } from "./source.js";

let activeBridge: ElfUIDevtoolsBridge | null = null;
const pendingCompilerArtifacts: CompilerArtifact[] = [];

export interface InstallElfUIDevtoolsOptions {
  aiExecutor?: AIExecutionClient;
  sourceReader?: ReadSourceContext;
}

export const ingestCompilerArtifact = (artifact: CompilerArtifact): void => {
  if (!activeBridge) {
    pendingCompilerArtifacts.push(artifact);
    return;
  }
  activeBridge.ingestCompilerArtifact(artifact);
};

export const ingestCompilerSnapshot = (
  snapshot: CompilerStateSnapshot,
): void => {
  if (
    snapshot.protocolVersion !== DEVTOOLS_PROTOCOL_VERSION ||
    !Array.isArray(snapshot.artifacts)
  )
    return;
  for (const artifact of [...snapshot.artifacts].sort(
    (left, right) => left.revision - right.revision,
  )) {
    ingestCompilerArtifact(artifact);
  }
};

export const installElfUIDevtools = (
  options: InstallElfUIDevtoolsOptions = {},
): (() => void) => {
  const bridge = createDevtoolsBridge();
  activeBridge = bridge;
  for (const artifact of pendingCompilerArtifacts.splice(0)) {
    bridge.ingestCompilerArtifact(artifact);
  }
  const uninstallGlobal = installGlobalDevtoolsBridge(bridge);
  const adapter = installElfUIAdapter(bridge);
  const rpc = new DevtoolsRpcClient(createInPageDevtoolsTransport(bridge));
  let disposed = false;
  let panel: DevtoolsPanel | null = null;
  void rpc
    .connect()
    .then(() => {
      if (!disposed)
        panel = new DevtoolsPanel(
          bridge,
          window.document,
          rpc,
          undefined,
          undefined,
          options.sourceReader,
          options.aiExecutor,
        );
    })
    .catch((error: unknown) => {
      console.warn("[ElfUI DevTools] RPC handshake failed", error);
      if (!disposed)
        panel = new DevtoolsPanel(
          bridge,
          window.document,
          undefined,
          undefined,
          undefined,
          options.sourceReader,
          options.aiExecutor,
        );
    });
  return () => {
    disposed = true;
    panel?.dispose();
    rpc.dispose();
    adapter.disconnect();
    uninstallGlobal();
    if (activeBridge === bridge) activeBridge = null;
  };
};
