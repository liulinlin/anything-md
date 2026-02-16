import { createExecutionContext, env, SELF, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('Anything-MD worker', () => {
  it('returns usage info when no URL provided (unit style)', async () => {
    const request = new IncomingRequest('http://example.com');
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.converters).toEqual(['ai (default)', 'readability', 'jina']);
  });

  it('returns usage info when no URL provided (integration style)', async () => {
    const response = await SELF.fetch('https://example.com');
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.converters).toEqual(['ai (default)', 'readability', 'jina']);
  });

  it('rejects invalid converter name', async () => {
    const request = new IncomingRequest('http://example.com/?url=https://example.com&converter=invalid');
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Invalid converter. Supported: ai, readability, jina');
  });

  it('rejects jina converter without URL', async () => {
    const request = new IncomingRequest('http://example.com/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: '<p>test</p>', converter: 'jina' }),
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Jina converter requires a URL');
  });
});
