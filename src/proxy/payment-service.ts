/**
 * PaymentService - Handles ecash payment operations for proxy requests.
 */
import { type Logger, defaultLogger } from "./types.js";
import { InsufficientBalanceError } from "./errors.js";

/**
 * Minimal wallet interface for PaymentService.
 */
export interface Wallet {
  balance: number;
  selectAndEncode(amount: number): Promise<string>;
  receiveToken(token: string): Promise<number>;
}

export interface PaymentServiceOptions {
  wallet: Wallet;
  logger?: Logger;
  appendFailedToken?: (token: string, type: "change" | "refund", error: string) => Promise<void>;
  lowBalanceThreshold?: number;
}

export interface TokenSelectionResult {
  token: string;
  balanceBefore: number;
  balanceAfter: number;
}

export interface GateTokensResult {
  changeSat: number;
  refundSat: number;
}

export class PaymentService {
  private readonly wallet: Wallet;
  private readonly logger: Logger;
  private readonly appendFailedToken: (token: string, type: "change" | "refund", error: string) => Promise<void>;
  private readonly lowBalanceThreshold: number;

  constructor(options: PaymentServiceOptions) {
    this.wallet = options.wallet;
    this.logger = options.logger ?? defaultLogger;
    this.appendFailedToken = options.appendFailedToken ?? (async () => {});
    this.lowBalanceThreshold = options.lowBalanceThreshold ?? 100;
  }

  /**
   * Check if wallet has sufficient balance for the request.
   * @throws InsufficientBalanceError if balance is insufficient
   */
  checkBalance(required: number, model: string): boolean {
    const balance = this.wallet.balance;
    if (balance < required) {
      this.logger.warn(`Insufficient balance: ${balance} < ${required} for ${model}`);
      throw new InsufficientBalanceError(balance, required, model);
    }
    return true;
  }

  /**
   * Select and encode tokens for payment.
   */
  async selectToken(amount: number): Promise<TokenSelectionResult> {
    const balanceBefore = this.wallet.balance;
    const token = await this.wallet.selectAndEncode(amount);
    const balanceAfter = this.wallet.balance;

    return { token, balanceBefore, balanceAfter };
  }

  /**
   * Receive change token from Gate.
   * Returns amount received, or 0 if failed.
   */
  async receiveChange(token: string): Promise<number> {
    try {
      const amount = await this.wallet.receiveToken(token);
      this.logger.info(`Received ${amount} change`);
      return amount;
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`Failed to store change: ${errMsg}`);
      await this.appendFailedToken(token, "change", errMsg);
      return 0;
    }
  }

  /**
   * Receive refund token from Gate.
   * Returns amount received, or 0 if failed.
   */
  async receiveRefund(token: string): Promise<number> {
    try {
      const amount = await this.wallet.receiveToken(token);
      this.logger.info(`Received ${amount} refund`);
      return amount;
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`Failed to store refund: ${errMsg}`);
      await this.appendFailedToken(token, "refund", errMsg);
      return 0;
    }
  }

  /**
   * Process change and refund tokens from Gate response.
   */
  async processGateTokens(
    changeToken?: string,
    refundToken?: string,
  ): Promise<GateTokensResult> {
    let changeSat = 0;
    let refundSat = 0;

    if (changeToken) {
      changeSat = await this.receiveChange(changeToken);
    }
    if (refundToken) {
      refundSat = await this.receiveRefund(refundToken);
    }

    return { changeSat, refundSat };
  }

  /**
   * Check and warn if balance is below threshold.
   */
  checkLowBalance(): void {
    const balance = this.wallet.balance;
    if (balance < this.lowBalanceThreshold) {
      this.logger.warn(`⚠️ Low ecash balance: ${balance} (threshold: ${this.lowBalanceThreshold})`);
    }
  }

  /**
   * Get current wallet balance.
   */
  getBalance(): number {
    return this.wallet.balance;
  }
}
