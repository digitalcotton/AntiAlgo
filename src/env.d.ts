/// <reference types="astro/client" />

import type { Verdict, Viewer } from './lib/entitlement';

declare global {
  namespace App {
    interface Locals {
      /** Null for a signed-out reader, and for any route middleware did not resolve a session on. */
      viewer: Viewer | null;
      /** The entitlement decision for a gated route, so the page can branch on the reason. */
      verdict?: Verdict;
    }
  }
}
