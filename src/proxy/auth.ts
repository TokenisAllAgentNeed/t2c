/**
 * Authentication middleware for proxy requests.
 * Uses timing-safe comparison to prevent timing attacks.
 */
import crypto from "node:crypto";

/**
 * Request-like object with authorization header.
 */
export interface AuthRequest {
  headers: {
    authorization?: string;
  };
}

/**
 * Function that checks if a request is authenticated.
 */
export type AuthChecker = (req: AuthRequest) => boolean;

/**
 * Create an auth checker function for Bearer token authentication.
 * Uses timing-safe comparison to prevent timing attacks.
 *
 * @param secret - The expected Bearer token value
 * @returns A function that returns true if the request has a valid Bearer token
 */
export function createAuthChecker(secret: string): AuthChecker {
  return (req: AuthRequest): boolean => {
    const auth = req.headers.authorization;
    if (!auth) return false;

    const parts = auth.split(" ");
    if (parts.length !== 2 || parts[0] !== "Bearer") return false;

    const provided = Buffer.from(parts[1]);
    const expected = Buffer.from(secret);

    // Length check before timing-safe comparison
    if (provided.length !== expected.length) return false;

    return crypto.timingSafeEqual(provided, expected);
  };
}
