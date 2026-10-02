import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buttonClasses, type ButtonVariant } from "@/components/ui/button";

/**
 * Button interaction feedback.
 *
 * Pins the shared primitive's pressed state so a future restyle cannot
 * silently drop it again. The production bug was that a tap produced no
 * visible change: these assertions require an `active:` treatment on every
 * variant, a transform-based press in the shared base, and a transition that
 * actually animates the transform (otherwise the press would snap with no
 * feedback on the way in).
 */

const VARIANTS: ButtonVariant[] = [
  "primary",
  "accent",
  "outline",
  "ghost",
  "danger",
];

/** All `active:` utility classes in a class string (variant or state). */
function activeClasses(classes: string): string[] {
  return classes.split(/\s+/).filter((token) => token.startsWith("active:"));
}

describe("shared Button: pressed/active feedback", () => {
  it("every variant has its own active: state", () => {
    for (const variant of VARIANTS) {
      const classes = buttonClasses({ variant });

      assert.ok(
        activeClasses(classes).length > 0,
        `variant "${variant}" must define an active: class`,
      );
    }
  });

  it("the base includes a scale-down press and an active: transition duration", () => {
    const classes = buttonClasses();

    assert.ok(
      classes.includes("active:scale-[0.97]"),
      "base must scale the button down while pressed",
    );
    assert.ok(
      classes.includes("active:duration-75"),
      "base must shorten the transition while pressed so the press reads instantly",
    );
  });

  it("animates the transform, not just colours", () => {
    const classes = buttonClasses();

    assert.ok(
      classes.includes("transition-[color,background-color,border-color,transform,opacity]"),
      "transition must include transform so the press is animated",
    );
  });

  it("keeps focus-visible and disabled affordances", () => {
    const classes = buttonClasses();

    assert.ok(classes.includes("focus-visible:ring-2"));
    assert.ok(classes.includes("disabled:pointer-events-none"));
    assert.ok(classes.includes("disabled:opacity-55"));
  });

  it("does not rely on hover alone for the pressed state", () => {
    for (const variant of VARIANTS) {
      const active = activeClasses(buttonClasses({ variant }));

      // An active: class that only restates a hover: class is still valid, but
      // at least one active: token must exist independent of hover.
      assert.ok(active.length > 0);
      assert.ok(
        active.some((token) => !token.includes("hover")),
        `variant "${variant}" needs an active: token that is not hover-derived`,
      );
    }
  });

  it("honours reduced-motion by not scaling when the user opts out", () => {
    assert.ok(buttonClasses().includes("motion-reduce:active:scale-100"));
  });

  it("still merges caller classNames after the variant classes", () => {
    const classes = buttonClasses({
      variant: "outline",
      size: "sm",
      className: "w-full",
    });

    assert.ok(classes.endsWith("w-full"));
    assert.ok(classes.includes("active:bg-surface-muted"));
  });
});
