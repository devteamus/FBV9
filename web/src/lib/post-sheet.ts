/**
 * Post-sheet parsing (CSV + XLSX) and demo-template generation.
 *
 * Used by:
 *   - POST /api/upload                → parses the user's file
 *   - GET  /api/upload/template       → generates the downloadable demo files
 *
 * Supported input: .csv (Google Sheets / Excel export, comma / semicolon /
 * tab delimited, UTF-8 or UTF-16 with BOM) and .xlsx (Google Sheets /
 * Excel download).
 *
 * Canonical columns (header matching is tolerant — case, spaces, dashes
 * and underscores are ignored, several aliases accepted):
 *
 *   caption                  (required)
 *   media_url                (required for image / video / reel)
 *   post_type                text | image | video | reel   (default image)
 *   comment_1                optional — alias: comment
 *   comment_1_delay_minutes  optional — blank / 0 = right after the post
 *   comment_2                optional
 *   comment_2_delay_minutes  required when comment_2 is filled
 *
 * Comment 3 was removed. Old files that still contain comment_3 columns
 * are accepted — those columns are ignored and a warning is returned.
 */

import { parse } from "csv-parse/sync";
import ExcelJS from "exceljs";
import { Readable } from "node:stream";
import { ValidationError } from "@/lib/auth";

export const CANONICAL_COLUMNS = [
  "caption",
  "media_url",
  "post_type",
  "comment_1",
  "comment_1_delay_minutes",
  "comment_2",
  "comment_2_delay_minutes",
] as const;

export type CanonicalColumn = (typeof CANONICAL_COLUMNS)[number];

export interface SheetRow {
  /** Row number as the user sees it in Excel / Sheets (header = row 1). */
  rowNumber: number;
  caption: string;
  media_url: string;
  post_type: string;
  comment_1: string;
  comment_1_delay_minutes: string;
  comment_2: string;
  comment_2_delay_minutes: string;
}

export interface ParsedSheet {
  format: "csv" | "xlsx";
  rows: SheetRow[];
  warnings: string[];
}

// ── Header mapping ──────────────────────────────────────────────

const COMMENT3_RE = /^comment3/;

function mapHeader(raw: string): CanonicalColumn | "comment_3" | null {
  const h = raw
    .replace(/^\uFEFF/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  if (!h) return null;

  if (["caption", "text", "message", "posttext", "postcaption", "content"].includes(h))
    return "caption";
  if (
    ["mediaurl", "media", "imageurl", "videourl", "image", "video", "photourl", "photo", "url"].includes(h)
  )
    return "media_url";
  if (["posttype", "type", "mediatype"].includes(h)) return "post_type";

  if (COMMENT3_RE.test(h)) return "comment_3";

  // comment_2 delay / text
  if (/^comment2delay(minutes?|mins?|m)?$/.test(h)) return "comment_2_delay_minutes";
  if (["comment2", "secondcomment", "comment2text"].includes(h)) return "comment_2";

  // comment_1 delay / text (plain "comment" is the legacy name of comment 1)
  if (/^(comment1?|firstcomment)delay(minutes?|mins?|m)?$/.test(h))
    return "comment_1_delay_minutes";
  if (["comment", "comment1", "firstcomment", "comment1text"].includes(h))
    return "comment_1";

  return null;
}

// ── Decoding / delimiter detection ──────────────────────────────

function decodeText(buf: Buffer): string {
  // UTF-16 LE BOM (Excel "Unicode Text")
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString("utf16le");
  }
  // UTF-16 BE BOM
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  return buf.toString("utf-8").replace(/^\uFEFF/, "");
}

function detectDelimiter(text: string): string {
  // Look at the first non-empty line (the header) — count candidate
  // delimiters that sit outside double quotes.
  const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  let inQuotes = false;
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch]++;
  }
  let best = ",";
  for (const d of [";", "\t"]) {
    if (counts[d] > counts[best]) best = d;
  }
  return best;
}

// ── Cell → string ───────────────────────────────────────────────

