import { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import { requireSupabase } from "@/lib/supabase";
import { useCurrentUser } from "@/lib/user";

type RecordingFile = { path?: string; filename?: string };
type Translate = (en: string, zh: string) => string;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FILE_BYTES = 50 * 1024 * 1024;

export function isOwnRecordingPath(path: unknown, userId: string, recordId: string) {
  return UUID.test(userId) && UUID.test(recordId) && path === `${userId}/${recordId}/input.xlsx`;
}

export async function downloadPrivateRecordingFile(client: ReturnType<typeof requireSupabase>, file: RecordingFile, userId: string, recordId: string) {
  if (!isOwnRecordingPath(file?.path, userId, recordId)) throw new Error("The recording is not available in this account.");
  const identity = await client.auth.getUser();
  if (identity.error || identity.data.user?.id !== userId) throw new Error("The current account changed.");
  // Download with the current authenticated session. Cached signed URLs are never used.
  const response = await client.storage.from("recordings").download(file.path!);
  if (response.error || !response.data || response.data.size <= 0 || response.data.size > MAX_FILE_BYTES) throw new Error("The recording could not be downloaded.");
  return response.data;
}

export function PrivateFileLink({ file, recordId, t }: { file: RecordingFile | null; recordId: string; t: Translate }) {
  const user = useCurrentUser();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false), alive = useRef(true), owner = useRef(user?.id);
  owner.current = user?.id;
  const objectUrls = useRef(new Set<string>());
  useEffect(() => { alive.current = true; return () => { alive.current = false; for (const url of objectUrls.current) URL.revokeObjectURL(url); objectUrls.current.clear(); }; }, []);
  useEffect(() => { setError(""); }, [user?.id, recordId, file?.path]);

  async function download() {
    if (lock.current || !user?.id || !file) return;
    const boundUser = user.id;
    lock.current = true; setBusy(true); setError("");
    try {
      const blob = await downloadPrivateRecordingFile(requireSupabase(), file, boundUser, recordId);
      if (!alive.current || owner.current !== boundUser) return;
      const url = URL.createObjectURL(blob);
      objectUrls.current.add(url);
      const link = document.createElement("a");
      link.href = url;
      link.download = (file.filename || "input.xlsx").replace(/[\\/\x00-\x1f\x7f]/g, "_").slice(0, 255);
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => { URL.revokeObjectURL(url); objectUrls.current.delete(url); }, 30000);
    } catch {
      if (alive.current && owner.current === boundUser) setError(t("The file could not be downloaded. Please try again.", "文件暂时无法下载，请重试。"));
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }

  if (!file?.path) return <span className="bm-note">{t("No file attached", "未附加文件")}</span>;
  return <><button type="button" className="bm-button ghost" disabled={busy || !user?.id} onClick={() => void download()}><Download size={17} />{busy ? t("Downloading…", "正在下载……") : t("Open file", "打开文件")}</button>{error && <p className="bm-error" role="alert">{error}</p>}</>;
}
