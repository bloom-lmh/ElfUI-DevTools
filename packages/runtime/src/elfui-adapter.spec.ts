import { afterEach, describe, expect, it } from "vitest";

import { createDevtoolsBridge } from "./bridge";
import { getElfUIRenderRoot, installElfUIAdapter } from "./elfui-adapter";

const INSTANCE_KEY = Symbol.for("elfui.instance");
const RENDER_ROOT_REGISTRY_KEY = Symbol.for(
  "elfui.devtools.render-root-registry",
);

describe("installElfUIAdapter", () => {
  afterEach(() => {
    document.body.replaceChildren();
    delete (globalThis as unknown as Record<symbol, unknown>)[
      RENDER_ROOT_REGISTRY_KEY
    ];
  });

  it("discovers ElfUI hosts and follows DOM lifecycle changes", async () => {
    class Counter extends HTMLElement {
      public static __elfDefinition = {
        tag: "elf-adapter-counter",
        props: { count: Number },
        shadow: "open" as const,
      };
      public count = 3;
      public static __elfSource = {
        file: "/src/Counter.elf",
        line: 4,
        column: 1,
      };
    }
    customElements.define("elf-adapter-counter", Counter);
    const host = document.createElement("elf-adapter-counter") as Counter;
    (host as unknown as Record<symbol, unknown>)[INSTANCE_KEY] = {
      devtools: {
        props: { count: 4 },
        setup: { ready: true },
        exposed: { focus: "method" },
      },
    };
    document.body.appendChild(host);
    const bridge = createDevtoolsBridge();
    const adapter = installElfUIAdapter(bridge);

    expect(bridge.getSnapshot().components).toMatchObject([
      { tag: "elf-adapter-counter", source: { file: "/src/Counter.elf" } },
    ]);
    expect(bridge.getSnapshot().components).toHaveLength(1);
    const id = bridge.getSnapshot().components[0]!.id;
    expect(bridge.getComponentDetail(id)?.setup).toMatchObject({
      entries: [{ key: "ready", value: { value: true } }],
    });
    host.remove();
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge.getSnapshot().components).toHaveLength(0);
    adapter.disconnect();
  });

  it("discovers an existing macro component after its custom element upgrades", async () => {
    const host = document.createElement("elf-adapter-late-counter");
    document.body.appendChild(host);
    const bridge = createDevtoolsBridge();
    const adapter = installElfUIAdapter(bridge);

    expect(bridge.getSnapshot().components).toHaveLength(0);

    class LateCounter extends HTMLElement {
      public static __elfDefinition = {
        tag: "elf-adapter-late-counter",
        props: {},
        shadow: "open" as const,
      };

      public constructor() {
        super();
        (this as unknown as Record<symbol, unknown>)[INSTANCE_KEY] = {};
      }
    }
    customElements.define("elf-adapter-late-counter", LateCounter);
    await customElements.whenDefined("elf-adapter-late-counter");
    await Promise.resolve();
    await Promise.resolve();

    expect(bridge.getSnapshot().components).toMatchObject([
      { tag: "elf-adapter-late-counter" },
    ]);
    adapter.disconnect();
  });

  it("recursively discovers existing components inside open shadow roots", () => {
    class ShadowParent extends HTMLElement {
      public static __elfDefinition = {
        tag: "elf-adapter-shadow-parent",
        props: {},
        shadow: "open" as const,
      };
      public constructor() {
        super();
        (this as unknown as Record<symbol, unknown>)[INSTANCE_KEY] = {};
      }
    }
    class ShadowChild extends HTMLElement {
      public static __elfDefinition = {
        tag: "elf-adapter-shadow-child",
        props: {},
        shadow: "open" as const,
      };
      public constructor() {
        super();
        (this as unknown as Record<symbol, unknown>)[INSTANCE_KEY] = {};
      }
    }
    customElements.define("elf-adapter-shadow-parent", ShadowParent);
    customElements.define("elf-adapter-shadow-child", ShadowChild);
    const parent = document.createElement("elf-adapter-shadow-parent");
    const child = document.createElement("elf-adapter-shadow-child");
    parent.attachShadow({ mode: "open" }).appendChild(child);
    document.body.appendChild(parent);

    const bridge = createDevtoolsBridge();
    const adapter = installElfUIAdapter(bridge);
    const components = bridge.getSnapshot().components;
    const parentNode = components.find(
      (component) => component.tag === "elf-adapter-shadow-parent",
    );
    const childNode = components.find(
      (component) => component.tag === "elf-adapter-shadow-child",
    );

    expect(components).toHaveLength(2);
    expect(childNode?.parentId).toBe(parentNode?.id);
    expect(parentNode?.children).toEqual([childNode?.id]);
    adapter.disconnect();
  });

  it("discovers components through the registry-only closed-root channel", () => {
    class ClosedParent extends HTMLElement {
      public static __elfDefinition = {
        tag: "elf-adapter-closed-parent",
        props: {},
        shadow: "closed" as const,
      };
      public constructor() {
        super();
        (this as unknown as Record<symbol, unknown>)[INSTANCE_KEY] = {};
      }
    }
    class ClosedChild extends HTMLElement {
      public static __elfDefinition = {
        tag: "elf-adapter-closed-child",
        props: {},
        shadow: "open" as const,
      };
      public constructor() {
        super();
        (this as unknown as Record<symbol, unknown>)[INSTANCE_KEY] = {};
      }
    }
    customElements.define("elf-adapter-closed-parent", ClosedParent);
    customElements.define("elf-adapter-closed-child", ClosedChild);
    const parent = document.createElement("elf-adapter-closed-parent");
    const root = parent.attachShadow({ mode: "closed" });
    const renderRoots = new WeakMap<HTMLElement, ShadowRoot>();
    renderRoots.set(parent, root);
    Object.defineProperty(globalThis, RENDER_ROOT_REGISTRY_KEY, {
      value: renderRoots,
      configurable: true,
    });
    root.append(document.createElement("elf-adapter-closed-child"));
    document.body.append(parent);

    const bridge = createDevtoolsBridge();
    const adapter = installElfUIAdapter(bridge);
    const components = bridge.getSnapshot().components;
    const parentNode = components.find(
      (component) => component.tag === "elf-adapter-closed-parent",
    );
    const childNode = components.find(
      (component) => component.tag === "elf-adapter-closed-child",
    );

    expect(components).toHaveLength(2);
    expect(childNode?.parentId).toBe(parentNode?.id);
    adapter.disconnect();
  });

  it("falls back to the beta.14 closed-root Symbol mirror", () => {
    const host = document.createElement("elf-legacy-closed-root");
    const root = host.attachShadow({ mode: "closed" });
    Object.defineProperty(host, Symbol.for("elfui.devtools.render-root"), {
      value: root,
      configurable: true,
    });

    expect(getElfUIRenderRoot(host)).toBe(root);
  });
});
