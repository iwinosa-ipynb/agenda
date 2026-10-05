import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { buttonClasses, type ButtonVariant } from "@/components/ui/button";

/**
 * Shared button pressed-state feedback.
 *
 * The production bug this pins: a tap produced no visible change on a phone.
 * The fix has two halves, and both are asserted here:
 *
 * 1. `pressed:` is a `@custom-variant` in globals.css that matches the native
 *    `:active` state OR the `data-pressed` attribute written by
 *    <PressFeedback>. Bare `active:` is not dependable on iOS Safari, so the
 *    primitive must never go back to using it.
 * 2. Every variant's pressed colour must be a large, measurable step in
 *    luminance away from its resting colour. This is the part that actually
 *    makes the press readable — the earlier `active:` attempt used a 3% scale
 *    plus a near-zero colour delta, which is why the tap "worked" but looked
 *    like nothing happened. Light surfaces step darker; the near-black primary
 *    button cannot get darker, so it steps lighter instead.
 *
 * The repo has no DOM renderer for UI components, so these assert the generated
 * class strings, the design tokens they resolve to and the shared listener's
 * source. They pin the contract, not pixels.
 */

const VARIANTS: ButtonVariant[] = [
  "primary",
  "accent",
  "outline",
  "ghost",
  "danger",
];

const globalsCss = readFileSync(
  new URL("../app/globals.css", import.meta.url),
  "utf8",
);

const pressFeedback = readFileSync(
  new URL("../components/ui/press-feedback.tsx", import.meta.url),
  "utf8",
);

/** Split a class string into individual tokens. */
function tokens(classes: string): string[] {
  return classes.split(/\s+/).filter(Boolean);
}

/** All `pressed:` utility classes in a class string. */
function pressedClasses(classes: string): string[] {
  return tokens(classes).filter((token) => token.startsWith("pressed:"));
}

