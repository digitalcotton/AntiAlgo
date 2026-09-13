import { beforeEach, describe, expect, it, vi } from 'vitest';

// A captured query spy and a controllable flag, so every property below is
// checked with no database and no real flag edition in the picture.
const query = vi.fn();
vi.mock('./db', () => ({ db: () => ({ query }) }));

const isOnMock = vi.fn((_flag?: string, _ed?: string) => true);
vi.mock('./flags', () => ({ isOn: (flag: string, ed?: string) => isOnMock(flag, ed) }));

import { recordEvent } from './analytics';

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
  isOnMock.mockReset();
  isOnMock.mockReturnValue(true);
});

describe('recordEvent', () => {
  it('records a milestone with the user id and event when the flag is on', async () => {
    await recordEvent('user-1', 'signup');
    expect(query).toHaveBeenCalledTimes(1);
    // The parameters carry only the id and the milestone name, nothing else.
    expect(query.mock.calls[0][1]).toEqual(['user-1', 'signup']);
    // And it is an upsert, so a second call for the same milestone is a no-write.
    expect(String(query.mock.calls[0][0])).toContain('ON CONFLICT');
  });

  it('is a no-op when the analytics flag is off', async () => {
    isOnMock.mockReturnValue(false);
    await recordEvent('user-1', 'apply');
    expect(query).not.toHaveBeenCalled();
  });

  it('is a no-op for an empty user id', async () => {
    await recordEvent('', 'apply');
    expect(query).not.toHaveBeenCalled();
  });

  it('swallows a database failure and resolves, so it never breaks the funnel action', async () => {
    query.mockRejectedValue(new Error('relation "analytics_event" does not exist'));
    await expect(recordEvent('user-1', 'first_entry')).resolves.toBeUndefined();
  });
});
