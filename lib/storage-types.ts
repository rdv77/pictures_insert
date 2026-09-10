/** Small storage contract shared by SQLite and the optional R2 adapter. */
export type StorageObject = { key: string; etag: string; size: number; customMetadata?: Record<string,string>; httpMetadata?: {contentType?: string} };
export type StoredBody = StorageObject & { readonly body: ReadableStream<Uint8Array>; arrayBuffer(): Promise<ArrayBuffer>; json<T>(): Promise<T> };
export type PutOptions = { customMetadata?: Record<string,string>; httpMetadata?: {contentType?: string}; onlyIf?: {etagMatches?: string; etagDoesNotMatch?: string} };
export interface StorageBucket {
  get(key: string): Promise<StoredBody | null>;
  head(key: string): Promise<StorageObject | null>;
  put(key: string, value: string | Uint8Array | ReadableStream<Uint8Array>, options?: PutOptions): Promise<StorageObject | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options: {prefix: string; cursor?: string; limit?: number; include?: string[]}): Promise<{objects: StorageObject[]; truncated: boolean; cursor?: string}>;
}
