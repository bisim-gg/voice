/**
 * An abort signal that fires after `delay` milliseconds, and its controller (abort it to cancel the timer).
 *
 * @param delay - Milliseconds
 * @internal
 */
export function abortAfter(delay: number): [AbortController, AbortSignal] {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), delay);
  controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  return [controller, controller.signal];
}
