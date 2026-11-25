/**
 * Embeddable savings progress widget (issue #630).
 *
 * Produces self-contained HTML/JS that external sites can drop in via an
 * `<iframe srcdoc>` or a `<script>` tag. The embedded runtime renders a
 * compact progress card and exposes `window.StowSavingsWidget.update(data)`
 * so host pages can push fresh numbers. If `dataUrl` is set, the runtime
 * also polls that URL every `refreshMs` milliseconds.
 */

export type WidgetSize = "sm" | "md" | "lg";
export type WidgetField = "name" | "amounts" | "percent";

export interface WidgetOptions {
  /** Accent colour for the progress bar, as `#rgb` or `#rrggbb`. */
  color: string;
  size: WidgetSize;
  /** Fields to display, in render order. */
  fields: WidgetField[];
  /** Privacy control: when true, amounts are masked and only the percent shows. */
  hideAmounts: boolean;
  /** Polling interval for `dataUrl`, in ms. Clamped to at least 5 seconds. */
  refreshMs: number;
}

export interface WidgetData {
  goalName: string;
  saved: number;
  target: number;
}

export const DEFAULT_WIDGET_OPTIONS: WidgetOptions = {
  color: "#16a34a",
  size: "md",
  fields: ["name", "amounts", "percent"],
  hideAmounts: false,
  refreshMs: 60_000,
};

export const MIN_REFRESH_MS = 5_000;

const HEX_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const SIZES: readonly WidgetSize[] = ["sm", "md", "lg"];
const FIELDS: readonly WidgetField[] = ["name", "amounts", "percent"];
const WIDTHS: Record<WidgetSize, number> = { sm: 240, md: 320, lg: 400 };

/** Fills in defaults and drops anything invalid, so unsafe values never reach the markup. */
export function normalizeWidgetOptions(
  input: Partial<WidgetOptions> = {},
): WidgetOptions {
  const color =
    typeof input.color === "string" && HEX_COLOR.test(input.color)
      ? input.color
      : DEFAULT_WIDGET_OPTIONS.color;
  const size = SIZES.includes(input.size as WidgetSize)
    ? (input.size as WidgetSize)
    : DEFAULT_WIDGET_OPTIONS.size;
  const fields = Array.isArray(input.fields)
    ? FIELDS.filter((f) => input.fields!.includes(f))
    : DEFAULT_WIDGET_OPTIONS.fields;
  const refreshMs =
    typeof input.refreshMs === "number" && Number.isFinite(input.refreshMs)
      ? Math.max(MIN_REFRESH_MS, input.refreshMs)
      : DEFAULT_WIDGET_OPTIONS.refreshMs;

  return {
    color,
    size,
    fields,
    hideAmounts: input.hideAmounts === true,
    refreshMs,
  };
}

/** Percent of target reached, clamped to 0–100. A zero target reads as 0%. */
export function widgetPercent(data: WidgetData): number {
  if (!(data.target > 0)) return 0;
  const pct = (data.saved / data.target) * 100;
  return Math.min(100, Math.max(0, pct));
}

