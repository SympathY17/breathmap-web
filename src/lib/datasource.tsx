import { useCallback, useEffect, useRef, useState } from "react";
import { requireSupabase, supabase } from "./supabase";
import { useCurrentUser } from "./user";

export type TableName = "recordings" | "profiles" | "diary" | "monitoring" | "routines" | "visits" | "reactions";
export interface DataRecord { id: string; fields: Record<string, any>; }
type Selection = Record<string, string>;
type Predicate = { field: string; operation: "is" | "gte" | "lte" | "lt"; value: unknown } | { and: Predicate[] };
type QueryOptions = { from: TableName; select?: Selection; count?: number; where?: Predicate; orderBy?: { field: string; ascending: boolean }; enabled?: boolean };
type DataPage = { items: DataRecord[]; total: number };
type LoadState = { owner: string; status: "pending" | "success" | "error"; pages: DataPage[]; hasMore: boolean; fetchingMore: boolean; error?: Error };

export const TABLE_FIELDS: Record<TableName, Record<string, string>> = {
  recordings: { title: "title", notes: "notes", details: "details", recordedAt: "recorded_at", uploadedAt: "uploaded_at", trashedAt: "trashed_at" },
  profiles: { name: "name", relaxPreferences: "relax_preferences" },
  diary: { title: "title", date: "date", bedAt: "bed_at", wakeAt: "wake_at", awakeningCount: "awakening_count", sleepQuality: "sleep_quality", daySleepiness: "day_sleepiness", caffeineNote: "caffeine_note", notes: "notes", recordings: "recordings" },
  monitoring: { title: "title", scheduledAt: "scheduled_at", status: "status", notes: "notes", recording: "recording_id" },
  routines: { title: "title", bedTime: "bed_time", wakeTime: "wake_time", targetMinutes: "target_minutes", windDownMinutes: "wind_down_minutes", days: "days", commitments: "commitments", active: "active" },
  visits: { title: "title", appointmentAt: "appointment_at", concerns: "concerns", questions: "questions", notes: "notes", afterNotes: "after_notes", status: "status", recordings: "recordings", diaryFrom: "diary_from", diaryTo: "diary_to" },
  reactions: { title: "title", completedAt: "completed_at", medianMs: "median_ms", meanMs: "mean_ms", misses: "misses", falseStarts: "false_starts", validTrials: "valid_trials", trialCount: "trial_count", sleepiness: "sleepiness", trialsJson: "trials_json", testVersion: "test_version", deviceClass: "device_class", notes: "notes" },
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const BUCKET = "recordings";
const DATA_EVENT = "breathmap:data-changed";

function filter(field: string) {
  return {
    is: (value: unknown): Predicate => ({ field, operation: "is", value }),
    gte: (value: unknown): Predicate => ({ field, operation: "gte", value }),
    lte: (value: unknown): Predicate => ({ field, operation: "lte", value }),
    lt: (value: unknown): Predicate => ({ field, operation: "lt", value }),
  };
}
export const q = {
  select: <T extends Selection>(selection: T) => selection,
  text: filter, date: filter, boolean: filter,
  and: (...conditions: Predicate[]): Predicate => ({ and: conditions }),
  asc: (field: string) => ({ field, ascending: true }),
  desc: (field: string) => ({ field, ascending: false }),
};
export const datasource = { define: <T extends Record<string, TableName>>(tables: T) => tables };

function safeTable(table: string): asserts table is TableName {
  if (!Object.hasOwn(TABLE_FIELDS, table)) throw new Error("Unsupported data source.");
}
function column(table: TableName, field: string) {
  const found = TABLE_FIELDS[table][field];
  if (!found) throw new Error("Unsupported query field.");
  return found;
}
export function applyWhere(query: any, table: TableName, predicate: Predicate | undefined, email: string): any {
  if (!predicate) return query;
  if ("and" in predicate) return predicate.and.reduce((current, part) => applyWhere(current, table, part, email), query);
  if (predicate.field === "owner" || table === "profiles" && predicate.field === "email") {
    // Legacy email filters only narrow the view. UUID ownership and RLS remain authoritative.
    return predicate.operation === "is" && String(predicate.value).toLowerCase() === email.toLowerCase() ? query : query.eq("id", "00000000-0000-0000-0000-000000000000");
  }
  const name = column(table, predicate.field);
  if (predicate.operation === "is") return predicate.value === null ? query.is(name, null) : query.eq(name, predicate.value);
  return query[predicate.operation](name, predicate.value);
}
function notify(table: TableName) { window.dispatchEvent(new CustomEvent(DATA_EVENT, { detail: table })); }
function checkFailure(error: any) { if (error) throw new Error(error.message || "The request could not be completed."); }

export function savedSummary(result: any) {
  const display = result?.display;
  if (display && typeof display === "object" && display.summary && display.execution) return {
    schema: "breathmap-analysis-1.1", execution: display.execution, summary: display.summary,
    versions: display.versions, configuration: display.configuration, record: display.extent,
  };
  return result?.summary ?? null;
}

async function mapRecords(table: TableName, rows: any[], identity: { id: string; email?: string }, hydrate = true): Promise<DataRecord[]> {
  const client = requireSupabase();
  let results = new Map<string, any>();
  let jobs = new Map<string, string>();
  let signed = new Map<string, string>();
  if (table === "recordings" && rows.length && hydrate) {
    const ids = rows.map(row => row.id);
    const paths = rows.map(row => row.file_path).filter(Boolean);
    const [resultResponse, jobResponse, files] = await Promise.all([
      client.from("analysis_results").select("recording_id,summary,display,result_sha256").eq("user_id", identity.id).in("recording_id", ids),
      client.from("analysis_jobs").select("recording_id,status,created_at").eq("user_id", identity.id).eq("operation", "analyse").in("recording_id", ids).order("created_at", { ascending: false }).limit(1000),
      paths.length ? client.storage.from(BUCKET).createSignedUrls(paths, 300) : Promise.resolve({ data: [], error: null }),
    ]);
    checkFailure(resultResponse.error); checkFailure(jobResponse.error);
    results = new Map((resultResponse.data ?? []).map(row => [row.recording_id, row]));
    for (const job of jobResponse.data ?? []) if (!jobs.has(job.recording_id)) jobs.set(job.recording_id, job.status);
    for (const file of files.data ?? []) if (file.path && file.signedUrl) signed.set(file.path, file.signedUrl);
  }
  return rows.map(row => {
    const fields: Record<string, any> = {};
    for (const [logical, db] of Object.entries(TABLE_FIELDS[table])) fields[logical] = row[db] ?? null;
    fields.owner = identity.email ?? "";
    if (table === "profiles") {
      fields.email = identity.email ?? "";
      fields.relaxPreferences = typeof row.relax_preferences === "string" ? row.relax_preferences : JSON.stringify(row.relax_preferences ?? {});
    }
    if (table === "monitoring") fields.recording = row.recording_id ? [row.recording_id] : [];
    if (table === "routines") {
      for (const key of ["days", "commitments"]) fields[key] = typeof fields[key] === "string" ? fields[key] : JSON.stringify(fields[key] ?? []);
      for (const key of ["bedTime", "wakeTime"]) if (typeof fields[key] === "string") fields[key] = fields[key].slice(0, 5);
    }
    if (table === "reactions" && typeof fields.trialsJson !== "string") fields.trialsJson = JSON.stringify(fields.trialsJson ?? []);
    if (table === "recordings") {
      const result = results.get(row.id);
      const summary = savedSummary(result);
      fields.analysisSummary = summary ? JSON.stringify(summary) : null;
      fields.status = ({ queued: "Queued", running: "Processing", failed: "Failed", interrupted: "Interrupted" } as Record<string, string>)[jobs.get(row.id) ?? ""] ?? "Not analysed";
      fields.file = row.file_path ? [{ filename: row.file_name, url: signed.get(row.file_path) ?? "", path: row.file_path, recordId: row.id, size: row.file_size, sha256: row.input_sha256 }] : [];
      fields.resultSha256 = result?.result_sha256 ?? null;
    }
    return { id: row.id, fields };
  });
}

export async function fetchPage(options: QueryOptions, identity: { id: string; email?: string }, offset: number): Promise<DataPage> {
  safeTable(options.from);
  const count = Math.max(1, Math.min(200, options.count ?? 50));
  let query: any = requireSupabase().from(options.from).select("*", { count: "exact" });
  query = query.eq(options.from === "profiles" ? "id" : "user_id", identity.id);
  query = applyWhere(query, options.from, options.where, identity.email ?? "");
  if (options.orderBy) query = query.order(column(options.from, options.orderBy.field), { ascending: options.orderBy.ascending });
  query = query.order("id", { ascending: true }).range(offset, offset + count - 1);
  const response = await query;
  checkFailure(response.error);
  return { items: await mapRecords(options.from, response.data ?? [], identity), total: response.count ?? 0 };
}

export function useRecords(options: QueryOptions) {
  const user = useCurrentUser();
  const owner = user?.id ?? "";
  const enabled = options.enabled !== false && !!owner && !!supabase;
  const key = JSON.stringify({ ...options, owner });
  const optionsRef = useRef(options); optionsRef.current = options;
  const userRef = useRef(user); userRef.current = user;
  const sequence = useRef(0);
  const alive = useRef(true);
  const stateRef = useRef<LoadState>(null);
  const [state, setState] = useState<LoadState>({ owner, status: "pending", pages: [], hasMore: false, fetchingMore: false });
  stateRef.current = state;
  useEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current++; }; }, []);
  const load = useCallback(async (append = false) => {
    const identity = userRef.current;
    if (!identity?.id || !supabase || optionsRef.current.enabled === false) return;
    const previous = stateRef.current;
    if (append && (previous?.fetchingMore || previous?.owner !== identity.id || !previous?.hasMore)) return;
    const request = ++sequence.current;
    const offset = append ? previous.pages.reduce((n, page) => n + page.items.length, 0) : 0;
    setState(old => append ? { ...old, fetchingMore: true } : { owner: identity.id, status: "pending", pages: [], hasMore: false, fetchingMore: false });
    try {
      const page = await fetchPage(optionsRef.current, identity, offset);
      if (!alive.current || request !== sequence.current || userRef.current?.id !== identity.id) return;
      setState({ owner: identity.id, status: "success", pages: append ? [...previous.pages, page] : [page], hasMore: offset + page.items.length < page.total, fetchingMore: false });
      return page;
    } catch (issue) {
      if (alive.current && request === sequence.current && userRef.current?.id === identity.id) setState(old => ({ ...old, status: "error", error: issue instanceof Error ? issue : new Error("Loading failed."), fetchingMore: false }));
      throw issue;
    }
  }, []);
  useEffect(() => {
    sequence.current++;
    if (!enabled) { setState({ owner, status: "success", pages: [], hasMore: false, fetchingMore: false }); return; }
    void load().catch(() => {});
    const changed = (event: Event) => { if ((event as CustomEvent).detail === optionsRef.current.from) void load().catch(() => {}); };
    window.addEventListener(DATA_EVENT, changed);
    return () => { sequence.current++; window.removeEventListener(DATA_EVENT, changed); };
  }, [key, enabled, load, owner]);
  const visible: LoadState = state.owner === owner ? state : { owner, status: "pending", pages: [], hasMore: false, fetchingMore: false };
  return { data: { pages: visible.pages }, status: visible.status, error: visible.error, hasNextPage: visible.hasMore, isFetchingNextPage: visible.fetchingMore, refetch: () => load(false), fetchNextPage: () => load(true) };
}

