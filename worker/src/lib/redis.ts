import { Redis } from "ioredis";

let redisSingleton: Redis | undefined;

export function getRedis(): Redis {
  if (!redisSingleton) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error("REDIS_URL environment variable is not set");
    redisSingleton = new Redis(url, {
      maxRetriesPerRequest: null, // required by BullMQ
    });
    // v2.3 — attach an error listener to the base singleton. Without
    // one, ioredis logs "[ioredis] Unhandled error event" on every
    // reconnect attempt while Redis is down (log noise at best); with
    // stricter runtimes an emitted 'error' with no listener can become
    // a hard throw. The BullMQ Workers/Queues each duplicate() their
    // own connection and already handle their errors — this covers the
    // shared base connection only.
    redisSingleton.on("error", (err) => {
      console.warn(`[redis] connection error: ${err.message}`);
    });
  }
  return redisSingleton;
}
