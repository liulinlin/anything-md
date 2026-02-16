/**
 * Anything-MD Worker
 *
 * Entry point for the Cloudflare Worker that converts any URL content
 * to Markdown via multiple converter backends.
 *
 * API:
 *   GET  /?url=https://example.com[&converter=ai|readability|jina]
 *   POST / { "url": "https://example.com", "converter": "readability" }
 *   POST / { "content": "<html>...</html>", "contentType": "text/html", "fileName": "page.html" }
 *
 * Response: { success, url, name, mimeType, tokens, markdown }
 */

import { fetchMaxAttempts, fetchTimeout } from './config';
import { type ConverterName, getConverter, isValidConverter } from './converters';
import { errorResponse, handlePreflight, jsonResponse, textResponse } from './cors';
import { robustFetch } from './fetch';
import { extractTitle, extractWeChatContent, isWeChatArticle, preprocessHtml } from './html';
import { collectImageUrls, rewriteImageUrls, uploadImages } from './r2';

/** Derive a filename from a URL path */
function getFileName(url: string): string {
  try {
    const segment = new URL(url).pathname.split('/').filter(Boolean).pop();
    if (segment?.includes('.')) return segment;
    return segment ? `${segment}.html` : 'page.html';
  } catch {
    return 'page.html';
  }
}

