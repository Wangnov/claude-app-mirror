import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  NonRetryableMirrorError,
  buildObjectPlan,
  cleanupStageObjects,
  commitObjectToAliases,
  commitOrder,
  decoratePlanWithStage,
  deriveReleaseTag,
  handleApiRequest,
  pruneAbandonedStageObjects,
  reconcileSync,
  uploadObjectToStage,
} from "../src/core.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("buildObjectPlan derives claude-app release tag and plans all 7 R2 objects", () => {
  const manifest = fixtureManifest();
  const tag = deriveReleaseTag(manifest);
  const plan = buildObjectPlan(manifest, tag);

  assert.equal(tag, "claude-app-v5.11492.5");
  assert.deepEqual(
    plan.items.map((item) => ({
      id: item.id,
      sourceKey: item.sourceKey,
      aliasKeys: item.aliasKeys,
      filename: item.filename,
      contentType: item.contentType,
      role: item.role,
    })),
    [
      {
        id: "mac",
        sourceKey: "latest/mac",
        aliasKeys: ["latest/mac"],
        filename: "Claude-mac-universal.dmg",
        contentType: "application/x-apple-diskimage",
        role: "installer",
      },
      {
        id: "win-x64",
        sourceKey: "latest/win-x64",
        aliasKeys: ["latest/win-x64"],
        filename: "Claude-win-x64.msix",
        contentType: "application/vnd.ms-appx",
        role: "installer",
      },
      {
        id: "win-arm64",
        sourceKey: "latest/win-arm64",
        aliasKeys: ["latest/win-arm64"],
        filename: "Claude-win-arm64.msix",
        contentType: "application/vnd.ms-appx",
        role: "installer",
      },
      {
        id: "linux-x64",
        sourceKey: "latest/linux-x64",
        aliasKeys: ["latest/linux-x64"],
        filename: "Claude-linux-x64.deb",
        contentType: "application/octet-stream",
        role: "installer",
      },
      {
        id: "linux-arm64",
        sourceKey: "latest/linux-arm64",
        aliasKeys: ["latest/linux-arm64"],
        filename: "Claude-linux-arm64.deb",
        contentType: "application/octet-stream",
        role: "installer",
      },
      {
        id: "checksums",
        sourceKey: "latest/checksums",
        aliasKeys: ["latest/checksums"],
        filename: "SHA256SUMS.txt",
        contentType: "text/plain; charset=utf-8",
        role: "checksums",
      },
      {
        id: "manifest",
        sourceKey: "latest/manifest",
        aliasKeys: ["latest/manifest"],
        filename: "release-manifest.json",
        contentType: "application/json",
        role: "manifest",
      },
    ],
  );
});

test("deriveReleaseTag and buildObjectPlan reject missing manifest fields", () => {
  assert.equal(deriveReleaseTag({}), "");

  const incomplete = fixtureManifest();
  delete incomplete.sources.linux.arm64;
  assert.throws(
    () => buildObjectPlan(incomplete, "claude-app-v5.11492.5"),
    (error) => error instanceof NonRetryableMirrorError && /sources\.linux\.arm64/.test(error.message),
  );
});

test("commitOrder advances checksums and manifest only after all installers", () => {
  const plan = buildObjectPlan(fixtureManifest(), "claude-app-v5.11492.5");
  const ordered = commitOrder(plan.items).map((item) => item.role);

  assert.equal(ordered.at(-1), "manifest");
  assert.equal(ordered.at(-2), "checksums");
  assert.deepEqual(ordered.slice(0, 5), [
    "installer",
    "installer",
    "installer",
    "installer",
    "installer",
  ]);
});

