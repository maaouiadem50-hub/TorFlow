export type RequestStatus = 'received' | 'completed' | 'partial' | 'failed' | 'timeout';

export interface RequestRecord {
  requestId: string;
  receivedAt: string;
  completedAt?: string;
  durationMs?: number;
  route: string;
  method: string;
  requestType?: string;
  status: RequestStatus;
  httpStatus?: number;
  phase: string;
  attempted?: number;
  source?: string;
  cacheHit?: boolean;
  subtitleStatus?: 'found' | 'not_found' | 'partial' | 'not_requested';
  subtitleLanguages?: string[];
  qualityStatus?: 'found' | 'unknown';
  quality?: string;
  errorCode?: string;
  errorMessage?: string;
}

export class RequestTracker {
  private readonly records: RequestRecord[] = [];
  constructor(private readonly maxRecords = 500) {}

  start(input: Pick<RequestRecord, 'requestId' | 'route' | 'method' | 'requestType'>): RequestRecord {
    const record: RequestRecord = { ...input, receivedAt: new Date().toISOString(), status: 'received', phase: 'received' };
    this.records.unshift(record);
    this.trim();
    return record;
  }

  finish(requestId: string, patch: Omit<Partial<RequestRecord>, 'requestId' | 'receivedAt'>): RequestRecord | undefined {
    const record = this.records.find((item) => item.requestId === requestId);
    if (!record) return undefined;
    Object.assign(record, patch, { requestId, completedAt: new Date().toISOString(), durationMs: Date.now() - Date.parse(record.receivedAt) });
    return record;
  }

  recent(limit = 100): RequestRecord[] { return this.records.slice(0, Math.min(Math.max(limit, 1), 500)).map((record) => ({ ...record, subtitleLanguages: record.subtitleLanguages ? [...record.subtitleLanguages] : undefined })); }
  private trim(): void { if (this.records.length > this.maxRecords) this.records.length = this.maxRecords; }
}
