const test = require("node:test");
const assert = require("node:assert/strict");

const IPCHandlers = require("../../src/helpers/ipcHandlers");

function completeBatch(overrides = {}) {
  return {
    complete: true,
    nextCursor: 0,
    scanned: 0,
    inserted: 0,
    skipped: 0,
    ...overrides,
  };
}

function createContext(backfillAnalyticsHistoryBatch) {
  return Object.assign(Object.create(IPCHandlers.prototype), {
    databaseManager: { backfillAnalyticsHistoryBatch },
    _analyticsHistoryBackfillPromise: null,
    _analyticsHistoryBackfilled: false,
  });
}

test("a failed history pass is absorbed and remains retryable", async () => {
  let attempts = 0;
  const context = createContext(() => {
    attempts += 1;
    if (attempts === 1) throw new Error("broken history row");
    return completeBatch();
  });

  assert.deepEqual(await context._ensureAnalyticsHistoryBackfilled(), {
    inserted: 0,
    scanned: 0,
  });
  assert.equal(context._analyticsHistoryBackfilled, false);

  assert.deepEqual(await context._ensureAnalyticsHistoryBackfilled(), {
    inserted: 0,
    scanned: 0,
  });
  assert.equal(attempts, 2);
  assert.equal(context._analyticsHistoryBackfilled, true);
});

test("concurrent readers share one pass and completed history is memoized", async () => {
  let calls = 0;
  const context = createContext(({ afterId }) => {
    calls += 1;
    return afterId === 0
      ? completeBatch({ complete: false, nextCursor: 10, scanned: 1 })
      : completeBatch({ nextCursor: 10, scanned: 1 });
  });

  const first = context._ensureAnalyticsHistoryBackfilled();
  const joining = context._ensureAnalyticsHistoryBackfilled();
  assert.deepEqual(await Promise.all([first, joining]), [
    { inserted: 0, scanned: 2 },
    { inserted: 0, scanned: 2 },
  ]);
  assert.equal(calls, 2, "joining the pass must not start a second scan");

  assert.deepEqual(await context._ensureAnalyticsHistoryBackfilled(), {
    inserted: 0,
    scanned: 0,
  });
  assert.equal(calls, 2, "a completed pass must short-circuit later reads");
});

test("a write that invalidates an in-flight pass remains visible to the next read", async () => {
  let calls = 0;
  const context = createContext(({ afterId }) => {
    calls += 1;
    return afterId === 0
      ? completeBatch({ complete: false, nextCursor: 10, scanned: 1 })
      : completeBatch({ nextCursor: 10, scanned: 1 });
  });

  const inFlight = context._ensureAnalyticsHistoryBackfilled();
  context._analyticsHistoryBackfilled = false;
  await inFlight;
  assert.equal(context._analyticsHistoryBackfilled, false);

  await context._ensureAnalyticsHistoryBackfilled();
  assert.equal(calls, 4, "the invalidating write must cause another complete pass");
});
