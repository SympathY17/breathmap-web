import { describe, expect, it, vi } from "vitest";
const mocked = vi.hoisted(() => ({ requireSupabase: vi.fn() }));
vi.mock("./user", () => ({ useCurrentUser: () => null }));
vi.mock("./supabase", () => ({ requireSupabase: mocked.requireSupabase, supabase: null }));
import { applyWhere, deleteRecordingWithLifecycle, fetchPage, insertRecordingWithRecovery, q, savedSummary, writableFields } from "./datasource";

const recordingOwner = "11111111-1111-4111-8111-111111111111";
const recordingId = "22222222-2222-4222-8222-222222222222";
const recordingSubmission = () => ({ id: recordingId, user_id: recordingOwner, file_path: `${recordingOwner}/${recordingId}/input.xlsx`, file_name: "synthetic.xlsx", file_size: 1234, input_sha256: "a".repeat(64), title: "Synthetic recording", details: "Quiet room", notes: "Synthetic only", recorded_at: "2026-10-28T01:00:00.000Z" });

function recordingServer(options: { row?: any; loseInsertAck?: "response" | "throw"; loseFirstRead?: boolean; insertError?: any } = {}) {
  // A small server model: INSERT commits atomically before the transport can
  // lose its acknowledgement, and a duplicate ID never updates that row.
  const rows = new Map<string, any>();
  if (options.row) rows.set(options.row.id, structuredClone(options.row));
  let inserted = 0, lookups = 0;
  const reads: any[] = [];
  const client: any = {
    from: vi.fn((table: string) => {
      expect(table).toBe("recordings");
      let input: any;
      const filters: Array<[string, any]> = [];
      const query: any = {
        insert: (value: any) => { input = structuredClone(value); return query; },
        select: () => query,
        eq: (key: string, value: any) => { filters.push([key, value]); return query; },
        single: async () => {
          inserted++;
          if (options.insertError) return { data: null, error: options.insertError, status: 400 };
          if (rows.has(input.id)) return { data: null, error: { code: "23505", message: "duplicate key" }, status: 409 };
          const saved = { ...input, recorded_at: input.recorded_at.replace("Z", "+00:00"), uploaded_at: "2026-10-28T02:00:00+00:00", trashed_at: null };
          rows.set(saved.id, saved);
          if (options.loseInsertAck === "throw") throw new TypeError("Failed to fetch: acknowledgement lost after commit");
          if (options.loseInsertAck === "response") return { data: null, error: { code: "", message: "TypeError: Failed to fetch" }, status: 0 };
          return { data: structuredClone(saved), error: null, status: 201 };
        },
        maybeSingle: async () => {
          lookups++; reads.push([...filters]);
          if (options.loseFirstRead && lookups === 1) throw new TypeError("Recovery read is offline");
          const row = [...rows.values()].find(value => filters.every(([key, expected]) => value[key] === expected));
          return { data: row ? structuredClone(row) : null, error: null };
        },
      };
      return query;
    }),
  };
  return { client, rows, reads, inserts: () => inserted, lookups: () => lookups };
}

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

