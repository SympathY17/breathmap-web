import { describe, expect, it, vi } from "vitest";
const mocked = vi.hoisted(() => ({ requireSupabase: vi.fn() }));
vi.mock("./user", () => ({ useCurrentUser: () => null }));
vi.mock("./supabase", () => ({ requireSupabase: mocked.requireSupabase, supabase: null }));
import { applyWhere, fetchPage, q, savedSummary, writableFields } from "./datasource";

describe("legacy query adapter", () => {
  it("combines UUID-bound queries with translated date and boolean filters", () => {
    const calls: any[] = [];
    const query: any = Object.fromEntries(["eq", "gte", "lte", "lt", "is"].map(method => [method, (...args: any[]) => { calls.push([method, ...args]); return query; }]));
    applyWhere(query, "diary", q.and(q.text("owner").is("a@example.com"), q.date("date").gte("2026-10-20"), q.date("date").lte("2026-10-28")), "a@example.com");
    expect(calls).toEqual([["gte", "date", "2026-10-20"], ["lte", "date", "2026-10-28"]]);
    calls.length = 0;
    applyWhere(query, "routines", q.boolean("active").is(false), "a@example.com");
    expect(calls).toEqual([["eq", "active", false]]);
  });
  it("cannot use an old page email filter to select a different owner", () => {
    const query: any = { eq: vi.fn().mockReturnThis() };
    applyWhere(query, "recordings", q.text("owner").is("other@example.com"), "a@example.com");
    expect(query.eq).toHaveBeenCalledWith("id", "00000000-0000-0000-0000-000000000000");
    expect(() => applyWhere(query, "recordings", q.text("user_id").is("foreign-id"), "a@example.com")).toThrow("Unsupported query field");
  });
  it("fetches a real database page by Auth UUID and normalizes persisted routine time values", async () => {
    const calls: any[] = [];
    const rows = [{ id: "row-1", user_id: "auth-user", bed_time: "22:30:00", wake_time: "06:15:00", active: false, wind_down_minutes: 0, days: [1, 3], commitments: [] }];
    const query: any = Object.fromEntries(["select", "eq", "order"].map(method => [method, (...args: any[]) => { calls.push([method, ...args]); return query; }]));
    query.range = (start: number, end: number) => { calls.push(["range", start, end]); return Promise.resolve({ data: rows, count: 51, error: null }); };
    mocked.requireSupabase.mockReturnValue({ from: (table: string) => { calls.push(["from", table]); return query; } });
    const page = await fetchPage({ from: "routines", count: 50, where: q.text("owner").is("a@example.com") }, { id: "auth-user", email: "a@example.com" }, 50);
    expect(calls).toContainEqual(["eq", "user_id", "auth-user"]);
    expect(calls).toContainEqual(["range", 50, 99]);
    expect(page.total).toBe(51);
    expect(page.items[0].fields).toMatchObject({ bedTime: "22:30", wakeTime: "06:15", active: false, windDownMinutes: 0, owner: "a@example.com", days: "[1,3]" });
  });
});

describe("mutation boundary", () => {
  it("drops legacy owner fields and worker-controlled result state", () => {
    expect(writableFields("recordings", { title: "record", owner: "foreign", user: ["foreign"], status: "Completed", analysisSummary: "fake", uploadedAt: "yesterday" }, { title: "zeEkp" })).toEqual({ title: "record" });
    expect(() => writableFields("recordings", { user_id: "foreign" })).toThrow("Unsupported writable field");
  });
  it("preserves zero, false and null rather than coercing missing values", () => {
    expect(writableFields("diary", { awakeningCount: 0, sleepQuality: null, bedAt: null })).toEqual({ awakening_count: 0, sleep_quality: null, bed_at: null });
    expect(writableFields("routines", { active: false, windDownMinutes: 0 })).toEqual({ active: false, wind_down_minutes: 0 });
    expect(() => writableFields("reactions", { medianMs: Infinity })).toThrow("Invalid field value");
  });
  it("normalizes JSON and owned-reference formats while rejecting malformed links", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    expect(writableFields("monitoring", { recording: [id] })).toEqual({ recording_id: id });
    expect(writableFields("monitoring", { recording: [] })).toEqual({ recording_id: null });
    expect(writableFields("routines", { days: "[1,3]", commitments: "[]" })).toEqual({ days: [1, 3], commitments: [] });
    expect(() => writableFields("diary", { recordings: ["not-a-uuid"] })).toThrow("Invalid recording links");
    expect(() => writableFields("profiles", { relaxPreferences: "[]" })).toThrow("Invalid saved preferences");
  });
  it("keeps result metrics and independent report failure intact for old pages", () => {
    const display = { execution: { status: "partial" }, summary: { frequency_bpm: 0, mean_expiratory_flow_l_min: null }, report: { status: "failed" }, versions: { model: "model-v1" } };
    expect(savedSummary({ display })).toMatchObject({ schema: "breathmap-analysis-1.1", execution: { status: "partial" }, summary: { frequency_bpm: 0, mean_expiratory_flow_l_min: null } });
    expect(savedSummary({ summary: { schema: "breathmap-web-summary-1" } })).toEqual({ schema: "breathmap-web-summary-1" });
  });
});