test("uploads a ranged multipart object to staging, commits its alias, and cleans up staging", async () => {
  const manifest = fixtureManifest();
  const tag = deriveReleaseTag(manifest);
  const r2Objects = fixtureR2Objects(manifest, {
    "latest/win-x64": "0123456789abcdefghijklmnopqrstuvwxyz",
  });
  const s3 = createMockS3();
  globalThis.fetch = s3.fetch;

  const env = fixtureEnv(r2Objects);
  const plan = decoratePlanWithStage(buildObjectPlan(manifest, tag), "instance-1", {
    SECONDARY_SYNC_STAGE_PREFIX: "staging/test",
  });
  const item = plan.items.find((entry) => entry.id === "win-x64");

  const upload = await uploadObjectToStage(env, item, {
    forceUpload: true,
    singlePutMaxBytes: 8,
    partSizeBytes: 8,
    minPartSizeBytes: 1,
  });
  assert.equal(upload.uploaded, true);

  const commit = await commitObjectToAliases(env, item);
  assert.deepEqual(commit.aliases, [{ key: "latest/win-x64", size: 36 }]);
  assert.equal(text(s3.objects.get("latest/win-x64").bytes), "0123456789abcdefghijklmnopqrstuvwxyz");

  await cleanupStageObjects(env, [item]);
  assert.equal(s3.objects.has(item.stageKey), false);
});

test("restores the published alias when the commit copy fails", async () => {
  const stageKey = "staging/test/instance-1/objects/mac";
  const s3 = createMockS3({ failCopyFrom: (sourceKey) => sourceKey === stageKey });
  s3.objects.set(stageKey, objectEntry("next-release"));
  s3.objects.set("latest/mac", objectEntry("published-release"));
  globalThis.fetch = s3.fetch;

  const item = { id: "mac", stageKey, aliasKeys: ["latest/mac"] };

  await assert.rejects(() => commitObjectToAliases(fixtureEnv(new Map()), item));

  assert.equal(text(s3.objects.get("latest/mac").bytes), "published-release");
  assert.equal(s3.objects.has("latest/mac.rollback"), false);
});

test("commits the alias and clears its rollback backup on success", async () => {
  const stageKey = "staging/test/instance-1/objects/linux-x64";
  const s3 = createMockS3();
  s3.objects.set(stageKey, objectEntry("next-release"));
  s3.objects.set("latest/linux-x64", objectEntry("published-release"));
  globalThis.fetch = s3.fetch;

  const item = { id: "linux-x64", stageKey, aliasKeys: ["latest/linux-x64"] };
  const commit = await commitObjectToAliases(fixtureEnv(new Map()), item);

  assert.deepEqual(commit.aliases, [{ key: "latest/linux-x64", size: 12 }]);
  assert.equal(text(s3.objects.get("latest/linux-x64").bytes), "next-release");
  assert.equal(s3.objects.has("latest/linux-x64.rollback"), false);
});

test("treats server-completed COPY that returned transient 502 as succeeded without hitting IHEP overwrite error", async () => {
  const stageKey = "staging/test/instance-1/objects/linux-x64";
  let stageCopyCalls = 0;
  const s3 = createMockS3({
    onCopy(sourceKey, destinationKey, store) {
      if (sourceKey === stageKey && destinationKey === "latest/linux-x64") {
        stageCopyCalls += 1;
        if (stageCopyCalls === 1) {
          store.set(destinationKey, objectEntry("next-release"));
          return new Response("Bad Gateway", { status: 502 });
        }
        if (store.has(destinationKey)) {
          return new Response("<Error><Code>InternalError</Code></Error>", { status: 502 });
        }
      }
      return null;
    },
  });
  s3.objects.set(stageKey, objectEntry("next-release"));
  s3.objects.set("latest/linux-x64", objectEntry("published-release"));
  globalThis.fetch = s3.fetch;

  const item = { id: "linux-x64", stageKey, aliasKeys: ["latest/linux-x64"] };
  const commit = await commitObjectToAliases(fixtureEnv(new Map()), item);

  assert.deepEqual(commit.aliases, [{ key: "latest/linux-x64", size: 12 }]);
  assert.equal(stageCopyCalls, 1);
  assert.equal(text(s3.objects.get("latest/linux-x64").bytes), "next-release");
  assert.equal(s3.objects.has("latest/linux-x64.rollback"), false);
});

