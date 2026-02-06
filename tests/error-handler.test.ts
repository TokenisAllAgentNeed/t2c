/**
 * Unit tests for error handler middleware.
 * Tests error response formatting and HTTP status codes.
 */
import { describe, it, expect, vi } from "vitest";
import {
  handleError,
  sendError,
  sendJsonResponse,
  type ResponseWriter,
} from "../src/proxy/response.js";
import {
  ProxyError,
  InsufficientBalanceError,
  PayloadTooLargeError,
  UnauthorizedError,
  NotFoundError,
  GateUnreachableError,
} from "../src/proxy/errors.js";

describe("sendJsonResponse", () => {
  function createMockResponse(): ResponseWriter & { written: { status: number; headers: Record<string, string>; body: string } } {
    const written = { status: 0, headers: {} as Record<string, string>, body: "" };
    return {
      writeHead: vi.fn((status: number, headers?: Record<string, string>) => {
        written.status = status;
        written.headers = headers ?? {};
      }),
      end: vi.fn((body?: string) => {
        written.body = body ?? "";
      }),
      written,
    };
  }

  it("sends JSON response with status and body", () => {
    const res = createMockResponse();
    sendJsonResponse(res, 200, { ok: true });

    expect(res.writeHead).toHaveBeenCalledWith(200, { "Content-Type": "application/json" });
    expect(res.end).toHaveBeenCalledWith('{"ok":true}');
  });

  it("sends empty object when body is undefined", () => {
    const res = createMockResponse();
    sendJsonResponse(res, 204);

    expect(res.writeHead).toHaveBeenCalledWith(204, { "Content-Type": "application/json" });
    expect(res.end).toHaveBeenCalledWith("{}");
  });

  it("handles complex nested objects", () => {
    const res = createMockResponse();
    sendJsonResponse(res, 200, {
      data: { items: [1, 2, 3] },
      meta: { total: 3 },
    });

    expect(res.written.body).toBe('{"data":{"items":[1,2,3]},"meta":{"total":3}}');
  });
});

describe("sendError", () => {
  function createMockResponse(): ResponseWriter & { written: { status: number; body: string } } {
    const written = { status: 0, body: "" };
    return {
      writeHead: vi.fn((status: number) => {
        written.status = status;
      }),
      end: vi.fn((body?: string) => {
        written.body = body ?? "";
      }),
      written,
    };
  }

  it("sends error with code and message", () => {
    const res = createMockResponse();
    sendError(res, 400, "bad_request", "Invalid input");

    expect(res.written.status).toBe(400);
    const body = JSON.parse(res.written.body);
    expect(body.error.code).toBe("bad_request");
    expect(body.error.message).toBe("Invalid input");
  });

  it("includes type when provided", () => {
    const res = createMockResponse();
    sendError(res, 401, "unauthorized", "No token", "auth_error");

    const body = JSON.parse(res.written.body);
    expect(body.error.type).toBe("auth_error");
  });

  it("omits type when not provided", () => {
    const res = createMockResponse();
    sendError(res, 500, "internal", "Server error");

    const body = JSON.parse(res.written.body);
    expect(body.error.type).toBeUndefined();
  });
});

describe("handleError", () => {
  function createMockResponse(): ResponseWriter & { written: { status: number; body: string } } {
    const written = { status: 0, body: "" };
    return {
      writeHead: vi.fn((status: number) => {
        written.status = status;
      }),
      end: vi.fn((body?: string) => {
        written.body = body ?? "";
      }),
      written,
    };
  }

  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  describe("ProxyError handling", () => {
    it("handles ProxyError with correct status and JSON", () => {
      const res = createMockResponse();
      const error = new ProxyError("test_error", "Test message", 400);

      handleError(res, error, mockLogger);

      expect(res.written.status).toBe(400);
      const body = JSON.parse(res.written.body);
      expect(body.error.code).toBe("test_error");
      expect(body.error.message).toBe("Test message");
    });

    it("handles InsufficientBalanceError", () => {
      const res = createMockResponse();
      const error = new InsufficientBalanceError(100, 500, "gpt-4o");

      handleError(res, error, mockLogger);

      expect(res.written.status).toBe(402);
      const body = JSON.parse(res.written.body);
      expect(body.error.code).toBe("insufficient_balance");
      expect(body.error.type).toBe("insufficient_funds");
    });

    it("handles PayloadTooLargeError", () => {
      const res = createMockResponse();
      const error = new PayloadTooLargeError(15_000_000, 10_000_000);

      handleError(res, error, mockLogger);

      expect(res.written.status).toBe(413);
      const body = JSON.parse(res.written.body);
      expect(body.error.code).toBe("payload_too_large");
    });

    it("handles UnauthorizedError", () => {
      const res = createMockResponse();
      const error = new UnauthorizedError();

      handleError(res, error, mockLogger);

      expect(res.written.status).toBe(401);
    });

    it("handles NotFoundError", () => {
      const res = createMockResponse();
      const error = new NotFoundError("/unknown");

      handleError(res, error, mockLogger);

      expect(res.written.status).toBe(404);
    });

    it("handles GateUnreachableError", () => {
      const res = createMockResponse();
      const error = new GateUnreachableError("https://gate.example.com");

      handleError(res, error, mockLogger);

      expect(res.written.status).toBe(502);
    });
  });

  describe("standard Error handling", () => {
    it("handles generic Error as 500", () => {
      const res = createMockResponse();
      const error = new Error("Something went wrong");

      handleError(res, error, mockLogger);

      expect(res.written.status).toBe(500);
      const body = JSON.parse(res.written.body);
      expect(body.error.code).toBe("proxy_error");
      expect(body.error.message).toBe("Internal proxy error");
    });

    it("handles 'Request body too large' as 413", () => {
      const res = createMockResponse();
      const error = new Error("Request body too large");

      handleError(res, error, mockLogger);

      expect(res.written.status).toBe(413);
      const body = JSON.parse(res.written.body);
      expect(body.error.code).toBe("payload_too_large");
    });

    it("logs error with logger", () => {
      const res = createMockResponse();
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const error = new Error("Test error");

      handleError(res, error, logger);

      expect(logger.error).toHaveBeenCalledWith("Proxy error:", error);
    });
  });

  describe("unknown error handling", () => {
    it("handles string thrown as error", () => {
      const res = createMockResponse();
      const error = "string error";

      handleError(res, error, mockLogger);

      expect(res.written.status).toBe(500);
    });

    it("handles null thrown as error", () => {
      const res = createMockResponse();
      
      handleError(res, null, mockLogger);

      expect(res.written.status).toBe(500);
    });

    it("handles undefined thrown as error", () => {
      const res = createMockResponse();
      
      handleError(res, undefined, mockLogger);

      expect(res.written.status).toBe(500);
    });

    it("handles object thrown as error", () => {
      const res = createMockResponse();
      
      handleError(res, { custom: "error" }, mockLogger);

      expect(res.written.status).toBe(500);
    });
  });
});
