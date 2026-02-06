/**
 * Unit tests for PaymentService class.
 * Tests balance checking, token selection, and change/refund handling.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PaymentService, type PaymentServiceOptions } from "../src/proxy/payment-service.js";
import { InsufficientBalanceError } from "../src/proxy/errors.js";

describe("PaymentService", () => {
  const mockWallet = {
    balance: 1000,
    proofCount: 5,
    selectAndEncode: vi.fn(),
    receiveToken: vi.fn(),
  };

  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const mockAppendFailedToken = vi.fn();

  beforeEach(() => {
    mockWallet.balance = 1000;
    mockWallet.selectAndEncode.mockReset();
    mockWallet.receiveToken.mockReset();
    mockLogger.info.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.error.mockReset();
    mockAppendFailedToken.mockReset();
  });

  function createService(options: Partial<PaymentServiceOptions> = {}) {
    return new PaymentService({
      wallet: mockWallet as any,
      logger: mockLogger,
      appendFailedToken: mockAppendFailedToken,
      lowBalanceThreshold: 100,
      ...options,
    });
  }

  describe("checkBalance", () => {
    it("returns true when balance is sufficient", () => {
      const service = createService();
      expect(service.checkBalance(500, "gpt-4o")).toBe(true);
    });

    it("returns true when balance equals required", () => {
      mockWallet.balance = 500;
      const service = createService();
      expect(service.checkBalance(500, "gpt-4o")).toBe(true);
    });

    it("throws InsufficientBalanceError when balance is insufficient", () => {
      mockWallet.balance = 100;
      const service = createService();
      expect(() => service.checkBalance(500, "gpt-4o")).toThrow(InsufficientBalanceError);
    });

    it("includes balance details in error", () => {
      mockWallet.balance = 100;
      const service = createService();
      try {
        service.checkBalance(500, "gpt-4o");
      } catch (e) {
        expect(e).toBeInstanceOf(InsufficientBalanceError);
        const err = e as InsufficientBalanceError;
        expect(err.balance).toBe(100);
        expect(err.required).toBe(500);
        expect(err.model).toBe("gpt-4o");
      }
    });

    it("logs warning when balance is insufficient", () => {
      mockWallet.balance = 100;
      const service = createService();
      try {
        service.checkBalance(500, "gpt-4o");
      } catch {
        // expected
      }
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Insufficient balance")
      );
    });
  });

  describe("selectToken", () => {
    it("selects and encodes token for given price", async () => {
      mockWallet.selectAndEncode.mockResolvedValueOnce("cashuAtoken123");
      const service = createService();
      
      const result = await service.selectToken(200);
      
      expect(mockWallet.selectAndEncode).toHaveBeenCalledWith(200);
      expect(result.token).toBe("cashuAtoken123");
    });

    it("returns balance before and after selection", async () => {
      mockWallet.balance = 1000;
      mockWallet.selectAndEncode.mockImplementation(async () => {
        mockWallet.balance = 800; // Simulate balance decrease
        return "token";
      });
      
      const service = createService();
      const result = await service.selectToken(200);
      
      expect(result.balanceBefore).toBe(1000);
      expect(result.balanceAfter).toBe(800);
    });

    it("throws on wallet error", async () => {
      mockWallet.selectAndEncode.mockRejectedValueOnce(new Error("No proofs available"));
      const service = createService();
      
      await expect(service.selectToken(200)).rejects.toThrow("No proofs available");
    });
  });

  describe("receiveChange", () => {
    it("receives change token and returns amount", async () => {
      mockWallet.receiveToken.mockResolvedValueOnce(50);
      const service = createService();
      
      const amount = await service.receiveChange("cashuAchange456");
      
      expect(mockWallet.receiveToken).toHaveBeenCalledWith("cashuAchange456");
      expect(amount).toBe(50);
    });

    it("logs received change", async () => {
      mockWallet.receiveToken.mockResolvedValueOnce(50);
      const service = createService();
      
      await service.receiveChange("token");
      
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("50 change")
      );
    });

    it("saves failed token and returns 0 on error", async () => {
      mockWallet.receiveToken.mockRejectedValueOnce(new Error("Invalid token"));
      const service = createService();
      
      const amount = await service.receiveChange("bad-token");
      
      expect(amount).toBe(0);
      expect(mockAppendFailedToken).toHaveBeenCalledWith(
        "bad-token",
        "change",
        "Invalid token"
      );
    });

    it("logs warning on failed change", async () => {
      mockWallet.receiveToken.mockRejectedValueOnce(new Error("Invalid token"));
      const service = createService();
      
      await service.receiveChange("bad-token");
      
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to store change")
      );
    });
  });

  describe("receiveRefund", () => {
    it("receives refund token and returns amount", async () => {
      mockWallet.receiveToken.mockResolvedValueOnce(100);
      const service = createService();
      
      const amount = await service.receiveRefund("cashuArefund789");
      
      expect(mockWallet.receiveToken).toHaveBeenCalledWith("cashuArefund789");
      expect(amount).toBe(100);
    });

    it("logs received refund", async () => {
      mockWallet.receiveToken.mockResolvedValueOnce(100);
      const service = createService();
      
      await service.receiveRefund("token");
      
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("100 refund")
      );
    });

    it("saves failed token and returns 0 on error", async () => {
      mockWallet.receiveToken.mockRejectedValueOnce(new Error("Token spent"));
      const service = createService();
      
      const amount = await service.receiveRefund("spent-token");
      
      expect(amount).toBe(0);
      expect(mockAppendFailedToken).toHaveBeenCalledWith(
        "spent-token",
        "refund",
        "Token spent"
      );
    });
  });

  describe("processGateTokens", () => {
    it("processes both change and refund tokens", async () => {
      mockWallet.receiveToken
        .mockResolvedValueOnce(30) // change
        .mockResolvedValueOnce(20); // refund
      
      const service = createService();
      const result = await service.processGateTokens("change-token", "refund-token");
      
      expect(result.changeSat).toBe(30);
      expect(result.refundSat).toBe(20);
    });

    it("handles missing change token", async () => {
      mockWallet.receiveToken.mockResolvedValueOnce(20);
      
      const service = createService();
      const result = await service.processGateTokens(undefined, "refund-token");
      
      expect(result.changeSat).toBe(0);
      expect(result.refundSat).toBe(20);
    });

    it("handles missing refund token", async () => {
      mockWallet.receiveToken.mockResolvedValueOnce(30);
      
      const service = createService();
      const result = await service.processGateTokens("change-token", undefined);
      
      expect(result.changeSat).toBe(30);
      expect(result.refundSat).toBe(0);
    });

    it("handles both tokens missing", async () => {
      const service = createService();
      const result = await service.processGateTokens(undefined, undefined);
      
      expect(result.changeSat).toBe(0);
      expect(result.refundSat).toBe(0);
      expect(mockWallet.receiveToken).not.toHaveBeenCalled();
    });
  });

  describe("checkLowBalance", () => {
    it("logs warning when balance below threshold", () => {
      mockWallet.balance = 50;
      const service = createService({ lowBalanceThreshold: 100 });
      
      service.checkLowBalance();
      
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Low ecash balance")
      );
    });

    it("does not log when balance above threshold", () => {
      mockWallet.balance = 200;
      const service = createService({ lowBalanceThreshold: 100 });
      
      service.checkLowBalance();
      
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it("does not log when balance equals threshold", () => {
      mockWallet.balance = 100;
      const service = createService({ lowBalanceThreshold: 100 });
      
      service.checkLowBalance();
      
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });
  });

  describe("getBalance", () => {
    it("returns current wallet balance", () => {
      mockWallet.balance = 750;
      const service = createService();
      
      expect(service.getBalance()).toBe(750);
    });
  });
});
