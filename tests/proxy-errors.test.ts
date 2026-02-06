/**
 * Unit tests for proxy error classes.
 * Tests error construction, serialization, and HTTP status codes.
 */
import { describe, it, expect } from "vitest";
import {
  ProxyError,
  InsufficientBalanceError,
  GateUnreachableError,
  PayloadTooLargeError,
  UnauthorizedError,
  NotFoundError,
} from "../src/proxy/errors.js";

describe("ProxyError", () => {
  it("creates error with code and message", () => {
    const error = new ProxyError("test_error", "Test message");
    expect(error.code).toBe("test_error");
    expect(error.message).toBe("Test message");
    expect(error.httpStatus).toBe(500);
    expect(error.name).toBe("ProxyError");
  });

  it("creates error with custom HTTP status", () => {
    const error = new ProxyError("bad_request", "Invalid input", 400);
    expect(error.httpStatus).toBe(400);
  });

  it("creates error with type", () => {
    const error = new ProxyError("auth_error", "Auth failed", 401, "authentication_error");
    expect(error.type).toBe("authentication_error");
  });

  it("serializes to OpenAI-compatible format", () => {
    const error = new ProxyError("test_error", "Test message", 400, "client_error");
    const json = error.toJSON();
    expect(json).toEqual({
      error: {
        code: "test_error",
        message: "Test message",
        type: "client_error",
      },
    });
  });

  it("omits type from JSON when undefined", () => {
    const error = new ProxyError("test_error", "Test message");
    const json = error.toJSON();
    expect(json.error.type).toBeUndefined();
  });

  it("is instanceof Error", () => {
    const error = new ProxyError("test", "test");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ProxyError);
  });
});

describe("InsufficientBalanceError", () => {
  it("creates with balance and required amounts", () => {
    const error = new InsufficientBalanceError(100, 500, "gpt-4o");
    expect(error.code).toBe("insufficient_balance");
    expect(error.httpStatus).toBe(402);
    expect(error.type).toBe("insufficient_funds");
    expect(error.balance).toBe(100);
    expect(error.required).toBe(500);
    expect(error.model).toBe("gpt-4o");
  });

  it("generates helpful message", () => {
    const error = new InsufficientBalanceError(100, 500, "gpt-4o");
    expect(error.message).toContain("100");
    expect(error.message).toContain("500");
    expect(error.message).toContain("t2c mint");
  });

  it("is instanceof ProxyError", () => {
    const error = new InsufficientBalanceError(0, 100, "test");
    expect(error).toBeInstanceOf(ProxyError);
  });
});

describe("GateUnreachableError", () => {
  it("creates with gate URL", () => {
    const error = new GateUnreachableError("https://gate.example.com");
    expect(error.code).toBe("gate_unreachable");
    expect(error.httpStatus).toBe(502);
    expect(error.gateUrl).toBe("https://gate.example.com");
  });

  it("creates with optional cause", () => {
    const cause = new Error("Connection refused");
    const error = new GateUnreachableError("https://gate.example.com", cause);
    expect(error.cause).toBe(cause);
  });

  it("message includes gate URL", () => {
    const error = new GateUnreachableError("https://gate.example.com");
    expect(error.message).toContain("gate.example.com");
  });
});

describe("PayloadTooLargeError", () => {
  it("creates with size and limit", () => {
    const error = new PayloadTooLargeError(15_000_000, 10_000_000);
    expect(error.code).toBe("payload_too_large");
    expect(error.httpStatus).toBe(413);
    expect(error.size).toBe(15_000_000);
    expect(error.limit).toBe(10_000_000);
  });

  it("message shows human-readable sizes", () => {
    const error = new PayloadTooLargeError(15_000_000, 10_000_000);
    // 15M bytes = 14.3 MB, 10M bytes = 9.5 MB
    expect(error.message).toContain("14.3 MB");
    expect(error.message).toContain("9.5 MB");
  });
});

describe("UnauthorizedError", () => {
  it("creates with default message", () => {
    const error = new UnauthorizedError();
    expect(error.code).toBe("unauthorized");
    expect(error.httpStatus).toBe(401);
    expect(error.message).toContain("Bearer token");
  });

  it("creates with custom message", () => {
    const error = new UnauthorizedError("Token expired");
    expect(error.message).toBe("Token expired");
  });
});

describe("NotFoundError", () => {
  it("creates with path", () => {
    const error = new NotFoundError("/v1/unknown");
    expect(error.code).toBe("not_found");
    expect(error.httpStatus).toBe(404);
    expect(error.path).toBe("/v1/unknown");
  });

  it("message includes path", () => {
    const error = new NotFoundError("/v1/unknown");
    expect(error.message).toContain("/v1/unknown");
  });
});