/** Resolve a Tailwind colour utility (`bg-ink`, `bg-danger-pressed`, …) to its hex value in @theme. */
function hexFor(utility: string): string {
  assert.match(utility, /^bg-[a-z0-9-]+$/, `unexpected colour utility: ${utility}`);

  const name = utility.slice("bg-".length);
  const match = globalsCss.match(
    new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{3,8})`),
  );

  assert.ok(match, `--color-${name} must be defined in globals.css @theme`);
  return match[1];
}

/** WCAG relative luminance of a `#rgb` / `#rrggbb` colour. */
function luminance(hex: string): number {
  const full =
    hex.length === 4
      ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
      : hex;
  const channels = [1, 3, 5].map((offset) => {
    const value = parseInt(full.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045
      ? value / 12.92
      : ((value + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/** Every solid `bg-*` colour utility in a class string. */
function backgroundUtilities(classes: string): string[] {
  return tokens(classes).filter(
    (token) => /^bg-[a-z0-9-]+$/.test(token) && !token.includes(":") && !token.includes("/"),
  );
}

describe("shared Button: pressed state", () => {
  it("every variant defines its own pressed: state", () => {
    for (const variant of VARIANTS) {
      assert.ok(
        pressedClasses(buttonClasses({ variant })).some(
          (token) => token.startsWith("pressed:bg-"),
        ),
        `variant "${variant}" must define a pressed: background colour`,
      );
    }
  });

  it("every variant's pressed colour is a clearly visible step from its resting colour", () => {
    for (const variant of VARIANTS) {
      const classes = buttonClasses({ variant });
      const pressed = pressedClasses(classes).find((token) =>
        token.startsWith("pressed:bg-"),
      );

      assert.ok(pressed, `variant "${variant}" must have a pressed:bg-`);

      // Ghost variants have no resting fill; their surface is the canvas, so
      // compare against the surface colour they sit on.
      const resting = backgroundUtilities(classes)[0] ?? "bg-surface";
      const delta = Math.abs(
        luminance(hexFor(resting)) - luminance(hexFor(pressed.slice(8))),
      );

      // 0.05 of relative luminance is a large, unmistakable step — several
      // times what a casual "a touch darker" tweak produces, and the reason
      // the original attempt read as "nothing happened" on a phone.
      assert.ok(
        delta > 0.05,
        `variant "${variant}": pressed colour ${pressed} must be clearly distinct from ${resting} (luminance delta was ${delta.toFixed(3)})`,
      );
    }
  });

  it("scales the button down while pressed and shortens the press transition", () => {
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

  it("animates the `scale` property, not just `transform`", () => {
    // Tailwind v4's scale-* utilities set the independent `scale` property, so
    // a `transition-transform` (or a transition that omits scale) makes the
    // press snap instead of animate.
    const classes = buttonClasses();
    const transition = classes.match(/transition-\[[^\]]+\]/)?.[0];

    assert.ok(transition, "base must declare an explicit transition list");
    assert.ok(
      transition.includes("scale"),
      `transition must include scale so the press is animated (got ${transition})`,
    );
  });

  it("does not rely on the iOS-unreliable bare active: utility", () => {
    for (const variant of VARIANTS) {
      assert.equal(
        tokens(buttonClasses({ variant })).filter((token) =>
          token.startsWith("active:"),
        ).length,
        0,
        `variant "${variant}" must use the data-pressed aware pressed: variant`,
      );
    }
  });

  it("keeps focus-visible, disabled and reduced-motion affordances", () => {
    const classes = buttonClasses();

    assert.ok(classes.includes("focus-visible:ring-2"));
    assert.ok(classes.includes("disabled:pointer-events-none"));
    assert.ok(classes.includes("disabled:opacity-55"));
    assert.ok(classes.includes("motion-reduce:pressed:scale-100"));
    assert.equal(
      pressedClasses(classes).some((token) => token.startsWith("pressed:opacity")),
      false,
      "the pressed state must not override the disabled opacity",
    );
  });

  it("still merges caller classNames after the variant classes", () => {
    const classes = buttonClasses({
      variant: "outline",
      size: "sm",
      className: "w-full",
    });

    assert.ok(classes.endsWith("w-full"));
    assert.ok(classes.includes("pressed:bg-line-strong"));
  });
});

describe("pressed: variant wiring in globals.css", () => {
  it("matches both the native :active state and the data-pressed attribute", () => {
    assert.ok(
      globalsCss.includes("@custom-variant pressed"),
      "globals.css must define the shared pressed: variant",
    );
    assert.ok(
      globalsCss.includes(":active"),
      "pressed: must still match the native :active state",
    );
    assert.ok(
      globalsCss.includes("[data-pressed]"),
      "pressed: must match the data-pressed attribute set by PressFeedback",
    );
  });

  it("excludes disabled controls from the pressed state", () => {
    assert.ok(
      globalsCss.includes(":not(:disabled)"),
      "pressed: must not style disabled/loading controls",
    );
  });

  it("suppresses the iOS tap-highlight flash so it cannot mask the pressed state", () => {
    assert.ok(
      globalsCss.includes("-webkit-tap-highlight-color: transparent"),
      "iOS paints its own tap flash over tappable elements; it must be disabled",
    );
  });
});

describe("PressFeedback listener", () => {
  it("registers the iOS :active enabler on touchstart in the capture phase", () => {
    assert.ok(
      pressFeedback.includes('"touchstart"'),
      "a passive touchstart listener is the documented switch that enables iOS :active",
    );
    assert.ok(
      /touchstart",\s*press,\s*pressOptions/.test(pressFeedback),
      "touchstart must be registered with the shared capture-phase options",
    );
    assert.ok(
      pressFeedback.includes("capture: true"),
      "listeners must run in the capture phase so nothing can stop propagation first",
    );
    assert.ok(
      pressFeedback.includes("passive: true"),
      "listeners must be passive so they never block scrolling or taps",
    );
  });

  it("sets and clears data-pressed", () => {
    assert.ok(
      pressFeedback.includes('setAttribute("data-pressed", "")'),
      "PressFeedback must mark the pressed element",
    );
    assert.ok(
      pressFeedback.includes('removeAttribute("data-pressed")'),
      "PressFeedback must clear the pressed element on release",
    );
  });

  it("never calls preventDefault, so behaviour and business logic are untouched", () => {
    assert.equal(
      /\.preventDefault\s*\(/.test(pressFeedback),
      false,
      "PressFeedback must not cancel any event",
    );
  });

  it("clears the press on every way a gesture can end", () => {
    for (const event of [
      "touchend",
      "touchcancel",
      "pointerup",
      "pointercancel",
      "touchmove",
      "scroll",
      "blur",
      "visibilitychange",
    ]) {
      assert.ok(
        pressFeedback.includes(`"${event}", release`),
        `a ${event} must release the pressed state`,
      );
    }
  });

  it("skips disabled and aria-disabled controls", () => {
    assert.ok(
      pressFeedback.includes('hasAttribute("disabled")'),
      "disabled buttons must keep their disabled appearance",
    );
    assert.ok(
      pressFeedback.includes('getAttribute("aria-disabled") === "true"'),
      "aria-disabled controls must keep their unavailable appearance",
    );
  });

  it("bounds the press with a timeout so a missed release cannot stick", () => {
    assert.ok(
      /PRESS_TIMEOUT_MS\s*=/.test(pressFeedback),
      "the press must be time-bounded",
    );
    assert.ok(
      pressFeedback.includes("setTimeout(release, PRESS_TIMEOUT_MS)"),
      "the safety timeout must release the pressed element",
    );
  });
});
