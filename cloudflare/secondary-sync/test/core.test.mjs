import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  NonRetryableMirrorError,
  SupersededMirrorError,
  aliasBackupKeys,
  buildObjectPlan,
  cleanupRollbackBackups,
  cleanupStageObjects,
  commitObjectToAliases,
  commitOrder,
  commitSingleAlias,
  createIncrementalSha256,
  decoratePlanWithStage,
  deriveReleaseTag,
  discoverSourceManifest,
  handleApiRequest,
  isSupersededError,
  pruneAbandonedStageObjects,
  reconcileSync,
  recordSwitchoverCommittedCheckpoint,
  rollbackCommittedAliases,
  startSync,
  uploadObjectToStage,
  verifyPriorSwitchoverCheckpoint,
  verifySourceManifestCurrent,
  workflowInstanceId,
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

  // When secondary S3 has matching latest/manifest AND all referenced aliases, reconcile skips.
  for (const [key, val] of r2Objects.entries()) {
    s3.objects.set(key, objectEntry(val, new Date(), { syncSha256: contentHashHex(val) }));
  }
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

  // When latest/manifest matches but a referenced installer alias is missing, reconcile heals!
  s3.objects.delete("latest/win-x64");
  const healRes = await handleApiRequest(
    new Request("https://sync.example.test/sync/reconcile", {
      method: "POST",
      headers: { Authorization: "Bearer top-secret-token" },
    }),
    env,
  );
  assert.equal(healRes.status, 200);
  const healBody = await healRes.json();
  assert.equal(healBody.created, true);
  assert.equal(createdWorkflows.length, 1);

  // Clear active pointer and delete latest/manifest -> reconcile starts workflow cleanly.
  s3.objects.delete("staging/secondary-sync/active-sync.json");
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
  assert.equal(createdWorkflows.length, 2);
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
  const r2 = await reconcileSync(env, { releaseTag: "claude-app-force-custom" });
  assert.equal(r1.created, true);
  assert.equal(r2.reused, true);
  assert.equal(r2.id, r1.id);
  assert.equal(createCalls, 1);
});

test("rejects 200 XML <Error>, same-size wrong-content COPY, cross-version R2 splicing, and supports SECONDARY_S3_PREFIX + group rollback", async () => {
  const manifest = fixtureManifest();
  const manifestText = JSON.stringify(manifest);
  const sha = createIncrementalSha256();
  sha.update(bytes(manifestText));
  const manifestSha = sha.digestHex();

  // 1. SECONDARY_S3_PREFIX maps aliases consistently with download-router.
  const prefixedPlan = buildObjectPlan(manifest, deriveReleaseTag(manifest), {
    manifestText,
    manifestSha256: manifestSha,
    secondaryPrefix: "edge",
  });
  assert.deepEqual(prefixedPlan.items[0].aliasKeys, ["edge/latest/mac"]);
  assert.deepEqual(prefixedPlan.items.at(-1).aliasKeys, ["edge/latest/manifest"]);

  // 2. Backup COPY 200 + <Error> preserves published alias; same-size wrong-content COPY recovery is rejected.
  let mode = "backup-200-err";
  const s3 = createMockS3({
    onCopy(sourceKey, destinationKey, store) {
      if (mode === "backup-200-err" && destinationKey === "latest/mac.rollback") {
        return new Response("<Error><Code>InternalError</Code><Message>err</Message></Error>", { status: 200 });
      }
      if (mode === "same-len-wrong" && sourceKey === "stage/mac" && destinationKey === "latest/mac") {
        store.set(destinationKey, objectEntry("BBBB", new Date(), { syncSha256: "b".repeat(64) }));
        return new Response("Bad Gateway", { status: 502 });
      }
      return null;
    },
  });
  globalThis.fetch = s3.fetch;
  s3.objects.set("stage/mac", objectEntry("AAAA", new Date(), { syncSha256: "a".repeat(64) }));
  s3.objects.set("latest/mac", objectEntry("ORIG", new Date(), { syncSha256: "0".repeat(64) }));

  const env = { ...fixtureEnv(fixtureR2Objects(manifest)), SECONDARY_S3_MAX_ATTEMPTS: "2" };
  await assert.rejects(
    () => commitObjectToAliases(env, { id: "mac", stageKey: "stage/mac", aliasKeys: ["latest/mac"] }),
    /200 XML InternalError/,
  );
  assert.equal(text(s3.objects.get("latest/mac").bytes), "ORIG");

  mode = "same-len-wrong";
  await assert.rejects(() =>
    commitObjectToAliases(env, { id: "mac", stageKey: "stage/mac", aliasKeys: ["latest/mac"] }),
  );
  assert.equal(text(s3.objects.get("latest/mac").bytes), "ORIG");

  // 3. Group rollback restores committed aliases when a later alias fails.
  mode = "ok";
  const c1 = await commitSingleAlias(env, "stage/mac", "latest/mac", { keepBackup: true });
  assert.equal(text(s3.objects.get("latest/mac").bytes), "AAAA");
  await rollbackCommittedAliases(env, [c1]);
  assert.equal(text(s3.objects.get("latest/mac").bytes), "ORIG");

  // 4. R2 conditional ETag prevents splicing two versions across multipart chunks.
  const r2Objects = fixtureR2Objects(manifest, { "latest/mac": "AAAABBBB" });
  const envSwap = fixtureEnv(r2Objects, {
    onR2Get(key, options) {
      if (key === "latest/mac" && options?.range?.offset === 4) {
        r2Objects.set("latest/mac", bytes("CCCCDDDD"));
      }
    },
  });
  await assert.rejects(
    () =>
      uploadObjectToStage(
        envSwap,
        {
          id: "mac",
          sourceKey: "latest/mac",
          stageKey: "stage/spliced",
          filename: "Claude-mac-universal.dmg",
          contentType: "application/x-apple-diskimage",
          required: true,
        },
        { forceUpload: true, singlePutMaxBytes: 4, partSizeBytes: 4, minPartSizeBytes: 1 },
      ),
    /changed mid-transfer/,
  );

  // 5. verifySourceManifestCurrent detects R2 manifest replacement before commit.
  r2Objects.set("latest/manifest", bytes(JSON.stringify({ ...manifest, version: "6.0.0" })));
  await assert.rejects(() => verifySourceManifestCurrent(envSwap, manifestSha), /advanced during sync/);
});

test("fences superseded workflows, preserves rollback backup on step retry, validates checksums digest, and fails safe on RPC errors", async () => {
  const manifestA = fixtureManifest();
  const textA = JSON.stringify(manifestA);
  const shaA = contentHashHex(bytes(textA));
  const manifestB = { ...fixtureManifest(), version: "6.0.0" };
  const textB = JSON.stringify(manifestB);
  const shaB = contentHashHex(bytes(textB));

  const r2Objects = fixtureR2Objects(manifestA);
  const s3 = createMockS3();
  globalThis.fetch = s3.fetch;

  let terminatedOld = 0;
  const wfInstances = new Map();
  const env = {
    ...fixtureEnv(r2Objects),
    SECONDARY_MIRROR_WORKFLOW: {
      async create(opts) {
        const inst = {
          id: opts.id,
          currentState: "running",
          async status() { return { status: this.currentState }; },
          async terminate() { terminatedOld += 1; this.currentState = "terminated"; },
        };
        wfInstances.set(opts.id, inst);
        return inst;
      },
      async get(id) {
        if (id === "rpc-glitch-peer") {
          throw new Error("Workflow RPC HTTP 503 (request id 6c404ab)");
        }
        return wfInstances.get(id) || null;
      },
    },
  };

  const syncA = await startSync(env, {});
  r2Objects.set("latest/manifest", bytes(textB));
  r2Objects.set("latest/checksums", bytes(`${shaB}  release-manifest.json\n`));
  const syncB = await startSync(env, {});
  assert.equal(terminatedOld, 1);

  await assert.rejects(
    () => discoverSourceManifest(env, "", shaA),
    (err) => err instanceof SupersededMirrorError && isSupersededError(err),
  );

  s3.objects.set("stage-a/mac", objectEntry("MAC-A", new Date(), { syncSha256: "a".repeat(64) }));
  s3.objects.set("latest/mac", objectEntry("MAC-B", new Date(), { syncSha256: "b".repeat(64) }));
  await assert.rejects(
    () =>
      commitSingleAlias(env, "stage-a/mac", "latest/mac", {
        keepBackup: true,
        expectedManifestSha256: shaA,
        instanceId: syncA.id,
      }),
    (err) => isSupersededError(err),
  );
  assert.equal(text(s3.objects.get("latest/mac").bytes), "MAC-B");

  s3.objects.set("stage-b/win", objectEntry("NEXT", new Date(), { syncSha256: "c".repeat(64) }));
  s3.objects.set("latest/win-x64", objectEntry("OLD!", new Date(), { syncSha256: "d".repeat(64) }));
  await commitSingleAlias(env, "stage-b/win", "latest/win-x64", {
    keepBackup: true,
    expectedManifestSha256: shaB,
    instanceId: syncB.id,
  });
  const retryCommit = await commitSingleAlias(env, "stage-b/win", "latest/win-x64", {
    keepBackup: true,
    expectedManifestSha256: shaB,
    instanceId: syncB.id,
  });
  assert.equal(text(s3.objects.get("latest/win-x64.rollback").bytes), "OLD!");
  await rollbackCommittedAliases(env, [retryCommit], { expectedManifestSha256: shaB, instanceId: syncB.id });
  assert.equal(text(s3.objects.get("latest/win-x64").bytes), "OLD!");

  const planB = decoratePlanWithStage(
    buildObjectPlan(manifestB, deriveReleaseTag(manifestB), {
      manifestText: textB,
      manifestSha256: shaB,
      secondaryPrefix: "claude-edge",
    }),
    "inst-edge",
    { SECONDARY_S3_PREFIX: "claude-edge" },
  );
  assert.ok(planB.stagePrefix.startsWith("claude-edge/staging/secondary-sync/"));
  const checksumsItem = planB.items.find((i) => i.id === "checksums");
  r2Objects.set("latest/checksums", bytes(`${shaA}  release-manifest.json\n`));
  await assert.rejects(
    () => uploadObjectToStage(env, checksumsItem, { forceUpload: true }),
    /does not match expected release checksums/,
  );

  const old = new Date("2020-01-01T00:00:00Z");
  s3.objects.set("staging/secondary-sync/claude-app-v6.0.0/rpc-glitch-peer/objects/part", objectEntry("keep", old));
  const rpcPrune = await pruneAbandonedStageObjects(env, "staging/secondary-sync/claude-app-v6.0.0/current", {
    graceHours: 1,
  });
  assert.equal(rpcPrune.deleted.includes("staging/secondary-sync/claude-app-v6.0.0/rpc-glitch-peer/objects/part"), false);

  // Unchanged installer is preserved on group rollback, and reconcileSync detects stamped SHA-256 mismatch!
  s3.objects.set("stage-same/mac", objectEntry("SAME", new Date(), { syncSha256: "f".repeat(64) }));
  s3.objects.set("latest/mac-same", objectEntry("SAME", new Date(), { syncSha256: "f".repeat(64) }));
  const sameCommit = await commitSingleAlias(env, "stage-same/mac", "latest/mac-same", {
    keepBackup: true,
    expectedManifestSha256: shaB,
    instanceId: syncB.id,
  });
  assert.equal(sameCommit.hadExisting, true);
  await rollbackCommittedAliases(env, [sameCommit], { expectedManifestSha256: shaB, instanceId: syncB.id });
  assert.equal(text(s3.objects.get("latest/mac-same").bytes), "SAME");
});

