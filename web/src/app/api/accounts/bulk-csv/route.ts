/**
 * POST /api/accounts/bulk-csv — bulk connect accounts from a CSV file
 *
 * v2.2 feature: instead of connecting pages one-by-one, a user can upload
 * a CSV with up to 500 rows and have every page auto-connected.
 *
 * Required CSV columns (header matching is tolerant — case-insensitive,
 * spaces/underscores/hyphens ignored, several aliases accepted):
 *   - Account name        (aliases: name, page name, account)
 *   - Page ID              (aliases: page id, id, fb page id)
 *   - Page Access Token    (aliases: access token, token, page token)
 * Optional column:
 *   - API Version          (aliases: fb api version, version; default v20.0)
 *
 * Semantics:
 * - Row-level validation mirrors the manual create form exactly
 *   (name ≤100, page id ≤50, token ≤500 chars). ANY invalid row rejects
 *   the whole file (atomic — no partial imports), like /api/upload.
 * - Rows whose Page ID is already connected (in this user's account list)
 *   are SKIPPED, not errors. Exact duplicates inside the CSV are also
 *   skipped. Both are reported in the response.
 * - Tokens are encrypted before storing (§7B) — never returned anywhere.
 * - Fire-and-forget validation jobs are queued for every created account
 *   (the worker verifies the token + persists the page picture). Bulk jobs
 *   are added with addBulk (chunked) — never one Redis call per row.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession, AuthError, ValidationError } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { encrypt } from "@/lib/encryption";
import { getRedis } from "@/lib/redis";
import { getValidateQueue } from "@/lib/queues/helpers";
import { MAX_ACCOUNTS_PER_USER } from "@/lib/config";
import { parse } from "csv-parse/sync";

// ── Header normalization & alias matching ────────────────────────
// Excel/Sheets exports vary wildly ("Account Name", "account_name",
// "ACCOUNT NAME", …). Normalize to lowercase alphanumerics and match
// against a curated alias list per logical column.
function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const NAME_ALIASES = new Set(["accountname", "name", "account", "pagename", "pagetitle", "accounttitle"]);
const PAGE_ID_ALIASES = new Set(["pageid", "page", "id", "fbpageid", "facebookpageid", "pageids"]);
const TOKEN_ALIASES = new Set([
  "pageaccesstoken",
  "accesstoken",
  "token",
  "pagetoken",
  "fbpagetoken",
  "facebookpageaccesstoken",
  "pageaccesstokens",
  "accesstokens",
]);
const VERSION_ALIASES = new Set(["apiversion", "fbapiversion", "version", "graphapiversion"]);

interface ParsedAccountRow {
  name: string;
  pageId: string;
  token: string;
  apiVersion: string;
}

function mapColumns(headers: string[]): {
  name?: number;
  pageId?: number;
  token?: number;
  apiVersion?: number;
} {
  const map: { name?: number; pageId?: number; token?: number; apiVersion?: number } = {};
  headers.forEach((raw, idx) => {
    const h = normalizeHeader(raw);
    if (map.name === undefined && NAME_ALIASES.has(h)) map.name = idx;
    else if (map.pageId === undefined && PAGE_ID_ALIASES.has(h)) map.pageId = idx;
    else if (map.token === undefined && TOKEN_ALIASES.has(h)) map.token = idx;
    else if (map.apiVersion === undefined && VERSION_ALIASES.has(h)) map.apiVersion = idx;
  });
  return map;
}

// ── File-level guards (same style as /api/upload) ────────────────
function assertLooksLikeCsv(buffer: Buffer): void {
  if (buffer.includes(0x00)) {
    throw new ValidationError("File does not look like a valid CSV");
  }
  try {
    buffer.toString("utf-8");
  } catch {
    try {
      buffer.toString("latin1");
    } catch {
      throw new ValidationError("File does not look like a valid CSV");
    }
  }
}

export async function POST(request: NextRequest) {
  try {
    const { sub: userId } = await getSession();

    const formData = await request.formData();
    const file = formData.get("csv") as File | null;
    if (!file) throw new ValidationError("No file part");
    if (!file.name.toLowerCase().endsWith(".csv")) {
      throw new ValidationError("Only .csv files allowed");
    }

    // v2.3 — OOM guard (same as /api/upload): hard byte cap checked
    // BEFORE arrayBuffer() buffers the whole part into RAM.
    const MAX_CSV_BYTES = parseInt(
      process.env.MAX_CSV_BYTES || String(10 * 1024 * 1024),
      10
    );
    if (file.size > MAX_CSV_BYTES) {
      throw new ValidationError(
        `CSV file is too large (${(file.size / 1024 / 1024).toFixed(1)} MB) — max allowed is ${(MAX_CSV_BYTES / 1024 / 1024).toFixed(0)} MB`
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    assertLooksLikeCsv(buffer);

    // Parse with headers as an array so we can do alias matching ourselves
    const parsed = parse(buffer.toString("utf-8"), {
      skip_empty_lines: true,
      bom: true,
    }) as string[][];
    if (parsed.length < 2) {
      throw new ValidationError("CSV has no data rows (header only or empty)");
    }

    const headers = parsed[0] as string[];
    const cols = mapColumns(headers);
    const missing: string[] = [];
    if (cols.name === undefined) missing.push("Account name");
    if (cols.pageId === undefined) missing.push("Page ID");
    if (cols.token === undefined) missing.push("Page Access Token");
    if (missing.length > 0) {
      throw new ValidationError(
        `Missing required column(s): ${missing.join(", ")}. Required columns: Account name, Page ID, Page Access Token.`
      );
    }

    // ── Capacity check (before any work) ──────────────────────
    const currentCount = await prisma.account.count({ where: { userId } });
    const remaining = Math.max(0, MAX_ACCOUNTS_PER_USER - currentCount);
    const dataRows = parsed.length - 1;
    if (remaining === 0) {
      throw new ValidationError(
        `Maximum ${MAX_ACCOUNTS_PER_USER} accounts already reached — remove some accounts first.`
      );
    }
    if (dataRows > remaining) {
      throw new ValidationError(
        `CSV has ${dataRows} rows but only ${remaining} account slot(s) left (limit ${MAX_ACCOUNTS_PER_USER}). Remove rows or delete unused accounts.`
      );
    }

    // ── Row-level validation (mirror of the manual create schema) ──
    // ANY invalid row rejects the whole file — atomic, like /api/upload.
    const invalidRows: number[] = [];
    const rows: ParsedAccountRow[] = [];
    for (let i = 1; i < parsed.length; i++) {
      const raw = parsed[i];
      const lineNo = i + 1; // human line number in the file
      const name = String(raw[cols.name!] ?? "").trim();
      const pageId = String(raw[cols.pageId!] ?? "").trim();
      const token = String(raw[cols.token!] ?? "").trim();
      const apiVersion = cols.apiVersion !== undefined
        ? String(raw[cols.apiVersion] ?? "").trim()
        : "";

      if (name.length < 1 || name.length > 100) invalidRows.push(lineNo);
      else if (pageId.length < 1 || pageId.length > 50) invalidRows.push(lineNo);
      else if (token.length < 1 || token.length > 500) invalidRows.push(lineNo);
      else if (apiVersion.length > 10) invalidRows.push(lineNo);
      else {
        rows.push({
          name,
          pageId,
          token,
          apiVersion: apiVersion || "v20.0",
        });
      }
      if (invalidRows.length >= 10) break;
    }
    if (invalidRows.length > 0) {
      const preview = invalidRows.slice(0, 10).join(", ");
      throw new ValidationError(
        `Invalid row(s) at CSV line(s): ${preview}${invalidRows.length >= 10 ? " …" : ""}. Every row needs Account name (≤100 chars), Page ID (≤50 chars) and Page Access Token (≤500 chars).`
      );
    }

    // ── Dedup: within file + already connected ────────────────
    const seenInFile = new Set<string>();
    const alreadyConnected = new Set(
      (
        await prisma.account.findMany({
          where: { userId },
          select: { fbPageId: true },
        })
      ).map((a) => a.fbPageId.trim().toLowerCase())
    );

    let skippedDuplicates = 0;
    let skippedAlreadyConnected = 0;
    const toCreate: ParsedAccountRow[] = [];
    for (const row of rows) {
      const key = row.pageId.toLowerCase();
      if (alreadyConnected.has(key)) {
        skippedAlreadyConnected++;
        continue;
      }
      if (seenInFile.has(key)) {
        skippedDuplicates++;
        continue;
      }
      seenInFile.add(key);
      toCreate.push(row);
    }

    if (toCreate.length === 0) {
      return NextResponse.json({
        success: true,
        created: 0,
        skippedDuplicates,
        skippedAlreadyConnected,
        message:
          "Nothing to import — every row is already connected or a duplicate.",
      });
    }

    // ── Encrypt tokens (chunked parallel — 50 at a time) ──────
    const encrypted: string[] = [];
    const ENC_CHUNK = 50;
    for (let off = 0; off < toCreate.length; off += ENC_CHUNK) {
      const wave = toCreate.slice(off, off + ENC_CHUNK);
      const encs = await Promise.all(wave.map((r) => encrypt(r.token)));
      encrypted.push(...encs);
    }

    // ── Single createMany — one DB write for the whole import ──
    const created = await prisma.account.createMany({
      data: toCreate.map((r, i) => ({
        userId,
        name: r.name,
        fbPageAccessToken: encrypted[i],
        fbPageId: r.pageId,
        fbApiVersion: r.apiVersion,
      })),
    });

    // ── Fire-and-forget validation for every new account ──────
    // addBulk in chunks — never one Redis round-trip per row. Failure is
    // non-fatal (same as the manual create path): the Accounts page
    // validate button remains as fallback.
    try {
      const redis = getRedis();
      const validateQueue = getValidateQueue(redis);
      const createdAccounts = await prisma.account.findMany({
        where: { userId, fbPageId: { in: toCreate.map((r) => r.pageId) } },
        select: { id: true, fbPageAccessToken: true, fbPageId: true, fbApiVersion: true },
      });
      const ADD_CHUNK = 100;
      for (let off = 0; off < createdAccounts.length; off += ADD_CHUNK) {
        const wave = createdAccounts.slice(off, off + ADD_CHUNK);
        await validateQueue.addBulk(
          wave.map((acc) => ({
            name: `validate:${acc.id}`,
            data: {
              accountId: acc.id,
              encryptedToken: acc.fbPageAccessToken,
              fbPageId: acc.fbPageId,
              fbApiVersion: acc.fbApiVersion,
            },
            opts: { attempts: 1 },
          }))
        );
      }
    } catch (validateErr) {
      console.warn(
        `[accounts:bulk-csv] background validation could not be queued: ${validateErr}`
      );
    }

    return NextResponse.json({
      success: true,
      created: created.count,
      skippedDuplicates,
      skippedAlreadyConnected,
      message: `Connected ${created.count} account(s)` +
        (skippedAlreadyConnected > 0 ? `, ${skippedAlreadyConnected} already connected (skipped)` : "") +
        (skippedDuplicates > 0 ? `, ${skippedDuplicates} duplicate row(s) in file (skipped)` : "") +
        ".",
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[accounts:bulk-csv]", err);
    const message =
      process.env.NODE_ENV === "development" && err instanceof Error
        ? err.message
        : "Could not import this CSV. Please check the format and try again.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