test("prunes abandoned staging objects and multipart uploads without touching active work", async () => {
  const s3 = createMockS3();
  const old = new Date("2020-01-01T00:00:00Z");
  const recent = new Date(Date.now() + 60_000);
  const activePrefix = "staging/secondary-sync/claude-app-v5.11492.5/active";
  s3.objects.set("staging/secondary-sync/old/objects/mac", objectEntry("old", old));
  s3.objects.set("staging/secondary-sync/recent/objects/mac", objectEntry("recent", recent));
  s3.objects.set(`${activePrefix}/objects/mac`, objectEntry("active", old));
  s3.objects.set("latest/mac", objectEntry("published", old));
  s3.uploads.set("upload-old", {
    key: "staging/secondary-sync/old/objects/partial",
    parts: new Map(),
    initiated: old,
  });
  s3.uploads.set("upload-active", {
    key: `${activePrefix}/objects/partial`,
    parts: new Map(),
    initiated: old,
  });
  globalThis.fetch = s3.fetch;

  const result = await pruneAbandonedStageObjects(fixtureEnv(new Map()), activePrefix, {
    graceHours: 1,
  });

  assert.deepEqual(result.deleted, ["staging/secondary-sync/old/objects/mac"]);
  assert.deepEqual(result.aborted, [
    {
      key: "staging/secondary-sync/old/objects/partial",
      uploadId: "upload-old",
    },
  ]);
  assert.equal(s3.objects.has("staging/secondary-sync/recent/objects/mac"), true);
  assert.equal(s3.objects.has(`${activePrefix}/objects/mac`), true);
  assert.equal(s3.objects.has("latest/mac"), true);
  assert.equal(s3.uploads.has("upload-old"), false);
  assert.equal(s3.uploads.has("upload-active"), true);
});

test("falls back to ListObjectsV2 when HEAD returns 403 or zero bytes for non-empty object", async () => {
  const s3 = createMockS3();
  globalThis.fetch = s3.fetch;
  const env = fixtureEnv(
    new Map([
      ["latest/linux-arm64", bytes("deb-body")],
      ["latest/checksums", bytes("checksum-body")],
    ]),
  );

  const upload403 = await uploadObjectToStage(
    env,
    {
      id: "linux-arm64",
      sourceKey: "latest/linux-arm64",
      stageKey: "staging/test/head-403-linux-arm64",
      filename: "Claude-linux-arm64.deb",
      contentType: "application/octet-stream",
      cacheControl: "public, max-age=600",
      required: true,
    },
    { forceUpload: true, singlePutMaxBytes: 32 },
  );
  assert.equal(upload403.uploaded, true);
  assert.equal(s3.objects.get("staging/test/head-403-linux-arm64").bytes.byteLength, 8);

  const uploadZero = await uploadObjectToStage(
    env,
    {
      id: "checksums",
      sourceKey: "latest/checksums",
      stageKey: "staging/test/head-zero-checksums",
      filename: "SHA256SUMS.txt",
      contentType: "text/plain; charset=utf-8",
      cacheControl: "public, max-age=600",
      required: true,
    },
    { forceUpload: true, singlePutMaxBytes: 32 },
  );
  assert.equal(uploadZero.uploaded, true);
  assert.equal(s3.objects.get("staging/test/head-zero-checksums").bytes.byteLength, 13);
});