test("retains unrestored rollback backup on persistent 502, clears restored marker on restarted recommit, and recovers from cleanup DELETE 503", async () => {
  const manifest = fixtureManifest();
  const r2Objects = fixtureR2Objects(manifest);
  let blockCommitAndRestore = true;

  const s3 = createMockS3({
    onCopy(src, dst) {
      if (blockCommitAndRestore && dst === "latest/win-x64") {
        return new Response("Bad Gateway", { status: 502 });
      }
      return null;
    },
  });
  globalThis.fetch = s3.fetch;

  const env = { ...fixtureEnv(r2Objects), SECONDARY_S3_MAX_ATTEMPTS: "1" };
  const stagePrefix = "staging/secondary-sync/claude-app-v5.11492.5/inst-502";
  s3.objects.set(`${stagePrefix}/objects/win-x64`, objectEntry("NEW-WIN", new Date(), { syncSha256: "a".repeat(64) }));
  s3.objects.set("latest/win-x64", objectEntry("LIVE-WIN", new Date(), { syncSha256: "b".repeat(64) }));

  await assert.rejects(() =>
    commitSingleAlias(env, `${stagePrefix}/objects/win-x64`, "latest/win-x64", {
      keepBackup: true,
      stagePrefix,
    }),
  );
  await assert.rejects(() =>
    rollbackCommittedAliases(env, [], { stagePrefix }),
  );
  await cleanupStageObjects(env, [{ stageKey: `${stagePrefix}/objects/win-x64` }], stagePrefix, {
    preserveBackups: false,
  });
  const retainedBackups = [...s3.objects.keys()].filter(
    (k) => k.startsWith(`${stagePrefix}/backups/`) && k.endsWith(".rollback"),
  );
  assert.equal(retainedBackups.length, 1, "unrestored .rollback backup must survive failure cleanup");
  assert.equal(text(s3.objects.get(retainedBackups[0]).bytes), "LIVE-WIN");

  blockCommitAndRestore = false;
  const recovered = await rollbackCommittedAliases(env, [], { stagePrefix });
  assert.deepEqual(recovered.restored, ["latest/win-x64"]);
  assert.equal(text(s3.objects.get("latest/win-x64").bytes), "LIVE-WIN");

  const restartPrefix = "staging/secondary-sync/claude-app-v5.11492.5/inst-restart";
  s3.objects.set(`${restartPrefix}/objects/mac`, objectEntry("NEW-MAC", new Date(), { syncSha256: "1".repeat(64) }));
  s3.objects.set(`${restartPrefix}/objects/linux`, objectEntry("NEW-LINUX", new Date(), { syncSha256: "2".repeat(64) }));
  s3.objects.set("latest/mac", objectEntry("OLD-MAC", new Date(), { syncSha256: "3".repeat(64) }));
  s3.objects.set("latest/linux-x64", objectEntry("OLD-LINUX", new Date(), { syncSha256: "4".repeat(64) }));

  const cMac1 = await commitSingleAlias(env, `${restartPrefix}/objects/mac`, "latest/mac", {
    keepBackup: true,
    stagePrefix: restartPrefix,
  });
  const cLin1 = await commitSingleAlias(env, `${restartPrefix}/objects/linux`, "latest/linux-x64", {
    keepBackup: true,
    stagePrefix: restartPrefix,
  });

  const s3Partial = createMockS3({
    onCopy(src, dst) {
      if (dst === "latest/mac") {
        return new Response("Bad Gateway", { status: 502 });
      }
      return null;
    },
  });
  for (const [k, v] of s3.objects.entries()) s3Partial.objects.set(k, v);
  globalThis.fetch = s3Partial.fetch;
  await assert.rejects(() =>
    rollbackCommittedAliases(env, [cMac1, cLin1], { stagePrefix: restartPrefix }),
  );
  assert.equal(text(s3Partial.objects.get("latest/linux-x64").bytes), "OLD-LINUX");

  for (const [k, v] of s3Partial.objects.entries()) s3.objects.set(k, v);
  globalThis.fetch = s3.fetch;
  const cMac2 = await commitSingleAlias(env, `${restartPrefix}/objects/mac`, "latest/mac", {
    keepBackup: true,
    stagePrefix: restartPrefix,
  });
  const cLin2 = await commitSingleAlias(env, `${restartPrefix}/objects/linux`, "latest/linux-x64", {
    keepBackup: true,
    stagePrefix: restartPrefix,
  });
  assert.equal(text(s3.objects.get("latest/linux-x64").bytes), "NEW-LINUX");

  let rollbackDeleteCount = 0;
  const s3DelRetry = createMockS3({
    onDelete(key) {
      if (key.endsWith(".rollback")) {
        rollbackDeleteCount += 1;
        if (rollbackDeleteCount === 2) {
          return new Response("Service Unavailable", { status: 503 });
        }
      }
      return null;
    },
  });
  for (const [k, v] of s3.objects.entries()) s3DelRetry.objects.set(k, v);
  globalThis.fetch = s3DelRetry.fetch;

  await assert.rejects(() =>
    rollbackCommittedAliases(env, [cMac2, cLin2], { stagePrefix: restartPrefix }),
  );
  assert.equal(text(s3DelRetry.objects.get("latest/mac").bytes), "OLD-MAC");
  assert.equal(text(s3DelRetry.objects.get("latest/linux-x64").bytes), "OLD-LINUX");

  const retryResult = await rollbackCommittedAliases(env, [cMac2, cLin2], {
    stagePrefix: restartPrefix,
  });
  assert.equal(retryResult.restored.length, 2);
  assert.equal(text(s3DelRetry.objects.get("latest/mac").bytes), "OLD-MAC");
  assert.equal(text(s3DelRetry.objects.get("latest/linux-x64").bytes), "OLD-LINUX");
  assert.equal(
    [...s3DelRetry.objects.keys()].some((k) => k.startsWith(`${restartPrefix}/backups/`)),
    false,
  );
});

