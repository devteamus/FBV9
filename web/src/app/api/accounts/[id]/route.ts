/**
 * GET    /api/accounts/[id] — get single account (NO token in response, §7B)
 * PUT    /api/accounts/[id] — update account (re-encrypts token if provided)
 * DELETE /api/accounts/[id] — delete account (cascades to jobs+posts)
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  getSession,
  AuthError,
  ValidationError,
} from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { encrypt } from "@/lib/encryption";
import { requireAccount, serializeAccount } from "@/lib/ownership";

const updateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  fb_page_access_token: z.string().trim().min(1).max(500).optional(),
  fb_page_id: z.string().trim().min(1).max(50).optional(),
  fb_api_version: z.string().trim().max(10).optional(),
  is_active: z.boolean().optional(),
});

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { sub: userId } = await getSession();
    const { id } = await params;
    const account = await requireAccount(userId, id);
    return NextResponse.json(serializeAccount(account));
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { sub: userId } = await getSession();
    const { id } = await params;

    // Ownership check
    await requireAccount(userId, id);

    const body = await request.json();
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors[0].message);
    }

    const data: Record<string, unknown> = {};
    if (parsed.data.name !== undefined) data.name = parsed.data.name;
    if (parsed.data.fb_page_id !== undefined) data.fbPageId = parsed.data.fb_page_id;
    if (parsed.data.fb_api_version !== undefined) data.fbApiVersion = parsed.data.fb_api_version;
    if (parsed.data.is_active !== undefined) data.isActive = parsed.data.is_active;

    // If token is being updated, encrypt it (§7B)
    if (parsed.data.fb_page_access_token !== undefined) {
      data.fbPageAccessToken = await encrypt(parsed.data.fb_page_access_token);
    }

    // NEVER allow setting userId or id from client input
    const updated = await prisma.account.update({
      where: { id },
      data,
      select: {
        id: true,
        name: true,
        fbPageId: true,
        fbApiVersion: true,
        isActive: true,
        createdAt: true,
        _count: { select: { jobs: true } },
      },
    });

    return NextResponse.json({
      success: true,
      account: serializeAccount(updated),
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[accounts:update]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { sub: userId } = await getSession();
    const { id } = await params;

    // Ownership check
    await requireAccount(userId, id);

    // Delete cascades to jobs → posts (Prisma schema)
    await prisma.account.delete({ where: { id } });

    return NextResponse.json({ success: true });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}