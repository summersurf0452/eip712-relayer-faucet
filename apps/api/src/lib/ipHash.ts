// raw IP를 저장하지 않고 HMAC hash로 저장한다.
// 동일성 비교는 가능하지만 원문 복원이 어렵다.

import { createHmac } from "crypto";
import { env } from "../env.js";

export function hashIp(ip: string): string {
  return createHmac("sha256", env.IP_HMAC_SECRET).update(ip).digest("hex");
}