test("continues rolling back healthy aliases when another alias fails 502, protects backups across pruning, and keeps inline restore backups during group commit", async () => {
  const manifest = fixtureManifest();
  const r2Objects = fixtureR2Objects(manifest);
  const old = new Date("2020-01-01T00:00:00Z");
  const stagePrefix = "staging/secondary-sync/claude-app-v5.11492.5/inst-cont";

  let failSecondCommit = true;
  let blockSecondRestore = true;
  let failStateDelete503 = true;

  const s3 = createMockS3({
    onCopy(src, dst) {
      if (failSecondCommit && src.endsWith("/objects/linux") && dst === "latest/linux-x64") {
        return new Response("Bad Gateway", { status: 502 });
      }
      if (blockSecondRestore && src.includes("/backups/") && dst === "latest/linux-x64") {
        return new Response("Bad Gateway", { status: 502 });
      }
      return null;
    },
    onDelete(key) {
      if (failStateDelete503 && key.endsWith(".state.json")) {
        return new Response("Service Unavailable", { status: 503 });
      }
      return null;
    },
  });
  globalThis.fetch = s3.fetch;

  const env = { ...fixtureEnv(r2Objects), SECONDARY_S3_MAX_ATTEMPTS: "1" };
  s3.objects.set(`${stagePrefix}/objects/mac`, objectEntry("NEW-MAC", old, { syncSha256: "1".repeat(64) }));
  s3.objects.set(`${stagePrefix}/objects/linux`, objectEntry("NEW-LINUX", old, { syncSha256: "2".repeat(64) }));
  s3.objects.set("latest/mac", objectEntry("OLD-MAC", old, { syncSha256: "3".repeat(64) }));
  s3.objects.set("latest/linux-x64", objectEntry("OLD-LINUX", old, { syncSha256: "4".repeat(64) }));

  const c1 = await commitSingleAlias(env, `${stagePrefix}/objects/mac`, "latest/mac", {
    keepBackup: true,
    stagePrefix,
  });
  await assert.rejects(() =>
    commitSingleAlias(env, `${stagePrefix}/objects/linux`, "latest/linux-x64", {
      keepBackup: true,
      stagePrefix,
    }),
  );

  await assert.rejects(() =>
    rollbackCommittedAliases(env, [c1], { stagePrefix }),
  );
  assert.equal(text(s3.objects.get("latest/mac").bytes), "OLD-MAC");

  for (const [k, v] of s3.objects.entries()) {
    if (k.startsWith(`${stagePrefix}/backups/`)) {
      v.lastModified = old;
    }
  }
  await pruneAbandonedStageObjects(env, "staging/secondary-sync/claude-app-v5.11492.5/other", { graceHours: 1 });

  blockSecondRestore = false;
  failStateDelete503 = false;
  const finalRb = await rollbackCommittedAliases(env, [c1], { stagePrefix });
  assert.equal(text(s3.objects.get("latest/mac").bytes), "OLD-MAC");
  assert.equal(text(s3.objects.get("latest/linux-x64").bytes), "OLD-LINUX");
  assert.equal(finalRb.restored.length, 2);

  const stageInline = "staging/secondary-sync/claude-app-v5.11492.5/inst-inline503";
  s3.objects.set(`${stageInline}/objects/mac`, objectEntry("NEW-MAC", old, { syncSha256: "1".repeat(64) }));
  s3.objects.set(`${stageInline}/objects/linux`, objectEntry("NEW-LINUX", old, { syncSha256: "2".repeat(64) }));
  failStateDelete503 = true;
  const ci1 = await commitSingleAlias(env, `${stageInline}/objects/mac`, "latest/mac", {
    keepBackup: true,
    stagePrefix: stageInline,
  });
  await assert.rejects(() =>
    commitSingleAlias(env, `${stageInline}/objects/linux`, "latest/linux-x64", {
      keepBackup: true,
      stagePrefix: stageInline,
    }),
  );
  failStateDelete503 = false;
  await rollbackCommittedAliases(env, [ci1], { stagePrefix: stageInline });
  assert.equal(text(s3.objects.get("latest/mac").bytes), "OLD-MAC");
  assert.equal(text(s3.objects.get("latest/linux-x64").bytes), "OLD-LINUX");

  const stageState502 = "staging/secondary-sync/claude-app-v5.11492.5/inst-state502";
  s3.objects.set(`${stageState502}/objects/mac`, objectEntry("NEW-MAC", old, { syncSha256: "1".repeat(64) }));
  s3.objects.set(`${stageState502}/objects/linux`, objectEntry("NEW-LINUX", old, { syncSha256: "2".repeat(64) }));
  const cs1 = await commitSingleAlias(env, `${stageState502}/objects/mac`, "latest/mac", {
    keepBackup: true,
    stagePrefix: stageState502,
  });
  failSecondCommit = true;
  blockSecondRestore = true;
  await assert.rejects(() =>
    commitSingleAlias(env, `${stageState502}/objects/linux`, "latest/linux-x64", {
      keepBackup: true,
      stagePrefix: stageState502,
    }),
  );
  const brokenStateKey = [...s3.objects.keys()].find(
    (k) => k.startsWith(`${stageState502}/backups/`) && k.includes("linux-x64") && k.endsWith(".state.json"),
  );
  const s3State502 = createMockS3({
    onGet(key) {
      if (key === brokenStateKey) {
        return new Response("Bad Gateway", { status: 502 });
      }
      return null;
    },
  });
  for (const [k, v] of s3.objects.entries()) s3State502.objects.set(k, v);
  globalThis.fetch = s3State502.fetch;
  await assert.rejects(() => rollbackCommittedAliases(env, [cs1], { stagePrefix: stageState502 }));
  assert.equal(text(s3State502.objects.get("latest/mac").bytes), "OLD-MAC");
  assert.equal(text(s3State502.objects.get("latest/linux-x64").bytes), "OLD-LINUX");

  const stageDone = "staging/secondary-sync/claude-app-v5.11492.5/inst-done";
  s3.objects.set(`${stageDone}/objects/mac`, objectEntry("NEW-MAC", old, { syncSha256: "1".repeat(64) }));
  s3.objects.set(`${stageDone}/objects/manifest`, objectEntry("NEW-MANIFEST", old, { syncSha256: "9".repeat(64) }));
  s3.objects.set("latest/mac", objectEntry("OLD-MAC", old, { syncSha256: "3".repeat(64) }));
  s3.objects.set("latest/manifest", objectEntry("OLD-MANIFEST", old, { syncSha256: "8".repeat(64) }));
  globalThis.fetch = s3.fetch;
  failSecondCommit = false;
  blockSecondRestore = false;
  const cd1 = await commitSingleAlias(env, `${stageDone}/objects/mac`, "latest/mac", {
    keepBackup: true,
    stagePrefix: stageDone,
  });
  const cd2 = await commitSingleAlias(env, `${stageDone}/objects/manifest`, "latest/manifest", {
    keepBackup: true,
    stagePrefix: stageDone,
  });
  let postCommitDeletes = 0;
  const s3PostCommit = createMockS3({
    onDelete(key) {
      if (key.endsWith(".rollback")) {
        postCommitDeletes += 1;
        if (postCommitDeletes === 2) {
          return new Response("Service Unavailable", { status: 503 });
        }
      }
      return null;
    },
  });
  for (const [k, v] of s3.objects.entries()) s3PostCommit.objects.set(k, v);
  globalThis.fetch = s3PostCommit.fetch;
  await assert.rejects(() =>
    cleanupRollbackBackups(env, [cd1, cd2], { stagePrefix: stageDone }),
  );
  for (const [k, v] of s3PostCommit.objects.entries()) {
    if (k.startsWith(`${stageDone}/`)) v.lastModified = old;
  }
  postCommitDeletes = 1;
  await assert.rejects(() =>
    pruneAbandonedStageObjects(env, "staging/secondary-sync/claude-app-v5.11492.5/other", { graceHours: 1 }),
  );
  assert.equal(s3PostCommit.objects.has(`${stageDone}/backups/_batch_committed.json`), true);
  const skippedCompletedRb = await rollbackCommittedAliases(env, [cd1, cd2], { stagePrefix: stageDone });
  assert.equal(skippedCompletedRb.skippedAlreadyCommitted, true);
  assert.equal(text(s3PostCommit.objects.get("latest/mac").bytes), "NEW-MAC");
  assert.equal(text(s3PostCommit.objects.get("latest/manifest").bytes), "NEW-MANIFEST");

  const stageRetry404 = "staging/secondary-sync/claude-app-v5.11492.5/inst-retry404";
  globalThis.fetch = s3.fetch;
  s3.objects.set(
    `${stageRetry404}/objects/win`,
    objectEntry("NEW!", old, { etag: '"111-2"', syncSha256: contentHashHex(bytes("NEW!")) }),
  );
  const detWin = aliasBackupKeys(`${stageRetry404}/objects/win`, "latest/win-x64", stageRetry404);
  s3.objects.delete("latest/win-x64");
  s3.objects.delete(detWin.stateKey);
  s3.objects.set(detWin.backupKey, objectEntry("OLD!", old, { etag: '"222-2"', syncSha256: "" }));
  const crA = await commitSingleAlias(env, `${stageRetry404}/objects/win`, "latest/win-x64", {
    keepBackup: true,
    stagePrefix: stageRetry404,
  });
  assert.equal(crA.hadExisting, true);
  s3.objects.delete(detWin.stateKey);
  const crB = await commitSingleAlias(env, `${stageRetry404}/objects/win`, "latest/win-x64", {
    keepBackup: true,
    stagePrefix: stageRetry404,
  });
  assert.equal(text(s3.objects.get(detWin.backupKey).bytes), "OLD!");
  await rollbackCommittedAliases(env, [crB], { stagePrefix: stageRetry404 });
  assert.equal(text(s3.objects.get("latest/win-x64").bytes), "OLD!");

  const stageShortBk = "staging/secondary-sync/claude-app-v5.11492.5/inst-shortbk";
  const detShort = aliasBackupKeys(`${stageShortBk}/objects/win`, "latest/win-x64", stageShortBk);
  s3.objects.set(`${stageShortBk}/objects/win`, objectEntry("NEW-PAYLOAD", old, { syncSha256: "9".repeat(64) }));
  s3.objects.set("latest/win-x64", objectEntry("LIVE-ORIGINAL", old, { syncSha256: "8".repeat(64) }));
  s3.objects.set(detShort.backupKey, objectEntry("BAD", old, { syncSha256: "7".repeat(64) }));
  const crShortOk = await commitSingleAlias(env, `${stageShortBk}/objects/win`, "latest/win-x64", {
    keepBackup: true,
    stagePrefix: stageShortBk,
  });
  await rollbackCommittedAliases(env, [crShortOk], { stagePrefix: stageShortBk });
  assert.equal(text(s3.objects.get("latest/win-x64").bytes), "LIVE-ORIGINAL");

  const badR2Manifest = new Map(r2Objects);
  badR2Manifest.set("latest/manifest", new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d]));
  await assert.rejects(() => discoverSourceManifest(fixtureEnv(badR2Manifest)), /invalid UTF-8/i);

  s3.objects.set("latest/manifest", objectEntry(new Uint8Array([0x7b, 0xff, 0x7d]), old));
  let repairStarted = 0;
  const envRepair = {
    ...fixtureEnv(r2Objects),
    SECONDARY_MIRROR_WORKFLOW: {
      async create(opts) {
        repairStarted += 1;
        return { id: opts.id, async status() { return { status: "running" }; } };
      },
      async get() { return null; },
    },
  };
  const utf8Heal = await reconcileSync(envRepair, {});
  assert.equal(utf8Heal.created, true);
  assert.equal(repairStarted, 1);

  const stageTruncList = "staging/secondary-sync/claude-app-v5.11492.5/inst-trunclist";
  const detTrunc = aliasBackupKeys(`${stageTruncList}/objects/win`, "latest/win-x64", stageTruncList);
  const s3TruncList = createMockS3({
    onList(prefix) {
      if (prefix.startsWith(`${stageTruncList}/backups/`)) {
        return new Response("<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>", { status: 200 });
      }
      return null;
    },
  });
  s3TruncList.objects.set(detTrunc.backupKey, objectEntry("UNRESTORED-BACKUP", old));
  s3TruncList.objects.set(detTrunc.stateKey, objectEntry(JSON.stringify({ aliasKey: "latest/win-x64", restored: false }), old));
  globalThis.fetch = s3TruncList.fetch;
  await cleanupStageObjects(env, [{ stageKey: `${stageTruncList}/objects/win`, aliasKeys: ["latest/win-x64"] }], {
    stagePrefix: stageTruncList,
  });
  assert.equal(s3TruncList.objects.has(detTrunc.backupKey), true);
  await pruneAbandonedStageObjects(env, "staging/secondary-sync/claude-app-v5.11492.5/other", { graceHours: 1 });
  assert.equal(s3TruncList.objects.has(detTrunc.backupKey), true);

  // Round-11 regressions: 403 HEAD fallback + short backup, unclosed <Contents> / <IsTruncated/>,
  // omitted LIST entry on _batch_committed.json, hadExisting=false state retention, corrupt UTF-8 body with matching metadata, and UTF-8 BOM manifest!
  const stageNewAlias = "staging/secondary-sync/claude-app-v5.11492.5/inst-newalias";
  const detNewArm = aliasBackupKeys(`${stageNewAlias}/objects/arm`, "latest/win-arm64", stageNewAlias);
  const s3R11 = createMockS3();
  s3R11.objects.set("latest/win-arm64", objectEntry("UNPUBLISHED-ARM", old));
  s3R11.objects.set(
    detNewArm.stateKey,
    objectEntry(JSON.stringify({ aliasKey: "latest/win-arm64", backupKey: detNewArm.backupKey, stateKey: detNewArm.stateKey, hadExisting: false, restored: false }), old),
  );
  globalThis.fetch = s3R11.fetch;
  await pruneAbandonedStageObjects(env, "staging/secondary-sync/claude-app-v5.11492.5/other", { graceHours: 1 });
  assert.equal(s3R11.objects.has(detNewArm.stateKey), true);
  const rbNew = await rollbackCommittedAliases(env, [], { stagePrefix: stageNewAlias });
  assert.deepEqual(rbNew.restored, ["latest/win-arm64"]);
  assert.equal(s3R11.objects.has("latest/win-arm64"), false);

  const cleanManifestBytes = bytes(JSON.stringify(manifest));
  const cleanManifestSha = contentHashHex(cleanManifestBytes);
  const corruptSameMeta = cleanManifestBytes.slice();
  corruptSameMeta[2] = 0xff;
  s3R11.objects.set("stage-heal/manifest", objectEntry(cleanManifestBytes, old, { syncSha256: cleanManifestSha }));
  s3R11.objects.set("latest/manifest", objectEntry(corruptSameMeta, old, { syncSha256: cleanManifestSha }));
  await commitSingleAlias(env, "stage-heal/manifest", "latest/manifest");
  assert.deepEqual(s3R11.objects.get("latest/manifest").bytes, cleanManifestBytes);

  const bomManifestBytes = concatBytes([new Uint8Array([0xef, 0xbb, 0xbf]), cleanManifestBytes]);
  const bomManifestSha = contentHashHex(bomManifestBytes);
  const bomR2 = fixtureR2Objects(manifest);
  bomR2.set("latest/manifest", bomManifestBytes);
  bomR2.set("latest/checksums", bytes(`${bomManifestSha}  release-manifest.json\n`));
  const bomEnv = fixtureEnv(bomR2);
  const bomSource = await discoverSourceManifest(bomEnv);
  assert.equal(bomSource.manifestSha256, bomManifestSha);
  const bomPlan = decoratePlanWithStage(
    buildObjectPlan(bomSource.manifest, bomSource.releaseTag, {
      manifestText: bomSource.manifestText,
      manifestSha256: bomSource.manifestSha256,
    }),
    "inst-bom",
    bomEnv,
  );
  const bomManifestItem = bomPlan.items.find((i) => i.id === "manifest");
  const bomUpload = await uploadObjectToStage(bomEnv, bomManifestItem, { forceUpload: true });
  assert.equal(bomUpload.sha256, bomManifestSha);
  assert.deepEqual(s3R11.objects.get(bomManifestItem.stageKey).bytes, bomManifestBytes);

  const stageLateCopy = "staging/secondary-sync/claude-app-v5.11492.5/inst-latecopy";
  const detLate = aliasBackupKeys(`${stageLateCopy}/objects/arm`, "latest/win-arm64", stageLateCopy);
  s3R11.objects.set("latest/win-arm64", objectEntry("LATE-ARRIVED-NEW", old));
  s3R11.objects.set(
    detLate.stateKey,
    objectEntry(JSON.stringify({ aliasKey: "latest/win-arm64", backupKey: detLate.backupKey, stateKey: detLate.stateKey, hadExisting: false, restored: true }), old),
  );
  await rollbackCommittedAliases(env, [{ aliasKey: "latest/win-arm64", backupKey: detLate.backupKey, stateKey: detLate.stateKey, hadExisting: false }], {
    stagePrefix: stageLateCopy,
  });
  assert.equal(s3R11.objects.has("latest/win-arm64"), false);

  // Round-13 regressions: sealed vs unsealed .rollback on state 404, tampered inlineText overwrite, and inst.status() 503 propagation
  const stageSeal = "staging/secondary-sync/claude-app-5.11492.5/inst-seal404";
  const detSeal = aliasBackupKeys(`${stageSeal}/objects/win`, "latest/win-x64", stageSeal);
  const s3Seal = createMockS3();
  const stageWinHash = contentHashHex(bytes("STAGE-WIN"));
  s3Seal.objects.set(`${stageSeal}/objects/win`, objectEntry("STAGE-WIN", old, { syncSha256: stageWinHash }));
  s3Seal.objects.set("latest/win-x64", objectEntry("STAGE-WIN", old, { syncSha256: stageWinHash }));
  s3Seal.objects.set(detSeal.backupKey, objectEntry("BAD", old));
  globalThis.fetch = s3Seal.fetch;
  await rollbackCommittedAliases(env, [], { stagePrefix: stageSeal });
  assert.equal(text(s3Seal.objects.get("latest/win-x64").bytes), "STAGE-WIN");

  const origEntry = objectEntry("ORIG-LIVE", old);
  s3Seal.objects.set(detSeal.backupKey, origEntry);
  s3Seal.objects.set(
    `${detSeal.backupKey}.seal.json`,
    objectEntry(
      JSON.stringify({
        aliasKey: "latest/win-x64",
        backupKey: detSeal.backupKey,
        backupVerified: true,
        backupSize: origEntry.bytes.byteLength,
        backupEtag: origEntry.etag,
        backupSha256: contentHashHex(origEntry.bytes),
      }),
      old,
    ),
  );
  await rollbackCommittedAliases(env, [], { stagePrefix: stageSeal });
  assert.equal(text(s3Seal.objects.get("latest/win-x64").bytes), "ORIG-LIVE");

  const inlinePlan = decoratePlanWithStage(
    buildObjectPlan(manifest, "claude-app-5.11492.5", {
      manifestText: JSON.stringify(manifest),
      manifestSha256: contentHashHex(bytes(JSON.stringify(manifest))),
    }),
    "inst-inlinetamper",
    env,
  );
  const inlineManifestItem = inlinePlan.items.find((i) => i.id === "manifest");
  const expectedInlineBytes = bytes(inlineManifestItem.inlineText);
  s3Seal.objects.set(
    inlineManifestItem.stageKey,
    objectEntry(bytes("X".repeat(expectedInlineBytes.byteLength)), old, {
      syncSha256: contentHashHex(expectedInlineBytes),
    }),
  );
  await uploadObjectToStage(env, inlineManifestItem, { forceUpload: false });
  assert.deepEqual(s3Seal.objects.get(inlineManifestItem.stageKey).bytes, expectedInlineBytes);

  s3Seal.objects.set(
    "staging/secondary-sync/active-sync.json",
    objectEntry(JSON.stringify({ instanceId: "wf-status-503", manifestSha256: contentHashHex(bytes(JSON.stringify(manifest))) }), old),
  );
  const envWf503 = {
    ...fixtureEnv(r2Objects),
    SECONDARY_MIRROR_WORKFLOW: {
      async create() {
        throw new Error("must not create duplicate workflow during status 503");
      },
      async get(id) {
        return {
          id,
          async status() {
            throw new Error("Workflow status RPC failed: 503 Service Unavailable");
          },
        };
      },
    },
  };
  await assert.rejects(() => reconcileSync(envWf503, {}), /503 Service Unavailable/);

  // Round-14 regressions: sealed backup preserved when .state.json is 404 & LIST-only multipart stage, plus 503 body mentioning HTTP 404
  const stageR14 = "staging/secondary-sync/claude-app-5.11492.5/inst-r14-mp";
  const detR14 = aliasBackupKeys(`${stageR14}/objects/head-403-mp`, "latest/win-x64", stageR14);
  const s3R14 = createMockS3({
    headOverride(k, store) {
      if (k.includes("head-403")) {
        return new Response("forbidden", { status: 403 });
      }
      return null;
    },
  });
  const origR14 = objectEntry("ORIG-MP", old);
  const nextR14Bytes = bytes("NEXT-MP");
  s3R14.objects.set(
    `${stageR14}/objects/head-403-mp`,
    objectEntry(nextR14Bytes, old, { etag: '"mp-etag-2"', syncSha256: contentHashHex(nextR14Bytes) }),
  );
  s3R14.objects.set("latest/win-x64", objectEntry(nextR14Bytes, old));
  s3R14.objects.set(detR14.backupKey, origR14);
  s3R14.objects.set(
    `${detR14.backupKey}.seal.json`,
    objectEntry(
      JSON.stringify({
        aliasKey: "latest/win-x64",
        stageKey: `${stageR14}/objects/head-403-mp`,
        backupKey: detR14.backupKey,
        backupVerified: true,
        backupSize: origR14.bytes.byteLength,
        backupEtag: origR14.etag,
        backupSha256: contentHashHex(origR14.bytes),
      }),
      old,
    ),
  );
  globalThis.fetch = s3R14.fetch;
  await commitSingleAlias(env, `${stageR14}/objects/head-403-mp`, "latest/win-x64", {
    keepBackup: true,
    stagePrefix: stageR14,
  });
  assert.equal(text(s3R14.objects.get(detR14.backupKey).bytes), "ORIG-MP");
  await rollbackCommittedAliases(env, [], { stagePrefix: stageR14 });
  assert.equal(text(s3R14.objects.get("latest/win-x64").bytes), "ORIG-MP");

  // Round-15: cleanupStageObjects re-runs artifact guard on DELETE retry via beforeAttempt
  const stageCpRetry = "staging/secondary-sync/claude-app-5.11492.5/inst-cpretry";
  const cpRetryKey = `${stageCpRetry}/backups/_batch_restored.json`;
  const detCpRetry = aliasBackupKeys(`${stageCpRetry}/objects/win`, "latest/win-x64", stageCpRetry);
  let injected503 = false;
  const s3CpRetry = createMockS3({
    onDelete(delKey) {
      if (delKey === cpRetryKey && !injected503) {
        injected503 = true;
        s3CpRetry.objects.set(detCpRetry.backupKey, objectEntry("LATE-RB", old));
        return new Response("Unavailable", { status: 503 });
      }
      return null;
    },
  });
  s3CpRetry.objects.set(cpRetryKey, objectEntry(JSON.stringify({ completed: true, entries: [] }), old));
  globalThis.fetch = s3CpRetry.fetch;
  await cleanupStageObjects(
    { ...env, SECONDARY_S3_MAX_ATTEMPTS: "2" },
    [{ stageKey: `${stageCpRetry}/objects/win`, aliasKeys: ["latest/win-x64"] }],
    stageCpRetry,
  );
  assert.equal(s3CpRetry.objects.has(cpRetryKey), true, "beforeAttempt must retain _batch_restored.json when .rollback appears before retry");

  // Round-17: contradictory installer digest repair, absent-baseline orphan rollback, purge 503 retention, and >8 repair slot restarts
  const manifestSha = contentHashHex(r2Objects.get("latest/manifest"));
  const s3Slots = createMockS3();
  s3Slots.objects.set("latest/manifest", objectEntry(new Uint8Array([0xff, 0xfe]), old));
  globalThis.fetch = s3Slots.fetch;
  const createdSlots = new Map();
  const canonicalForSlots = workflowInstanceId("manifest", manifestSha);
  const envSlots = {
    ...fixtureEnv(r2Objects),
    SECONDARY_MIRROR_WORKFLOW: {
      async get(id) {
        if (id === canonicalForSlots) {
          return {
            id,
            async status() {
              return { status: "complete" };
            },
          };
        }
        return createdSlots.get(id) || null;
      },
      async create({ id, params }) {
        const inst = {
          id,
          params,
          state: "errored",
          async status() {
            return { status: this.state };
          },
          async restart() {
            this.state = "running";
          },
        };
        createdSlots.set(id, inst);
        return inst;
      },
    },
  };
  const firstSlot = await reconcileSync(envSlots, { releaseTag: "claude-app-v5.0.0" });
  for (let i = 0; i < 9; i += 1) {
    createdSlots.get(firstSlot.id).state = "errored";
    s3Slots.objects.delete("staging/secondary-sync/active-sync.json");
    const again = await reconcileSync(envSlots, { releaseTag: i % 2 === 0 ? "" : "claude-app-v5.0.0" });
    assert.equal(again.id, firstSlot.id);
  }
});

