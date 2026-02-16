export interface ConvertInput {
  url: string | null;
  body: ArrayBuffer;
  contentType: string;
  fileName: string;
}

export interface ConvertResult {
  markdown: string;
  name: string;
  mimeType: string;
  tokens: number;
}

export type ConverterFn = (input: ConvertInput, env: Env) => Promise<ConvertResult>;
