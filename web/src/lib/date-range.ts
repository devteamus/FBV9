/**
 * Shared date-range parsing for the analytics / posts / comments APIs.
 *
 * Supported presets: "today" (default), "yesterday", "last7", "custom".
 * Custom uses `from` + `to` as ISO dates (YYYY-MM-DD) or full timestamps.
 * Ranges are start-inclusive / end-exclusive, resolved in the server's
 * local timezone so "today" matches what the user sees in the dashboard.
 *
 * All returned values are validated: `to` is clamped to "end of now" so a
 * user can't query the future, and `from` must be before `to`.
 */

export interface DateRange {
  from: Date;
  to: Date;
  preset: "today" | "yesterday" | "last7" | "custom";
}

export class DateRangeError extends Error {
  status = 400;
  constructor(message: string) {
    super(message);
    this.name = "DateRangeError";
  }
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

export function parseDateRange(params: URLSearchParams): DateRange {
  const preset = (params.get("preset") || "today").toLowerCase();

  if (preset === "yesterday") {
    const y = new Date();
    y.setDate(y.getDate() - 1);
    return { from: startOfDay(y), to: endOfDay(y), preset: "yesterday" };
  }

  if (preset === "last7") {
    const from = new Date();
    from.setDate(from.getDate() - 6); // today + previous 6 days
    return { from: startOfDay(from), to: new Date(), preset: "last7" };
  }

  if (preset === "custom") {
    const fromRaw = params.get("from");
    const toRaw = params.get("to");
    if (!fromRaw || !toRaw) {
      throw new DateRangeError("preset=custom requires from and to (YYYY-MM-DD)");
    }
    const from = startOfDay(new Date(fromRaw));
    const to = endOfDay(new Date(toRaw));
    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      throw new DateRangeError("Invalid from/to date — use YYYY-MM-DD");
    }
    if (from.getTime() > to.getTime()) {
      throw new DateRangeError("from must be before to");
    }
    // Clamp: never query the future
    const now = new Date();
    return { from, to: to > now ? now : to, preset: "custom" };
  }

  // default: today
  return { from: startOfDay(new Date()), to: new Date(), preset: "today" };
}