test("handleApiRequest enforces auth, exposes /health and /sync/plan, and reconciles manifest", async () => {
  const manifest = fixtureManifest();
  const manifestText = JSON.stringify(manifest);
  const r2Objects = fixtureR2Objects(manifest);
  const s3 = createMockS3();
  globalThis.fetch = s3.fetch;

  const createdWorkflows = [];
  const env = {
    ...fixtureEnv(r2Objects),
    SYNC_AUTH_TOKEN: "top-secret-token",
    SECONDARY_MIRROR_WORKFLOW: {
      async create(opts) {
        createdWorkflows.push(opts);
        return {
          id: opts.id,
          async status() {
            return { status: "running" };
          },
        };
      },
      async get() {
        return null;
      },
    },
  };

  const healthRes = await handleApiRequest(new Request("https://sync.example.test/health"), env);
  assert.equal(healthRes.status, 200);
  assert.deepEqual(await healthRes.json(), {
    ok: true,
    service: "claude-app-mirror-secondary-sync",
  });

  await assert.rejects(
    () => handleApiRequest(new Request("https://sync.example.test/sync/plan"), env),
    /Unauthorized/,
  );

  const planRes = await handleApiRequest(
    new Request("https://sync.example.test/sync/plan", {
      headers: { Authorization: "Bearer top-secret-token" },
    }),
    env,
  );
  assert.equal(planRes.status, 200);
  const planBody = await planRes.json();
  assert.equal(planBody.releaseTag, "claude-app-v5.11492.5");
  assert.equal(planBody.items.length, 7);

  // When secondary S3 already has matching latest/manifest, reconcile skips.
  s3.objects.set("latest/manifest", objectEntry(manifestText));
  const skipRes = await handleApiRequest(
    new Request("https://sync.example.test/sync/reconcile", {
      method: "POST",
      headers: { Authorization: "Bearer top-secret-token" },
    }),
    env,
  );
  assert.equal(skipRes.status, 200);
  const skipBody = await skipRes.json();
  assert.equal(skipBody.skipped, true);
  assert.equal(createdWorkflows.length, 0);

  // When secondary S3 manifest differs or is absent, reconcile starts workflow.
  s3.objects.delete("latest/manifest");
  const startRes = await handleApiRequest(
    new Request("https://sync.example.test/sync/reconcile", {
      method: "POST",
      headers: { Authorization: "Bearer top-secret-token" },
    }),
    env,
  );
  assert.equal(startRes.status, 200);
  const startBody = await startRes.json();
  assert.equal(startBody.created, true);
  assert.equal(startBody.releaseTag, "claude-app-v5.11492.5");
  assert.equal(createdWorkflows.length, 1);
});

test("retries transient S3 5xx and network errors per multipart part and deduplicates reconcileSync", async () => {
  const manifest = fixtureManifest();
  const tag = deriveReleaseTag(manifest);
  const payload = "0123456789abcdefghijklmnopqrstuvwxyz";
  const r2Objects = fixtureR2Objects(manifest, {
    "latest/win-x64": payload,
  });
  let part2Failures = 0;
  let abortedCount = 0;
  const s3 = createMockS3({
    onUploadPart(partNumber) {
      if (partNumber === 2 && part2Failures < 2) {
        part2Failures += 1;
        if (part2Failures === 1) {
          return new Response("<Error><Code>InternalError</Code></Error>", { status: 500 });
        }
        throw new TypeError("fetch failed");
      }
      return null;
    },
    onAbortMultipart() {
      abortedCount += 1;
    },
  });
  globalThis.fetch = s3.fetch;

  const instances = new Map();
  let createCalls = 0;
  const env = {
    ...fixtureEnv(r2Objects),
    SECONDARY_MIRROR_WORKFLOW: {
      async create(opts) {
        createCalls += 1;
        const inst = {
          id: opts.id,
          currentState: "running",
          async status() {
            return { status: this.currentState };
          },
          async restart() {
            this.currentState = "running";
          },
        };
        instances.set(opts.id, inst);
        return inst;
      },
      async get(id) {
        const found = instances.get(id);
        if (!found) throw new Error("not found");
        return found;
      },
    },
  };

  const plan = decoratePlanWithStage(buildObjectPlan(manifest, tag), "instance-retry", {
    SECONDARY_SYNC_STAGE_PREFIX: "staging/test",
  });
  const item = plan.items.find((entry) => entry.id === "win-x64");
  const upload = await uploadObjectToStage(env, item, {
    forceUpload: true,
    singlePutMaxBytes: 8,
    partSizeBytes: 8,
    minPartSizeBytes: 1,
  });
  assert.equal(upload.uploaded, true);
  assert.equal(part2Failures, 2);
  assert.equal(abortedCount, 0);
  assert.equal(text(s3.objects.get(item.stageKey).bytes), payload);

  const r1 = await reconcileSync(env, {});
  const r2 = await reconcileSync(env, {});
  assert.equal(r1.created, true);
  assert.equal(r2.reused, true);
  assert.equal(r2.id, r1.id);
  assert.equal(createCalls, 1);
});

