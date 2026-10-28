import { describe, expect, it, vi } from "vitest";
import { downloadPrivateRecordingFile, isOwnRecordingPath } from "./private-file-link";

const user = "11111111-1111-4111-8111-111111111111";
const record = "22222222-2222-4222-8222-222222222222";
const path = `${user}/${record}/input.xlsx`;

describe("private recording downloads", () => {
  it("accepts only the current user's exact recording path", () => {
    expect(isOwnRecordingPath(path, user, record)).toBe(true);
    expect(isOwnRecordingPath(path, record, record)).toBe(false);
    expect(isOwnRecordingPath(`${user}/${record}/../input.xlsx`, user, record)).toBe(false);
    expect(isOwnRecordingPath(`${user}/${record}/output.json`, user, record)).toBe(false);
    expect(isOwnRecordingPath(path, "not-a-uuid", record)).toBe(false);
  });
  it("uses a fresh authenticated download even when a signed URL is expired", async () => {
    const blob = new Blob(["synthetic workbook"]);
    const download = vi.fn().mockResolvedValue({ data: blob, error: null });
    const client: any = { auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: user } }, error: null }) }, storage: { from: vi.fn().mockReturnValue({ download }) } };
    const file = { path, filename: "record.xlsx", url: "https://expired.example.invalid/file" };
    expect(await downloadPrivateRecordingFile(client, file, user, record)).toBe(blob);
    expect(client.auth.getUser).toHaveBeenCalledOnce();
    expect(client.storage.from).toHaveBeenCalledWith("recordings");
    expect(download).toHaveBeenCalledWith(path);
  });
  it("does not request a file after the signed-in account changes", async () => {
    const from = vi.fn();
    const client: any = { auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: record } }, error: null }) }, storage: { from } };
    await expect(downloadPrivateRecordingFile(client, { path }, user, record)).rejects.toThrow("current account changed");
    expect(from).not.toHaveBeenCalled();
  });
  it("rejects a failed, empty or oversized storage response", async () => {
    for (const response of [{ data: null, error: { message: "denied" } }, { data: new Blob(), error: null }, { data: { size: 50 * 1024 * 1024 + 1 }, error: null }]) {
      const client: any = { auth: { getUser: async () => ({ data: { user: { id: user } }, error: null }) }, storage: { from: () => ({ download: async () => response }) } };
      await expect(downloadPrivateRecordingFile(client, { path }, user, record)).rejects.toThrow("could not be downloaded");
    }
  });
});
