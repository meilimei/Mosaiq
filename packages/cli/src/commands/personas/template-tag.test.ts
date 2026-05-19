import { describe, expect, it } from 'vitest';

import { extractTemplateTag, makeTemplateTag } from './template-tag.js';

describe('makeTemplateTag', () => {
  it('prefixes with "template:"', () => {
    expect(makeTemplateTag('win11-chrome-us')).toBe('template:win11-chrome-us');
  });
});

describe('extractTemplateTag', () => {
  it('finds CLI-style prefix tag (template:<id>)', () => {
    const p = { metadata: { tags: ['template:win11-chrome-us', 'reddit'] } };
    expect(extractTemplateTag(p)).toBe('win11-chrome-us');
  });

  it('finds desktop-style bare tag matching a known template id', () => {
    const p = { metadata: { tags: ['win11-chrome-us', 'reddit'] } };
    expect(extractTemplateTag(p)).toBe('win11-chrome-us');
  });

  it('prefers prefix form over bare match when both present', () => {
    const p = {
      metadata: {
        tags: ['win10-chrome-us', 'template:win11-chrome-us', 'reddit'],
      },
    };
    expect(extractTemplateTag(p)).toBe('win11-chrome-us');
  });

  it('returns undefined when no template tag (default desktop create with bench/baseline tags)', () => {
    const p = { metadata: { tags: ['bench', 'baseline'] } };
    expect(extractTemplateTag(p)).toBeUndefined();
  });

  it('returns undefined for empty tags array', () => {
    expect(extractTemplateTag({ metadata: { tags: [] } })).toBeUndefined();
  });

  it('returns undefined for missing tags property', () => {
    expect(extractTemplateTag({ metadata: {} })).toBeUndefined();
  });

  it('ignores bare tags that are not in the known template id set', () => {
    const p = { metadata: { tags: ['reddit', 'us', 'warming'] } };
    expect(extractTemplateTag(p)).toBeUndefined();
  });
});
