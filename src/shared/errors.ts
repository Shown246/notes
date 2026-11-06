export interface ErrorDetail { field: string; message: string }

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: ErrorDetail[]
  ) { super(message); }
}
