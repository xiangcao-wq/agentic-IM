// @vitest-environment node
import { validateHeaderValue } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  assertUploadContentTypeAllowed,
  createDownloadHeaders,
  sanitizeAttachmentFilename
} from './downloadPolicy';

describe('download policy', () => {
  it('creates hardened attachment headers', () => {
    expect(
      createDownloadHeaders({
        filename: 'team notes.txt',
        contentType: 'text/plain',
        byteLength: 12
      })
    ).toEqual({
      'cache-control': 'private, no-store',
      'content-disposition': `attachment; filename="team notes.txt"; filename*=UTF-8''team%20notes.txt`,
      'content-length': '12',
      'content-type': 'text/plain',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff'
    });
  });

  it('creates header-safe disposition values for non-ASCII filenames', () => {
    const filename = '\u8bbf\u8c08\u5bf9\u8c61.txt';
    const headers = createDownloadHeaders({
      filename,
      contentType: 'text/plain',
      byteLength: 1
    });

    expect(() => validateHeaderValue('content-disposition', headers['content-disposition'])).not.toThrow();
    expect(headers['content-disposition']).toContain(`filename*=UTF-8''${encodeURIComponent(filename)}`);
  });

  it('sanitizes attachment filenames', () => {
    expect(sanitizeAttachmentFilename('../secret\r\nx.txt')).toBe('secret__x.txt');
    expect(sanitizeAttachmentFilename('')).toBe('download');
  });

  it('blocks SVG uploads in product mode', () => {
    expect(() =>
      assertUploadContentTypeAllowed({
        contentType: 'image/svg+xml',
        productMode: true
      })
    ).toThrow('SVG uploads are disabled in product mode');
  });

  it('allows SVG uploads outside product mode', () => {
    expect(() =>
      assertUploadContentTypeAllowed({
        contentType: 'image/svg+xml',
        productMode: false
      })
    ).not.toThrow();
  });
});
