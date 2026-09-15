export class AppError extends Error {
  constructor(
    message: string,
    readonly code: string = "app_error"
  ) {
    super(message);
    this.name = "AppError";
  }
}
