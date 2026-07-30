export interface RedactedText {
  text: string;
  replacements: number;
}

export const redactSensitiveText = (input: string): RedactedText => {
  let text = input;
  let replacements = 0;
  const replace = (
    pattern: RegExp,
    replacement: (...matches: string[]) => string,
  ): void => {
    text = text.replace(pattern, (...matches: string[]) => {
      replacements += 1;
      return replacement(...matches);
    });
  };

  replace(
    /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gu,
    () => "[REDACTED PRIVATE KEY]",
  );
  replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/giu, () => "Bearer [REDACTED]");
  replace(
    /(\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password)\b\s*[:=]\s*)(["'`])([^"'`\r\n]+)\2/giu,
    (_match, prefix, quote) => `${prefix}${quote}[REDACTED]${quote}`,
  );
  replace(
    /(\b[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)\s*=\s*)([^\s#"'`]+)/gu,
    (_match, prefix) => `${prefix}[REDACTED]`,
  );
  replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gu, () => "[REDACTED]");

  return { text, replacements };
};