function cellToString(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    // Hyperlink cell: Excel / Sheets turn pasted URLs into these
    if (typeof o.hyperlink === "string") {
      const text = typeof o.text === "string" ? o.text : "";
      return /^https?:\/\//i.test(text.trim()) ? text : (o.hyperlink as string);
    }
    if (Array.isArray(o.richText)) {
      return (o.richText as Array<{ text?: string }>).map((r) => r.text ?? "").join("");
    }
    if ("result" in o) return cellToString(o.result);
    if (typeof o.text === "string") return o.text;
    if ("error" in o) return "";
  }
  return "";
}

// ── Low-memory readers ──────────────────────────────────────────
//
// Files can be up to MAX_CSV_BYTES (25 MB) with up to 10,000 rows and
// 10,000 columns. Only 7 columns matter, so every reader keeps ONLY those
// cells of each row (the other columns are dropped as they stream past) —
// memory stays proportional to rows × 7, never rows × 10,000.

export const MAX_SHEET_COLUMNS = parseInt(process.env.MAX_CSV_COLUMNS || "10000", 10);

type ColMap = Partial<Record<CanonicalColumn, number>>;

interface RawSheet {
  headerCells: string[];
  colIndex: ColMap;
  sawComment3: boolean;
  /** [sheetRowNumber, record][] — rows with no data already dropped */
  rows: Array<[number, Partial<Record<CanonicalColumn, string>>]>;
}

function buildColumnMap(headerCells: string[]): { colIndex: ColMap; sawComment3: boolean } {
  if (headerCells.length > MAX_SHEET_COLUMNS) {
    throw new ValidationError(
      `The file has ${headerCells.length} columns — max allowed is ${MAX_SHEET_COLUMNS}.`
    );
  }
  const colIndex: ColMap = {};
  let sawComment3 = false;
  headerCells.forEach((h, i) => {
    const mapped = mapHeader(h ?? "");
    if (mapped === "comment_3") sawComment3 = true;
    else if (mapped && colIndex[mapped] === undefined) colIndex[mapped] = i;
  });
  return { colIndex, sawComment3 };
}

function readCsvSheet(buffer: Buffer, maxRows: number): RawSheet {
  const text = decodeText(buffer);
  if (!text.trim()) throw new ValidationError("The file is empty.");

  let headerCells: string[] = [];
  let colIndex: ColMap = {};
  let sawComment3 = false;

  let records: Array<Record<string, string> & { __line: number }>;
  try {
    records = parse(text, {
      delimiter: detectDelimiter(text),
      bom: true,
      // Header → per-column target name, `false` = drop the column while
      // parsing (so 10,000 unused columns are never kept in memory).
      columns: (header: string[]) => {
        headerCells = header.map((h) => (h ?? "").toString());
        ({ colIndex, sawComment3 } = buildColumnMap(headerCells));
        const byIndex = new Map<number, string>();
        (Object.keys(colIndex) as CanonicalColumn[]).forEach((c) => byIndex.set(colIndex[c]!, c));
        return header.map((_, i) => byIndex.get(i) ?? false);
      },
      skip_empty_lines: true,
      relax_column_count: true, // ragged rows (unquoted commas, trailing cells) are OK
      relax_quotes: true, // stray quotes inside a field are OK
      // NOT `info: true` — it attaches the full header to every record
      // (10,000 columns × 10,000 rows = gigabytes). Keep just the line number.
      on_record: (record: Record<string, string>, ctx: { lines: number }) => ({
        ...record,
        __line: ctx.lines,
      }),
    }) as Array<Record<string, string> & { __line: number }>;
  } catch (err: any) {
    if (err instanceof ValidationError) throw err;
    const line = err?.lines ? ` (near line ${err.lines})` : "";
    throw new ValidationError(
      `The CSV could not be read${line}: ${err?.message || "invalid format"}. ` +
        `Tip: re-download it from Google Sheets / Excel as CSV, or use the demo template. ` +
        `If a caption contains a double quote ("), wrap the whole cell in quotes.`
    );
  }

  const rows: RawSheet["rows"] = [];
  for (const r of records) {
    const rec: Partial<Record<CanonicalColumn, string>> = {};
    let hasData = false;
    for (const c of CANONICAL_COLUMNS) {
      const v = r[c];
      if (v !== undefined && v !== null) {
        rec[c] = String(v);
        if (String(v).trim() !== "") hasData = true;
      }
    }
    if (!hasData) continue;
    // __line = line where the record ENDS; subtract line breaks inside
    // quoted cells to get the line where it starts (= sheet row).
    const innerBreaks = Object.values(rec).join("").split("\n").length - 1;
    rows.push([Math.max(1, r.__line - innerBreaks), rec]);
    if (rows.length > maxRows) break; // caller reports "too many rows"
  }
  return { headerCells, colIndex, sawComment3, rows };
}

