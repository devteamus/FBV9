/**
 * GET  /api/accounts — list user's accounts
 * POST /api/accounts — create new account
 *
 * Token is encrypted before storing (§7B).
 * Token is NEVER returned in any response (§7B, §8 checklist).
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession, AuthError, ValidationError } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { encrypt } from "@/lib/encryption";
import { serializeAccount } from "@/lib/ownership";
import { getRedis } from "@/lib/redis";
import { getValidateQueue } from "@/lib/queues/helpers";

const createAccountSchema = z.object({
  name: z.string().trim().min(1).max(100),
  fb_page_access_token: z.string().trim().min(1).max(500),
  fb_page_id: z.string().trim().min(1).max(50),
  fb_api_version: z.string().trim().max(10).default("v20.0"),
});

export async function GET() {
  try {
    const { sub: userId } = await getSession();
    const accounts = await prisma.account.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
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
    return NextResponse.json(accounts.map(serializeAccount));
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[accounts:list]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { sub: userId } = await getSession();

    // Cap: max 100 accounts per user (v1 behavior)
    const count = await prisma.account.count({ where: { userId } });
    if (count >= 100) {
      throw new ValidationError("Maximum 100 accounts reached");
    }

    const body = await request.json();
    const parsed = createAccountSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors[0].message);
    }

    const { name, fb_page_access_token, fb_page_id, fb_api_version } = parsed.data;

    // Encrypt token before storing (§7B)
    // If ENCRYPTION_KEY is missing or invalid, return a meaningful error
    // to the client instead of a generic "Internal server error".
    let encryptedToken: string;
    try {
      encryptedToken = await encrypt(fb_page_access_token);
    } catch (encErr) {
      console.error("[accounts:create] encryption failed:", encErr);
      return NextResponse.json(
        {
          error:
            "Failed to encrypt token. Please check that ENCRYPTION_KEY is set in the server environment.",
        },
        { status: 500 }
      );
    }

    const account = await prisma.account.create({
      data: {
        userId,
        name,
        fbPageAccessToken: encryptedToken,
        fbPageId: fb_page_id,
        fbApiVersion: fb_api_version,
      },
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

    // Fire-and-forget validation so the worker fetches + persists the page
    // profile picture (and confirms the token works). We deliberately do
    // NOT wait for the result — account creation must not fail or slow
    // down because of it. Failures surface later on the Accounts page
    // validate button / overview avatar fallback.
    try {
      const redis = getRedis();
      const validateQueue = getValidateQueue(redis);
      await validateQueue.add(
        `validate:${account.id}`,
        {
          accountId: account.id,
          encryptedToken,
          fbPageId: fb_page_id,
          fbApiVersion: fb_api_version,
        },
        { attempts: 1 }
      );
    } catch (validateErr) {
      // Non-fatal — the picture simply stays null until the user clicks
      // Validate on the Accounts page.
      console.warn(
        `[accounts:create] background validation could not be queued: ${validateErr}`
      );
    }

    return NextResponse.json(
      { success: true, account: serializeAccount(account) },
      { status: 201 }
    );
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[accounts:create]", err);
    // Include the actual error message in dev for easier debugging
    const message = process.env.NODE_ENV === "development" && err instanceof Error
      ? err.message
      : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