export function useRecord({ from, recordId, select }: { from: TableName; recordId: string; select?: Selection }) {
  const user = useCurrentUser();
  const [state, setState] = useState<{ owner: string; id: string; status: "pending" | "error" | "success"; data: DataRecord | null; error?: Error }>({ owner: "", id: "", status: "pending", data: null });
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    if (!supabase || !user?.id || !UUID.test(recordId ?? "")) { setState({ owner: user?.id ?? "", id: recordId, status: "success", data: null }); return; }
    setState({ owner: user.id, id: recordId, status: "pending", data: null });
    try {
      safeTable(from);
      const response = await supabase.from(from).select("*").eq("id", recordId).eq(from === "profiles" ? "id" : "user_id", user.id).maybeSingle();
      checkFailure(response.error);
      const [record] = response.data ? await mapRecords(from, [response.data], user) : [];
      if (request === generation.current) setState({ owner: user.id, id: recordId, status: "success", data: record ?? null });
      return record;
    } catch (issue) {
      if (request === generation.current) setState({ owner: user.id, id: recordId, status: "error", data: null, error: issue as Error });
      throw issue;
    }
  }, [from, recordId, user?.id, user?.email]);
  useEffect(() => { void refresh().catch(() => {}); const changed = (event: Event) => { if ((event as CustomEvent).detail === from) void refresh().catch(() => {}); }; window.addEventListener(DATA_EVENT, changed); return () => { generation.current++; window.removeEventListener(DATA_EVENT, changed); }; }, [refresh, from]);
  return state.owner === (user?.id ?? "") && state.id === recordId ? { ...state, refetch: refresh } : { status: "pending" as const, data: null, refetch: refresh };
}
export function useCurrentRecordId() { const params = new URLSearchParams(window.location.search); return params.get("recordId") || params.get("record_id") || params.get("id") || ""; }

