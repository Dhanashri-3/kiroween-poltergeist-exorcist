import { describe, it, expect } from 'vitest';
import { DEFAULT_API_BASE_URL, resolveApiBaseUrl } from './config.js';

describe('resolveApiBaseUrl', () => {
  it('defaults to the documented /api/v1 prefix', () => {
    expect(DEFAULT_API_BASE_URL).toBe('/api/v1');
    expect(resolveApiBaseUrl({})).toBe('/api/v1');
    expect(resolveApiBaseUrl({ VITE_API_BASE_URL: '  ' })).toBe('/api/v1');
  });

  it('uses VITE_API_BASE_URL when set and trims trailing slashes', () => {
    expect(resolveApiBaseUrl({ VITE_API_BASE_URL: 'http://127.0.0.1:4000/api/v1/' })).toBe(
      'http://127.0.0.1:4000/api/v1',
    );
  });
});
