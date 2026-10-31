// @vitest-environment happy-dom
/** Real hook, controlled query promises. No network, Auth accounts or AI. */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cloud = vi.hoisted(() => ({ from: vi.fn(), queries: [] as any[] }));
vi.mock('./supabase', () => ({ supabase: { from: cloud.from } }));
import { useAssistantRecord } from './use-assistant-record';

const recordId = '22222222-2222-4222-8222-222222222222';
const userA = '11111111-1111-4111-8111-111111111111';
const userB = '99999999-9999-4999-8999-999999999999';
let root: Root, container: HTMLDivElement, latest: ReturnType<typeof useAssistantRecord>;
let renders: Array<{ owner: string; record: any; result: any; jobs: any[] }>;

function Probe({ owner }: { owner: string }) {
  latest = useAssistantRecord(recordId, owner);
  renders.push({ owner, record: latest.record, result: latest.result, jobs: latest.jobs });
  return <span>{latest.record?.title ?? 'No recording loaded'}</span>;
}

function resolveBatch(offset: number, label: string, jobId: string, unavailable = false) {
  const batch = cloud.queries.slice(offset, offset + 4);
  expect(batch).toHaveLength(4);
  for (const query of batch) {
    const data = query.table === 'recordings' ? unavailable ? null : { id: recordId, title: label }
      : query.table === 'analysis_results' ? unavailable ? null : { result_sha256: label }
        : query.table === 'analysis_jobs' ? unavailable ? [] : [{ id: jobId, status: 'queued' }]
          : { last_seen: '2026-10-31T10:00:00Z' };
    query.resolve({ data, error: null });
  }
}

async function render(owner: string) {
  await act(async () => { root.render(<Probe owner={owner} />); });
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers(); renders = []; cloud.queries = []; cloud.from.mockReset();
  cloud.from.mockImplementation((table: string) => {
    let resolve!: (value: any) => void;
    const promise = new Promise<any>(done => { resolve = done; });
    const request = { table, filters: {} as Record<string, unknown>, resolve };
    cloud.queries.push(request);
    const query: any = {
      select: () => query,
      eq: (key: string, value: unknown) => { request.filters[key] = value; return query; },
      is: () => query, order: () => query,
      maybeSingle: () => promise, limit: () => promise,
    };
    return query;
  });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove(); vi.useRealTimers(); vi.restoreAllMocks();
});

describe('assistant record query ownership and fresh refreshes', () => {
  it('hides the previous owner cache on every render of the same record under a new owner', async () => {
    await render(userA);
    await act(async () => { resolveBatch(0, 'A private recording', 'a-private-job'); });
    expect(latest.record.title).toBe('A private recording');

    await render(userB);
    const newOwnerRenders = renders.filter(snapshot => snapshot.owner === userB);
    expect(newOwnerRenders.length).toBeGreaterThan(0);
    for (const snapshot of newOwnerRenders) {
      expect(snapshot.record).toBeUndefined();
      expect(snapshot.result).toBeUndefined();
      expect(snapshot.jobs).toEqual([]);
    }
    expect(cloud.queries.slice(4, 7).map(query => query.filters.user_id)).toEqual([userB, userB, userB]);
    await act(async () => { resolveBatch(4, '', '', true); });
    expect(latest.record).toBeNull();
    expect(container.textContent).not.toContain('A private recording');
  });

  it('ignores a delayed old-owner response arriving after the new owner response', async () => {
    await render(userA);
    await render(userB);
    await act(async () => { resolveBatch(4, '', '', true); });
    expect(latest.record).toBeNull();

    await act(async () => { resolveBatch(0, 'Late A private recording', 'late-a-job'); });
    expect(latest.record).toBeNull();
    expect(latest.result).toBeNull();
    expect(latest.jobs).toEqual([]);
    expect(renders.filter(snapshot => snapshot.owner === userB).every(snapshot => !snapshot.record && !snapshot.result && !snapshot.jobs.length)).toBe(true);
  });

  it('waits for an in-flight poll and then reads again before manual refresh resolves', async () => {
    await render(userA);
    let refreshed = false, refreshPromise!: Promise<void>;
    await act(async () => {
      refreshPromise = latest.refresh().then(() => { refreshed = true; });
      await Promise.resolve();
    });
    expect(refreshed).toBe(false);
    expect(cloud.queries).toHaveLength(4);

    await act(async () => { resolveBatch(0, 'Before accepted request', 'old-job'); });
    expect(cloud.queries).toHaveLength(8);
    expect(refreshed).toBe(false);
    expect(latest.jobs).toEqual([{ id: 'old-job', status: 'queued' }]);

    await act(async () => {
      resolveBatch(4, 'After accepted request', 'newly-accepted-job');
      await refreshPromise;
    });
    expect(refreshed).toBe(true);
    expect(latest.record.title).toBe('After accepted request');
    expect(latest.jobs).toEqual([{ id: 'newly-accepted-job', status: 'queued' }]);
  });

  it('serializes two manual refreshes waiting on the same poll instead of starting competing reads', async () => {
    await render(userA);
    let firstDone = false, secondDone = false;
    let firstRefresh!: Promise<void>, secondRefresh!: Promise<void>;
    await act(async () => {
      firstRefresh = latest.refresh().then(() => { firstDone = true; });
      secondRefresh = latest.refresh().then(() => { secondDone = true; });
      await Promise.resolve();
    });
    expect(cloud.queries).toHaveLength(4);

    await act(async () => { resolveBatch(0, 'Initial poll', 'poll-job'); });
    // Exactly one waiter may read while the other continues waiting for it.
    expect(cloud.queries).toHaveLength(8);
    expect(firstDone).toBe(false);
    expect(secondDone).toBe(false);

    await act(async () => {
      resolveBatch(4, 'First refreshed snapshot', 'first-refresh-job');
      await firstRefresh;
    });
    expect(firstDone).toBe(true);
    expect(secondDone).toBe(false);
    expect(cloud.queries).toHaveLength(12);
    expect(latest.record.title).toBe('First refreshed snapshot');

    await act(async () => {
      resolveBatch(8, 'Latest refreshed snapshot', 'latest-refresh-job');
      await secondRefresh;
    });
    expect(secondDone).toBe(true);
    expect(latest.record.title).toBe('Latest refreshed snapshot');
    expect(latest.jobs).toEqual([{ id: 'latest-refresh-job', status: 'queued' }]);
    expect(cloud.queries).toHaveLength(12);
  });
});
