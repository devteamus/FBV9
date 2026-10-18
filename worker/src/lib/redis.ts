import { Redis } from "ioredis";

let redisSingleton: Redis | undefined;

export function getRedis(): Redis {
  if (!redisSingleton) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error("REDIS_URL environment variable is not set");
    redisSingleton = new Redis(url, {
      maxRetriesPerRequest: null, // required by BullMQ
    });
  }
  return redisSingleton;
}
