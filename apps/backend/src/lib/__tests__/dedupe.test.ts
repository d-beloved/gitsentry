import {isSameIssue, matchExisting, normalizeSnippet, type DedupeCandidate} from "../dedupe";

const base = {
  category: "sql_injection",
  file_path: "src/db.ts",
  line_number: 42,
  code_snippet: 'db.query(`SELECT * FROM users WHERE id = ${req.params.id}`)',
};

const candidate = (over: Partial<DedupeCandidate>): DedupeCandidate => ({
  ...base,
  id: "c1",
  is_false_positive: false,
  sameTrigger: false,
  ...over,
});

describe("isSameIssue", () => {
  it("matches the same snippet even when the line moved (different PR base)", () => {
    expect(isSameIssue(base, {...base, line_number: 57})).toBe(true);
  });

  it("ignores whitespace and diff markers in the quoted code", () => {
    expect(isSameIssue(base, {...base, code_snippet: `+   ${base.code_snippet}  `})).toBe(true);
  });

  it("matches a multi-line quote that contains the single-line one", () => {
    expect(isSameIssue(base, {...base, code_snippet: `const id = req.params.id;\n${base.code_snippet}`})).toBe(true);
  });

  it("does not treat a tiny shared fragment as the same issue", () => {
    expect(isSameIssue({...base, code_snippet: "});"}, {...base, code_snippet: "foo(); });"})).toBe(false);
  });

  it("requires the same category and file", () => {
    expect(isSameIssue(base, {...base, category: "xss"})).toBe(false);
    expect(isSameIssue(base, {...base, file_path: "src/other.ts"})).toBe(false);
  });

  it("falls back to the line when either side has no snippet", () => {
    expect(isSameIssue({...base, code_snippet: null}, base)).toBe(true);
    expect(isSameIssue({...base, code_snippet: null}, {...base, line_number: 43})).toBe(false);
  });
});

describe("matchExisting", () => {
  it("returns null when nothing on record matches", () => {
    expect(matchExisting(base, [candidate({category: "xss"})])).toBeNull();
  });

  it("inherits a dismissal over an open match", () => {
    const m = matchExisting(base, [candidate({id: "open"}), candidate({id: "fp", is_false_positive: true})]);
    expect(m).toEqual({kind: "dismissed", canonicalId: "fp"});
  });

  it("links to an open finding from another PR or branch", () => {
    expect(matchExisting(base, [candidate({id: "pr3"})])).toEqual({kind: "duplicate", canonicalId: "pr3"});
  });

  it("prefers another PR's finding over this PR's earlier one", () => {
    const m = matchExisting(base, [candidate({id: "mine", sameTrigger: true}), candidate({id: "pr3"})]);
    expect(m).toEqual({kind: "duplicate", canonicalId: "pr3"});
  });

  it("supersedes this PR's earlier open finding", () => {
    expect(matchExisting(base, [candidate({id: "mine", sameTrigger: true})])).toEqual({
      kind: "supersedes",
      canonicalId: "mine",
    });
  });

  it("picks the nearest line when several match", () => {
    const m = matchExisting(base, [candidate({id: "far", line_number: 400}), candidate({id: "near", line_number: 44})]);
    expect(m?.canonicalId).toBe("near");
  });
});

describe("normalizeSnippet", () => {
  it("keeps a leading minus that is part of the code", () => {
    expect(normalizeSnippet("-1")).toBe("-1");
  });
});
