import { describe, expect, it } from 'vitest';
import { boardReturnHref } from './board-return';

const HERE = 'https://www.antialgo.ai/board/openai-product-designer-youth-v225pv';
const LISTS = ['/board', '/prelist'];

describe('boardReturnHref', () => {
  it('carries the page the reader was on', () => {
    expect(boardReturnHref('https://www.antialgo.ai/board?page=4', HERE, LISTS)).toBe('/board?page=4');
  });

  it('carries the whole question, not just the page', () => {
    expect(
      boardReturnHref('https://www.antialgo.ai/board?location=remote&sort=age&per=25&page=3', HERE, LISTS)
    ).toBe('/board?location=remote&sort=age&per=25&page=3');
  });

  it('returns the bare path when the reader was on page one', () => {
    expect(boardReturnHref('https://www.antialgo.ai/board', HERE, LISTS)).toBe('/board');
  });

  it('keeps a reader on the listing they actually came from', () => {
    expect(boardReturnHref('https://www.antialgo.ai/prelist?page=2', HERE, LISTS)).toBe('/prelist?page=2');
  });

  // The referrer is a header, so it is input. Everything below is the reason
  // this goes through parseBoardQuery instead of being pasted into an href.
  it('drops a parameter the board does not have', () => {
    expect(boardReturnHref('https://www.antialgo.ai/board?page=4&next=//evil.example', HERE, LISTS)).toBe(
      '/board?page=4'
    );
  });

  it('reads a value the board would not accept as the default', () => {
    expect(boardReturnHref('https://www.antialgo.ai/board?sort=price&per=7&page=-2', HERE, LISTS)).toBe('/board');
  });

  it('refuses another origin', () => {
    expect(boardReturnHref('https://evil.example/board?page=4', HERE, LISTS)).toBeNull();
  });

  it('refuses a path that is not a listing', () => {
    expect(boardReturnHref('https://www.antialgo.ai/settings?page=4', HERE, LISTS)).toBeNull();
    expect(boardReturnHref('https://www.antialgo.ai/board/some-other-role', HERE, LISTS)).toBeNull();
  });

  it('treats a trailing slash as the same page', () => {
    expect(boardReturnHref('https://www.antialgo.ai/board/?page=2', HERE, LISTS)).toBe('/board?page=2');
  });

  it('falls back when there is no referrer, or it is unreadable', () => {
    expect(boardReturnHref(null, HERE, LISTS)).toBeNull();
    expect(boardReturnHref('', HERE, LISTS)).toBeNull();
    expect(boardReturnHref('not a url', HERE, LISTS)).toBeNull();
  });
});
