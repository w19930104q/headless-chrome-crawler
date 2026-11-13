const RobotsMeta = require('../lib/robots-meta');

describe('RobotsMeta.normalizeUserAgents', () => {
  test('returns an empty array for falsy values', () => {
    expect(RobotsMeta.normalizeUserAgents(null)).toEqual([]);
    expect(RobotsMeta.normalizeUserAgents(undefined)).toEqual([]);
  });

  test('wraps a single string into an array', () => {
    expect(RobotsMeta.normalizeUserAgents('Googlebot')).toEqual(['googlebot']);
  });

  test('lower-cases, trims and de-duplicates names', () => {
    expect(RobotsMeta.normalizeUserAgents([' Googlebot ', 'googlebot', 'Bingbot']))
      .toEqual(['googlebot', 'bingbot']);
  });
});

describe('RobotsMeta.evaluate', () => {
  test('allows indexing and following when no directive is present', () => {
    const result = RobotsMeta.evaluate({ headers: {}, metas: [], userAgents: null });
    expect(result.noindex).toBe(false);
    expect(result.nofollow).toBe(false);
    expect(result.obeyed).toBe(true);
  });

  test('reads a generic noindex meta tag', () => {
    const result = RobotsMeta.evaluate({
      headers: {},
      metas: [{ name: 'robots', content: 'noindex' }],
      userAgents: null,
    });
    expect(result.noindex).toBe(true);
    expect(result.nofollow).toBe(false);
  });

  test('reads a generic nofollow meta tag', () => {
    const result = RobotsMeta.evaluate({
      headers: {},
      metas: [{ name: 'robots', content: 'nofollow' }],
      userAgents: null,
    });
    expect(result.noindex).toBe(false);
    expect(result.nofollow).toBe(true);
  });

  test('expands none into noindex and nofollow', () => {
    const result = RobotsMeta.evaluate({
      headers: {},
      metas: [{ name: 'robots', content: 'none' }],
      userAgents: null,
    });
    expect(result.noindex).toBe(true);
    expect(result.nofollow).toBe(true);
  });

  test('treats all as permissive', () => {
    const result = RobotsMeta.evaluate({
      headers: {},
      metas: [{ name: 'robots', content: 'all' }],
      userAgents: null,
    });
    expect(result.noindex).toBe(false);
    expect(result.nofollow).toBe(false);
  });

  test('parses comma-separated directive lists', () => {
    const result = RobotsMeta.evaluate({
      headers: {},
      metas: [{ name: 'robots', content: 'noindex, nofollow' }],
      userAgents: null,
    });
    expect(result.noindex).toBe(true);
    expect(result.nofollow).toBe(true);
  });

  test('is case-insensitive for directives, meta names and bot names', () => {
    const result = RobotsMeta.evaluate({
      headers: {},
      metas: [{ name: 'GoogleBot', content: 'NoIndex' }],
      userAgents: ['GOOGLEBOT'],
    });
    expect(result.noindex).toBe(true);
  });

  test('reads an X-Robots-Tag response header case-insensitively', () => {
    const result = RobotsMeta.evaluate({
      headers: { 'X-Robots-Tag': 'noindex' },
      metas: [],
      userAgents: null,
    });
    expect(result.noindex).toBe(true);
  });

  test('supports multiple X-Robots-Tag fields joined by new lines', () => {
    const result = RobotsMeta.evaluate({
      headers: { 'x-robots-tag': 'noindex\nnofollow' },
      metas: [],
      userAgents: null,
    });
    expect(result.noindex).toBe(true);
    expect(result.nofollow).toBe(true);
  });

  test('parses bot-specific header directives', () => {
    const result = RobotsMeta.evaluate({
      headers: { 'x-robots-tag': 'googlebot: noindex' },
      metas: [],
      userAgents: ['googlebot'],
    });
    expect(result.noindex).toBe(true);
    expect(result.policies.googlebot.noindex).toBe(true);
    expect(result.policies['*'].noindex).toBe(false);
  });

  test('parses several bot groups combined in a single header field', () => {
    const result = RobotsMeta.evaluate({
      headers: { 'x-robots-tag': 'googlebot: noindex, bingbot: nofollow' },
      metas: [],
      userAgents: ['googlebot', 'bingbot'],
    });
    expect(result.policies.googlebot.noindex).toBe(true);
    expect(result.policies.bingbot.nofollow).toBe(true);
    expect(result.policies['*'].noindex).toBe(false);
    expect(result.noindex).toBe(true);
    expect(result.nofollow).toBe(true);
  });

  test('merges a general directive and a bot group within one field', () => {
    const result = RobotsMeta.evaluate({
      headers: { 'x-robots-tag': 'noindex, googlebot: nofollow' },
      metas: [],
      userAgents: ['googlebot'],
    });
    expect(result.policies['*'].noindex).toBe(true);
    expect(result.policies.googlebot.nofollow).toBe(true);
  });

  test('ignores header rules targeting unconfigured bots', () => {
    const result = RobotsMeta.evaluate({
      headers: { 'x-robots-tag': 'bingbot: noindex' },
      metas: [],
      userAgents: ['googlebot'],
    });
    expect(result.noindex).toBe(false);
  });

  test('merges generic rules with explicit bot rules from meta tags', () => {
    const result = RobotsMeta.evaluate({
      headers: {},
      metas: [
        { name: 'robots', content: 'nofollow' },
        { name: 'googlebot', content: 'noindex' },
      ],
      userAgents: ['googlebot'],
    });
    expect(result.noindex).toBe(true);
    expect(result.nofollow).toBe(true);
  });

  test('lets a restriction on any configured bot win conservatively', () => {
    const result = RobotsMeta.evaluate({
      headers: {},
      metas: [
        { name: 'googlebot', content: 'noindex' },
        { name: 'bingbot', content: 'nofollow' },
      ],
      userAgents: ['googlebot', 'bingbot'],
    });
    expect(result.noindex).toBe(true);
    expect(result.nofollow).toBe(true);
  });

  test('prefers the restrictive directive when header and meta conflict', () => {
    const header = RobotsMeta.evaluate({
      headers: { 'x-robots-tag': 'noindex' },
      metas: [{ name: 'robots', content: 'all' }],
      userAgents: null,
    });
    expect(header.noindex).toBe(true);
    const meta = RobotsMeta.evaluate({
      headers: { 'x-robots-tag': 'all' },
      metas: [{ name: 'robots', content: 'noindex' }],
      userAgents: null,
    });
    expect(meta.noindex).toBe(true);
  });

  test('merges headers and meta tags across both sources', () => {
    const result = RobotsMeta.evaluate({
      headers: { 'x-robots-tag': 'nofollow' },
      metas: [{ name: 'robots', content: 'noindex' }],
      userAgents: null,
    });
    expect(result.noindex).toBe(true);
    expect(result.nofollow).toBe(true);
  });

  test('exposes per-bot policy decisions for the success callback', () => {
    const result = RobotsMeta.evaluate({
      headers: {},
      metas: [{ name: 'googlebot', content: 'noindex, nofollow' }],
      userAgents: ['googlebot'],
    });
    expect(result.bots).toEqual(['googlebot']);
    expect(result.policies).toEqual({
      '*': { noindex: false, nofollow: false },
      googlebot: { noindex: true, nofollow: true },
    });
  });
});