async function verifiedIdentity(expected: string) {
  const client = requireSupabase();
  const { data, error } = await client.auth.getUser();
  checkFailure(error);
  if (!expected || !data.user || data.user.id !== expected) throw new Error("Your account changed. Sign in again before saving.");
  return data.user;
}
function jsonField(value: unknown, fallback: any) {
  if (typeof value !== "string") return value ?? fallback;
  try { return JSON.parse(value); } catch { throw new Error("Invalid saved preferences."); }
}
export function writableFields(table: TableName, input: Record<string, any>, selection?: Selection) {
  safeTable(table);
  const output: Record<string, any> = {};
  for (const [field, value] of Object.entries(input)) {
    if (["owner", "user", "file"].includes(field) || table === "recordings" && ["status", "analysisSummary", "uploadedAt"].includes(field)) continue;
    if (selection && !Object.hasOwn(selection, field)) throw new Error("This field cannot be changed from this form.");
    const target = TABLE_FIELDS[table][field];
    if (!target || field === "uploadedAt") throw new Error("Unsupported writable field.");
    if (typeof value === "string" && value.length > 65536 || typeof value === "number" && !Number.isFinite(value)) throw new Error("Invalid field value.");
    const textLimit = table === "recordings" ? field === "title" ? 200 : ["details", "notes"].includes(field) ? 10000 : 65536 : table === "profiles" && field === "name" ? 160 : 65536;
    if (typeof value === "string" && value.length > textLimit) throw new Error(`This text must contain at most ${textLimit} characters.`);
    if (field === "recording") {
      if (!Array.isArray(value) || value.length > 1 || value.some(id => typeof id !== "string" || !UUID.test(id))) throw new Error("Choose at most one valid recording.");
      output[target] = value[0] ?? null;
    } else if (field === "recordings") {
      if (!Array.isArray(value) || value.some(id => typeof id !== "string" || !UUID.test(id))) throw new Error("Invalid recording links.");
      output[target] = [...new Set(value)];
    } else if (table === "profiles" && field === "relaxPreferences") {
      const preferences = jsonField(value, {});
      if (!preferences || typeof preferences !== "object" || Array.isArray(preferences) || new TextEncoder().encode(JSON.stringify(preferences)).length > 8192) throw new Error("Invalid saved preferences.");
      output[target] = preferences;
    }
    else if (table === "routines" && ["days", "commitments"].includes(field) || table === "reactions" && field === "trialsJson") output[target] = jsonField(value, []);
    else output[target] = value;
  }
  return output;
}

