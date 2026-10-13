// A completed scan may only retire findings in files it actually re-read (a `synchronize`
// scan sees only the incremental diff). Asserts against a recording query-builder stub.

type Op = {op: string; args: unknown[]};
type Call = {table: string; ops: Op[]};

const calls: Call[] = [];

const SCAN_ROW = {repo_id: "repo-1", trigger_ref: "2", trigger_type: "pull_request"};
const PRIOR_SCANS = [{id: "scan-earlier"}];

// Chainable, thenable stub: awaiting resolves from the recorded ops, so writer order doesn't matter.
function resultFor(record: Call): unknown {
  const ops = record.ops.map((o) => o.op);
  if (record.table === "public_stats") {
    // Short-circuits updatePublicStats.
    return {data: null, error: {code: "PGRST116", message: "no rows"}};
  }
  if (record.table === "scans") {
    if (ops.includes("single")) return {data: SCAN_ROW, error: null};
    if (ops.includes("neq")) return {data: PRIOR_SCANS, error: null};
    if (ops.includes("update")) return {data: [{id: "scan-current"}], error: null};
    return {data: [], error: null};
  }
  return {data: null, error: null};
}

function builder(table: string): unknown {
  const record: Call = {table, ops: []};
  calls.push(record);
  const chain: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") {
          return (resolve: (v: unknown) => unknown) => resolve(resultFor(record));
        }
        return (...args: unknown[]) => {
          record.ops.push({op: String(prop), args});
          return chain;
        };
      },
    },
  );
  return chain;
}

jest.mock("../client", () => ({
  supabase: {from: (table: string) => builder(table)},
}));

import {updateScanStatus} from "../queries";

function stalenessWrite(): Call | undefined {
  return calls.find(
    (c) => c.table === "findings" && c.ops.some((o) => o.op === "update"),
  );
}

function argsOf(call: Call, op: string): unknown[] | undefined {
  return call.ops.find((o) => o.op === op)?.args;
}

// markStaleFindings is fire-and-forget; let its promise chain drain.
const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  calls.length = 0;
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe("scan completion — what a scan is allowed to retire", () => {
  it("scopes the staleness write to the files the scan examined", async () => {
    await updateScanStatus("scan-current", [], 100, "complete", {
      examinedPaths: ["src/x.ts", "src/y.ts"],
    });
    await flush();

    const write = stalenessWrite();
    expect(write).toBeDefined();
    expect(argsOf(write!, "update")).toEqual([{is_stale: true}]);
    // Without this filter the update hits every open finding on the PR.
    expect(write!.ops.filter((o) => o.op === "in")).toEqual(
      expect.arrayContaining([
        {op: "in", args: ["file_path", ["src/x.ts", "src/y.ts"]]},
      ]),
    );
  });

  it("retires nothing when the scan examined no files", async () => {
    await updateScanStatus("scan-current", [], 100, "complete", {
      examinedPaths: [],
    });
    await flush();

    expect(stalenessWrite()).toBeUndefined();
  });

  it("retires nothing when the caller reports no file scope at all", async () => {
    // Skips, failures and unparseable diffs take this path: fail toward keeping findings visible.
    await updateScanStatus("scan-current", [], 100, "complete");
    await flush();

    expect(stalenessWrite()).toBeUndefined();
  });

  it("leaves resolved and dismissed findings alone", async () => {
    await updateScanStatus("scan-current", [], 100, "complete", {
      examinedPaths: ["src/x.ts"],
    });
    await flush();

    const write = stalenessWrite()!;
    const eqs = write.ops.filter((o) => o.op === "eq");
    expect(eqs).toEqual(
      expect.arrayContaining([
        {op: "eq", args: ["is_resolved", false]},
        {op: "eq", args: ["is_false_positive", false]},
        {op: "eq", args: ["is_stale", false]},
      ]),
    );
  });

  it("does not run the staleness write for a scan that did not complete", async () => {
    await updateScanStatus("scan-current", [], 100, "failed", {
      failureReason: "pipeline_error",
      examinedPaths: ["src/x.ts"],
    });
    await flush();

    expect(stalenessWrite()).toBeUndefined();
  });
});
