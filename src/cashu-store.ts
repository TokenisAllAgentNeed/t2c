/**
 * CashuStore — Cashu ecash proof management.
 *
 * Single source of truth for proof storage, selection, encoding,
 * and mint interactions.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  CashuMint,
  CashuWallet,
  MintQuoteState,
  getEncodedTokenV4,
  type Proof,
} from "@cashu/cashu-ts";

export interface CashuStoreData {
  mint: string;
  unit: string;
  proofs: Proof[];
}

/**
 * Simple async mutex to prevent concurrent wallet operations.
 * Protects against double-spend and data loss from overlapping read-modify-write cycles.
 */
class Mutex {
  private _queue: (() => void)[] = [];
  private _locked = false;

  async lock<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this._acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private _acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const tryAcquire = () => {
        if (!this._locked) {
          this._locked = true;
          resolve(() => {
            this._locked = false;
            const next = this._queue.shift();
            if (next) next();
          });
        } else {
          this._queue.push(tryAcquire);
        }
      };
      tryAcquire();
    });
  }
}

export class CashuStore {
  private path: string;
  private data: CashuStoreData;
  private wallet: CashuWallet | null = null;
  private mutex = new Mutex();

  constructor(path: string, data: CashuStoreData) {
    this.path = path;
    this.data = data;
  }

  // ── Getters ────────────────────────────────────────────────

  get mint(): string {
    return this.data.mint;
  }

  get balance(): number {
    return this.data.proofs.reduce((s, p) => s + p.amount, 0);
  }

  get proofCount(): number {
    return this.data.proofs.length;
  }

  // ── Load / Save ────────────────────────────────────────────

  /** Load from file, or create new empty store */
  static async load(path: string, mint?: string): Promise<CashuStore> {
    try {
      const raw = await readFile(path, "utf-8");
      const data = JSON.parse(raw) as CashuStoreData;

      // Migrate legacy wallets that stored unit as "sat"
      // Our mint only supports USD keysets
      if (data.unit === "sat") {
        data.unit = "usd";
        const store = new CashuStore(path, data);
        await store.save();
        return store;
      }

      return new CashuStore(path, data);
    } catch {
      const data: CashuStoreData = {
        mint: mint ?? "https://mint.token2chat.com",
        unit: "usd",
        proofs: [],
      };
      const store = new CashuStore(path, data);
      await store.save();
      return store;
    }
  }

  /** Persist to file */
  async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(this.path, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }

  // ── Data export ────────────────────────────────────────────

  /** Return a deep copy of the store data */
  exportData(): CashuStoreData {
    return {
      mint: this.data.mint,
      unit: this.data.unit,
      proofs: this.data.proofs.map((p) => ({ ...p })),
    };
  }

  // ── Funding check ──────────────────────────────────────────

  /** Returns true if balance is below threshold */
  needsFunding(threshold: number): boolean {
    return this.balance < threshold;
  }

  // ── Proof selection ────────────────────────────────────────

  /**
   * Select proofs totalling at least `amount` units,
   * encode as a Cashu V4 token, and remove them from the store.
   */
  async selectAndEncode(amount: number): Promise<string> {
    return this.mutex.lock(async () => {
      if (this.balance < amount) {
        throw new Error(
          `Insufficient balance: need ${amount}, have ${this.balance}`,
        );
      }

      const sorted = [...this.data.proofs].sort((a, b) => b.amount - a.amount);
      const selected: Proof[] = [];
      let total = 0;

      for (const p of sorted) {
        if (total >= amount) break;
        selected.push(p);
        total += p.amount;
      }

      if (total < amount) {
        throw new Error(`Could not select enough proofs for ${amount}`);
      }

      // Remove selected proofs
      const selectedSecrets = new Set(
        selected.map((p) =>
          typeof p.secret === "string" ? p.secret : JSON.stringify(p.secret),
        ),
      );
      this.data.proofs = this.data.proofs.filter(
        (p) =>
          !selectedSecrets.has(
            typeof p.secret === "string" ? p.secret : JSON.stringify(p.secret),
          ),
      );
      await this.save();

      return getEncodedTokenV4({
        mint: this.data.mint,
        proofs: selected,
        unit: this.data.unit,
      });
    });
  }

  // ── Proof import (no mint interaction) ─────────────────────

  /**
   * Import proofs directly into the store.
   * No mint swap — caller is responsible for proof validity.
   */
  async importProofs(proofs: Proof[]): Promise<number> {
    if (proofs.length === 0) return 0;
    return this.mutex.lock(async () => {
      const amount = proofs.reduce((s, p) => s + p.amount, 0);
      this.data.proofs.push(...proofs);
      await this.save();
      return amount;
    });
  }

  // ── Mint-dependent operations ──────────────────────────────

  /** Get or init CashuWallet (lazy, connects to mint) */
  private async getCashuWallet(): Promise<CashuWallet> {
    if (!this.wallet) {
      const m = new CashuMint(this.data.mint);
      this.wallet = new CashuWallet(m, { unit: this.data.unit });
      await this.wallet.loadMint();
    }
    return this.wallet;
  }

  /**
   * Receive an encoded Cashu token — swap at mint for fresh proofs.
   * Used for change/refund tokens from the Gate.
   */
  async receiveToken(encodedToken: string): Promise<number> {
    return this.mutex.lock(async () => {
      const w = await this.getCashuWallet();
      const proofs = await w.receive(encodedToken);
      if (!proofs || proofs.length === 0) return 0;
      const amount = proofs.reduce((s, p) => s + p.amount, 0);
      this.data.proofs.push(...proofs);
      await this.save();
      return amount;
    });
  }

  /**
   * Create a mint quote (Lightning invoice) for funding.
   */
  async createMintQuote(amount: number): Promise<{ quote: string; request: string }> {
    const wallet = await this.getCashuWallet();
    const quote = await wallet.createMintQuote(amount);
    return { quote: quote.quote, request: quote.request };
  }

  /**
   * Check and mint tokens from a paid quote.
   */
  async mintFromQuote(quoteId: string, amount: number): Promise<number> {
    return this.mutex.lock(async () => {
      const wallet = await this.getCashuWallet();
      const check = await wallet.checkMintQuote(quoteId);

      if (check.state !== MintQuoteState.PAID && check.state !== MintQuoteState.ISSUED) {
        throw new Error(`Quote not paid yet (state: ${check.state})`);
      }

      const proofs = await wallet.mintProofs(amount, quoteId);
      this.data.proofs.push(...proofs);
      await this.save();

      return proofs.reduce((s, p) => s + p.amount, 0);
    });
  }
}