test("Round 18 regressions: stale header exposure on LIST-sealed backup, unstamped migration & multipart checksum stamping, 503 manifest guard, same-manifest repair rollback, fenced checkpoint/pruner, and stale repair-slot checkpoint invalidation", async () => {
  const manifest = fixtureManifest();
  const r2Objects = fixtureR2Objects(manifest);
  const manifestText = text(r2Objects.get("latest/manifest"));
  const manifestSha = contentHashHex(r2Objects.get("latest/manifest"));
  const old = new Date(Date.now() - 86400_000);

  // 1) Orphan backup sealed via LIST fallback (HEAD 403) restores cleanly when HEAD later exposes stale syncSha256
  let forceListFallback = true;
  const s3StaleVis = createMockS3({
    onHead() {
      return forceListFallback ? new Response("forbidden", { status: 403 }) : null;
    },
  });
  globalThis.fetch = s3StaleVis.fetch;
  const origWinBytes = bytes("CLAUDE-ORIG-STALE-HDR");
  s3StaleVis.objects.set("latest/win-x64", objectEntry(origWinBytes, old, { syncSha256: "e".repeat(64) }));
  const m1Json = JSON.stringify({ ...manifest, version: "5.20000.0" });
  const m2Json = JSON.stringify({ ...manifest, version: "5.30000.0" });
  const m1Sha = contentHashHex(bytes(m1Json));
  const m2Sha = contentHashHex(bytes(m2Json));
  const r2M1 = fixtureR2Objects(JSON.parse(m1Json), { "latest/manifest": m1Json });
  const r2M2 = fixtureR2Objects(JSON.parse(m2Json), { "latest/manifest": m2Json });
  const stgVisW1 = "staging/secondary-sync/claude-app-v5.20000.0/inst-vis-w1";
  s3StaleVis.objects.set(
    "staging/secondary-sync/active-sync.json",
    objectEntry(JSON.stringify({ instanceId: "inst-vis-w1", manifestSha256: m1Sha, epoch: 10 }), old),
  );
  s3StaleVis.objects.set(
    `${stgVisW1}/objects/win`,
    objectEntry("UNPUBLISHED-W1-WIN", old, { syncSha256: contentHashHex(bytes("UNPUBLISHED-W1-WIN")) }),
  );
  await commitSingleAlias(fixtureEnv(r2M1), `${stgVisW1}/objects/win`, "latest/win-x64", {
    keepBackup: true,
    expectedManifestSha256: m1Sha,
    instanceId: "inst-vis-w1",
    stagePrefix: stgVisW1,
  });
  forceListFallback = false;
  s3StaleVis.objects.set(
    "staging/secondary-sync/active-sync.json",
    objectEntry(JSON.stringify({ instanceId: "inst-vis-w2", manifestSha256: m2Sha, epoch: 11 }), old),
  );
  await rollbackCommittedAliases(fixtureEnv(r2M2), [], {
    expectedManifestSha256: m2Sha,
    instanceId: "inst-vis-w2",
    stagePrefix: "staging/secondary-sync/claude-app-v5.30000.0/inst-vis-w2",
  });
  assert.equal(text(s3StaleVis.objects.get("latest/win-x64").bytes), "CLAUDE-ORIG-STALE-HDR");

  // 2 & 3) Unstamped release schedules migration with 0 binary reads, and multipart installer with digest in latest/checksums stamps & skips
  let binaryGetBytes = 0;
  const s3Unstamped = createMockS3({
    onGet(key, store) {
      if (!key.endsWith("manifest") && !key.endsWith("checksums") && !key.endsWith(".json")) {
        binaryGetBytes += store.get(key)?.bytes.byteLength || 0;
      }
      return null;
    },
  });
  globalThis.fetch = s3Unstamped.fetch;
  const mpWinBytes = new Uint8Array(6 * 1024 * 1024 + 11);
  mpWinBytes.fill(0x43);
  const mpWinSha = contentHashHex(mpWinBytes);
  const r2Mp = fixtureR2Objects(manifest, {
    "latest/win-x64": mpWinBytes,
  });
  r2Mp.set(
    "latest/checksums",
    bytes(`${manifestSha}  release-manifest.json\n${mpWinSha}  Claude-win-x64.msix\n`),
  );
  const envMpBase = {
    ...fixtureEnv(r2Mp),
    SECONDARY_SYNC_SINGLE_PUT_MAX_BYTES: String(5 * 1024 * 1024),
    SECONDARY_SYNC_PART_SIZE_BYTES: String(5 * 1024 * 1024),
  };
  const mpPlan = decoratePlanWithStage(
    buildObjectPlan(manifest, "claude-app-v5.11492.5", {
      manifestText,
      manifestSha256: manifestSha,
    }),
    "inst-mp-stamp",
    envMpBase,
  );
  for (const item of mpPlan.items) {
    for (const ak of item.aliasKeys) {
      s3Unstamped.objects.set(ak, objectEntry(r2Mp.get(item.sourceKey), old, { syncSha256: "" }));
    }
  }
  let scheduledMigrations = 0;
  const envMpWf = {
    ...envMpBase,
    SECONDARY_MIRROR_WORKFLOW: {
      async get() {
        return null;
      },
      async create({ id }) {
        scheduledMigrations += 1;
        return {
          id,
          async status() {
            return { status: "running" };
          },
        };
      },
    },
  };
  const migRes = await reconcileSync(envMpWf, {});
  assert.equal(migRes.created, true);
  assert.equal(binaryGetBytes, 0);
  s3Unstamped.objects.delete("staging/secondary-sync/active-sync.json");
  for (const item of mpPlan.items) {
    await uploadObjectToStage(envMpBase, item);
  }
  for (const item of commitOrder(mpPlan.items)) {
    for (const ak of item.aliasKeys) {
      await commitSingleAlias(envMpBase, item.stageKey, ak, {
        keepBackup: false,
        stagePrefix: mpPlan.stagePrefix,
        expectedManifestSha256: manifestSha,
      });
    }
  }
  assert.equal(s3Unstamped.objects.get("latest/win-x64").syncSha256, mpWinSha);
  const afterStamp = await reconcileSync(envMpWf, {});
  assert.equal(afterStamp.skipped, true);
  assert.equal(scheduledMigrations, 1);

  // 4, 5, 6, 7, 8, 9) 503 manifest guard, self-rollback guard, same-manifest repair, fenced checkpoint/pruner, and stale repair-slot invalidation
  let failBatchCommittedPut = true;
  const s3Guard = createMockS3({
    onPut(key) {
      if (failBatchCommittedPut && key.endsWith("/_batch_committed.json")) {
        return new Response("Unavailable", { status: 503 });
      }
      return null;
    },
  });
  globalThis.fetch = s3Guard.fetch;
  const m0Json = JSON.stringify({ ...manifest, version: "5.10000.0" });
  s3Guard.objects.set("latest/win-x64", objectEntry("V510-WIN", old));
  s3Guard.objects.set("latest/manifest", objectEntry(m0Json, old));
  const stgW0 = "staging/secondary-sync/claude-app-v5.15000.0/inst-w0";
  const detW0Win = aliasBackupKeys(`${stgW0}/objects/win`, "latest/win-x64", stgW0);
  s3Guard.objects.set(detW0Win.backupKey, objectEntry("V510-WIN", old));
  s3Guard.objects.set(
    detW0Win.stateKey,
    objectEntry(
      JSON.stringify({
        aliasKey: "latest/win-x64",
        backupKey: detW0Win.backupKey,
        stateKey: detW0Win.stateKey,
        hadExisting: true,
        backupVerified: true,
        backupSize: bytes("V510-WIN").byteLength,
        backupSha256: contentHashHex(bytes("V510-WIN")),
        ownerEpoch: 50,
        restored: false,
      }),
      old,
    ),
  );
  const envCp503 = { ...fixtureEnv(r2M1), SECONDARY_S3_MAX_ATTEMPTS: "1" };
  const stgPub503 = "staging/secondary-sync/claude-app-v5.20000.0/inst-pub503";
  s3Guard.objects.set(
    "staging/secondary-sync/active-sync.json",
    objectEntry(JSON.stringify({ instanceId: "inst-pub503", manifestSha256: m1Sha, epoch: 60 }), old),
  );
  s3Guard.objects.set(
    `${stgPub503}/objects/win`,
    objectEntry("V520-WIN", old, { syncSha256: contentHashHex(bytes("V520-WIN")) }),
  );
  s3Guard.objects.set(`${stgPub503}/objects/manifest`, objectEntry(m1Json, old, { syncSha256: m1Sha }));
  const pubWin = await commitSingleAlias(envCp503, `${stgPub503}/objects/win`, "latest/win-x64", {
    keepBackup: true,
    expectedManifestSha256: m1Sha,
    instanceId: "inst-pub503",
    stagePrefix: stgPub503,
  });
  const pubManifest = await commitSingleAlias(envCp503, `${stgPub503}/objects/manifest`, "latest/manifest", {
    keepBackup: true,
    expectedManifestSha256: m1Sha,
    instanceId: "inst-pub503",
    stagePrefix: stgPub503,
  });
  const selfRb = await rollbackCommittedAliases(envCp503, [pubWin, pubManifest], {
    expectedManifestSha256: m1Sha,
    instanceId: "inst-pub503",
    stagePrefix: stgPub503,
  });
  assert.equal(selfRb.skippedAlreadyCommitted, true);
  await cleanupStageObjects(
    envCp503,
    [
      { stageKey: `${stgPub503}/objects/win`, aliasKeys: ["latest/win-x64"] },
      { stageKey: `${stgPub503}/objects/manifest`, aliasKeys: ["latest/manifest"] },
    ],
    stgPub503,
    { switchoverComplete: true, expectedManifestSha256: m1Sha, instanceId: "inst-pub503" },
  );
  assert.equal(s3Guard.objects.has(pubManifest.stateKey), true);
  s3Guard.objects.set(
    "staging/secondary-sync/active-sync.json",
    objectEntry(JSON.stringify({ instanceId: "inst-w2", manifestSha256: m2Sha, epoch: 70 }), old),
  );
  await rollbackCommittedAliases({ ...fixtureEnv(r2M2), SECONDARY_S3_MAX_ATTEMPTS: "1" }, [], {
    expectedManifestSha256: m2Sha,
    instanceId: "inst-w2",
    stagePrefix: "staging/secondary-sync/claude-app-v5.30000.0/inst-w2",
  });
  assert.equal(text(s3Guard.objects.get("latest/win-x64").bytes), "V520-WIN");

  failBatchCommittedPut = false;
  const repairPlan = decoratePlanWithStage(
    buildObjectPlan(manifest, "claude-app-v5.11492.5", {
      manifestText,
      manifestSha256: manifestSha,
    }),
    "inst-repair-slot-1",
    fixtureEnv(r2Objects),
  );
  s3Guard.objects.set(
    "staging/secondary-sync/active-sync.json",
    objectEntry(JSON.stringify({ instanceId: "inst-repair-slot-1", manifestSha256: manifestSha, epoch: 300 }), old),
  );
  await recordSwitchoverCommittedCheckpoint(fixtureEnv(r2Objects), repairPlan.stagePrefix, [], {
    releaseTag: "claude-app-v5.11492.5",
    manifestSha256: manifestSha,
    instanceId: "inst-repair-slot-1",
  });
  s3Guard.objects.set("latest/manifest", objectEntry(new Uint8Array([0xff, 0xfe]), old));
  s3Guard.objects.set(
    "staging/secondary-sync/active-sync.json",
    objectEntry(JSON.stringify({ instanceId: "inst-repair-slot-1", manifestSha256: manifestSha, epoch: 301 }), old),
  );
  const verifiedCp = await verifyPriorSwitchoverCheckpoint(
    fixtureEnv(r2Objects),
    { releaseTag: "claude-app-v5.11492.5", manifest, manifestText, manifestSha256: manifestSha },
    repairPlan,
    { instanceId: "inst-repair-slot-1" },
  );
  assert.equal(verifiedCp, null);
});

