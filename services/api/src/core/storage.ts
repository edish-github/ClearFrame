import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { env } from "./env.js";

export interface StoredObject { key: string; size: number; sha256: string; }

interface Driver {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
}

const localDriver: Driver = {
  async put(key, body) {
    const path = resolve(join(env.storage.localDir, key));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  },
  async get(key) {
    return readFile(resolve(join(env.storage.localDir, key)));
  },
};

let gcs: Driver | null = null;
async function gcsDriver(): Promise<Driver> {
  if (gcs) return gcs;
  const { Storage } = await import("@google-cloud/storage");
  const bucket = new Storage().bucket(env.storage.gcsBucket);
  gcs = {
    async put(key, body, contentType) {
      await bucket.file(key).save(body, { contentType, resumable: false });
    },
    async get(key) {
      const [buf] = await bucket.file(key).download();
      return buf;
    },
  };
  return gcs;
}

async function driver(): Promise<Driver> {
  return env.storage.driver === "gcs" ? gcsDriver() : localDriver;
}

export async function putObject(
  prefix: string,
  body: Buffer,
  contentType: string,
  filename?: string
): Promise<StoredObject> {
  const sha256 = createHash("sha256").update(body).digest("hex");
  const safe = (filename ?? "object").replace(/[^A-Za-z0-9._-]/g, "_").slice(-80);
  const key = `${prefix}/${randomUUID()}-${safe}`;
  await (await driver()).put(key, body, contentType);
  return { key, size: body.length, sha256 };
}

export async function getObject(key: string): Promise<Buffer> {
  return (await driver()).get(key);
}

export const sha256Hex = (input: string | Buffer): string =>
  createHash("sha256").update(input).digest("hex");
