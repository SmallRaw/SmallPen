export class SmallPenError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "SmallPenError";
    this.code = code;
    this.details = details;
  }
}

export function fail(code, message, details) {
  throw new SmallPenError(code, message, details);
}
