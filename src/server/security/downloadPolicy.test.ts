// @vitest-environment node
import { validateHeaderValue } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  assertUploadContentAllowed,
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

  it('RFC 5987-escapes filename* special characters', () => {
    const headers = createDownloadHeaders({
      filename: "team's notes(1)*.txt",
      contentType: 'text/plain',
      byteLength: 1
    });

    expect(headers['content-disposition']).toContain("filename*=UTF-8''team%27s%20notes%281%29%2A.txt");
  });

  it('sanitizes attachment filenames', () => {
    expect(sanitizeAttachmentFilename('../secret\r\nx.txt')).toBe('secret__x.txt');
    expect(sanitizeAttachmentFilename('')).toBe('download');
  });

  it('blocks SVG uploads in product mode', () => {
    expect(() =>
      assertUploadContentAllowed({
        filename: 'diagram.svg',
        contentType: 'image/svg+xml',
        productMode: true
      })
    ).toThrow('SVG uploads are disabled in product mode');
  });

  it('blocks SVG uploads in product mode by extension even when MIME is plain text', () => {
    expect(() =>
      assertUploadContentAllowed({
        filename: 'diagram.svg',
        contentType: 'text/plain',
        productMode: true
      })
    ).toThrow('SVG uploads are disabled in product mode');
  });

  it('blocks SVG uploads in product mode with MIME case variants and parameters', () => {
    expect(() =>
      assertUploadContentAllowed({
        filename: 'diagram.txt',
        contentType: 'IMAGE/SVG+XML; charset=utf-8',
        productMode: true
      })
    ).toThrow('SVG uploads are disabled in product mode');
  });

  it('allows SVG uploads outside product mode', () => {
    expect(() =>
      assertUploadContentAllowed({
        filename: 'diagram.svg',
        contentType: 'image/svg+xml',
        productMode: false
      })
    ).not.toThrow();
  });
});
