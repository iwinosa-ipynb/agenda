import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { buttonClasses, type ButtonVariant } from "@/components/ui/button";

/**
 * Shared button pressed-state feedback.
 *
 * The production bug: a tap on iPhone produced no visible change. The fix is
 * two-part and both parts are pinned here:
 *
 * 1. `pressed:` (a `@custom-variant` in globals.css) matches `:active` OR the
 *    `data-pressed` attribute that <PressFeedback> sets on touch, because iOS
 *    Safari does not apply `:active` on tap unless the page handles touch.
 * 2. Every variant has a pressed colour that is darker than its base and hover
 *    colours, so the press reads on touch even if a hover colour is showing.
 *
 * These assertions run against the generated class strings (the repo has no
 * DOM renderer for UI components), so they guard the contract, not pixels.
 */

const VARIANTS: ButtonVariant[] = [
  "primary",
  "accent",
  "outline",
  "ghost",
  "danger",
];

/** Split a class string into tokens. */
function tokens(classes: string): string[] {
  return classes.split(/\s+/).filter(Boolean);
}

/** All `pressed:` utility classes in a class string. */
function pressedClasses(classes: string): string[] {
  return tokens(classes).filter((token) => token.startsWith("pressed:"));
}

describe("shared Button: pressed/active feedback", () => {
  it("every variant has its own pressed: state", () => {
    for (const variant of VARIANTS) {
      assert.ok(
        pressedClasses(buttonClasses({ variant })).length > 0,
        `variant "${variant}" must define a pressed: class`,
      );
    }
  });

  it("does not rely on the iOS-unreliable bare active: utility", () => {
    for (const variant of VARIANTS) {
      const classes = buttonClasses({ variant });

      assert.equal(
        tokens(classes).filter((token) => token.startsWith("active:")).length,
        0,
        `variant "${variant}" must use pressed: (data-pressed aware), not active:`,
      );
    }
  });

  it("the base includes a scale-down press and a short pressed duration", () => {
    const classes = buttonClasses();

    assert.ok(
      classes.includes("pressed:scale-[0.96]"),
      "base must scale the button down while pressed",
    );
    assert.ok(
      classes.includes("pressed:duration-75"),
      "base must shorten the transition while pressed so the press reads instantly",
    );
  });

  it("animates `scale`, not just `transform`", () => {
    // Tailwind's scale-* utilities animate the `scale` property, so a
    // transition that only lists `transform` would snap the press instantly.
    assert.ok(
      buttonClasses().includes(
        "transition-[color,background-color,border-color,scale,opacity]",
      ),
      "transition must include scale so the press is animated",
    );
  });

  it("keeps focus-visible and disabled affordances", () => {
    const classes = buttonClasses();

    assert.ok(classes.includes("focus-visible:ring-2"));
    assert.ok(classes.includes("disabled:pointer-events-none"));
    assert.ok(classes.includes("disabled:opacity-55"));
  });

  it("keeps disabled/loading buttons on their existing appearance", () => {
    // The pressed: variant is guarded with :not(:disabled) in globals.css; the
    // disabled utilities must still be present so a pending submit button keeps
    // its disabled look instead of flashing a pressed colour.
    const classes = buttonClasses();

    assert.ok(classes.includes("disabled:pointer-events-none"));
    assert.ok(classes.includes("disabled:opacity-55"));
    assert.equal(
      classes.includes("pressed:opacity"),
      false,
      "pressed state must not override the disabled opacity",
    );
  });

  it("honours reduced-motion by not scaling when the user opts out", () => {
    assert.ok(buttonClasses().includes("motion-reduce:pressed:scale-100"));
  });

  it("still merges caller classNames after the variant classes", () => {
    const classes = buttonClasses({
      variant: "outline",
      size: "sm",
      className: "w-full",
    });

    assert.ok(classes.endsWith("w-full"));
    assert.ok(classes.includes("pressed:bg-line"));
  });
});

describe("pressed: variant wiring", () => {
  const globalsCss = readFileSync(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  const pressFeedback = readFileSync(
    new URL("../components/ui/press-feedback.tsx", import.meta.url),
    "utf8",
  );

  it("defines a pressed: variant that is data-pressed aware", () => {
    assert.ok(
      globalsCss.includes("@custom-variant pressed"),
      "globals.css must define the shared pressed: variant",
    );
    assert.ok(
      globalsCss.includes("[data-pressed]"),
      "pressed: must match the data-pressed attribute set by PressFeedback",
    );
    assert.ok(
      globalsCss.includes(":active"),
      "pressed: must also match the native :active state",
    );
  });

  it("excludes disabled controls from the pressed state", () => {
    assert.ok(
      globalsCss.includes(":not(:disabled)"),
      "pressed: must not style disabled/loading controls",
    );
  });

  it("PressFeedback registers the iOS touch enabler and toggles data-pressed", () => {
    assert.ok(
      pressFeedback.includes('"touchstart"'),
      "PressFeedback must register a touchstart listener to enable iOS :active",
    );
    assert.ok(
      pressFeedback.includes("data-pressed"),
      "PressFeedback must set/clear the data-pressed attribute",
    );
    assert.ok(
      pressFeedback.includes("passive: true"),
      "listeners must be passive so they never block scrolling or taps",
    );
  });
});
