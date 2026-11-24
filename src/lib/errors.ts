/** Error carrying the HTTP status and a type that both API styles can render. */
export class HttpError extends Error {
  readonly status: number
  readonly type: string

  constructor(status: number, message: string, type = "api_error") {
    super(message)
    this.status = status
    this.type = type
  }
}

/** Map the Agent SDK's assistant-message error codes to HTTP statuses. */
export function statusForSdkError(code: string | undefined): number {
  switch (code) {
    case "authentication_failed":
    case "oauth_org_not_allowed":
      return 401
    case "billing_error":
    case "account_on_hold":
      return 402
    case "rate_limit":
      return 429
    case "invalid_request":
    case "max_output_tokens":
      return 400
    case "model_not_found":
      return 404
    case "overloaded":
      return 529
    default:
      return 502
  }
}

export function anthropicErrorBody(err: HttpError) {
  return { type: "error", error: { type: err.type, message: err.message } }
}

export function openAIErrorBody(err: HttpError) {
  return { error: { message: err.message, type: err.type, code: err.status } }
}

export function toHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err
  if (err instanceof SyntaxError) {
    return new HttpError(400, `Invalid JSON body: ${err.message}`, "invalid_request_error")
  }
  if (err instanceof Error && err.name === "AbortError") {
    return new HttpError(499, "Request was cancelled", "cancelled")
  }
  return new HttpError(500, err instanceof Error ? err.message : String(err))
}