export function useRecordCreate({ from, fields }: { from: TableName; fields?: Selection }) {
  const user = useCurrentUser();
  const [isPending, setPending] = useState(false);
  const lock = useRef(false);
  const mutateAsync = async (input: Record<string, any>) => {
    if (lock.current) throw new Error("A save is already in progress.");
    lock.current = true; setPending(true);
    try {
      const identity = await verifiedIdentity(user?.id ?? "");
      const values = writableFields(from, input, fields);
      if (from === "profiles") throw new Error("Profile creation is managed during sign-in.");
      values.user_id = identity.id;
      if (from === "recordings") {
        const file = Array.isArray(input.file) ? input.file[0] : input.file;
        if (!file || !UUID.test(file.recordId ?? "") || file.path !== `${identity.id}/${file.recordId}/input.xlsx` || !SHA256.test(file.sha256 ?? "") || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > 50 * 1024 * 1024) throw new Error("Upload an original recording before saving.");
        if (typeof file.filename !== "string" || file.filename.length < 1 || file.filename.length > 255) throw new Error("The file name must contain 1–255 characters.");
        Object.assign(values, { id: file.recordId, file_path: file.path, file_name: file.filename, file_size: file.size, input_sha256: file.sha256 });
      }
      const response = await requireSupabase().from(from).insert(values).select("*").single();
      checkFailure(response.error);
      const [saved] = await mapRecords(from, [response.data], identity, false);
      notify(from);
      return saved;
    } finally { lock.current = false; setPending(false); }
  };
  return { enabled: !!supabase && !!user?.id, isPending, mutateAsync };
}
export function useRecordUpdate({ from, fields }: { from: TableName; fields?: Selection }) {
  const user = useCurrentUser();
  const [isPending, setPending] = useState(false);
  const lock = useRef(false);
  const mutateAsync = async ({ recordId, fields: input }: { recordId: string; fields: Record<string, any> }) => {
    if (lock.current) throw new Error("A save is already in progress.");
    lock.current = true; setPending(true);
    try {
      if (!UUID.test(recordId ?? "")) throw new Error("Invalid record reference.");
      const identity = await verifiedIdentity(user?.id ?? "");
      const values = writableFields(from, input, fields);
      const response = await requireSupabase().from(from).update(values).eq("id", recordId).eq(from === "profiles" ? "id" : "user_id", identity.id).select("*").single();
      checkFailure(response.error);
      const [saved] = await mapRecords(from, [response.data], identity, false);
      notify(from);
      return saved;
    } finally { lock.current = false; setPending(false); }
  };
  return { enabled: !!supabase && !!user?.id, isPending, mutateAsync };
}