/** Escapes a value for use inside a double-quoted HTML attribute. */
const escapeAttr = (value: string): string => value.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`);

/** JSON that is safe to inline inside a `<script>` element. */
const safeJson = (value: unknown): string =>
  JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");

/**
 * Browser-side runtime shared by both embed styles. Written as ES5 so it runs
 * on any host page. `__CONFIG__` and `__DATA__` are replaced with JSON.
 */
const RUNTIME = `(function (root) {
  var CONFIG = __CONFIG__;
  var data = __DATA__;
  function esc(v) {
    return String(v).replace(/[&<>"']/g, function (c) { return "&#" + c.charCodeAt(0) + ";"; });
  }
  function money(n) {
    return "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function percent(d) {
    if (!(d.target > 0)) return 0;
    return Math.min(100, Math.max(0, (d.saved / d.target) * 100));
  }
  function render() {
    var el = document.getElementById(CONFIG.containerId) || document.body;
    var p = percent(data);
    var has = function (f) { return CONFIG.fields.indexOf(f) !== -1; };
    var html = "";
    if (has("name")) html += '<div style="font-weight:600">' + esc(data.goalName) + "</div>";
    if (has("amounts")) {
      html += '<div style="font-size:0.9em;opacity:0.8">' +
        (CONFIG.hideAmounts ? "Amounts hidden" : money(data.saved) + " of " + money(data.target)) + "</div>";
    }
    html += '<div style="height:8px;border-radius:4px;background:#e5e7eb;overflow:hidden;margin:8px 0">' +
      '<div style="height:100%;width:' + p.toFixed(1) + "%;background:" + CONFIG.color + '"></div></div>';
    if (has("percent")) html += '<div style="font-size:0.9em">' + Math.round(p) + "% saved</div>";
    el.innerHTML = '<div style="font-family:system-ui,sans-serif;padding:12px;border:1px solid #d1d5db;border-radius:12px;width:' +
      CONFIG.width + 'px;box-sizing:border-box;background:#fff;color:#111827">' + html + "</div>";
  }
  function update(next) {
    if (!next || typeof next !== "object") return;
    data = {
      goalName: String(next.goalName == null ? data.goalName : next.goalName),
      saved: Number(next.saved == null ? data.saved : next.saved),
      target: Number(next.target == null ? data.target : next.target)
    };
    render();
  }
  function poll() {
    if (!CONFIG.dataUrl || typeof fetch !== "function") return;
    fetch(CONFIG.dataUrl).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (json) { if (json) update(json); })
      .catch(function () {});
  }
  root.StowSavingsWidget = { update: update };
  render();
  if (CONFIG.dataUrl) setInterval(poll, CONFIG.refreshMs);
})(window);`;

export interface WidgetEmbedInput {
  data: WidgetData;
  options?: Partial<WidgetOptions>;
  /** Optional JSON endpoint returning `{ goalName, saved, target }` for live updates. */
  dataUrl?: string;
  /** Element id used by the script embed. Must be a plain identifier. */
  containerId?: string;
}

export interface WidgetEmbedCodes {
  /** Drop-in `<iframe>` that renders the widget in isolation. */
  iframe: string;
  /** `<div>` plus inline `<script>` for embedding directly into the host page. */
  script: string;
  /** Full standalone HTML document the iframe loads via `srcdoc`. */
  document: string;
}

function buildRuntime(config: Record<string, unknown>, data: WidgetData): string {
  return RUNTIME.replace("__CONFIG__", () => safeJson(config)).replace(
    "__DATA__",
    () => safeJson(data),
  );
}

/** Builds the iframe, script and standalone document embed variants for a widget. */
export function buildWidgetEmbedCodes(input: WidgetEmbedInput): WidgetEmbedCodes {
  const options = normalizeWidgetOptions(input.options);
  const containerId = /^[A-Za-z][\w-]*$/.test(input.containerId ?? "")
    ? (input.containerId as string)
    : "stow-savings-widget";
  const config = {
    ...options,
    width: WIDTHS[options.size],
    containerId,
    dataUrl: input.dataUrl && /^https?:\/\//.test(input.dataUrl) ? input.dataUrl : null,
  };
  const runtime = buildRuntime(config, input.data);

  const doc = [
    "<!doctype html>",
    '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>',
    `<body style="margin:0"><div id="${containerId}"></div>`,
    `<script>${runtime.replace(/<\/script/gi, "<\\/script")}</script>`,
    "</body></html>",
  ].join("");

  const iframe =
    `<iframe title="Stow savings progress" width="${WIDTHS[options.size]}" height="160" style="border:0" ` +
    `srcdoc="${escapeAttr(doc)}"></iframe>`;

  const script = [
    `<div id="${containerId}"></div>`,
    `<script>${runtime.replace(/<\/script/gi, "<\\/script")}</script>`,
  ].join("\n");

  return { iframe, script, document: doc };
}
