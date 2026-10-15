import {createHash, timingSafeEqual} from "crypto";
import type {Request, Response, NextFunction, RequestHandler} from "express";

// Equal-length digests let timingSafeEqual compare without leaking the key's prefix or length.
function sameSecret(supplied: string, expected: string): boolean {
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(supplied), digest(expected));
}

/** Gate for dashboard-only endpoints; fails closed when INTERNAL_API_KEY is unset. */
export function requireInternalKey(tag: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = process.env.INTERNAL_API_KEY;
    if (!key) {
      console.error(`[${tag}] INTERNAL_API_KEY is not configured — rejecting request`);
      res.status(503).json({error: "Endpoint not available"});
      return;
    }
    if (!sameSecret(req.headers["authorization"] ?? "", `Bearer ${key}`)) {
      res.status(401).json({error: "Unauthorized"});
      return;
    }
    next();
  };
}
