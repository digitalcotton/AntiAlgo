/**
 * return-to.ts: where an action endpoint sends the browser afterwards.
 *
 * The action endpoints each 303 back to the page they were built for (the
 * Desk, Settings, the Profile). Come ready (/start) posts to the same
 * endpoints and needs to keep its place, so a form may carry a `return`
 * field. It is honoured only when it is one of the addresses written below:
 * an open redirect that follows any submitted path is how a forged form
 * sends a signed-in reader somewhere else, so an unknown value falls back to
 * the endpoint's own page exactly as if the field were absent.
 *
 * Base-free, like ROUTE_POLICY: the caller wraps the result in withBase().
 */

/** The only return addresses followed: /start, or /start on one step, with
    the optional saved marker the key step uses to play its connected moment
    once. */
const ALLOWED_RETURN = /^\/start(\?step=(3|4|5|6|door)(&saved=1)?)?$/;

export function isAllowedReturn(value: unknown): value is string {
  return typeof value === 'string' && ALLOWED_RETURN.test(value);
}

/** The submitted `return` when it is allowed, else the fallback verbatim. */
export function returnTo(form: FormData, fallback: string): string {
  const value = form.get('return');
  return isAllowedReturn(value) ? value : fallback;
}
