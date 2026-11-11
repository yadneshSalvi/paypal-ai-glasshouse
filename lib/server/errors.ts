export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export function problem(error: unknown): Response {
  if (error instanceof HttpError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
  // Provider payloads and credentials never leave the server's adapter.
  console.error('[glasshouse]', error instanceof Error ? error.name + ': ' + error.message.replace(/postgres(?:ql)?:\/\/\S+/gi, '[database]') : 'Unexpected server failure');
  return Response.json({ error: 'The request could not finish. Your saved evidence is safe. Please try again.', code: 'REQUEST_FAILED' }, { status: 500 });
}
export async function body<T>(request: Request): Promise<T> {
  const content = await request.text();
  if (content.length > 2_000_000) throw new HttpError(413, 'BODY_TOO_LARGE', 'This request is too large.');
  try { return JSON.parse(content) as T; } catch { throw new HttpError(400, 'INVALID_JSON', 'Send a valid JSON request.'); }
}
export function sameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) throw new HttpError(403, 'ORIGIN_DENIED', 'This action must start from your Glasshouse session.');
}
