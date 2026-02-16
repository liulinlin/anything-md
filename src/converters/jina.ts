import { jinaApiKey } from '../config';
import type { ConverterFn, ConvertInput, ConvertResult } from './types';

export const jinaConvert: ConverterFn = async (input: ConvertInput, env: Env): Promise<ConvertResult> => {
  if (!input.url) {
    throw new Error('Jina converter requires a URL');
  }

  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'X-Engine': 'browser',
    'X-Return-Format': 'markdown',
  };

  const apiKey = jinaApiKey(env);
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(`https://r.jina.ai/${input.url}`, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`Jina Reader API returned ${response.status}`);
  }

  const data = (await response.json()) as { data?: { title?: string; content?: string } };
  const markdown = data.data?.content ?? '';
  const title = data.data?.title ?? input.fileName;

  return {
    markdown,
    name: title,
    mimeType: 'text/html',
    tokens: markdown.split(/\s+/).length,
  };
};