async function removeStoragePrefix(bucket: string, prefix: string) {
  const client = requireSupabase();
  const paths: string[] = [];
  async function list(folder: string, depth = 0) {
    if (depth > 5) throw new Error("Unexpected file layout; the record was kept in the recycle bin.");
    for (let offset = 0; ; offset += 100) {
      const response = await client.storage.from(bucket).list(folder, { limit: 100, offset });
      checkFailure(response.error);
      for (const item of response.data ?? []) {
        if (!item.name || item.name.includes("/") || [".", ".."].includes(item.name)) throw new Error("Invalid stored file reference.");
        const path = `${folder}/${item.name}`;
        if (item.id) paths.push(path); else await list(path, depth + 1);
      }
      if ((response.data ?? []).length < 100) break;
    }
  }
  await list(prefix);
  for (let offset = 0; offset < paths.length; offset += 100) checkFailure((await client.storage.from(bucket).remove(paths.slice(offset, offset + 100))).error);
}
export function useRecordDelete({ from }: { from: TableName }) {
  const user = useCurrentUser();
  const [isPending, setPending] = useState(false);
  const lock = useRef(false);
  const mutateAsync = async (recordId: string) => {
    if (lock.current) throw new Error("A delete is already in progress.");
    lock.current = true; setPending(true);
    try {
      if (from !== "recordings" || !UUID.test(recordId ?? "")) throw new Error("Unsupported deletion.");
      const identity = await verifiedIdentity(user?.id ?? "");
      const client = requireSupabase();
      const record = await client.from("recordings").select("id,trashed_at,file_path").eq("id", recordId).eq("user_id", identity.id).single();
      checkFailure(record.error);
      if (!record.data.trashed_at || record.data.file_path !== `${identity.id}/${recordId}/input.xlsx`) throw new Error("Move this recording to the recycle bin before deleting it.");
      await removeStoragePrefix("analysis-artifacts", `${identity.id}/${recordId}`);
      checkFailure((await client.storage.from(BUCKET).remove([record.data.file_path])).error);
      const response = await client.from(from).delete().eq("id", recordId).eq("user_id", identity.id).not("trashed_at", "is", null).select("id").single();
      checkFailure(response.error);
      notify(from);
    } finally { lock.current = false; setPending(false); }
  };
  return { enabled: !!supabase && !!user?.id, isPending, mutateAsync };
}

export function useUpload() {
  const user = useCurrentUser();
  const [isUploading, setUploading] = useState(false);
  const lock = useRef(false);
  const uploadAsync = async (file: File) => {
    if (lock.current) throw new Error("An upload is already in progress.");
    lock.current = true; setUploading(true);
    try {
      const identity = await verifiedIdentity(user?.id ?? "");
      if (!(file instanceof File) || !/\.xlsx$/i.test(file.name) || file.name.length > 255 || file.size <= 0 || file.size > 50 * 1024 * 1024) throw new Error("Choose an XLSX workbook of at most 50 MiB, with a name of at most 255 characters.");
      const recordId = crypto.randomUUID();
      const path = `${identity.id}/${recordId}/input.xlsx`;
      const bytes = await file.arrayBuffer();
      const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
      const response = await requireSupabase().storage.from(BUCKET).upload(path, bytes, { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", upsert: false, metadata: { sha256 } });
      checkFailure(response.error);
      const signed = await requireSupabase().storage.from(BUCKET).createSignedUrl(path, 300);
      checkFailure(signed.error);
      return [{ status: "completed", file, filename: file.name, url: signed.data.signedUrl, path, recordId, size: file.size, sha256 }];
    } finally { lock.current = false; setUploading(false); }
  };
  return { uploadAsync, isUploading };
}
