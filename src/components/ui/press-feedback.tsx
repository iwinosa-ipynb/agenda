"use client";

import { useEffect } from "react";

/**
 * Shared "finger is down" feedback for every interactive element in Agenda.
 *
 * Why this exists: a bare CSS `:active` rule is not dependable on iOS Safari.
 * iOS only honours `:active` for an element once the page demonstrably handles
 * touch, and there are documented cases (labels wrapping hidden inputs, list
 * items, custom role="button" wrappers) where it never matches at all. So we do
 * not depend on `:active` for the visual; we drive it ourselves:
 *
 * 1. Registering a `touchstart` listener is the documented switch that turns
 *    iOS's `:active` back on, so keep it.
 * 2. On press we set `data-pressed` on the nearest interactive ancestor. The
 *    `pressed:` variant in globals.css matches `:active` OR `[data-pressed]`,
 *    so the press shows even where `:active` would not have applied.
 *
 * All listeners are passive and none of them call `preventDefault`, so taps,
 * scrolling, text selection, form submission and navigation are untouched. This
 * component renders nothing and contains no business logic.
 */

/** Elements that should visibly react when a finger lands on them. */
const PRESSABLE_SELECTOR =
  'button, a[href], label, [role="button"], summary, [data-pressable]';

/** Elements that must keep their disabled/unavailable appearance. */
function isInert(element: HTMLElement): boolean {
  return (
    element.hasAttribute("disabled") ||
    element.getAttribute("aria-disabled") === "true"
  );
}

/**
 * If a `touchend` is ever missed (system gesture, interrupted scroll, the tab
 * losing focus), the button would stay dark forever. This bounds the press.
 */
const PRESS_TIMEOUT_MS = 1500;

export function PressFeedback() {
  useEffect(() => {
    let pressed: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const release = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }

      if (pressed) {
        pressed.removeAttribute("data-pressed");
        pressed = null;
      }
    };

    const press = (event: Event) => {
      const target = event.target;

      if (!(target instanceof Element)) {
        release();
        return;
      }

      const element = target.closest<HTMLElement>(PRESSABLE_SELECTOR);

      // A new gesture supersedes any previous press (e.g. a second finger, or
      // sliding off one button onto another).
      release();

      if (!element || isInert(element)) {
        return;
      }

      element.setAttribute("data-pressed", "");
      pressed = element;

      timer = setTimeout(release, PRESS_TIMEOUT_MS);
    };

    // Capture phase on `window` so the iOS `:active` enabler and the attribute
    // are in place before any element-level handler can stop propagation.
    const pressOptions: AddEventListenerOptions = {
      capture: true,
      passive: true,
    };

    window.addEventListener("touchstart", press, pressOptions);
    window.addEventListener("pointerdown", press, pressOptions);

    // Release: bubble phase is enough and keeps the handler off the hot path.
    const releaseOptions: AddEventListenerOptions = { passive: true };

    window.addEventListener("touchend", release, releaseOptions);
    window.addEventListener("touchcancel", release, releaseOptions);
    window.addEventListener("pointerup", release, releaseOptions);
    window.addEventListener("pointercancel", release, releaseOptions);
    // The finger sliding off the button, or the page being scrolled, ends the
    // press rather than leaving the button stuck in its pressed colour.
    window.addEventListener("touchmove", release, releaseOptions);
    window.addEventListener("scroll", release, releaseOptions);
    window.addEventListener("blur", release, releaseOptions);
    document.addEventListener("visibilitychange", release, releaseOptions);

    return () => {
      window.removeEventListener("touchstart", press, pressOptions);
      window.removeEventListener("pointerdown", press, pressOptions);
      window.removeEventListener("touchend", release, releaseOptions);
      window.removeEventListener("touchcancel", release, releaseOptions);
      window.removeEventListener("pointerup", release, releaseOptions);
      window.removeEventListener("pointercancel", release, releaseOptions);
      window.removeEventListener("touchmove", release, releaseOptions);
      window.removeEventListener("scroll", release, releaseOptions);
      window.removeEventListener("blur", release, releaseOptions);
      document.removeEventListener("visibilitychange", release, releaseOptions);
      release();
    };
  }, []);

  return null;
}