test("Round 19 regressions: monotonic pointer retry, permanent committed-epoch ledger, own-slot superseded state/restored guard, reused-dir epoch recovery & pruner, invalidation before delete, failure-cleanup guard, and 0-byte mixed-HEAD migration", async () => {
  const manifest = fixtureManifest();
  const r2Objects = fixtureR2Objects(manifest);
  const manifestText = text(r2Objects.get("latest/manifest"));
  const manifestSha = contentHashHex(r2Objects.get("latest/manifest"));
  const old = new Date(Date.now() - 86400_000);

  // 1) Retried active-sync.json PUT 503 cannot regress epoch over an intervening forced repair
  let pointerAttempt = 0;
  const wfInstances = new Map();
  const s3Ptr = createMockS3({
    onPut(key, store) {
      if (key === "staging/secondary-sync/active-sync.json") {
        pointerAttempt += 1;
        if (pointerAttempt === 1) {
          const forcedEpoch = Date.now() * 512 + 999_999;
          store.set(
            key,
            objectEntry(
              JSON.stringify({
                instanceId: "inst-forced-repair",
                manifestSha256: manifestSha,
                epoch: forcedEpoch,
                runEpoch: forcedEpoch,
              }),
              new Date(),
            ),
          );
          wfInstances.set("inst-forced-repair", "running");
          return new Response("Unavailable", { status: 503 });
        }
      }
      return null;
    },
  });
  globalThis.fetch = s3Ptr.fetch;
  const envPtr = {
    ...fixtureEnv(r2Objects),
    SECONDARY_MIRROR_WORKFLOW: {
      async get(id) {
        if (!wfInstances.has(id)) return null;
        return {
          id,
          async status() {
            return { status: wfInstances.get(id) };
          },
          async terminate() {
            wfInstances.set(id, "terminated");
          },
        };
      },
      async create({ id }) {
        wfInstances.set(id, "running");
        return {
          id,
          async status() {
            return { status: wfInstances.get(id) };
          },
          async terminate() {
            wfInstances.set(id, "terminated");
          },
        };
      },
    },
  };
  await assert.rejects(
    () => startSync(envPtr, { instanceId: "inst-normal-sync" }),
    /SUPERSEDED/,
  );
  const finalPtr = JSON.parse(
    text(s3Ptr.objects.get("staging/secondary-sync/active-sync.json").bytes),
  );
  assert.equal(finalPtr.instanceId, "inst-forced-repair");
  await verifySourceManifestCurrent(envPtr, manifestSha, {
    instanceId: "inst-forced-repair",
    requirePointer: true,
  });
  await assert.rejects(
    () =>
      verifySourceManifestCurrent(envPtr, manifestSha, {
        instanceId: "inst-normal-sync",
        requirePointer: true,
      }),
    /SUPERSEDED/,
  );

  // 2) Late in-flight predecessor PUT .state.json landing AFTER successor cleanup is blocked by committed-state.json
  const s3Ledger = createMockS3();
  globalThis.fetch = s3Ledger.fetch;
  const envLedger = fixtureEnv(r2Objects);
  const stgSucc = "staging/secondary-sync/claude-app-v5.11492.5/inst-succ-ledger";
  s3Ledger.objects.set(
    "staging/secondary-sync/active-sync.json",
    objectEntry(JSON.stringify({ instanceId: "inst-succ-ledger", manifestSha256: manifestSha, epoch: 500 }), old),
  );
  s3Ledger.objects.set(
    `${stgSucc}/objects/arm64`,
    objectEntry("PUB-ARM64-V5", old, { syncSha256: contentHashHex(bytes("PUB-ARM64-V5")) }),
  );
  s3Ledger.objects.set(
    `${stgSucc}/objects/manifest`,
    objectEntry(manifestText, old, { syncSha256: manifestSha }),
  );
  const succArm = await commitSingleAlias(envLedger, `${stgSucc}/objects/arm64`, "latest/win-arm64", {
    keepBackup: true,
    expectedManifestSha256: manifestSha,
    instanceId: "inst-succ-ledger",
    stagePrefix: stgSucc,
  });
  const succMan = await commitSingleAlias(envLedger, `${stgSucc}/objects/manifest`, "latest/manifest", {
    keepBackup: true,
    expectedManifestSha256: manifestSha,
    instanceId: "inst-succ-ledger",
    stagePrefix: stgSucc,
  });
  await recordSwitchoverCommittedCheckpoint(envLedger, stgSucc, [succArm, succMan], {
    releaseTag: "claude-app-v5.11492.5",
    manifestSha256: manifestSha,
    instanceId: "inst-succ-ledger",
  });
  await cleanupStageObjects(
    envLedger,
    [
      { stageKey: `${stgSucc}/objects/arm64`, aliasKeys: ["latest/win-arm64"] },
      { stageKey: `${stgSucc}/objects/manifest`, aliasKeys: ["latest/manifest"] },
    ],
    stgSucc,
    {
      switchoverComplete: true,
      purgeSupersededOrphans: true,
      expectedManifestSha256: manifestSha,
      instanceId: "inst-succ-ledger",
    },
  );
  assert.equal(s3Ledger.objects.has(`${stgSucc}/backups/_batch_committed.json`), false);
  assert.equal(s3Ledger.objects.has("staging/secondary-sync/committed-state.json"), true);
  const stgLatePred = "staging/secondary-sync/claude-app-v5.11492.0/inst-late-pred";
  const detLateArm = aliasBackupKeys("", "latest/win-arm64", stgLatePred);
  s3Ledger.objects.set(
    detLateArm.stateKey,
    objectEntry(
      JSON.stringify({
        aliasKey: "latest/win-arm64",
        backupKey: detLateArm.backupKey,
        stateKey: detLateArm.stateKey,
        hadExisting: false,
        absentBaselineVerified: true,
        ownerEpoch: 450,
        restored: false,
      }),
      new Date(),
    ),
  );
  s3Ledger.objects.set(
    "staging/secondary-sync/active-sync.json",
    objectEntry(JSON.stringify({ instanceId: "inst-next-fail", manifestSha256: manifestSha, epoch: 510 }), new Date()),
  );
  await rollbackCommittedAliases(envLedger, [], {
    expectedManifestSha256: manifestSha,
    instanceId: "inst-next-fail",
    stagePrefix: "staging/secondary-sync/claude-app-v5.11492.5/inst-next-fail",
  });
  assert.equal(text(s3Ledger.objects.get("latest/win-arm64").bytes), "PUB-ARM64-V5");

  // 3 & 4) Restarted slot ignores its own superseded Run-#1 state/_batch_restored, and reused dir at epoch 630 > 610 survives pruning and recovers
  const s3Slot = createMockS3();
  globalThis.fetch = s3Slot.fetch;
  const envSlot = {
    ...fixtureEnv(r2Objects),
    SECONDARY_MIRROR_WORKFLOW: {
      async get() {
        return {
          id: "inst-slot-s1",
          async status() {
            return { status: "errored" };
          },
        };
      },
    },
  };
  const stgS1 = "staging/secondary-sync/claude-app-v5.11492.5/inst-slot-s1";
  const detS1Win = aliasBackupKeys(`${stgS1}/objects/win`, "latest/win-x64", stgS1);
  s3Slot.objects.set(detS1Win.backupKey, objectEntry("OLD-WIN-600", old));
  s3Slot.objects.set(
    detS1Win.stateKey,
    objectEntry(
      JSON.stringify({
        aliasKey: "latest/win-x64",
        backupKey: detS1Win.backupKey,
        stateKey: detS1Win.stateKey,
        hadExisting: true,
        backupVerified: true,
        backupSize: bytes("OLD-WIN-600").byteLength,
        backupSha256: contentHashHex(bytes("OLD-WIN-600")),
        ownerEpoch: 600,
        restored: false,
      }),
      old,
    ),
  );
  s3Slot.objects.set(
    `${stgS1}/backups/_batch_restored.json`,
    objectEntry(
      JSON.stringify({
        completed: true,
        ownerEpoch: 600,
        restored: ["latest/win-arm64"],
        entries: [{ aliasKey: "latest/win-arm64", backupKey: "", stateKey: "", hadExisting: false }],
        completedAt: old.toISOString(),
      }),
      old,
    ),
  );
  s3Slot.objects.set("latest/win-x64", objectEntry("NEW-WIN-610", old, { syncSha256: contentHashHex(bytes("NEW-WIN-610")) }));
  s3Slot.objects.set("latest/win-arm64", objectEntry("NEW-ARM64-610", old, { syncSha256: contentHashHex(bytes("NEW-ARM64-610")) }));
  s3Slot.objects.set("latest/manifest", objectEntry(manifestText, old, { syncSha256: manifestSha }));
  const stgPub610 = "staging/secondary-sync/claude-app-v5.11492.5/inst-pub-610";
  s3Slot.objects.set(
    "staging/secondary-sync/active-sync.json",
    objectEntry(JSON.stringify({ instanceId: "inst-pub-610", manifestSha256: manifestSha, epoch: 610 }), old),
  );
  await recordSwitchoverCommittedCheckpoint(envSlot, stgPub610, [], {
    releaseTag: "claude-app-v5.11492.5",
    manifestSha256: manifestSha,
    instanceId: "inst-pub-610",
    supersededBackupDirs: [`${stgS1}/backups/`],
  });
  s3Slot.objects.set(
    "staging/secondary-sync/active-sync.json",
    objectEntry(JSON.stringify({ instanceId: "inst-slot-s1", manifestSha256: manifestSha, epoch: 620 }), old),
  );
  await rollbackCommittedAliases(envSlot, [], {
    expectedManifestSha256: manifestSha,
    instanceId: "inst-slot-s1",
    stagePrefix: stgS1,
  });
  assert.equal(text(s3Slot.objects.get("latest/win-x64").bytes), "NEW-WIN-610");
  assert.equal(text(s3Slot.objects.get("latest/win-arm64").bytes), "NEW-ARM64-610");

  let supersede630 = false;
  const s3Reuse = createMockS3({
    onDelete(delKey, store) {
      if (supersede630 && delKey === "latest/win-x64") {
        store.delete(delKey);
        store.set(
          "staging/secondary-sync/active-sync.json",
          objectEntry(JSON.stringify({ instanceId: "inst-640", manifestSha256: manifestSha, epoch: 640 }), old),
        );
        return new Response(null, { status: 204 });
      }
      return null;
    },
  });
  for (const [k, v] of s3Slot.objects.entries()) {
    s3Reuse.objects.set(k, v);
  }
  globalThis.fetch = s3Reuse.fetch;
  s3Reuse.objects.set(
    "staging/secondary-sync/active-sync.json",
    objectEntry(JSON.stringify({ instanceId: "inst-slot-s1", manifestSha256: manifestSha, epoch: 630 }), old),
  );
  s3Reuse.objects.set(
    `${stgS1}/objects/win`,
    objectEntry("REPAIR-WIN-630", old, { syncSha256: contentHashHex(bytes("REPAIR-WIN-630")) }),
  );
  supersede630 = true;
  await assert.rejects(
    () =>
      commitSingleAlias(envSlot, `${stgS1}/objects/win`, "latest/win-x64", {
        keepBackup: true,
        force: true,
        expectedManifestSha256: manifestSha,
        instanceId: "inst-slot-s1",
        stagePrefix: stgS1,
      }),
    /SUPERSEDED/,
  );
  supersede630 = false;
  for (const [k, v] of s3Reuse.objects.entries()) {
    if (k.startsWith(stgS1)) v.lastModified = old;
  }
  await pruneAbandonedStageObjects(envSlot, "", { graceHours: 1 });
  assert.equal(s3Reuse.objects.has(detS1Win.backupKey), true);
  await rollbackCommittedAliases(envSlot, [], {
    expectedManifestSha256: manifestSha,
    instanceId: "inst-640",
    stagePrefix: "staging/secondary-sync/claude-app-v5.11492.5/inst-640",
  });
  assert.equal(text(s3Reuse.objects.get("latest/win-x64").bytes), "NEW-WIN-610");

  // 5 & 6) Restart invalidation when _batch_committed.json was missing persists guard BEFORE deleting <manifest>.state.json, and failure cleanup retains priorRunSuperseded
  const s3Inv = createMockS3();
  globalThis.fetch = s3Inv.fetch;
  const envInv = {
    ...fixtureEnv(r2Objects),
    SECONDARY_MIRROR_WORKFLOW: {
      async get() {
        return null;
      },
    },
  };
  const stgPred700 = "staging/secondary-sync/claude-app-v5.11492.0/inst-pred-700";
  const detPred700 = aliasBackupKeys(`${stgPred700}/objects/win`, "latest/win-x64", stgPred700);
  s3Inv.objects.set(detPred700.backupKey, objectEntry("OBSOLETE-700-WIN", old));
  s3Inv.objects.set(
    detPred700.stateKey,
    objectEntry(
      JSON.stringify({
        aliasKey: "latest/win-x64",
        backupKey: detPred700.backupKey,
        stateKey: detPred700.stateKey,
        hadExisting: true,
        backupVerified: true,
        backupSize: bytes("OBSOLETE-700-WIN").byteLength,
        backupSha256: contentHashHex(bytes("OBSOLETE-700-WIN")),
        ownerEpoch: 700,
        restored: false,
      }),
      old,
    ),
  );
  const plan710 = decoratePlanWithStage(
    buildObjectPlan(manifest, "claude-app-v5.11492.5", { manifestText, manifestSha256: manifestSha }),
    "inst-slot-710",
    envInv,
  );
  const det710Man = aliasBackupKeys("", "latest/manifest", plan710.stagePrefix);
  s3Inv.objects.set("latest/win-x64", objectEntry("LIVE-710-WIN", old, { syncSha256: contentHashHex(bytes("LIVE-710-WIN")) }));
  s3Inv.objects.set("latest/manifest", objectEntry(manifestText, old, { syncSha256: manifestSha }));
  s3Inv.objects.set(
    det710Man.stateKey,
    objectEntry(
      JSON.stringify({
        aliasKey: "latest/manifest",
        backupKey: det710Man.backupKey,
        stateKey: det710Man.stateKey,
        hadExisting: false,
        absentBaselineVerified: true,
        ownerEpoch: 710,
        targetManifestSha256: manifestSha,
        supersededBackupDirs: [`${stgPred700}/backups/`],
        restored: false,
      }),
      old,
    ),
  );
  s3Inv.objects.set(
    "staging/secondary-sync/active-sync.json",
    objectEntry(JSON.stringify({ instanceId: "inst-slot-710", manifestSha256: manifestSha, epoch: 720 }), old),
  );
  const invRes = await verifyPriorSwitchoverCheckpoint(
    envInv,
    { releaseTag: "claude-app-v5.11492.5", manifest, manifestText, manifestSha256: manifestSha },
    plan710,
    { instanceId: "inst-slot-710" },
  );
  assert.equal(invRes, null);
  assert.equal(s3Inv.objects.has(`${plan710.stagePrefix}/backups/_batch_committed.json`), true);
  assert.equal(s3Inv.objects.has("staging/secondary-sync/committed-state.json"), true);
  await rollbackCommittedAliases(envInv, [], {
    expectedManifestSha256: manifestSha,
    instanceId: "inst-slot-710",
    stagePrefix: plan710.stagePrefix,
  });
  assert.equal(text(s3Inv.objects.get("latest/win-x64").bytes), "LIVE-710-WIN");
  await cleanupStageObjects(envInv, plan710.items, plan710.stagePrefix, {
    switchoverComplete: false,
    expectedManifestSha256: manifestSha,
    instanceId: "inst-slot-710",
  });
  assert.equal(s3Inv.objects.has(`${plan710.stagePrefix}/backups/_batch_committed.json`), true);
  await rollbackCommittedAliases(envInv, [], {
    expectedManifestSha256: manifestSha,
    instanceId: "inst-slot-710",
    stagePrefix: plan710.stagePrefix,
  });
  assert.equal(text(s3Inv.objects.get("latest/win-x64").bytes), "LIVE-710-WIN");

  // 8) Mixed LIST-fallback + unstamped authoritative HEAD schedules migration with 0 binary GET bytes
  const bigMac = new Uint8Array(6 * 1024 * 1024);
  bigMac.fill(0x43);
  const r2Mixed = fixtureR2Objects(manifest, { "latest/mac": bigMac });
  const mixedManText = text(r2Mixed.get("latest/manifest"));
  const mixedManSha = contentHashHex(r2Mixed.get("latest/manifest"));
  r2Mixed.set(
    "latest/checksums",
    bytes(
      [
        `${contentHashHex(bigMac)}  Claude-mac-universal.dmg`,
        `${contentHashHex(r2Mixed.get("latest/win-x64"))}  Claude-win-x64.msix`,
        `${contentHashHex(r2Mixed.get("latest/win-arm64"))}  Claude-win-arm64.msix`,
        `${contentHashHex(r2Mixed.get("latest/linux-x64"))}  Claude-linux-x64.deb`,
        `${contentHashHex(r2Mixed.get("latest/linux-arm64"))}  Claude-linux-arm64.deb`,
        `${mixedManSha}  release-manifest.json`,
      ].join("\n") + "\n",
    ),
  );
  let binaryGetBytes = 0;
  const s3Mixed = createMockS3({
    onHead(key) {
      if (key === "latest/mac") {
        return new Response("Forbidden", { status: 403 });
      }
      return null;
    },
    onGet(key, store, reqHeaders) {
      if (key === "latest/mac") {
        if (reqHeaders?.get("range")) {
          return new Response("Forbidden", { status: 403 });
        }
        const ent = store.get(key);
        if (ent) binaryGetBytes += ent.bytes.byteLength;
      }
      return null;
    },
  });
  globalThis.fetch = s3Mixed.fetch;
  const mixedPlan = buildObjectPlan(manifest, "claude-app-v5.11492.5", {
    manifestText: mixedManText,
    manifestSha256: mixedManSha,
  });
  for (const item of mixedPlan.items) {
    const val = r2Mixed.get(item.sourceKey) || bytes(item.inlineText || "");
    for (const ak of item.aliasKeys) {
      s3Mixed.objects.set(ak, objectEntry(val, old));
    }
  }
  const mixedRes = await reconcileSync(
    {
      ...fixtureEnv(r2Mixed),
      SECONDARY_SYNC_SINGLE_PUT_MAX_BYTES: String(5 * 1024 * 1024),
      SECONDARY_MIRROR_WORKFLOW: {
        async get() {
          return null;
        },
        async create({ id }) {
          return {
            id,
            async status() {
              return { status: "running" };
            },
          };
        },
      },
    },
    {},
  );
  assert.equal(mixedRes.created, true);
  assert.equal(binaryGetBytes, 0, "mixed HEAD visibility must NOT stream 6 MiB installer before spotting unstamped alias");
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
  const manifestJson = JSON.stringify(manifest);
  const manifestHex = contentHashHex(bytes(manifestJson));
  return new Map(
    Object.entries({
      "latest/mac": "mac-dmg",
      "latest/win-x64": "win-x64",
      "latest/win-arm64": "win-arm64",
      "latest/linux-x64": "linux-x64",
      "latest/linux-arm64": "linux-arm64",
      "latest/checksums": `${manifestHex}  release-manifest.json\n`,
      "latest/manifest": manifestJson,
      ...overrides,
    }).map(([key, value]) => [key, bytes(value)]),
  );
}

function fixtureEnv(r2Objects, r2Hooks = {}) {
  return {
    GLOBAL_R2: new MockR2Bucket(r2Objects, r2Hooks),
    SECONDARY_S3_ENDPOINT: "https://s3.example.test",
    SECONDARY_S3_BUCKET: "bucket",
    SECONDARY_S3_REGION: "auto",
    SECONDARY_S3_ACCESS_KEY_ID: "key",
    SECONDARY_S3_SECRET_ACCESS_KEY: "secret",
    SECONDARY_S3_RETRY_BASE_DELAY_MS: "0",
  };
}

class MockR2Bucket {
  constructor(objects, hooks = {}) {
    this.objects = objects;
    this.onR2Get = hooks.onR2Get || null;
  }

  etagFor(value) {
    return contentHashHex(value);
  }

  async head(key) {
    const value = this.objects.get(key);
    return value ? { size: value.byteLength, etag: this.etagFor(value) } : null;
  }

  async get(key, options = {}) {
    if (this.onR2Get) {
      this.onR2Get(key, options);
    }
    const value = this.objects.get(key);
    if (!value) {
      return null;
    }
    const etag = this.etagFor(value);
    if (options.onlyIf?.etagMatches && options.onlyIf.etagMatches !== etag) {
      return { size: value.byteLength, etag };
    }
    const range = options.range;
    const sliced = range ? value.slice(range.offset, range.offset + range.length) : value;
    return {
      size: sliced.byteLength,
      etag,
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
  const onGet = options.onGet || (() => null);
  const onHead = options.onHead || (() => null);
  const onPut = options.onPut || (() => null);
  const onDelete = options.onDelete || (() => null);
  const onList = options.onList || (() => null);
  const onUploadPart = options.onUploadPart || (() => null);
  const onCompleteMultipart = options.onCompleteMultipart || (() => null);
  const onAbortMultipart = options.onAbortMultipart || (() => {});

  async function fetch(input, init = {}) {
    const url = new URL(input);
    const { key } = parseS3Path(url.pathname);
    const method = init.method || "GET";
    const headers = new Headers(init.headers || {});

    if (method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") || "";
      const injectedList = onList(prefix, objects);
      if (injectedList) {
        return injectedList;
      }
      const contents = [...objects.entries()]
        .filter(([objectKey]) => objectKey.startsWith(prefix))
        .map(
          ([objectKey, entry]) =>
            `<Contents><Key>${xmlEscape(objectKey)}</Key><LastModified>${entry.lastModified.toISOString()}</LastModified><ETag>${xmlEscape(entry.etag)}</ETag><Size>${entry.bytes.byteLength}</Size></Contents>`,
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
      const injectedHead = onHead(key, objects, headers);
      if (injectedHead) {
        return injectedHead;
      }
      if (key.includes("head-403")) {
        return new Response("forbidden", { status: 403 });
      }
      const entry = objects.get(key);
      if (!entry) {
        return new Response(null, { status: 404 });
      }
      const resHeaders = {
        "content-length": key.includes("head-zero") ? "0" : String(entry.bytes.byteLength),
        "last-modified": entry.lastModified.toUTCString(),
        etag: entry.etag,
      };
      if (entry.syncSha256) {
        resHeaders["x-amz-meta-sync-sha256"] = entry.syncSha256;
      }
      return new Response(null, {
        status: 200,
        headers: resHeaders,
      });
    }

    if (method === "GET") {
      const injectedGet = onGet(key, objects, headers);
      if (injectedGet) {
        return injectedGet;
      }
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
      uploads.set(uploadId, {
        key,
        parts: new Map(),
        initiated: new Date(),
        syncSha256: headers.get("x-amz-meta-sync-sha256") || "",
      });
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
      const injectedComplete = onCompleteMultipart(key, url.searchParams.get("uploadId"));
      if (injectedComplete) {
        return injectedComplete;
      }
      const upload = uploads.get(url.searchParams.get("uploadId"));
      const joined = concatBytes([...upload.parts.entries()].sort(([a], [b]) => a - b).map(([, value]) => value));
      objects.set(
        upload.key,
        objectEntry(joined, new Date(), {
          etag: `"${contentHashHex(joined)}-${upload.parts.size}"`,
          syncSha256: upload.syncSha256,
        }),
      );
      uploads.delete(url.searchParams.get("uploadId"));
      return new Response("<CompleteMultipartUploadResult><ETag>\"mp\"</ETag></CompleteMultipartUploadResult>");
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
      const copiedEntry = objectEntry(source.bytes.slice(0), new Date(), {
        syncSha256: source.syncSha256,
      });
      objects.set(key, copiedEntry);
      return new Response(`<CopyObjectResult><ETag>${xmlEscape(copiedEntry.etag)}</ETag></CopyObjectResult>`);
    }

    if (method === "PUT") {
      const injectedPut = onPut(key, objects, headers);
      if (injectedPut) {
        return injectedPut;
      }
      objects.set(
        key,
        objectEntry(await bodyBytes(init.body), new Date(), {
          syncSha256: headers.get("x-amz-meta-sync-sha256") || "",
        }),
      );
      return new Response(null, { status: 200 });
    }

    if (method === "DELETE") {
      const injectedDelete = onDelete(key, objects);
      if (injectedDelete) {
        return injectedDelete;
      }
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

function contentHashHex(valueBytes) {
  const inc = createIncrementalSha256();
  inc.update(valueBytes);
  return inc.digestHex();
}

function objectEntry(value, lastModified = new Date(), meta = {}) {
  const valueBytes = value instanceof Uint8Array ? value : bytes(value);
  return {
    bytes: valueBytes,
    lastModified,
    etag: meta.etag || `"${contentHashHex(valueBytes).slice(0, 32)}"`,
    syncSha256: meta.syncSha256 || "",
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