async function readXlsxSheet(buffer: Buffer, maxRows: number): Promise<RawSheet> {
  // Streaming reader: rows are processed one by one instead of loading the
  // whole workbook (a 25 MB .xlsx expands to hundreds of MB as a DOM).
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(Readable.from([buffer]), {
    worksheets: "emit",
    sharedStrings: "cache",
    hyperlinks: "cache",
    styles: "ignore",
    entries: "emit",
  });

  let headerCells: string[] | null = null;
  let colIndex: ColMap = {};
  let sawComment3 = false;
  let wanted: Array<[CanonicalColumn, number]> = [];
  const rows: RawSheet["rows"] = [];

  try {
    for await (const ws of reader) {
      // first sheet that has data wins (our demo file keeps "Posts" first)
      for await (const row of ws as AsyncIterable<ExcelJS.Row>) {
        const values = row.values as unknown[]; // 1-based
        if (headerCells === null) {
          const cells: string[] = [];
          const len = Math.min(values.length - 1, MAX_SHEET_COLUMNS + 1);
          for (let i = 1; i <= len; i++) cells.push(cellToString(values[i]));
          if (!cells.some((c) => c.trim() !== "")) continue; // blank leading row
          headerCells = cells;
          ({ colIndex, sawComment3 } = buildColumnMap(cells));
          wanted = (Object.keys(colIndex) as CanonicalColumn[]).map((c) => [c, colIndex[c]! + 1]);
          continue;
        }
        const rec: Partial<Record<CanonicalColumn, string>> = {};
        let hasData = false;
        for (const [c, idx] of wanted) {
          const v = cellToString(values[idx]);
          rec[c] = v;
          if (v.trim() !== "") hasData = true;
        }
        if (!hasData) continue;
        rows.push([row.number, rec]);
        if (rows.length > maxRows) break;
      }
      if (headerCells !== null) break;
    }
  } catch (err: any) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError(
      "The Excel file could not be opened. Make sure it is a real .xlsx file " +
        "(Google Sheets: File → Download → Microsoft Excel (.xlsx))."
    );
  }

  if (headerCells === null) throw new ValidationError("The Excel file has no data.");
  return { headerCells, colIndex, sawComment3, rows };
}

// ── Public: parse ───────────────────────────────────────────────

export async function parsePostSheet(
  buffer: Buffer,
  fileName: string
): Promise<ParsedSheet> {
  const lower = fileName.toLowerCase();
  let format: "csv" | "xlsx";

  if (lower.endsWith(".xlsx")) {
    format = "xlsx";
    // xlsx files are zip archives — must start with "PK"
    if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
      throw new ValidationError(
        "This file is named .xlsx but is not a real Excel file. Re-download it as Microsoft Excel (.xlsx)."
      );
    }
  } else if (lower.endsWith(".csv") || lower.endsWith(".tsv") || lower.endsWith(".txt")) {
    format = "csv";
    // Binary sniff — UTF-16 text legitimately contains 0x00, everything else must not
    const isUtf16 =
      buffer.length >= 2 &&
      ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff));
    if (!isUtf16 && buffer.includes(0x00)) {
      throw new ValidationError(
        "This file does not look like a CSV. If it is an Excel file, save it as .xlsx or .csv."
      );
    }
  } else if (lower.endsWith(".xls")) {
    throw new ValidationError(
      "Old Excel (.xls) is not supported. Open it and Save As .xlsx (or .csv), then upload again."
    );
  } else {
    throw new ValidationError("Only .csv or .xlsx files are allowed.");
  }

  const maxRows = parseInt(process.env.MAX_CSV_ROWS || "10000", 10);
  const sheet =
    format === "xlsx" ? await readXlsxSheet(buffer, maxRows) : readCsvSheet(buffer, maxRows);

  const warnings: string[] = [];
  if (sheet.colIndex.caption === undefined) {
    const found = sheet.headerCells.map((h) => h.trim()).filter(Boolean).slice(0, 15).join(", ") || "(none)";
    throw new ValidationError(
      `Missing required column "caption". Columns found: ${found}. ` +
        `Use the demo template (Download demo) for the exact format.`
    );
  }
  if (sheet.sawComment3) {
    warnings.push(
      "comment_3 columns were ignored — only comment_1 and comment_2 are supported now."
    );
  }

  const rows: SheetRow[] = sheet.rows.map(([rowNumber, rec]) => ({
    rowNumber,
    caption: rec.caption ?? "",
    media_url: rec.media_url ?? "",
    post_type: rec.post_type ?? "",
    comment_1: rec.comment_1 ?? "",
    comment_1_delay_minutes: rec.comment_1_delay_minutes ?? "",
    comment_2: rec.comment_2 ?? "",
    comment_2_delay_minutes: rec.comment_2_delay_minutes ?? "",
  }));

  return { format, rows, warnings };
}

