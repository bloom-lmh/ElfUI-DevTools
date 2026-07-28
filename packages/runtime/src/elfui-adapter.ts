import type { DevtoolsComponentInput } from "./bridge.js";
import type { ElfUIDevtoolsBridge } from "./bridge.js";
import type { SourceLocation } from "@elfui/devtools-shared";

const INSTANCE_KEY = Symbol.for("elfui.instance");
const APP_ID_KEY = Symbol.for("elfui.app.id");
const RENDER_ROOT_KEY = Symbol.for("elfui.devtools.render-root");
const RENDER_ROOT_REGISTRY_KEY = Symbol.for(
  "elfui.devtools.render-root-registry",
);

type WeakRegistry<K extends object, V> = Pick<WeakMap<K, V>, "get" | "set">;

const isWeakRegistry = <K extends object, V>(
  value: unknown,
): value is WeakRegistry<K, V> =>
  !!value &&
  typeof value === "object" &&
  typeof (value as { get?: unknown }).get === "function" &&
  typeof (value as { set?: unknown }).set === "function";

const renderRootRegistry = (): WeakRegistry<HTMLElement, ShadowRoot> | null => {
  try {
    const value = (globalThis as unknown as Record<symbol, unknown>)[
      RENDER_ROOT_REGISTRY_KEY
    ];
    return isWeakRegistry<HTMLElement, ShadowRoot>(value) ? value : null;
  } catch {
    return null;
  }
};

interface ElfUIDefinition {
  tag?: string;
  props?: Record<string, unknown>;
  shadow?: "open" | "closed" | false;
}

interface ElfUIConstructor extends CustomElementConstructor {
  __elfDefinition?: ElfUIDefinition;
  __elfSource?: SourceLocation;
}

interface ElfUIInstanceDebugState {
  devtools?: {
    id?: string;
    parentId?: string | null;
    props?: Record<string, unknown>;
    setup?: Record<string, unknown>;
    exposed?: Record<string, unknown>;
  };
}

const instanceFor = (host: HTMLElement): ElfUIInstanceDebugState | null =>
  ((host as unknown as Record<symbol, unknown>)[INSTANCE_KEY] as
    | ElfUIInstanceDebugState
    | undefined) ?? null;

const appIdFor = (host: HTMLElement): string | null => {
  let current: Node | null = host;
  while (current) {
    const appId = (current as unknown as Record<symbol, unknown>)[APP_ID_KEY];
    if (typeof appId === "string") return appId;
    if (current.parentNode) current = current.parentNode;
    else if (current instanceof ShadowRoot) current = current.host;
    else current = null;
  }
  return null;
};

const isElfUIHost = (node: Node): node is HTMLElement => {
  if (!(node instanceof HTMLElement)) return false;
  const constructor = node.constructor as ElfUIConstructor;
  return Boolean(
    constructor.__elfDefinition?.tag &&
    (node as unknown as Record<symbol, unknown>)[INSTANCE_KEY],
  );
};

const attributes = (host: HTMLElement): Record<string, string> =>
  Object.fromEntries(
    Array.from(host.attributes, (attribute) => [
      attribute.name,
      attribute.value,
    ]),
  );

export const getElfUIRenderRoot = (
  host: HTMLElement,
): ShadowRoot | HTMLElement | null => {
  const registry = renderRootRegistry();
  if (registry) {
    try {
      const root = registry.get(host);
      if (root instanceof ShadowRoot) return root;
    } catch {
      // Fall through to the beta.14 compatibility mirror.
    }
  }
  try {
    const instrumented = (host as unknown as Record<symbol, unknown>)[
      RENDER_ROOT_KEY
    ];
    if (instrumented instanceof ShadowRoot) return instrumented;
  } catch {
    // Fall through to the native open-root channel.
  }
  return host.shadowRoot ?? host;
};

const inputFor = (host: HTMLElement): DevtoolsComponentInput => {
  const definition = (host.constructor as ElfUIConstructor).__elfDefinition!;
  const source = (host.constructor as ElfUIConstructor).__elfSource;
  const propNames = Object.keys(definition.props ?? {});
  const debug = instanceFor(host)?.devtools;
  const hostRef = new WeakRef(host);
  return {
    ...(typeof debug?.id === "string" ? { id: debug.id } : {}),
    host,
    appId: appIdFor(host),
    ...(typeof debug?.parentId === "string" || debug?.parentId === null
      ? { parentId: debug.parentId }
      : {}),
    tag: definition.tag!,
    ...(definition.tag ? { displayName: definition.tag } : {}),
    shadowMode:
      definition.shadow === false ? "none" : (definition.shadow ?? "open"),
    ...(source ? { source } : {}),
    props: () =>
      debug?.props ??
      Object.fromEntries(
        propNames.map((name) => [
          name,
          hostRef.deref()?.[name as keyof HTMLElement],
        ]),
      ),
    attrs: () => {
      const current = hostRef.deref();
      return current ? attributes(current) : {};
    },
    setup: () => debug?.setup ?? {},
    exposed: () => debug?.exposed ?? {},
  };
};

const visit = (
  root: Node,
  callback: (host: HTMLElement) => void,
  onUnresolvedCustomElement?: (host: HTMLElement) => void,
): void => {
  const elements: Element[] = [
    ...(root instanceof Element ? [root] : []),
    ...Array.from((root as ParentNode).querySelectorAll?.("*") ?? []),
  ];
  for (const element of elements) {
    if (isElfUIHost(element)) callback(element);
    else if (element instanceof HTMLElement && element.localName.includes("-"))
      onUnresolvedCustomElement?.(element);
    if (element instanceof HTMLElement) {
      const renderRoot = getElfUIRenderRoot(element);
      if (renderRoot instanceof ShadowRoot)
        visit(renderRoot, callback, onUnresolvedCustomElement);
    }
  }
};

export interface ElfUIAdapter {
  disconnect(): void;
  scan(): void;
}

export const installElfUIAdapter = (
  bridge: ElfUIDevtoolsBridge,
  root: ParentNode = document,
): ElfUIAdapter => {
  const documentForRoot =
    root instanceof Document ? root : (root.ownerDocument ?? document);
  const registry = documentForRoot.defaultView?.customElements;
  const pendingDefinitions = new Set<string>();
  let disconnected = false;

  const watchForUpgrade = (host: HTMLElement): void => {
    if (!registry) return;
    const tag = host.localName;
    if (pendingDefinitions.has(tag)) return;
    pendingDefinitions.add(tag);
    void registry.whenDefined(tag).then(() => {
      pendingDefinitions.delete(tag);
      if (!disconnected) queueMicrotask(scan);
    });
  };
  const scan = (): void =>
    visit(
      root as Node,
      (host) => bridge.registerComponent(inputFor(host)),
      watchForUpgrade,
    );
  scan();
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of Array.from(record.addedNodes))
        visit(
          node,
          (host) => bridge.registerComponent(inputFor(host)),
          watchForUpgrade,
        );
      for (const node of Array.from(record.removedNodes)) {
        visit(node, (host) =>
          queueMicrotask(() => {
            if (!host.isConnected) bridge.unregisterComponent(host);
          }),
        );
      }
    }
  });
  observer.observe(root, { childList: true, subtree: true });
  return {
    disconnect: () => {
      disconnected = true;
      observer.disconnect();
    },
    scan,
  };
};
