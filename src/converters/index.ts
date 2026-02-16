import { aiConvert } from './ai';
import { jinaConvert } from './jina';
import { readabilityConvert } from './readability';
import type { ConverterFn } from './types';

export type ConverterName = 'ai' | 'readability' | 'jina';

const converters: Record<ConverterName, ConverterFn> = {
  ai: aiConvert,
  readability: readabilityConvert,
  jina: jinaConvert,
};

export function isValidConverter(name: string): name is ConverterName {
  return name in converters;
}

export function getConverter(name: ConverterName): ConverterFn {
  return converters[name];
}

export type { ConverterFn, ConvertInput, ConvertResult } from './types';
