import { describe, expect, it } from 'vitest';

import { parseProxyUrl } from './proxy-url.js';

describe('parseProxyUrl', () => {
  describe('happy paths', () => {
    it('parses http with full credentials', () => {
      expect(parseProxyUrl('http://alice:secret@proxy.example.com:8080')).toEqual({
        protocol: 'http',
        host: 'proxy.example.com',
        port: 8080,
        username: 'alice',
        password: 'secret',
      });
    });

    it('parses https with full credentials', () => {
      expect(parseProxyUrl('https://u:p@h:443')).toEqual({
        protocol: 'https',
        host: 'h',
        port: 443,
        username: 'u',
        password: 'p',
      });
    });

    it('parses socks5 with full credentials', () => {
      expect(parseProxyUrl('socks5://user:pass@brd.superproxy.io:33335')).toEqual({
        protocol: 'socks5',
        host: 'brd.superproxy.io',
        port: 33335,
        username: 'user',
        password: 'pass',
      });
    });

    it('parses socks5 without credentials', () => {
      expect(parseProxyUrl('socks5://localhost:1080')).toEqual({
        protocol: 'socks5',
        host: 'localhost',
        port: 1080,
        username: undefined,
        password: undefined,
      });
    });

    it('parses http with username only (no password)', () => {
      const out = parseProxyUrl('http://alice@proxy.example.com:8080');
      expect(out.username).toBe('alice');
      expect(out.password).toBeUndefined();
    });

    it('decodes URL-encoded credentials (e.g. password contains @)', () => {
      // Bright Data sticky-session usernames frequently contain `:` and `-`
      // in the literal value; the user's responsibility to URL-encode them.
      const out = parseProxyUrl('http://brd-customer-XXX:p%40ss%3Aword@brd.example:33335');
      expect(out.username).toBe('brd-customer-XXX');
      expect(out.password).toBe('p@ss:word');
    });

    it('strips a single trailing slash (no real path)', () => {
      expect(parseProxyUrl('http://h:8080/').host).toBe('h');
      expect(parseProxyUrl('socks5://h:1080/').host).toBe('h');
    });

    it('trims surrounding whitespace before parsing', () => {
      expect(parseProxyUrl('  http://h:8080  ').host).toBe('h');
    });
  });

  describe('rejection: protocol', () => {
    it('rejects empty string', () => {
      expect(() => parseProxyUrl('')).toThrow(/empty/i);
    });

    it('rejects garbage (URL ctor fails)', () => {
      expect(() => parseProxyUrl('not a url')).toThrow(/invalid proxy url/i);
    });

    it('rejects ftp scheme', () => {
      expect(() => parseProxyUrl('ftp://h:21')).toThrow(/unsupported proxy protocol/i);
    });

    it('rejects socks5h (DNS-over-proxy variant; SDK does not support)', () => {
      expect(() => parseProxyUrl('socks5h://h:1080')).toThrow(/unsupported proxy protocol/i);
    });

    it('rejects socks4', () => {
      expect(() => parseProxyUrl('socks4://h:1080')).toThrow(/unsupported proxy protocol/i);
    });
  });

  describe('rejection: host / port', () => {
    it('rejects URL missing port', () => {
      expect(() => parseProxyUrl('http://h')).toThrow(/missing port/i);
    });

    it('accepts http://h:80 (explicit default port; URL ctor strips it but the regex fallback recovers)', () => {
      const out = parseProxyUrl('http://h:80');
      expect(out.port).toBe(80);
    });

    it('accepts https://h:443 (explicit default port; same fallback)', () => {
      const out = parseProxyUrl('https://h:443');
      expect(out.port).toBe(443);
    });

    it('rejects port 0', () => {
      // WHATWG URL emits empty `url.port` for `:0`; the regex fallback then
      // recovers `0` from the raw string, which our `port < 1` guard rejects
      // as "invalid". Either error path is fine — we just want to ensure we
      // never accept port 0 silently.
      expect(() => parseProxyUrl('http://h:0')).toThrow(/invalid port|missing port/i);
    });

    it('rejects port 65536 (URL ctor itself throws)', () => {
      // node's URL parser rejects port > 65535 with TypeError, so it surfaces
      // through our `Invalid proxy URL` branch
      expect(() => parseProxyUrl('http://h:65536')).toThrow(/invalid proxy url/i);
    });
  });

  describe('rejection: path / query / fragment', () => {
    it('rejects http://h:8080/foo (path)', () => {
      expect(() => parseProxyUrl('http://h:8080/foo')).toThrow(/must not include a path/i);
    });

    it('rejects http://h:8080?x=1 (query)', () => {
      expect(() => parseProxyUrl('http://h:8080?x=1')).toThrow(/must not include a query/i);
    });

    it('rejects http://h:8080#frag (fragment)', () => {
      expect(() => parseProxyUrl('http://h:8080#frag')).toThrow(/must not include a fragment/i);
    });
  });
});
