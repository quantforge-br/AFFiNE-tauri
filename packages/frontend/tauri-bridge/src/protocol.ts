export const PROTOCOL_VERSION = 1;
export const MAX_UPDATE_BYTES = 16 * 1024 * 1024;
export const MAX_IN_FLIGHT = 64;
export const MAX_QUEUED_BYTES = 64 * 1024 * 1024;

export type ErrorCode =
  | 'INVALID_INPUT'
  | 'UNAUTHORIZED'
  | 'INVALID_HANDLE'
  | 'RESOURCE_LIMIT'
  | 'STORAGE'
  | 'RESYNC_REQUIRED'
  | 'CANCELLED'
  | 'CLOSED'
  | 'PROTOCOL';

const ERROR_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  'INVALID_INPUT',
  'UNAUTHORIZED',
  'INVALID_HANDLE',
  'RESOURCE_LIMIT',
  'STORAGE',
  'RESYNC_REQUIRED',
  'CANCELLED',
  'CLOSED',
  'PROTOCOL',
]);

export class StorageBridgeError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
    this.name = 'StorageBridgeError';
  }
}

export interface DocRecord {
  docId: string;
  timestampMs: number;
  data: Uint8Array;
}
export interface DocClock {
  docId: string;
  timestampMs: number;
}

export type Request =
  | { version: 1; type: 'call'; id: number; op: 'getDoc'; docId: string }
  | {
      version: 1;
      type: 'call';
      id: number;
      op: 'pushUpdate';
      docId: string;
      data: Uint8Array;
    }
  | { version: 1; type: 'cancel'; id: number }
  | { version: 1; type: 'close' };

export type Response =
  | {
      version: 1;
      type: 'result';
      id: number;
      ok: true;
      value: DocRecord | DocClock | null;
    }
  | { version: 1; type: 'result'; id: number; ok: false; error: ErrorCode }
  | { version: 1; type: 'closed'; error: ErrorCode };

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[]
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && actual.every(key => keys.includes(key))
  );
}
export function identifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 2048 &&
    new TextEncoder().encode(value).length <= 2048 &&
    !Array.from(value).some(char => {
      const code = char.charCodeAt(0);
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    })
  );
}
export function requestId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
export function bytes(value: unknown): value is Uint8Array<ArrayBuffer> {
  return (
    value instanceof Uint8Array &&
    value.buffer instanceof ArrayBuffer &&
    value.byteLength <= MAX_UPDATE_BYTES &&
    value.buffer.byteLength <= MAX_UPDATE_BYTES
  );
}
export function clock(value: unknown, docId: string): value is DocClock {
  return (
    record(value) &&
    value.docId === docId &&
    typeof value.timestampMs === 'number' &&
    Number.isSafeInteger(value.timestampMs)
  );
}
export function errorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && ERROR_CODES.has(value);
}
export function sanitizeError(error: unknown): ErrorCode {
  return error instanceof StorageBridgeError && errorCode(error.code)
    ? error.code
    : 'STORAGE';
}

export function parseRequest(value: unknown): Request | null {
  if (!record(value) || value.version !== PROTOCOL_VERSION) return null;
  if (value.type === 'close')
    return exactKeys(value, ['version', 'type']) ? (value as Request) : null;
  if (!requestId(value.id)) return null;
  if (value.type === 'cancel')
    return exactKeys(value, ['version', 'type', 'id'])
      ? (value as Request)
      : null;
  if (value.type !== 'call' || !identifier(value.docId)) return null;
  if (
    value.op === 'getDoc' &&
    exactKeys(value, ['version', 'type', 'id', 'op', 'docId'])
  )
    return value as Request;
  if (
    value.op === 'pushUpdate' &&
    exactKeys(value, ['version', 'type', 'id', 'op', 'docId', 'data']) &&
    bytes(value.data) &&
    value.data.byteLength > 0
  )
    return value as Request;
  return null;
}