// ── Demo template ───────────────────────────────────────────────

const DEMO_ROWS: string[][] = [
  [
    "Fresh morning vibes ☀️ #example",
    "https://example.com/images/photo-1.jpg",
    "image",
    "Shop now 👉 https://example.com",
    "0",
    "Tell us your favourite in the comments!",
    "5",
  ],
  [
    "New arrival — limited stock",
    "https://example.com/images/photo-2.jpg",
    "image",
    "Free delivery this week",
    "2",
    "Order before midnight",
    "10",
  ],
  ["Text only post — no media_url needed", "", "text", "First comment right after posting", "", "", ""],
  ["Watch our latest reel", "https://example.com/videos/reel-1.mp4", "reel", "", "", "", ""],
];

const INSTRUCTIONS: Array<[string, string]> = [
  ["caption", "REQUIRED. The post text."],
  ["media_url", "Full http(s) link to the image / video. Required for image, video and reel. Leave blank for text posts."],
  ["post_type", "text, image, video or reel. Blank = image."],
  ["comment_1", "Optional. First comment."],
  ["comment_1_delay_minutes", "Optional. Minutes after the post goes live. Blank or 0 = comment immediately."],
  ["comment_2", "Optional. Second comment."],
  ["comment_2_delay_minutes", "Required if comment_2 is filled. Minutes after the post goes live (1 or more)."],
  ["", ""],
  ["Tip", "Delete the sample rows and keep the header row. Google Sheets: File → Download → CSV or Microsoft Excel (.xlsx), then upload here."],
];

function csvEscape(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function buildTemplateCsv(): Buffer {
  const lines = [CANONICAL_COLUMNS.join(","), ...DEMO_ROWS.map((r) => r.map(csvEscape).join(","))];
  // UTF-8 BOM so Excel shows emoji / Bengali text correctly
  return Buffer.from("\uFEFF" + lines.join("\r\n") + "\r\n", "utf-8");
}

export async function buildTemplateXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "FB Auto-Poster";

  const ws = wb.addWorksheet("Posts", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.addRow([...CANONICAL_COLUMNS]);
  // Delay columns (index 4 and 6) are written as real numbers so Excel
  // does not flag them as "number stored as text".
  DEMO_ROWS.forEach((r) =>
    ws.addRow(r.map((v, i) => ((i === 4 || i === 6) && v !== "" ? Number(v) : v)))
  );

  const widths = [48, 44, 12, 40, 24, 40, 24];
  widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));
  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1D4ED8" } };
  // Keep delay columns as plain numbers
  ws.getColumn(5).numFmt = "0";
  ws.getColumn(7).numFmt = "0";

  const info = wb.addWorksheet("Instructions");
  info.getColumn(1).width = 28;
  info.getColumn(2).width = 100;
  info.addRow(["Column", "How to fill it"]).font = { bold: true };
  INSTRUCTIONS.forEach((r) => info.addRow(r));

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}
