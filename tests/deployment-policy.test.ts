import { describe, expect, it } from 'vitest';
import { publishedProduction } from '../server/deployment-policy';
describe('trusted Netlify deployment policy', () => {
  it('requires invocation metadata and a currently published production deploy', () => {
    expect(publishedProduction()).toBe(false);
    expect(publishedProduction({})).toBe(false);
    expect(publishedProduction({ deploy: { context: 'production' } })).toBe(false);
    expect(publishedProduction({ deploy: { context: 'production', published: false } })).toBe(false);
    expect(publishedProduction({ deploy: { context: 'production', published: true } })).toBe(true);
  });
  it('denies previews and branch deploys even when their URL is published', () => {
    for (const context of ['deploy-preview', 'branch-deploy', 'dev', '']) expect(publishedProduction({ deploy: { context, published: true } })).toBe(false);
  });
});