describe("recording creation acknowledgement recovery", () => {
  it("recovers a committed recording after an ambiguous network response", async () => {
    const server = recordingServer({ loseInsertAck: "response" });
    const submitted = recordingSubmission();
    const saved = await insertRecordingWithRecovery(server.client, submitted, recordingOwner);
    expect(saved.id).toBe(recordingId);
    expect(server.rows.size).toBe(1);
    expect(server.inserts()).toBe(1);
    expect(server.reads).toEqual([[["id", recordingId], ["user_id", recordingOwner]]]);
  });
  it("retains the same upload UUID across lost acknowledgement and a failed recovery read, then resolves the duplicate on retry", async () => {
    const server = recordingServer({ loseInsertAck: "throw", loseFirstRead: true });
    const submitted = recordingSubmission();
    await expect(insertRecordingWithRecovery(server.client, submitted, recordingOwner)).rejects.toThrow("could not be confirmed");
    expect(server.rows.size).toBe(1);
    expect(submitted.id).toBe(recordingId);
    expect(submitted.file_path).toBe(`${recordingOwner}/${recordingId}/input.xlsx`);
    const saved = await insertRecordingWithRecovery(server.client, submitted, recordingOwner);
    expect(saved).toMatchObject({ id: recordingId, title: submitted.title, notes: submitted.notes, input_sha256: submitted.input_sha256 });
    expect(server.rows.size).toBe(1);
    expect(server.inserts()).toBe(2);
    expect(server.lookups()).toBe(2);
    expect(server.reads.every(filters => filters.some(([key, value]: any) => key === "user_id" && value === recordingOwner))).toBe(true);
  });
  it.each([
    ["file_path", "wrong/path/input.xlsx"],
    ["file_name", "another.xlsx"],
    ["input_sha256", "b".repeat(64)],
    ["file_size", 1235],
    ["title", "A newer title"],
    ["details", "A newer detail"],
    ["notes", "A newer note"],
    ["recorded_at", "2026-10-28T01:00:01Z"],
    ["trashed_at", "2026-10-28T03:00:00Z"],
  ])("does not accept or overwrite a duplicate whose %s differs", async (key, different) => {
    const submitted = recordingSubmission();
    const row = { ...submitted, trashed_at: null, [key]: different };
    const server = recordingServer({ row });
    await expect(insertRecordingWithRecovery(server.client, submitted, recordingOwner)).rejects.toThrow("different saved data");
    expect(server.rows.get(recordingId)).toEqual(row);
    expect(server.rows.size).toBe(1);
  });
  it("never recovers a different owner's row", async () => {
    const submitted = recordingSubmission();
    const foreign = { ...submitted, user_id: "33333333-3333-4333-8333-333333333333", trashed_at: null };
    const server = recordingServer({ row: foreign });
    await expect(insertRecordingWithRecovery(server.client, submitted, recordingOwner)).rejects.toThrow("duplicate key");
    expect(server.reads[0]).toContainEqual(["user_id", recordingOwner]);
    expect(server.rows.get(recordingId)).toEqual(foreign);
  });
  it("keeps definite validation failures as errors instead of accepting a pre-existing row", async () => {
    const submitted = recordingSubmission();
    const server = recordingServer({ row: { ...submitted, trashed_at: null }, insertError: { code: "23514", message: "connection check constraint failed" } });
    await expect(insertRecordingWithRecovery(server.client, submitted, recordingOwner)).rejects.toThrow("check constraint failed");
    expect(server.lookups()).toBe(0);
  });
});

function deletionServer(options: { beginError?: string; removeFailure?: boolean; malformedAck?: boolean; filteredRemoveBucket?: string; invalidListBucket?: string } = {}) {
  const state = { exists: true, marked: false, failed: false };
  const events: string[] = [];
  const prefix = `${recordingOwner}/${recordingId}`, hash = 'a'.repeat(64);
  const files: Record<string, Set<string>> = {
    recordings: new Set([`${prefix}/input.xlsx`]),
    'analysis-artifacts': new Set([`${prefix}/${hash}/overview-job.json`]),
  };
  const client: any = {
    rpc: async (name: string, input: any) => {
      events.push('begin'); expect(name).toBe('begin_recording_deletion'); expect(input).toEqual({ p_recording_id: recordingId });
      if (options.beginError) return { data: null, error: { message: options.beginError } };
      state.marked = true;
      return { data: options.malformedAck ? { id: recordingId } : { id: recordingId, file_path: `${prefix}/input.xlsx`, deletion_started_at: '2026-10-28T06:00:00Z' }, error: null };
    },
    storage: { from: (bucket: string) => ({
      list: async (folder: string) => {
        events.push(`list:${bucket}`); expect(state.marked).toBe(true);
        if (bucket === options.invalidListBucket) return { data: null, error: null };
        const children = new Map<string, any>();
        for (const file of files[bucket]) {
          if (!file.startsWith(folder + '/')) continue;
          const tail = file.slice(folder.length + 1), name = tail.split('/')[0];
          children.set(name, { name, id: tail.includes('/') ? null : 'object-id' });
        }
        return { data: [...children.values()], error: null };
      },
      remove: async (paths: string[]) => {
        events.push(`remove:${bucket}`); expect(state.marked).toBe(true);
        if (options.removeFailure && !state.failed) { state.failed = true; return { data: null, error: { message: 'Network interruption' } }; }
        if (bucket === options.filteredRemoveBucket) return { data: [], error: null };
        for (const path of paths) files[bucket].delete(path);
        return { data: [], error: null };
      },
    }) },
    from: (table: string) => {
      expect(table).toBe('recordings'); const filters: any[] = [];
      const query: any = {
        delete: () => query,
        eq: (...args: any[]) => { filters.push(args); return query; },
        not: (...args: any[]) => { filters.push(args); return query; },
        select: () => query,
        single: async () => {
          events.push('delete-row'); expect(state.marked).toBe(true);
          expect(files.recordings.size + files['analysis-artifacts'].size).toBe(0);
          expect(filters).toContainEqual(['user_id', recordingOwner]);
          expect(filters).toContainEqual(['deletion_started_at', 'is', null]);
          state.exists = false; return { data: { id: recordingId }, error: null };
        },
      };
      return query;
    },
  };
  return { client, state, events, files };
}

