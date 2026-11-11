import { CapacitorHttp } from '@capacitor/core';
import type { Connection } from './types';

export class ReachClient {
  constructor(readonly connection: Connection) {}

  async request<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
    const response = await CapacitorHttp.request({
      url: `${this.connection.url}/api${path}`, method,
      headers: { Authorization: `Bearer ${this.connection.key}`, 'Content-Type': 'application/json' },
      data, responseType: 'json', connectTimeout: 8000, readTimeout: 25000,
      disableRedirects: true, webFetchExtra: { redirect: 'error' },
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(response.data?.error ?? `请求失败，HTTP ${response.status}`);
    }
    return response.data as T;
  }
}
