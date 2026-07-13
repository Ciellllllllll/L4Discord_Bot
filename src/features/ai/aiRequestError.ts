export type AiRequestErrorKind =
  | "configuration"
  | "caller_abort"
  | "timeout"
  | "network"
  | "http_status"
  | "invalid_response";

export class AiRequestError extends Error {
  constructor(
    public readonly kind: AiRequestErrorKind,
    message: string,
    options: {
      status?: number;
      apiCode?: string;
      usageTotalTokens?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AiRequestError";
    this.status = options.status;
    this.apiCode = options.apiCode;
    this.usageTotalTokens = options.usageTotalTokens;
  }

  readonly status?: number;
  readonly apiCode?: string;
  readonly usageTotalTokens?: number;
}
