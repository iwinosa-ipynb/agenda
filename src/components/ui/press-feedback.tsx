"use client";

import { useEffect } from "react";

/**
 * Reliable press feedback for touch devices (notably iOS Safari).
 *
 * Two things are needed to show a "finger is down" state on iPhone:
 *
 * 1. iOS Safari does not apply the CSS `:active` pseudo-class on tap unless the
 *    page actually handles touch. Registering a passive `touchstart` listener
 *    on `document` (we do it here) is the documented switch that turns `:active`
 *    back on.
 * 2. Even with `:active` enabled it is still not applied to every element (for
 *    example a `<label>` wrapping a hidden radio). So we also mark the pressed
 *    element with `data-pressed`, which the `pressed:` variant in globals.css
 *    matches. On `pointerdown`/`touchstart` we walk up to the nearest interactive
 *    ancestor (`button`, `a`, `label`, `[role="button"]`) and set the attribute;
 *    it is cleared on release/cancel and on scroll.
 *
 * The listeners are passive and never call `preventDefault`, so no default
 * browser behaviour, navigation or business logic is altered. Rendering nothing
 * keeps this out of the server components' way.
 */
export function PressFeedback() {
  useEffect(() => {
    const PRESSED_SELECTOR =
      'button, a, label, [role="button"], [data-pressable]';
    const ATTRIBUTE = "data-pressed";

    const resolvePressable = (target: EventTarget | null): HTMLElement | null => {
      if (!(target instanceof Element)) {
        return null;
      }

      const element = target.closest(PRESSED_SELECTOR);
      return element instanceof HTMLElement ? element : null;
    };

    const clearPressed = () => {
      document
        .querySelectorAll<HTMLElement>(`[${ATTRIBUTE}]`)
        .forEach((element) => element.removeAttribute(ATTRIBUTE));
    };

    const press = (event: Event) => {
      const element = resolvePressable(event.target);

      // A new gesture replaces any previous press (e.g. a second finger).
      clearPressed();

      if (!element || element.hasAttribute("disabled")) {
        return;
      }

      element.setAttribute(ATTRIBUTE, "");
    };

    document.addEventListener("touchstart", press, { passive: true });
    document.addEventListener("pointerdown", press, { passive: true });
    document.addEventListener("touchend", clearPressed, { passive: true });
    document.addEventListener("touchcancel", clearPressed, { passive: true });
    document.addEventListener("pointerup", clearPressed, { passive: true });
    document.addEventListener("pointercancel", clearPressed, { passive: true });
    window.addEventListener("scroll", clearPressed, { passive: true });

    return () => {
      document.removeEventListener("touchstart", press);
      document.removeEventListener("pointerdown", press);
      document.removeEventListener("touchend", clearPressed);
      document.removeEventListener("touchcancel", clearPressed);
      document.removeEventListener("pointerup", clearPressed);
      document.removeEventListener("pointercancel", clearPressed);
      window.removeEventListener("scroll", clearPressed);
      clearPressed();
    };
  }, []);

  return null;
}
