import { describe, it, expect, vi } from 'vitest';

interface Mock {
  select: ReturnType<typeof vi.fn> & ((...args: unknown[]) => Mock);
  eq: ReturnType<typeof vi.fn> & ((...args: unknown[]) => Mock);
  order: ReturnType<typeof vi.fn> & ((...args: unknown[]) => Mock);
}

function makeMock(): Mock {
  const self = {} as Mock;
  self.select = vi.fn(() => self);
  self.eq = vi.fn(() => self);
  self.order = vi.fn(() => self);
  return self;
}

describe('debug', () => {
  it('chains select -> eq -> order', () => {
    const mock = makeMock();
    const result = mock.select('*').eq('user_id', 'u1').order('created_at', { ascending: false });
    expect(result).toBe(mock);
    expect(mock.select).toHaveBeenCalledWith('*');
    expect(mock.eq).toHaveBeenCalledWith('user_id', 'u1');
  });
});
