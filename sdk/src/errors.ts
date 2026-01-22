// Custom error classes for SDK

export class ApiError extends Error {
  constructor(public code: string, message: string, public statusCode = 500) {
    super(message);
    this.name = "ApiError";
  }
}

export class NetworkError extends Error {
  constructor(message: string, public cause?: Error) {
    super(message);
    this.name = "NetworkError";
  }
}

export class BidError extends ApiError {
  constructor(code: string, message: string) {
    super(code, message, 409);
    this.name = "BidError";
  }
}

export class TimeoutError extends Error {
  constructor(message = "Request timed out") {
    super(message);
    this.name = "TimeoutError";
  }
}
