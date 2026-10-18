/**
 * Singleton Prisma client — safe to import from multiple files.
 * In development, Next.js hot-reloads and would otherwise create
 * multiple client instances that exhaust the connection pool.
 */
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
