'use client';

/** Thrown for any non-2xx response. `hint` is the actionable half. */
export class ApiCallError extends Error {
  readonly hint: string | null;
  readonly status: number;

  constructor(message: string, hint: string | null, status: number) {
    super(message);
    this.name = 'ApiCallError';
    this.hint = hint;
    this.status = status;
  }
}

async function unwrap<T>(response: Response): Promise<T> {
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const body = payload as { error?: string; hint?: string | null } | null;
    throw new ApiCallError(
      body?.error ?? `Request failed (${response.status}).`,
      body?.hint ?? null,
      response.status,
    );
  }

  return payload as T;
}

export async function apiGet<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-store' });
  return unwrap<T>(response);
}

export async function apiSend<T>(
  url: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body?: unknown,
): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return unwrap<T>(response);
}

export async function apiUpload<T>(url: string, form: FormData): Promise<T> {
  const response = await fetch(url, { method: 'POST', body: form });
  return unwrap<T>(response);
}

/** Turns any thrown value into a message + hint pair for antd notifications. */
export function describeError(err: unknown): { message: string; hint: string | null } {
  if (err instanceof ApiCallError) return { message: err.message, hint: err.hint };
  if (err instanceof Error) return { message: err.message, hint: null };
  return { message: 'Unexpected error.', hint: null };
}
