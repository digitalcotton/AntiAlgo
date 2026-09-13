/**
 * Local .env.local -> process.env, for local development only.
 *
 * Astro exposes .env files to import.meta.env, not to process.env, and this
 * site reads its secrets (DATABASE_URL, BETTER_AUTH_SECRET) off process.env
 * so the same code runs under Vercel, which injects them before the server
 * starts. Locally nothing injects them, so this bridges the gap. Three guards:
 * it does nothing when the file is absent (git-ignored, never deployed), it
 * never overwrites a value already set, and the parse is deliberately dumb
 * (KEY=VALUE, no interpolation).
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const path = fileURLToPath(new URL('./.env.local', import.meta.url));
if (existsSync(path)) {
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key in process.env) continue;
    process.env[key] = trimmed.slice(eq + 1).trim();
  }
}
