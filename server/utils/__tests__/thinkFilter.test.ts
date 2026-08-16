/* SPDX-License-Identifier: Apache-2.0 */
import { describe, it, expect } from 'vitest';
import { stripThinkBlocks, ThinkStreamFilter } from '../thinkFilter';

describe('stripThinkBlocks', () => {
  it('returns clean text unchanged', () => {
    expect(stripThinkBlocks('# Summary\n\nHello')).toBe('# Summary\n\nHello');
  });

  it('removes a closed think block and keeps surrounding text', () => {
    expect(stripThinkBlocks('<think>reasoning here</think>The answer')).toBe('The answer');
    expect(stripThinkBlocks('Before<think>drop me</think>After')).toBe('BeforeAfter');
  });

  it('removes multiple think blocks', () => {
    expect(stripThinkBlocks('<think>a</think>x<think>b</think>y')).toBe('xy');
  });

  it('swallows everything after an unclosed think block (truncated generation)', () => {
    expect(stripThinkBlocks('Answer A<think>half-finished reason')).toBe('Answer A');
  });

  it('yields empty when the whole completion is one unclosed block', () => {
    expect(stripThinkBlocks('<think>only reasoning')).toBe('');
  });

  it('trims whitespace left behind by stripping', () => {
    expect(stripThinkBlocks('<think>r</think>\n\n  answer  ')).toBe('answer');
  });
});

describe('ThinkStreamFilter', () => {
  function stream(deltas: string[]): string {
    const f = new ThinkStreamFilter();
    let out = '';
    for (const d of deltas) out += f.push(d);
    out += f.flush();
    return out;
  }

  it('passes clean deltas through (joined == input)', () => {
    expect(stream(['Hello ', 'world', '!'])).toBe('Hello world!');
  });

  it('drops a think block split across many deltas', () => {
    const f = new ThinkStreamFilter();
    let out = f.push('<th');
    out += f.push('ink>reason');
    out += f.push('ing</th');
    out += f.push('ink>done');
    out += f.flush();
    expect(out).toBe('done');
  });

  it('holds back a tail that could still grow into an opening marker', () => {
    const f = new ThinkStreamFilter();
    const first = f.push('answer<');
    expect(first).toBe('answer');
    expect(f.push('think>hidden</think>!')).toBe('!');
    expect(f.flush()).toBe('');
  });

  it('releases held-back text when it turns out to be plain content', () => {
    const f = new ThinkStreamFilter();
    expect(f.push('a<t')).toBe('a');
    expect(f.push('xt')).toBe('<txt');
  });

  it('drops trailing think content on flush (never emits reasoning)', () => {
    const f = new ThinkStreamFilter();
    expect(f.push('ok<think>unfinished')).toBe('ok');
    expect(f.flush()).toBe('');
  });

  it('handles think-close split across deltas', () => {
    const f = new ThinkStreamFilter();
    expect(f.push('<think>x</')).toBe('');
    expect(f.push('think>real')).toBe('real');
  });
});
