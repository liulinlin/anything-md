import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import type { ConverterFn, ConvertInput, ConvertResult } from './types';

export const readabilityConvert: ConverterFn = async (input: ConvertInput): Promise<ConvertResult> => {
  const html = new TextDecoder().decode(input.body);
  const { document } = parseHTML(html);

  const reader = new Readability(document);
  const article = reader.parse();

  if (!article) {
    throw new Error('Could not extract article content');
  }

  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  const markdown = turndown.turndown(article.content);

  return {
    markdown,
    name: input.fileName,
    mimeType: 'text/html',
    tokens: markdown.split(/\s+/).length,
  };
};
