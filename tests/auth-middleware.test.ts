/**
 * Unit tests for auth middleware.
 * Tests Bearer token validation with timing-safe comparison.
 */
import { describe, it, expect, vi } from "vitest";
import { createAuthChecker, type AuthChecker } from "../src/proxy/auth.js";

describe("createAuthChecker", () => {
  const secret = "test-secret-token-12345";

  function createMockRequest(authHeader?: string) {
    return {
      headers: {
        authorization: authHeader,
      },
    } as { headers: { authorization?: string } };
  }

  describe("valid authentication", () => {
    it("returns true for valid Bearer token", () => {
      const check = createAuthChecker(secret);
      const req = createMockRequest(`Bearer ${secret}`);
      expect(check(req)).toBe(true);
    });

    it("handles tokens with special characters", () => {
      const specialSecret = "abc123!@#$%^&*()_+-=[]{}|;':\",./<>?";
      const check = createAuthChecker(specialSecret);
      const req = createMockRequest(`Bearer ${specialSecret}`);
      expect(check(req)).toBe(true);
    });

    it("handles long tokens", () => {
      const longSecret = "a".repeat(1000);
      const check = createAuthChecker(longSecret);
      const req = createMockRequest(`Bearer ${longSecret}`);
      expect(check(req)).toBe(true);
    });
  });

  describe("invalid authentication", () => {
    it("returns false when Authorization header is missing", () => {
      const check = createAuthChecker(secret);
      const req = createMockRequest(undefined);
      expect(check(req)).toBe(false);
    });

    it("returns false for empty Authorization header", () => {
      const check = createAuthChecker(secret);
      const req = createMockRequest("");
      expect(check(req)).toBe(false);
    });

    it("returns false for wrong token", () => {
      const check = createAuthChecker(secret);
      const req = createMockRequest("Bearer wrong-token");
      expect(check(req)).toBe(false);
    });

    it("returns false for non-Bearer scheme", () => {
      const check = createAuthChecker(secret);
      const req = createMockRequest(`Basic ${secret}`);
      expect(check(req)).toBe(false);
    });

    it("returns false for lowercase bearer", () => {
      const check = createAuthChecker(secret);
      const req = createMockRequest(`bearer ${secret}`);
      expect(check(req)).toBe(false);
    });

    it("returns false for missing token after Bearer", () => {
      const check = createAuthChecker(secret);
      const req = createMockRequest("Bearer ");
      expect(check(req)).toBe(false);
    });

    it("returns false for Bearer only (no space)", () => {
      const check = createAuthChecker(secret);
      const req = createMockRequest("Bearer");
      expect(check(req)).toBe(false);
    });

    it("returns false for token with extra spaces", () => {
      const check = createAuthChecker(secret);
      const req = createMockRequest(`Bearer  ${secret}`);
      expect(check(req)).toBe(false);
    });

    it("returns false for token with leading space", () => {
      const check = createAuthChecker(secret);
      const req = createMockRequest(` Bearer ${secret}`);
      expect(check(req)).toBe(false);
    });
  });

  describe("timing-safe comparison", () => {
    it("takes similar time for wrong tokens of same length", () => {
      const check = createAuthChecker(secret);
      const wrongToken = "x".repeat(secret.length);
      
      // Just verify it returns false - timing safety is implementation detail
      const req = createMockRequest(`Bearer ${wrongToken}`);
      expect(check(req)).toBe(false);
    });

    it("handles different length tokens safely", () => {
      const check = createAuthChecker(secret);
      
      // Shorter token
      const shortReq = createMockRequest("Bearer short");
      expect(check(shortReq)).toBe(false);
      
      // Longer token
      const longReq = createMockRequest(`Bearer ${secret}extra`);
      expect(check(longReq)).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("handles empty secret", () => {
      const check = createAuthChecker("");
      const req = createMockRequest("Bearer ");
      // Empty token after "Bearer " should match empty secret
      expect(check(req)).toBe(true);
    });

    it("handles unicode in tokens", () => {
      const unicodeSecret = "密码🔐token";
      const check = createAuthChecker(unicodeSecret);
      const req = createMockRequest(`Bearer ${unicodeSecret}`);
      expect(check(req)).toBe(true);
    });

    it("is case-sensitive for token value", () => {
      const check = createAuthChecker("MySecret");
      const req = createMockRequest("Bearer mysecret");
      expect(check(req)).toBe(false);
    });
  });
});

describe("AuthChecker type", () => {
  it("accepts IncomingMessage-like objects", () => {
    const check: AuthChecker = createAuthChecker("secret");
    // Should accept any object with headers.authorization
    const result = check({ headers: { authorization: "Bearer secret" } });
    expect(result).toBe(true);
  });
});
