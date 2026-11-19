import type { InvestigationResult, MediaType } from '../types';

export type InvestigationStatus = 'pending' | 'running' | 'completed' | 'failed' | 'inconclusive';

export interface StoredInvestigation {
  id: string;
  filename: string;
  mediaType: MediaType;
  submittedAt: string;
  status: InvestigationStatus;
  statusUrl?: string;
  reportUrl?: string;
  result?: InvestigationResult;
}

const STORAGE_KEY = 'truthlens-investigations';

export interface InvestigationHistoryRead {
  records: StoredInvestigation[];
  error?: string;
}

export function readInvestigationHistory(): InvestigationHistoryRead {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { records: [] };
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { records: [], error: 'Saved investigation history is not in a supported format.' };
    const validStatuses: InvestigationStatus[] = ['pending','running','completed','failed','inconclusive'];
    const records = parsed.filter((item): item is StoredInvestigation =>
      typeof item?.id === 'string' &&
      typeof item?.filename === 'string' &&
      ['image','video','audio','text'].includes(item.mediaType) &&
      typeof item?.submittedAt === 'string' &&
      validStatuses.includes(item.status) &&
      (item.statusUrl === undefined || typeof item.statusUrl === 'string') &&
      (item.reportUrl === undefined || typeof item.reportUrl === 'string')
    );
    return { records };
  } catch {
    return { records: [], error: 'Unable to read locally saved investigation history.' };
  }
}

export function readInvestigations(): StoredInvestigation[] {
  return readInvestigationHistory().records;
}

export function saveInvestigation(record: StoredInvestigation): void {
  const { records } = readInvestigationHistory();
  const next = [record, ...records.filter((item) => item.id !== record.id)].slice(0, 100);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

export function updateInvestigationStatus(id: string, status: InvestigationStatus): void {
  const { records } = readInvestigationHistory();
  const next = records.map((record) => record.id === id ? { ...record, status } : record);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

export function deleteInvestigation(id: string): void {
  const { records } = readInvestigationHistory();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records.filter((record) => record.id !== id)));
}

export function clearInvestigationHistory(): void {
  localStorage.removeItem(STORAGE_KEY);
}
