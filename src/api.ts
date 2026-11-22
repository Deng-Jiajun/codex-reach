import { CapacitorHttp } from '@capacitor/core';
import manifest from '../package.json' with { type: 'json' };
import type { Connection, ModelChoice } from './types';

const reachVersion = manifest.version;

export class ReachError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

type ServerStatus = Pick<Connection, 'serverId' | 'desktopLocale'> & { version: string };

export class ReachClient {
  private versionChecked = false;
  private statusRequest?: Promise<ServerStatus>;
  private models: ModelChoice[] = [];
  private modelsRequest?: Promise<ModelChoice[]>;

  readonly connection: Connection;
  constructor(connection: Connection) { this.connection = connection; }

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

  getStatus(): Promise<ServerStatus> {
    if (!this.statusRequest) {
      this.statusRequest = this.fetch<ServerStatus>('/status', 'GET').then(status => {
        if (status?.version !== reachVersion) {
          throw new ReachError(`手机 Reach 版本为 ${reachVersion}，电脑版本为 ${status?.version || '未知'}。请同步更新手机 APK 和电脑服务。`, 412);
        }
        this.versionChecked = true;
        return status;
      }).catch(error => {
        this.versionChecked = false;
        if (error instanceof ReachError && error.status === 404) {
          throw new ReachError(`电脑未提供 Reach ${reachVersion} 接口，请同步更新手机 APK 和电脑服务。`, 412);
        }
        throw error;
      }).finally(() => { this.statusRequest = undefined; });
    }
    return this.statusRequest;
  }

  async request<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
    if (!this.versionChecked || this.statusRequest) await this.getStatus();
    return this.fetch<T>(path, method, data);
  }

  private async fetch<T>(path: string, method: string, data?: unknown): Promise<T> {
    const response = await CapacitorHttp.request({
      url: `${this.connection.url}/api/${reachVersion}${path}`, method,
      headers: { Authorization: `Bearer ${this.connection.key}`, 'Content-Type': 'application/json' },
      data, responseType: 'json', connectTimeout: 8000, readTimeout: 25000,
      disableRedirects: true, webFetchExtra: { redirect: 'error' },
    });
    if (response.status < 200 || response.status >= 300) {
      if (response.status === 412) this.versionChecked = false;
      throw new ReachError(response.data?.error ?? `请求失败，HTTP ${response.status}`, response.status);
    }
    return response.data as T;
  }
}
