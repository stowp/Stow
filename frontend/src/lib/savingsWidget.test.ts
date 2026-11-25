import { describe, expect, it } from "vitest";
import {
  DEFAULT_WIDGET_OPTIONS,
  MIN_REFRESH_MS,
  buildWidgetEmbedCodes,
  normalizeWidgetOptions,
  widgetPercent,
} from "./savingsWidget";

describe("normalizeWidgetOptions", () => {
  it("returns defaults for empty input", () => {
    expect(normalizeWidgetOptions()).toEqual(DEFAULT_WIDGET_OPTIONS);
  });

  it("rejects invalid colours, sizes and fields", () => {
    const opts = normalizeWidgetOptions({
      color: "red; background:url(x)",
      size: "huge" as never,
      fields: ["name", "bogus" as never],
    });
    expect(opts.color).toBe(DEFAULT_WIDGET_OPTIONS.color);
    expect(opts.size).toBe(DEFAULT_WIDGET_OPTIONS.size);
    expect(opts.fields).toEqual(["name"]);
  });

  it("accepts valid hex colours and clamps the refresh interval", () => {
    expect(normalizeWidgetOptions({ color: "#abc" }).color).toBe("#abc");
    expect(normalizeWidgetOptions({ refreshMs: 10 }).refreshMs).toBe(MIN_REFRESH_MS);
  });
});

describe("widgetPercent", () => {
  it("clamps to 0–100 and treats a zero target as 0%", () => {
    expect(widgetPercent({ goalName: "g", saved: 50, target: 200 })).toBe(25);
    expect(widgetPercent({ goalName: "g", saved: 300, target: 200 })).toBe(100);
    expect(widgetPercent({ goalName: "g", saved: 5, target: 0 })).toBe(0);
  });
});

describe("buildWidgetEmbedCodes", () => {
  const data = { goalName: "Trip <b>", saved: 50, target: 200 };

  it("produces an iframe that embeds the document via srcdoc", () => {
    const { iframe, document } = buildWidgetEmbedCodes({ data });
    expect(iframe.startsWith("<iframe")).toBe(true);
    expect(iframe).toContain("srcdoc=");
    expect(iframe).not.toContain("<b>");
    expect(document).toContain("<!doctype html>");
  });

  it("produces a script embed with a container and inline runtime", () => {
    const { script } = buildWidgetEmbedCodes({
      data,
      containerId: "my-widget",
      options: { hideAmounts: true, fields: ["percent"] },
    });
    expect(script).toContain('<div id="my-widget"></div>');
    expect(script).toContain("StowSavingsWidget");
    expect(script).toContain('"hideAmounts":true');
  });

  it("escapes markup in the goal name so it cannot break out of the script", () => {
    const { script } = buildWidgetEmbedCodes({
      data: { goalName: "</script><img src=x>", saved: 1, target: 2 },
    });
    expect(script).not.toContain("</script><img");
    expect(script).toContain("\\u003c/script");
  });

  it("ignores unsafe container ids and non-http data URLs", () => {
    const { script } = buildWidgetEmbedCodes({
      data,
      containerId: '"><script>',
      dataUrl: "javascript:alert(1)",
    });
    expect(script).toContain('<div id="stow-savings-widget"></div>');
    expect(script).toContain('"dataUrl":null');
  });

  it("generates runtime that parses as valid JavaScript", () => {
    const { script } = buildWidgetEmbedCodes({
      data,
      dataUrl: "https://example.com/goal.json",
    });
    const code = script.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
    expect(() => new Function(code)).not.toThrow();
  });
});
