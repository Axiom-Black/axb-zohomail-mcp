/**
 * Thin Zoho Mail REST client. Tokens are supplied lazily via `getToken` so the
 * caller can refresh transparently; this client never touches the OAuth secret.
 */
export class ZohoClient {
  constructor(
    private readonly getToken: () => Promise<string>,
    private readonly apiBase: string,
  ) {}

  private async request<T>(
    method: string,
    path: string,
    opts: { params?: Record<string, unknown>; body?: unknown } = {},
  ): Promise<T> {
    const token = await this.getToken();
    const url = new URL(`${this.apiBase}${path}`);
    for (const [k, v] of Object.entries(opts.params ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }

    const res = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        "Content-Type": "application/json",
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const msg =
        data?.data?.errorMessage || data?.message || `HTTP ${res.status}`;
      throw new Error(`Zoho API error: ${msg}`);
    }
    return data as T;
  }

  get<T = any>(path: string, params?: Record<string, unknown>) {
    return this.request<T>("GET", path, { params });
  }
  post<T = any>(path: string, body?: unknown) {
    return this.request<T>("POST", path, { body });
  }
  put<T = any>(path: string, body?: unknown) {
    return this.request<T>("PUT", path, { body });
  }

  /** Download raw attachment bytes (Zoho returns an octet stream). */
  async getBinary(path: string): Promise<{ buffer: ArrayBuffer; contentType: string }> {
    const token = await this.getToken();
    const res = await fetch(`${this.apiBase}${path}`, {
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        Accept: "application/octet-stream",
      },
    });
    if (!res.ok) {
      throw new Error(`Zoho API error: HTTP ${res.status} downloading attachment`);
    }
    return {
      buffer: await res.arrayBuffer(),
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  /**
   * Upload one attachment (raw-file method) and return the reference fields
   * Zoho expects back in a send request's `attachments` array.
   */
  async uploadAttachment(
    accountId: string,
    fileName: string,
    bytes: Uint8Array,
  ): Promise<{ storeName: string; attachmentName: string; attachmentPath: string }> {
    const token = await this.getToken();
    const url = new URL(`${this.apiBase}/api/accounts/${accountId}/messages/attachments`);
    url.searchParams.set("fileName", fileName);
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        "Content-Type": "application/octet-stream",
      },
      body: bytes,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const msg = data?.data?.errorMessage || data?.message || `HTTP ${res.status}`;
      throw new Error(`Zoho attachment upload failed: ${msg}`);
    }
    const d = data.data ?? {};
    return {
      storeName: d.storeName,
      attachmentName: d.attachmentName ?? fileName,
      attachmentPath: d.attachmentPath,
    };
  }
}
