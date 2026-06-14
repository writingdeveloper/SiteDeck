/** An error carrying a stable code (for client-side localization) plus optional detail. */
export class AppError extends Error {
  constructor(
    public code: string,
    public detail?: string,
  ) {
    super(`${code}${detail ? `: ${detail}` : ''}`);
    this.name = 'AppError';
  }
}
