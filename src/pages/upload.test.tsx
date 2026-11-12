// @vitest-environment happy-dom
import ExcelJS from 'exceljs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({
  user: {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'upload-test@example.invalid',
    fullName: 'Upload tester',
  },
  upload: vi.fn(),
  save: vi.fn(),
  requestJob: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('@/lib/datasource', () => ({
  datasource: { define: (definition: Record<string, string>) => definition },
  q: { select: (value: unknown) => value, text: () => ({ is: () => ({}) }), desc: () => ({}) },
  useCurrentRecordId: () => null,
  useRecord: () => ({ status: 'success', data: null }),
  useRecords: ({ from }: { from: string }) => {
    const items = from === 'profiles' ? [{ id: boundary.user.id, fields: { email: boundary.user.email } }] : [];
    return { status: 'success', data: { pages: [{ items, total: items.length }] } };
  },
  useRecordCreate: () => ({ enabled: true, mutateAsync: boundary.save }),
  useRecordUpdate: () => ({ enabled: true }),
  useRecordDelete: () => ({ enabled: true }),
  useUpload: () => ({ uploadAsync: boundary.upload, isUploading: false }),
}));
vi.mock('@/lib/user', () => ({ useCurrentUser: () => boundary.user }));
vi.mock('@/lib/editable-settings', () => ({
  useTextSetting: ({ initialValue }: { initialValue: unknown }) => initialValue,
  useNavigationSetting: ({ initialValue }: { initialValue: unknown }) => initialValue,
  useNavigation: () => boundary.navigate,
}));
vi.mock('@/lib/analysis', () => ({ requestJob: boundary.requestJob }));
vi.mock('@/lib/supabase', () => ({ requireSupabase: () => { throw new Error('Unexpected live storage access'); } }));

import UploadPage from './upload';

const recordId = '22222222-2222-4222-8222-222222222222';
const analysisHref = `/analysis?recordId=${recordId}`;
const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
let workbookBytes: ArrayBuffer;
let container: HTMLDivElement;
let root: Root;

beforeAll(async () => {
  const workbook = new ExcelJS.Workbook();
  const magnetic = workbook.addWorksheet('磁场数据');
  magnetic.addRow(['点数', 'PC接收时间', '工作时间_秒', '磁场响应信号_mT', '信号模式', 'TMR_X_mT', 'TMR_Y_mT', 'TMR_Z_mT', 'ESP32_TIMESTAMP_US', 'TMR_QUEUE_DROPS']);
  magnetic.addRow([1, '2026-11-10 12:00:00.000', 0, 2, 'TMR', 1, 2, 3, 1000000, 0]);
  const voltage = workbook.addWorksheet('SIG差分电压');
  voltage.addRow(['点数', 'PC接收时间', '工作时间_秒', 'ESP32_TIME_US', 'SIG_INPUT_uV']);
  voltage.addRow([1, '2026-11-10 12:00:00.000', 0, 1000000, 42]);
  workbookBytes = Uint8Array.from(new Uint8Array(await workbook.xlsx.writeBuffer())).buffer;
});

beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks();
  boundary.upload.mockImplementation(async (file: File) => [{ status: 'completed', file, url: 'https://storage.example.invalid/input.xlsx' }]);
  boundary.save.mockResolvedValue({ id: recordId });
  localStorage.setItem('breathmap-language', 'en');
  window.history.replaceState(null, '', '/upload');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root.render(<UploadPage />); });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  localStorage.clear();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
});

async function chooseWorkbook() {
  const file = new File([workbookBytes], 'synthetic-test.xlsx', { type: mime });
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  const selection = new DataTransfer();
  selection.items.add(file);
  vi.useFakeTimers();
  try {
    await act(async () => {
      input.files = selection.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await vi.runAllTimersAsync();
    });
  } finally {
    vi.useRealTimers();
  }
  expect(container.querySelector('#bm-file-status')?.textContent).toContain('Format checked · 2 sheets');
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
  return file;
}

async function submitRecording() {
  const form = container.querySelector('form')!;
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
}

describe('upload and analyse', () => {
  it('saves the validated workbook, queues analysis and opens the saved recording', async () => {
    let acceptQueue: (job: { id: string }) => void;
    boundary.requestJob.mockImplementation(() => new Promise(resolve => { acceptQueue = resolve; }));
    const file = await chooseWorkbook();
    await submitRecording();

    expect(boundary.upload).toHaveBeenCalledExactlyOnceWith(file);
    expect(boundary.save).toHaveBeenCalledBefore(boundary.requestJob);
    expect(boundary.requestJob).toHaveBeenCalledExactlyOnceWith(recordId, 'analyse', { language: 'en' });
    expect(boundary.navigate).not.toHaveBeenCalled();
    expect(container.querySelector('.progress-panel')?.textContent).toContain('Starting analysis');

    await act(async () => { acceptQueue({ id: 'analysis-job' }); });
    expect(boundary.navigate).toHaveBeenCalledExactlyOnceWith({ destination: analysisHref, openIn: 'SELF' });
  });

  it('keeps a direct link to the saved recording if queuing fails', async () => {
    boundary.requestJob.mockRejectedValueOnce(new Error('Synthetic queue failure'));
    const file = await chooseWorkbook();
    await submitRecording();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Your recording is saved.');
    const link = Array.from(container.querySelectorAll('a')).find(item => item.textContent?.trim() === 'Open data analysis');
    expect(link?.getAttribute('href')).toBe(analysisHref);
    expect(container.querySelector('form')).toBeNull();
    expect(boundary.upload).toHaveBeenCalledExactlyOnceWith(file);
    expect(boundary.save).toHaveBeenCalledTimes(1);
    expect(boundary.requestJob).toHaveBeenCalledExactlyOnceWith(recordId, 'analyse', { language: 'en' });
    expect(boundary.navigate).not.toHaveBeenCalled();
  });
});
