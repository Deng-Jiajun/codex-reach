import { CapacitorHttp } from '@capacitor/core';
import type { Connection, ModelChoice } from './types';

export class ReachError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export class ReachClient {
  private models: ModelChoice[] = [];
  private modelsRequest?: Promise<ModelChoice[]>;

  constructor(readonly connection: Connection) {}

  cachedModels(): ModelChoice[] {
    return this.models;
  }

  loadModels(): Promise<ModelChoice[]> {
    if (!this.modelsRequest) {
      this.modelsRequest = this.request<{ models: ModelChoice[] }>('/models').then(result => {
        this.models = result.models;
        return this.models;
      }).finally(() => { this.modelsRequest = undefined; });
    }
    return this.modelsRequest;
  }

  async request<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
    const response = await CapacitorHttp.request({
      url: `${this.connection.url}/api${path}`, method,
      headers: { Authorization: `Bearer ${this.connection.key}`, 'Content-Type': 'application/json' },
      data, responseType: 'json', connectTimeout: 8000, readTimeout: 25000,
      disableRedirects: true, webFetchExtra: { redirect: 'error' },
    });
    if (response.status < 200 || response.status >= 300) {
      throw new ReachError(response.data?.error ?? `请求失败，HTTP ${response.status}`, response.status);
    }
    return response.data as T;
  }
}
