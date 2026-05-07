export interface DownloadHeaderInput {
  filename: string;
  contentType: string;
  byteLength: number;
}

export function createDownloadHeaders(input: DownloadHeaderInput): Record<string, string> {
  const filename = sanitizeAttachmentFilename(input.filename);
  const fallbackFilename = sanitizeHeaderFallbackFilename(filename);
  return {
    'cache-control': 'private, no-store',
    'content-disposition': `attachment; filename="${fallbackFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'content-length': String(input.byteLength),
    'content-type': input.contentType || 'application/octet-stream',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff'
  };
}

export function sanitizeAttachmentFilename(filename: string): string {
  const baseName = filename.replace(/\\/g, '/').split('/').pop()?.trim() ?? '';
  const cleaned = baseName.replace(/[\r\n"]/g, '_');
  return cleaned || 'download';
}

function sanitizeHeaderFallbackFilename(filename: string): string {
  return filename.replace(/[^\x20-\x7e]/g, '_');
}

export function assertUploadContentTypeAllowed(input: { contentType: string; productMode: boolean }): void {
  if (input.productMode && input.contentType.toLowerCase() === 'image/svg+xml') {
    throw new Error('SVG uploads are disabled in product mode');
  }
}
