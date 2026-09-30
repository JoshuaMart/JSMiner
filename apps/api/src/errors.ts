/** Stable public code only; never include paths, source, or tool output. */
export class ServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly publicMessage?: string,
  ) {
    super(code);
  }
}