function fixtureManifest() {
  return {
    schemaVersion: 2,
    generatedAt: "2026-11-14T00:08:04Z",
    updateApiBase: "https://api.anthropic.com",
    version: "5.11492.5",
    sources: {
      macos: {
        universal: {
          version: "5.11492.5",
          assetName: "Claude-mac-universal.dmg",
        },
      },
      windows: {
        x64: {
          version: "5.11492.5",
          assetName: "Claude-win-x64.msix",
        },
        arm64: {
          version: "5.11492.5",
          assetName: "Claude-win-arm64.msix",
        },
      },
      linux: {
        x64: {
          version: "5.11492.5",
          assetName: "Claude-linux-x64.deb",
        },
        arm64: {
          version: "5.11492.5",
          assetName: "Claude-linux-arm64.deb",
        },
      },
    },
  };
}

function fixtureR2Objects(manifest, overrides = {}) {
  return new Map(
    Object.entries({
      "latest/mac": "mac-dmg",
      "latest/win-x64": "win-x64",
      "latest/win-arm64": "win-arm64",
      "latest/linux-x64": "linux-x64",
      "latest/linux-arm64": "linux-arm64",
      "latest/checksums": "checksums",
      "latest/manifest": JSON.stringify(manifest),
      ...overrides,
    }).map(([key, value]) => [key, bytes(value)]),
  );
}

function fixtureEnv(r2Objects) {
  return {
    GLOBAL_R2: new MockR2Bucket(r2Objects),
    SECONDARY_S3_ENDPOINT: "https://s3.example.test",
    SECONDARY_S3_BUCKET: "bucket",
    SECONDARY_S3_REGION: "auto",
    SECONDARY_S3_ACCESS_KEY_ID: "key",
    SECONDARY_S3_SECRET_ACCESS_KEY: "secret",
    SECONDARY_S3_RETRY_BASE_DELAY_MS: "0",
  };
}

class MockR2Bucket {
  constructor(objects) {
    this.objects = objects;
  }

  async head(key) {
    const value = this.objects.get(key);
    return value ? { size: value.byteLength } : null;
  }

  async get(key, options = {}) {
    const value = this.objects.get(key);
    if (!value) {
      return null;
    }
    const range = options.range;
    const sliced = range ? value.slice(range.offset, range.offset + range.length) : value;
    return {
      size: sliced.byteLength,
      async arrayBuffer() {
        return sliced.slice(0);
      },
      async text() {
        return text(sliced);
      },
    };
  }
}

