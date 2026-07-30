import {
  DEVTOOLS_OPEN_IN_EDITOR_ENDPOINT,
  DEVTOOLS_SOURCE_READ_ENDPOINT,
  type SourceReadRequest,
  type SourceReadResult,
  type SourceLocation,
} from "@elfui/devtools-shared";

export type OpenSourceInEditor = (source: SourceLocation) => Promise<void>;
export type ReadSourceContext = (
  request: SourceReadRequest,
) => Promise<SourceReadResult>;

export const openSourceInEditor = async (
  source: SourceLocation,
  fetchImplementation: typeof fetch = globalThis.fetch,
  origin = globalThis.location?.origin ?? "http://localhost",
): Promise<void> => {
  const url = new URL(DEVTOOLS_OPEN_IN_EDITOR_ENDPOINT, origin);
  url.searchParams.set("file", source.file);
  url.searchParams.set("line", String(source.line));
  url.searchParams.set("column", String(source.column));
  const response = await fetchImplementation(url, { method: "POST" });
  if (!response.ok) {
    throw new Error(
      `Failed to open source in editor (${response.status} ${response.statusText})`,
    );
  }
};

export const createSourceContextReader = (
  accessToken: string,
  fetchImplementation: typeof fetch = globalThis.fetch,
  origin = globalThis.location?.origin ?? "http://localhost",
): ReadSourceContext => {
  return async (request) => {
    const response = await fetchImplementation(
      new URL(DEVTOOLS_SOURCE_READ_ENDPOINT, origin),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-elfui-devtools-token": accessToken,
        },
        body: JSON.stringify(request),
      },
    );
    if (!response.ok)
      throw new Error(
        `Failed to read source context (${response.status} ${response.statusText})`,
      );
    return (await response.json()) as SourceReadResult;
  };
};
