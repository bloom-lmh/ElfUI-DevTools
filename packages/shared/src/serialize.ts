import type {
  SerializedArray,
  SerializedCollection,
  SerializedObject,
  SerializedValue,
} from "./protocol.js";

export interface SerializeOptions {
  maxDepth?: number;
  maxEntries?: number;
}

const defaultOptions: Required<SerializeOptions> = {
  maxDepth: 4,
  maxEntries: 50,
};

const preview = (value: unknown): string => {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "function")
    return `[Function ${value.name || "anonymous"}]`;
  if (typeof value === "symbol") return String(value);
  if (typeof value === "bigint") return `${String(value)}n`;
  if (typeof value === "object") {
    const name = (value as { constructor?: { name?: string } }).constructor
      ?.name;
    return `[${name || "Object"}]`;
  }
  return String(value);
};

const isDomNode = (value: unknown): value is Node =>
  typeof Node !== "undefined" && value instanceof Node;

export const serialize = (
  value: unknown,
  options: SerializeOptions = {},
): SerializedValue => {
  const resolved = { ...defaultOptions, ...options };
  const seen = new WeakMap<object, number>();
  let nextId = 1;

  const visit = (current: unknown, depth: number): SerializedValue => {
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "number" ||
      typeof current === "boolean"
    ) {
      return { kind: "primitive", value: current };
    }
    if (current === undefined)
      return { kind: "undefined", preview: "undefined" };
    if (typeof current === "bigint")
      return { kind: "bigint", preview: `${String(current)}n` };
    if (typeof current === "symbol")
      return { kind: "symbol", preview: String(current) };
    if (typeof current === "function")
      return { kind: "function", preview: preview(current) };
    if (isDomNode(current))
      return { kind: "dom", preview: `<${current.nodeName.toLowerCase()}>` };
    if (current instanceof WeakMap || current instanceof WeakSet)
      return { kind: "weak", preview: preview(current) };
    if (current instanceof Date)
      return {
        kind: "date",
        preview: Number.isNaN(current.valueOf())
          ? "Invalid Date"
          : current.toISOString(),
      };
    if (current instanceof RegExp)
      return { kind: "regexp", preview: String(current) };
    if (current instanceof Error)
      return { kind: "error", preview: `${current.name}: ${current.message}` };

    const object = current as object;
    const previousId = seen.get(object);
    if (previousId !== undefined)
      return { kind: "reference", id: previousId, preview: preview(current) };

    const id = nextId++;
    seen.set(object, id);
    if (depth >= resolved.maxDepth)
      return { kind: "reference", id, preview: preview(current) };

    if (Array.isArray(current)) {
      const values = current
        .slice(0, resolved.maxEntries)
        .map((item) => visit(item, depth + 1));
      const result: SerializedArray = {
        kind: "array",
        id,
        items: values,
        truncated: current.length > values.length,
      };
      return result;
    }
    if (current instanceof Map) {
      const entries = Array.from(current.entries())
        .slice(0, resolved.maxEntries)
        .map(([key, item]) => ({
          key: visit(key, depth + 1),
          value: visit(item, depth + 1),
        }));
      const result: SerializedCollection = {
        kind: "map",
        id,
        entries,
        truncated: current.size > entries.length,
      };
      return result;
    }
    if (current instanceof Set) {
      const entries = Array.from(current.values())
        .slice(0, resolved.maxEntries)
        .map((item) => visit(item, depth + 1));
      const result: SerializedCollection = {
        kind: "set",
        id,
        entries,
        truncated: current.size > entries.length,
      };
      return result;
    }

    const keys = Object.keys(current as object);
    const entries = keys.slice(0, resolved.maxEntries).map((key) => {
      let entry: unknown;
      try {
        entry = (current as Record<string, unknown>)[key];
      } catch (error) {
        entry = error instanceof Error ? error : new Error(String(error));
      }
      return { key, value: visit(entry, depth + 1) };
    });
    const result: SerializedObject = {
      kind: "object",
      id,
      name:
        (current as { constructor?: { name?: string } }).constructor?.name ||
        "Object",
      entries,
      truncated: keys.length > entries.length,
    };
    return result;
  };

  return visit(value, 0);
};
