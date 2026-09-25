import "server-only";

import {
  registerVerifier,
} from "@/services/verification";

/**
 * Registration for the built-in verifiers. Importing this module (server-side
 * only) populates the verification registry once, via each verifier module's
 * own top-level `registerVerifier(...)` call.
 */
import "@/services/verification/tiktok-verifier";
import "@/services/verification/x-verifier";

/**
 * Idempotent guard for callers that want to force registration (e.g. tests or
 * a future worker entry point). Side-effect imports above already populate
 * the registry at module load; this re-exports the register function so the
 * mechanism stays the single source of truth.
 */
export { registerVerifier };
