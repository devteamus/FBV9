/**
 * GET /api/upload/template?format=csv|xlsx — downloadable demo file.
 *
 * Gives users a ready-to-edit sheet with the exact columns the uploader
 * expects (caption, media_url, post_type, comment_1 + delay, comment_2 + delay).
 * Works for Google Sheets (import the CSV/XLSX) and Excel.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession, AuthError } from "@/lib/auth";
import { buildTemplateCsv, buildTemplateXlsx } from "@/lib/post-sheet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await getSession();
    const format = (request.nextUrl.searchParams.get("format") || "csv").toLowerCase();

    if (format === "xlsx") {
      const buf = await buildTemplateXlsx();
      return new NextResponse(new Uint8Array(buf), {
        status: 200,
        headers: {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": 'attachment; filename="fb-poster-demo.xlsx"',
          "Cache-Control": "no-store",
        },
      });
    }
    if (format !== "csv") {
      return NextResponse.json({ error: "format must be csv or xlsx" }, { status: 400 });
    }
    return new NextResponse(new Uint8Array(buildTemplateCsv()), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="fb-poster-demo.csv"',
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[upload/template]", err);
    return NextResponse.json({ error: "Could not build the template." }, { status: 500 });
  }
}
