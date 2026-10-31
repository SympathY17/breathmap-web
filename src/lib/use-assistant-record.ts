import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from './supabase';
import { assistantUuid } from './assistant-context';

export function useAssistantRecord(recordingId: string | undefined, userId: string | undefined, limit = 50) {
  const [state, setState] = useState<{ id?: string; owner?: string; record?: any; result?: any; jobs: any[]; heartbeat?: any; loading: boolean; failed: boolean }>({ jobs: [], loading: false, failed: false });
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    let active = true, inFlight: Promise<void> | null = null;
    setState({ id: recordingId, owner: userId, jobs: [], loading: !!recordingId, failed: false });
    const refresh = async () => {
      while (inFlight) await inFlight;
      if (!supabase || !userId || !assistantUuid(recordingId) || !active) return;
      const request = (async () => { try {
        const [record, result, jobs, heartbeat] = await Promise.all([
          supabase.from('recordings').select('id,title,recorded_at,uploaded_at,trashed_at').eq('id', recordingId).eq('user_id', userId).is('trashed_at', null).maybeSingle(),
          supabase.from('analysis_results').select('*').eq('recording_id', recordingId).eq('user_id', userId).maybeSingle(),
          supabase.from('analysis_jobs').select('id,recording_id,operation,payload,status,result,error_code,created_at,finished_at').eq('recording_id', recordingId).eq('user_id', userId).order('created_at', { ascending: false }).limit(limit),
          supabase.from('worker_heartbeat').select('last_seen,assistant_protocol,assistant_seen_at').eq('id', 'main').maybeSingle(),
        ]);
        if (!active) return;
        if (record.error || result.error || jobs.error) { setState(current => ({ ...current, loading: false, failed: true })); return; }
        setState({ id: recordingId, owner: userId, record: record.data, result: result.data, jobs: jobs.data ?? [], heartbeat: heartbeat.error ? undefined : heartbeat.data, loading: false, failed: false });
      } catch { if (active) setState(current => ({ ...current, loading: false, failed: true })); }
      })();
      inFlight = request;
      try { await request; } finally { if (inFlight === request) inFlight = null; }
    };
    refreshRef.current = refresh;
    void refresh(); const timer = setInterval(() => { if (!inFlight) void refresh(); }, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [recordingId, userId, limit]);
  const refresh = useCallback(() => refreshRef.current(), []);
  return { ...(state.id === recordingId && state.owner === userId ? state : { jobs: [], loading: !!recordingId, failed: false }), refresh };
}
