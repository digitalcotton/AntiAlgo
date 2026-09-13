/**
 * machine-wake.ts: ring the Mac mini.
 *
 * The mini keeps one outbound connection open to ntfy.sh, subscribed to a
 * topic whose name is a long random secret (MACHINE_NTFY_TOPIC here, the same
 * string in ~/.jobmachine-fetch there). Publishing one message to that topic
 * wakes it in under a second. The message is the request id and nothing
 * else: no URL, no person. A spoofed message costs the mini one harmless
 * claim call that answers 204.
 *
 * Best effort by design. A failed publish is logged and the request stays
 * pending; the mini also drains pending requests every time it connects and
 * on a schedule, so a lost wake delays a read, it never loses one.
 */
export const WAKE_TIMEOUT_MS = 5_000;

export function machineNtfyTopic(): string | null {
  const value = process.env.MACHINE_NTFY_TOPIC;
  return value && value.trim().length > 0 ? value.trim() : null;
}

export async function publishWake(requestId: string): Promise<boolean> {
  const topic = machineNtfyTopic();
  if (!topic) {
    console.warn('machine-wake: MACHINE_NTFY_TOPIC is unset; the request waits for the machine to drain.');
    return false;
  }
  try {
    const response = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: 'POST',
      body: requestId,
      headers: { 'Content-Type': 'text/plain', Title: 'posting-fetch', Priority: 'default' },
      signal: AbortSignal.timeout(WAKE_TIMEOUT_MS)
    });
    if (!response.ok) {
      console.warn(`machine-wake: ntfy answered ${response.status}; the request waits for a drain.`);
      return false;
    }
    return true;
  } catch (error) {
    console.warn('machine-wake: could not reach ntfy; the request waits for a drain.', error);
    return false;
  }
}