describe('permanent deletion lifecycle', () => {
  it.each(['RECORDING_ANALYSIS_RUNNING', 'RECORDING_TASK_BUSY'])('does not touch any files when the server reports %s', async code => {
    const server = deletionServer({ beginError: code });
    await expect(deleteRecordingWithLifecycle(server.client, recordingId, recordingOwner)).rejects.toThrow(code);
    expect(server.events).toEqual(['begin']); expect(server.state.exists).toBe(true); expect(server.state.marked).toBe(false);
  });
  it('requires an acknowledged, owner-bound deletion marker before file removal', async () => {
    const server = deletionServer({ malformedAck: true });
    await expect(deleteRecordingWithLifecycle(server.client, recordingId, recordingOwner)).rejects.toThrow('Deletion could not be confirmed');
    expect(server.events).toEqual(['begin']); expect(server.files.recordings.size).toBe(1);
  });
  it('keeps a failed cleanup marked and retries it before deleting the row', async () => {
    const server = deletionServer({ removeFailure: true });
    await expect(deleteRecordingWithLifecycle(server.client, recordingId, recordingOwner)).rejects.toThrow('Network interruption');
    expect(server.state).toMatchObject({ exists: true, marked: true });
    expect(server.events).not.toContain('delete-row');
    await deleteRecordingWithLifecycle(server.client, recordingId, recordingOwner);
    expect(server.events.at(-1)).toBe('delete-row'); expect(server.state.exists).toBe(false);
    expect(server.files.recordings.size + server.files['analysis-artifacts'].size).toBe(0);
    expect(server.events.filter(event => event === 'begin')).toHaveLength(2);
  });
  it('does not let forms forge the read-only deletion marker', () => {
    expect(() => writableFields('recordings', { deletionStartedAt: '2026-10-28T06:00:00Z' })).toThrow('managed by the server');
  });
  it.each(['recordings', 'analysis-artifacts'])('keeps metadata and its marker when HTTP 200 removes no %s objects', async bucket => {
    const server = deletionServer({ filteredRemoveBucket: bucket });
    await expect(deleteRecordingWithLifecycle(server.client, recordingId, recordingOwner)).rejects.toThrow('File cleanup could not be confirmed');
    expect(server.state).toMatchObject({ exists: true, marked: true });
    expect(server.events).not.toContain('delete-row');
    expect(server.files[bucket].size).toBe(1);
    expect(server.events.filter(event=>event===`list:${bucket}`).length).toBeGreaterThanOrEqual(1);
  });
  it('accepts an already absent input on retry only after both fresh prefix listings are empty', async () => {
    const server = deletionServer();
    server.files.recordings.clear();
    await deleteRecordingWithLifecycle(server.client, recordingId, recordingOwner);
    expect(server.state.exists).toBe(false);
    const finalLists=server.events.slice(server.events.indexOf('remove:recordings')+1,-1);
    expect(finalLists).toContain('list:analysis-artifacts');expect(finalLists).toContain('list:recordings');
    expect(server.events.at(-1)).toBe('delete-row');
  });
  it('keeps metadata when the origin list has no valid acknowledgement', async () => {
    const server = deletionServer({ invalidListBucket: 'recordings' });
    await expect(deleteRecordingWithLifecycle(server.client, recordingId, recordingOwner)).rejects.toThrow('File cleanup could not be confirmed');
    expect(server.state).toMatchObject({ exists: true, marked: true });
    expect(server.events).not.toContain('delete-row');
  });
});
