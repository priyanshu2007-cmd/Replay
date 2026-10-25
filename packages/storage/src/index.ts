import { createClient, SupabaseClient } from '@supabase/supabase-js';

export interface StorageConfig {
  supabaseUrl?: string;
  supabaseServiceRoleKey?: string;
  bucketName?: string;
}

export class StorageService {
  private client: SupabaseClient;
  private bucket: string;

  constructor(config?: StorageConfig) {
    const url = config?.supabaseUrl || process.env.SUPABASE_URL;
    const key = config?.supabaseServiceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY;
    this.bucket = config?.bucketName || process.env.STORAGE_BUCKET_ARTIFACTS || 'replay-artifacts';

    if (!url || !key) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for StorageService');
    }
    this.client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  async createSignedUploadUrl(path: string) {
    const { data, error } = await this.client.storage
      .from(this.bucket)
      .createSignedUploadUrl(path);
    if (error) throw error;
    return data;
  }

  async createSignedReadUrl(path: string, expiresInSeconds = 3600) {
    const { data, error } = await this.client.storage
      .from(this.bucket)
      .createSignedUrl(path, expiresInSeconds);
    if (error) throw error;
    return data.signedUrl;
  }

  async uploadFile(path: string, fileBody: Buffer | Uint8Array, contentType: string) {
    const { data, error } = await this.client.storage
      .from(this.bucket)
      .upload(path, fileBody, {
        contentType,
        upsert: true,
      });
    if (error) throw error;
    return data;
  }

  async downloadFile(path: string): Promise<Buffer> {
    const { data, error } = await this.client.storage
      .from(this.bucket)
      .download(path);
    if (error) throw error;
    const arrayBuffer = await data.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}