/** Determine whether the content type is HTML */
function isHtmlContent(contentType: string): boolean {
  return contentType.includes('text/html') || contentType.includes('application/xhtml');
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return handlePreflight(env);
    }

    // --- Parse request parameters ---
    let targetUrl: string | null = null;
    let directContent: string | null = null;
    let directContentType: string | null = null;
    let directFileName: string | null = null;
    let rawFormat = false;
    let converterName = 'ai';

    if (request.method === 'GET') {
      const params = new URL(request.url).searchParams;
      targetUrl = params.get('url');
      rawFormat = params.get('format') === 'raw';
      converterName = params.get('converter') || 'ai';
    } else if (request.method === 'POST') {
      try {
        const body = (await request.json()) as {
          url?: string;
          content?: string;
          html?: string;
          contentType?: string;
          fileName?: string;
          format?: string;
          converter?: string;
        };
        targetUrl = body.url ?? null;
        // Support both 'content' and 'html' for direct content
        directContent = body.content ?? body.html ?? null;
        directContentType = body.contentType ?? null;
        directFileName = body.fileName ?? null;
        rawFormat = body.format === 'raw';
        converterName = body.converter || 'ai';
      } catch {
        return errorResponse(env, 'Invalid JSON body. Expected: { "url": "https://..." } or { "content": "..." }');
      }
    } else {
      return errorResponse(env, 'Method not allowed. Use GET or POST.', 405);
    }

    // Validate converter name
    if (!isValidConverter(converterName)) {
      return errorResponse(env, 'Invalid converter. Supported: ai, readability, jina');
    }

    // No URL or content provided — return usage info
    if (!targetUrl && !directContent) {
      return jsonResponse(env, {
        success: true,
        message: 'Anything-MD API — Convert any URL or content to Markdown',
        usage: {
          GET: '/?url=https://example.com',
          POST_URL: '{ "url": "https://example.com" }',
          POST_CONTENT: '{ "content": "<html>...</html>", "contentType": "text/html", "fileName": "page.html" }',
          POST_HTML: '{ "html": "<html>...</html>" }',
        },
        converters: ['ai (default)', 'readability', 'jina'],
      });
    }

    // Validate URL format if URL is provided
    if (targetUrl) {
      try {
        new URL(targetUrl);
      } catch {
        return errorResponse(env, 'Invalid URL provided.');
      }
    }

    // Jina converter requires a URL — it cannot process direct content
    if (converterName === 'jina' && !targetUrl) {
      return errorResponse(env, 'Jina converter requires a URL');
    }

    try {
      const converter = getConverter(converterName as ConverterName);

      // --- Jina path: skip local fetch and HTML preprocessing ---
      if (converterName === 'jina') {
        const result = await converter({ url: targetUrl, body: new ArrayBuffer(0), contentType: '', fileName: '' }, env);

        let markdown = result.markdown;

        // R2 image proxy still applies
        if (env.IMAGES_BUCKET && env.R2_PUBLIC_URL) {
          const imageUrls = collectImageUrls('', markdown);
          if (imageUrls.length > 0) {
            markdown = rewriteImageUrls(markdown, imageUrls, env.R2_PUBLIC_URL, env);
            ctx.waitUntil(uploadImages(imageUrls, env.IMAGES_BUCKET, env));
          }
        }

        if (rawFormat) {
          return textResponse(env, markdown);
        }

        return jsonResponse(env, {
          success: true,
          url: targetUrl ?? undefined,
          name: result.name,
          mimeType: result.mimeType,
          tokens: result.tokens,
          markdown,
        });
      }

      // --- ai / readability path ---
      let body: ArrayBuffer;
      let contentType: string;
      let fileName: string;

      // Branch 1: Direct content provided
      if (directContent) {
        // Use provided contentType or default to text/html
        contentType = directContentType || 'text/html';
        fileName = directFileName || 'content.html';

        // For HTML content: extract title first, then process content
        if (isHtmlContent(contentType)) {
          // Step 1: Extract title from original HTML (before any processing)
          if (!directFileName) {
            const title = extractTitle(directContent, 'content');
            fileName = `${title}.html`;
          }

          // Step 2: Extract WeChat content if applicable
          let processedContent = directContent;
          if (isWeChatArticle(directContent)) {
            processedContent = extractWeChatContent(directContent);
          }

          // Step 3: Preprocess lazy-loaded images
          processedContent = preprocessHtml(processedContent);
          body = new TextEncoder().encode(processedContent).buffer as ArrayBuffer;
        } else {
          // Non-HTML content: encode directly
          body = new TextEncoder().encode(directContent).buffer as ArrayBuffer;
        }
      }
      // Branch 2: Fetch from URL
      else if (targetUrl) {
        const response = await robustFetch(targetUrl, {
          timeout: fetchTimeout(env),
          maxAttempts: fetchMaxAttempts(env),
        });

        if (!response.ok) {
          return errorResponse(env, `Failed to fetch URL: ${response.status} ${response.statusText}`, 502);
        }

        contentType = response.headers.get('content-type') || 'application/octet-stream';
        body = await response.arrayBuffer();
        fileName = getFileName(targetUrl);

        // For HTML content: extract title first, then process content
        if (isHtmlContent(contentType)) {
          const rawHtml = new TextDecoder().decode(body);

          // Step 1: Extract title from original HTML (before any processing)
          const title = extractTitle(rawHtml, fileName.replace(/\.html$/, ''));
          fileName = `${title}.html`;

          // Step 2: Extract WeChat content if applicable
          let processedHtml = rawHtml;
          if (isWeChatArticle(rawHtml)) {
            processedHtml = extractWeChatContent(rawHtml);
          }

          // Step 3: Preprocess lazy-loaded images
          processedHtml = preprocessHtml(processedHtml);
          body = new TextEncoder().encode(processedHtml).buffer as ArrayBuffer;
        }
      } else {
        return errorResponse(env, 'No URL or content provided.');
      }

      // Readability only supports HTML content
      if (converterName === 'readability' && !isHtmlContent(contentType)) {
        return errorResponse(env, 'Readability only supports HTML', 422);
      }

      // Convert via selected converter
      const result = await converter({ url: targetUrl, body, contentType, fileName }, env);

      let markdown = result.markdown;

      // Proxy images through R2 (if configured)
      const rawHtmlForImages = isHtmlContent(contentType) ? new TextDecoder().decode(body) : '';

      if (env.IMAGES_BUCKET && env.R2_PUBLIC_URL) {
        const imageUrls = collectImageUrls(rawHtmlForImages, markdown);
        if (imageUrls.length > 0) {
          markdown = rewriteImageUrls(markdown, imageUrls, env.R2_PUBLIC_URL, env);
          // Upload in the background — does not block the response
          ctx.waitUntil(uploadImages(imageUrls, env.IMAGES_BUCKET, env));
        }
      }

      // Return raw Markdown text or JSON envelope
      if (rawFormat) {
        return textResponse(env, markdown);
      }

      return jsonResponse(env, {
        success: true,
        url: targetUrl ?? undefined,
        name: result.name,
        mimeType: result.mimeType,
        tokens: result.tokens,
        markdown,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';

      // Map known converter errors to appropriate status codes
      if (message === 'Could not extract article content') {
        return errorResponse(env, message, 500);
      }
      if (message.startsWith('Jina Reader API returned')) {
        return errorResponse(env, message, 500);
      }
      if (message.startsWith('Conversion failed:')) {
        return errorResponse(env, message, 422);
      }

      return errorResponse(env, `Internal error: ${message}`, 500);
    }
  },
} satisfies ExportedHandler<Env>;