function createMockS3(options = {}) {
  const objects = new Map();
  const uploads = new Map();
  let uploadCounter = 0;
  const failCopyFrom = options.failCopyFrom || (() => false);
  const onCopy = options.onCopy || (() => null);
  const onUploadPart = options.onUploadPart || (() => null);
  const onAbortMultipart = options.onAbortMultipart || (() => {});

  async function fetch(input, init = {}) {
    const url = new URL(input);
    const { key } = parseS3Path(url.pathname);
    const method = init.method || "GET";
    const headers = new Headers(init.headers || {});

    if (method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") || "";
      const contents = [...objects.entries()]
        .filter(([objectKey]) => objectKey.startsWith(prefix))
        .map(
          ([objectKey, entry]) =>
            `<Contents><Key>${xmlEscape(objectKey)}</Key><LastModified>${entry.lastModified.toISOString()}</LastModified><Size>${entry.bytes.byteLength}</Size></Contents>`,
        )
        .join("");
      return new Response(`<ListBucketResult>${contents}</ListBucketResult>`, { status: 200 });
    }

    if (method === "GET" && url.searchParams.has("uploads")) {
      const prefix = url.searchParams.get("prefix") || "";
      const entries = [...uploads.entries()]
        .filter(([, upload]) => upload.key.startsWith(prefix))
        .map(
          ([uploadId, upload]) =>
            `<Upload><Key>${xmlEscape(upload.key)}</Key><UploadId>${xmlEscape(uploadId)}</UploadId><Initiated>${upload.initiated.toISOString()}</Initiated></Upload>`,
        )
        .join("");
      return new Response(`<ListMultipartUploadsResult>${entries}</ListMultipartUploadsResult>`, {
        status: 200,
      });
    }

    if (method === "HEAD") {
      if (key.includes("head-403")) {
        return new Response("forbidden", { status: 403 });
      }
      const entry = objects.get(key);
      if (!entry) {
        return new Response(null, { status: 404 });
      }
      return new Response(null, {
        status: 200,
        headers: {
          "content-length": key.includes("head-zero") ? "0" : String(entry.bytes.byteLength),
          "last-modified": entry.lastModified.toUTCString(),
          etag: entry.etag,
        },
      });
    }

    if (method === "GET") {
      const entry = objects.get(key);
      if (!entry) {
        return new Response("missing", { status: 404 });
      }
      return new Response(entry.bytes, {
        status: 200,
        headers: { "content-length": String(entry.bytes.byteLength) },
      });
    }

    if (method === "POST" && url.searchParams.has("uploads")) {
      const uploadId = `upload-${++uploadCounter}`;
      uploads.set(uploadId, { key, parts: new Map(), initiated: new Date() });
      return new Response(`<InitiateMultipartUploadResult><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`);
    }

    if (method === "PUT" && url.searchParams.has("partNumber")) {
      const partNumber = Number(url.searchParams.get("partNumber"));
      const injected = onUploadPart(partNumber);
      if (injected) {
        return injected;
      }
      const uploadId = url.searchParams.get("uploadId");
      const upload = uploads.get(uploadId);
      upload.parts.set(partNumber, await bodyBytes(init.body));
      return new Response(null, { status: 200, headers: { etag: `"part-${upload.parts.size}"` } });
    }

    if (method === "POST" && url.searchParams.has("uploadId")) {
      const upload = uploads.get(url.searchParams.get("uploadId"));
      const joined = concatBytes([...upload.parts.entries()].sort(([a], [b]) => a - b).map(([, value]) => value));
      objects.set(upload.key, objectEntry(joined));
      uploads.delete(url.searchParams.get("uploadId"));
      return new Response("<CompleteMultipartUploadResult />");
    }

    if (method === "DELETE" && url.searchParams.has("uploadId")) {
      onAbortMultipart(url.searchParams.get("uploadId"));
      uploads.delete(url.searchParams.get("uploadId"));
      return new Response(null, { status: 204 });
    }

    if (method === "PUT" && headers.has("x-amz-copy-source")) {
      const sourceKey = parseCopySource(headers.get("x-amz-copy-source"));
      const injectedCopy = onCopy(sourceKey, key, objects);
      if (injectedCopy) {
        return injectedCopy;
      }
      if (failCopyFrom(sourceKey)) {
        return new Response("<Error><Code>InternalError</Code></Error>", { status: 500 });
      }
      const source = objects.get(sourceKey);
      if (!source) {
        return new Response("missing copy source", { status: 404 });
      }
      objects.set(key, objectEntry(source.bytes.slice(0)));
      return new Response("<CopyObjectResult />");
    }

    if (method === "PUT") {
      objects.set(key, objectEntry(await bodyBytes(init.body)));
      return new Response(null, { status: 200 });
    }

    if (method === "DELETE") {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }

    return new Response(`unexpected ${method} ${url}`, { status: 500 });
  }

  return { fetch, objects, uploads };
}

function parseS3Path(pathname) {
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  return {
    bucket: parts[0],
    key: parts.slice(1).join("/"),
  };
}

function parseCopySource(value) {
  const parts = value.split("/").filter(Boolean).map(decodeURIComponent);
  return parts.slice(1).join("/");
}

async function bodyBytes(body) {
  if (!body) {
    return new Uint8Array();
  }
  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body);
  }
  if (body instanceof Uint8Array) {
    return body;
  }
  if (typeof body === "string") {
    return bytes(body);
  }
  return new Uint8Array(await new Response(body).arrayBuffer());
}

function objectEntry(value, lastModified = new Date()) {
  const valueBytes = value instanceof Uint8Array ? value : bytes(value);
  return {
    bytes: valueBytes,
    lastModified,
    etag: `"${valueBytes.byteLength}"`,
  };
}

function bytes(value) {
  if (value instanceof Uint8Array) {
    return value;
  }
  return encoder.encode(String(value));
}

function text(value) {
  return decoder.decode(value);
}

function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
