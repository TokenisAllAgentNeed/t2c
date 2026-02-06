/**
 * Local HTTP proxy that translates standard OpenAI-compatible requests
 * into ecash-paid requests to the token2chat Gate.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { CashuStore } from "./cashu-store.js";
import { type T2CConfig, resolveHome, appendFailedToken, appendTransaction, loadOrCreateProxySecret } from "./config.js";
import { GateRegistry } from "./gate-discovery.js";
import {
  type Logger,
  type ProxyHandle,
  defaultLogger,
  transformModelId,
  parseRetryAfter,
  MAX_BODY_SIZE,
  MAX_RETRY_DELAY_MS,
  DEFAULT_RETRY_CONFIG,
  PricingCache,
  GateClient,
  PaymentService,
  createAuthChecker,
  handleError,
  sendJsonResponse,
} from "./proxy/index.js";
import { extractCashuChangeFromSSE } from "./proxy/sse-parser.js";

// Re-export for backwards compatibility
export { transformModelId, parseRetryAfter, type Logger, type ProxyHandle };

export async function startProxy(
  config: T2CConfig,
  logger: Logger = defaultLogger,
): Promise<ProxyHandle> {
  const { gateUrl, mintUrl, proxyPort: port, lowBalanceThreshold } = config;
  const walletPath = resolveHome(config.walletPath);

  // Gate discovery + failover
  const gateRegistry = config.autoDiscover
    ? new GateRegistry(gateUrl, config.discoveryUrl)
    : null;
  if (gateRegistry) {
    await gateRegistry.discover().catch(() => {});
  }

  // Load proxy authentication secret
  const proxySecret = await loadOrCreateProxySecret();
  const checkAuth = createAuthChecker(proxySecret);

  // Load wallet synchronously before starting server (fixes race condition)
  let wallet: CashuStore;
  try {
    wallet = await CashuStore.load(walletPath, mintUrl);
    logger.info(`Wallet loaded: balance=${wallet.balance} (${wallet.proofCount} proofs)`);
  } catch (e) {
    logger.error("Failed to load wallet:", e);
    throw new Error(`Cannot start proxy: wallet load failed - ${e instanceof Error ? e.message : e}`);
  }

  // Pricing cache
  const pricingCache = new PricingCache(gateUrl);

  // Gate client
  const gateClient = new GateClient(gateUrl, { logger });

  // Payment service
  const paymentService = new PaymentService({
    wallet,
    logger,
    appendFailedToken,
    lowBalanceThreshold,
  });

  async function readBody(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        throw new Error("Request body too large");
      }
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Health check (unauthenticated — no sensitive data)
    if (req.method === "GET" && req.url === "/health") {
      sendJsonResponse(res, 200, { ok: true });
      return;
    }

    // All endpoints below require authentication
    if (!checkAuth(req)) {
      sendJsonResponse(res, 401, { error: { message: "Unauthorized. Provide a valid Bearer token." } });
      return;
    }

    // Pricing passthrough
    if (req.method === "GET" && req.url === "/v1/pricing") {
      try {
        const upstream = await fetch(`${gateUrl}/v1/pricing`);
        res.writeHead(upstream.status, { "Content-Type": "application/json" });
        res.end(await upstream.text());
      } catch {
        sendJsonResponse(res, 502, { error: "Gate unreachable" });
      }
      return;
    }

    // Models endpoint
    if (req.method === "GET" && req.url === "/v1/models") {
      await pricingCache.get(); // Ensure cache is populated
      const models = pricingCache.getModels().map((id) => ({
        id,
        object: "model",
        created: Date.now(),
        owned_by: "token2chat",
      }));
      sendJsonResponse(res, 200, { object: "list", data: models });
      return;
    }

    // Only proxy POST /v1/chat/completions
    if (req.method !== "POST" || !req.url?.startsWith("/v1/chat/completions")) {
      sendJsonResponse(res, 404, { error: { message: "Not found" } });
      return;
    }

    try {
      const body = await readBody(req);
      const parsed = JSON.parse(body.toString());
      const requestedModel = parsed.model as string;
      const isStream = parsed.stream === true;

      // Transaction tracking
      const txStart = Date.now();
      const txId = `tx-${txStart}-${Math.random().toString(36).slice(2, 8)}`;
      let txChangeSat = 0;
      let txRefundSat = 0;
      const balanceBefore = paymentService.getBalance();

      await pricingCache.get(); // Ensure cache is populated
      const price = pricingCache.getPrice(requestedModel);

      // Check balance using PaymentService (throws InsufficientBalanceError)
      try {
        paymentService.checkBalance(price, requestedModel);
      } catch (e) {
        handleError(res, e, logger);
        return;
      }

      // Prepare modified body once (model transform doesn't change between retries)
      parsed.model = transformModelId(requestedModel);
      const modifiedBody = JSON.stringify(parsed);

      // Resolve gate URL(s) — with failover if auto-discover enabled
      const gateUrls = gateRegistry
        ? await gateRegistry.selectGate(requestedModel)
        : [gateUrl];

      // Make request with retry logic (new token per attempt for ecash)
      const { maxRetries, baseDelayMs } = DEFAULT_RETRY_CONFIG;
      let lastGateResponse: { status: number; body?: string } | null = null;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        // Pick gate for this attempt (rotate through available gates)
        const currentGateUrl = gateUrls[attempt % gateUrls.length];
        const currentPrice = pricingCache.getPrice(requestedModel);

        // Select token using PaymentService
        const { token, balanceAfter } = await paymentService.selectToken(currentPrice);

        if (attempt === 0) {
          logger.info(`Paying ${currentPrice} for ${requestedModel} → ${currentGateUrl} (balance: ${balanceAfter + currentPrice} → ~${balanceAfter})`);
        } else {
          logger.info(`Retry ${attempt}/${maxRetries} for ${requestedModel} → ${currentGateUrl}`);
        }

        // Use GateClient for the actual request
        const gateRes = await gateClient.request({
          path: "/v1/chat/completions",
          body: modifiedBody,
          token,
          gateUrl: currentGateUrl,
          stream: isStream,
        });

        // Handle change/refund tokens using PaymentService
        const tokens = await paymentService.processGateTokens(
          gateRes.changeToken,
          gateRes.refundToken,
        );
        txChangeSat += tokens.changeSat;
        txRefundSat += tokens.refundSat;

        // If not 429, we're done (and mark gate healthy for failover)
        if (gateRes.status !== 429) {
          if (gateRegistry) {
            if (gateRes.status >= 500) gateRegistry.markFailed(currentGateUrl);
            else gateRegistry.markSuccess(currentGateUrl);
          }

          const resHeaders: Record<string, string> = {};
          if (gateRes.contentType) resHeaders["Content-Type"] = gateRes.contentType;

          res.writeHead(gateRes.status, resHeaders);

          if (isStream && gateRes.stream) {
            // Filter out cashu-change SSE events from stream
            const { filtered, changeToken: sseChangeToken } = extractCashuChangeFromSSE(gateRes.stream);
            const reader = filtered.getReader();
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                res.write(value);
              }
            } finally {
              reader.releaseLock();
            }
            res.end();

            // Process SSE change token (if any)
            const sseChange = sseChangeToken();
            if (sseChange) {
              const sseChangeResult = await paymentService.receiveChange(sseChange);
              txChangeSat += sseChangeResult;
            }
          } else {
            res.end(gateRes.body ?? "");
          }

          // Log balance warning
          paymentService.checkLowBalance();

          // Record transaction
          appendTransaction({
            id: txId, timestamp: txStart, model: requestedModel,
            priceSat: currentPrice, changeSat: txChangeSat, refundSat: txRefundSat,
            gateStatus: gateRes.status, balanceBefore, balanceAfter: paymentService.getBalance(),
            durationMs: Date.now() - txStart,
          }).catch(() => {});
          return;
        }

        // Store last 429 response — mark gate for failover
        if (gateRegistry) gateRegistry.markFailed(currentGateUrl);
        lastGateResponse = { status: gateRes.status, body: gateRes.body };

        // On 429, calculate backoff delay (GateClient doesn't retry, we do it here for new tokens)
        if (attempt < maxRetries) {
          const backoffMs = Math.min(baseDelayMs * Math.pow(2, attempt), MAX_RETRY_DELAY_MS);
          logger.warn(`Rate limited (429), retrying in ${backoffMs}ms...`);
          await new Promise((r) => setTimeout(r, backoffMs));
        }
      }

      // All retries exhausted — record failed transaction
      appendTransaction({
        id: txId, timestamp: txStart, model: requestedModel,
        priceSat: price, changeSat: txChangeSat, refundSat: txRefundSat,
        gateStatus: lastGateResponse!.status, balanceBefore, balanceAfter: paymentService.getBalance(),
        durationMs: Date.now() - txStart, error: "Rate limited after retries",
      }).catch(() => {});
      res.writeHead(lastGateResponse!.status, { "Content-Type": "application/json" });
      res.end(lastGateResponse!.body ?? "");
    } catch (e) {
      handleError(res, e, logger);
    }
  });

  server.listen(port, "127.0.0.1", () => {
    logger.info(`🎟️ t2c proxy on http://127.0.0.1:${port}`);
    logger.info(`   Gate: ${gateUrl} | Mint: ${mintUrl}`);
  });

  return {
    stop: () => {
      server.close();
      logger.info("t2c proxy stopped");
    },
    proxySecret,
  };
}
