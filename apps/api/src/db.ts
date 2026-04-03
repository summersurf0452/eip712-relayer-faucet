import { PrismaClient } from "@prisma/client";

// 싱글톤. 앱 전체에서 하나의 connection pool을 공유한다.
export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === "development" ? ["query", "warn", "error"] : ["warn", "error"],
});
