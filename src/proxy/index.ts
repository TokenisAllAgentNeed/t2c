/**
 * Proxy module exports.
 */

// Types and utilities
export * from "./types.js";

// Error classes
export * from "./errors.js";

// Pricing cache
export { PricingCache, type PricingCacheOptions } from "./pricing.js";

// Gate client
export { GateClient, type GateClientOptions, type GateRequestOptions, type GateResponse } from "./gate-client.js";

// Payment service
export { PaymentService, type PaymentServiceOptions, type Wallet, type TokenSelectionResult, type GateTokensResult } from "./payment-service.js";

// Auth
export { createAuthChecker, type AuthChecker, type AuthRequest } from "./auth.js";

// Response utilities
export { handleError, sendError, sendJsonResponse, type ResponseWriter } from "./response.js";
