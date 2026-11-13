const extend = require('lodash/extend');
const HCCrawler = require('../../');
const Crawler = require('../../lib/crawler');
const Server = require('../server');

const PORT_A = 8101;
const PORT_B = 8102;
const PREFIX_A = `http://127.0.0.1:${PORT_A}`;
const PREFIX_B = `http://127.0.0.1:${PORT_B}`;

const DEFAULT_OPTIONS = { args: ['--no-sandbox'] };

describe('HCCrawler linkGraph option', () => {
  beforeAll(async () => {
    this.serverA = await Server.run(PORT_A);
    this.serverB = await Server.run(PORT_B);
  });

  afterAll(async () => {
    await this.serverA.stop();
    await this.serverB.stop();
  });

  beforeEach(() => {
    this.serverA.reset();
    this.serverB.reset();
    this.onSuccess = jest.fn();
    this.onError = jest.fn();
  });

  afterEach(async () => {
    if (this.crawler) await this.crawler.close();
    // Make sure a prototype override installed by a test never leaks.
    if (this._originalEvaluateFrameLinks) {
      Crawler.prototype._evaluateFrameLinks = this._originalEvaluateFrameLinks;
      this._originalEvaluateFrameLinks = null;
    }
  });

  describe('when linkGraph is enabled', () => {
    beforeEach(() => {
      this.serverA.setContent('/graph.html', `<html><head><base href="${PREFIX_A}/base/"></head><body>
        <a href="same">same link</a>
        <a href="same">same link again</a>
        <a href="${PREFIX_A}/followed#frag">followed absolute</a>
        <a href="/nofollowed" rel="nofollow">not followed</a>
        <a href="mailto:hello@example.com">mail link</a>
        <iframe src="${PREFIX_A}/inner.html"></iframe>
        <iframe src="${PREFIX_B}/cross-inner.html"></iframe>
      </body></html>`);
      this.serverA.setContent('/inner.html', `<html><body>
        <a href="inner">inner link</a>
        <a href="${PREFIX_A}/nofollowed" rel="nofollow ugc">inner nofollow</a>
        <iframe src="${PREFIX_A}/nested.html"></iframe>
      </body></html>`);
      this.serverA.setContent('/nested.html', '<html><body><a href="nested">nested link</a></body></html>');
      this.serverB.setContent('/cross-inner.html', '<html><body><a href="cross">cross link</a></body></html>');
    });

    beforeEach(async () => {
      this.crawler = await HCCrawler.launch(extend({
        linkGraph: true,
        obeyRobotsTxt: false,
        maxDepth: 2,
        maxConcurrency: 1,
        onSuccess: this.onSuccess,
        onError: this.onError,
      }, DEFAULT_OPTIONS));
      await this.crawler.queue(`${PREFIX_A}/graph.html`);
      await this.crawler.onIdle();
    });

    test('records every a[href] edge including duplicates', () => {
      const result = this.onSuccess.mock.calls[0][0];
      expect(result.linkGraph).toHaveLength(9);
      const rawHrefs = result.linkGraph.map(edge => edge.rawHref);
      expect(rawHrefs.filter(href => href === 'same')).toEqual(['same', 'same']);
    });

    test('keeps edges ordered by the frame tree and the DOM order', () => {
      const result = this.onSuccess.mock.calls[0][0];
      expect(result.linkGraph.map(edge => edge.framePath)).toEqual([
        [], [], [], [], [],
        [0], [0],
        [0, 0],
        [1],
      ]);
      expect(result.linkGraph.slice(0, 5).map(edge => edge.text)).toEqual([
        'same link',
        'same link again',
        'followed absolute',
        'not followed',
        'mail link',
      ]);
    });

    test('resolves urls against each document base and final document url', () => {
      const result = this.onSuccess.mock.calls[0][0];
      const mainEdges = result.linkGraph.filter(edge => edge.framePath.length === 0);
      expect(mainEdges[0].url).toBe(`${PREFIX_A}/base/same`);
      expect(mainEdges[0].documentUrl).toBe(`${PREFIX_A}/base/`);
      const innerEdge = result.linkGraph.find(edge => edge.text === 'inner link');
      expect(innerEdge.documentUrl).toBe(`${PREFIX_A}/inner.html`);
      expect(innerEdge.url).toBe(`${PREFIX_A}/inner`);
      const nestedEdge = result.linkGraph.find(edge => edge.text === 'nested link');
      expect(nestedEdge.url).toBe(`${PREFIX_A}/nested`);
    });

    test('covers cross-origin iframes', () => {
      const result = this.onSuccess.mock.calls[0][0];
      const crossEdge = result.linkGraph.find(edge => edge.framePath.join('.') === '1');
      expect(crossEdge.documentUrl).toBe(`${PREFIX_B}/cross-inner.html`);
      expect(crossEdge.url).toBe(`${PREFIX_B}/cross`);
      expect(crossEdge.rel).toBe(null);
      expect(crossEdge.nofollow).toBe(false);
    });

    test('records rel and the nofollow flag on each edge', () => {
      const result = this.onSuccess.mock.calls[0][0];
      const nofollowEdges = result.linkGraph.filter(edge => edge.nofollow);
      expect(nofollowEdges).toHaveLength(2);
      expect(nofollowEdges.map(edge => edge.rel).sort()).toEqual(['nofollow', 'nofollow ugc']);
      const normalEdge = result.linkGraph.find(edge => edge.text === 'same link');
      expect(normalEdge.rel).toBe(null);
      expect(normalEdge.nofollow).toBe(false);
    });

    test('records nofollow edges but never follows them while still following other edges to the same url', () => {
      const result = this.onSuccess.mock.calls[0][0];
      expect(result.links).not.toContain(`${PREFIX_A}/nofollowed`);
      expect(result.links).toContain(`${PREFIX_A}/followed`);
      expect(result.links).toContain(`${PREFIX_A}/base/same`);
      const visitedUrls = this.onSuccess.mock.calls.map(call => call[0].response.url);
      expect(visitedUrls).not.toContain(`${PREFIX_A}/nofollowed`);
      expect(visitedUrls).toContain(`${PREFIX_A}/followed`);
      expect(visitedUrls).toContain(`${PREFIX_A}/base/same`);
    });

    test('keeps the legacy links field as a deduplicated string array', () => {
      const result = this.onSuccess.mock.calls[0][0];
      expect(Array.isArray(result.links)).toBe(true);
      result.links.forEach(link => expect(typeof link).toBe('string'));
      expect(new Set(result.links).size).toBe(result.links.length);
      expect(result.links.some(link => link.startsWith('mailto:'))).toBe(false);
    });

    test('delivers no frame failures for healthy same- and cross-origin frames', () => {
      const result = this.onSuccess.mock.calls[0][0];
      expect(result.frameFailures).toEqual([]);
    });
  });

  describe('when a cross-origin frame responds slowly', () => {
    beforeEach(() => {
      this.serverA.setContent('/ordered.html', `<html><body>
        <a href="/main-one">main one</a>
        <iframe src="${PREFIX_A}/fast.html"></iframe>
        <iframe src="${PREFIX_B}/slow.html"></iframe>
      </body></html>`);
      this.serverA.setContent('/fast.html', '<html><body><a href="/fast-link">fast link</a></body></html>');
      this.serverB.setContent('/slow.html', '<html><body><a href="/slow-link">slow link</a></body></html>');
      // Make the cross-origin child finish well after the same-origin child,
      // which would interleave the edges without frame-tree ordered slots.
      this.serverB.setResponseDelay('/slow.html', 800);
    });

    test('still orders edges by the frame tree regardless of completion timing', async () => {
      this.crawler = await HCCrawler.launch(extend({
        linkGraph: true,
        obeyRobotsTxt: false,
        maxDepth: 1,
        onSuccess: this.onSuccess,
        onError: this.onError,
      }, DEFAULT_OPTIONS));
      await this.crawler.queue(`${PREFIX_A}/ordered.html`);
      await this.crawler.onIdle();
      expect(this.onError).not.toHaveBeenCalled();
      const result = this.onSuccess.mock.calls[0][0];
      expect(result.linkGraph.map(edge => edge.text)).toEqual([
        'main one',
        'fast link',
        'slow link',
      ]);
      expect(result.linkGraph.map(edge => edge.framePath)).toEqual([[], [0], [1]]);
      expect(result.frameFailures).toEqual([]);
    });
  });

  describe('when a frame fails during collection', () => {
    beforeEach(() => {
      this.serverA.setContent('/frames.html', `<html><body>
        <a href="/main">main link</a>
        <iframe src="${PREFIX_A}/frame.html"></iframe>
        <iframe src="${PREFIX_A}/healthy.html"></iframe>
      </body></html>`);
      this.serverA.setContent('/frame.html', '<html><body><a href="/frame-link">frame link</a></body></html>');
      this.serverA.setContent('/healthy.html', '<html><body><a href="/healthy-link">healthy link</a></body></html>');
    });

    // Injects the exact errors puppeteer raises for a frame that becomes
    // unavailable inside the collection window, while keeping a real page and
    // a real frame tree. This exercises the production failure handling
    // deterministically instead of racing against navigation timing.
    function failFirstChildFrame(message) {
      const original = Crawler.prototype._evaluateFrameLinks;
      this._originalEvaluateFrameLinks = original;
      Crawler.prototype._evaluateFrameLinks = function (frame) {
        if (frame.url().endsWith('/frame.html')) return Promise.reject(new Error(message));
        return original.call(this, frame);
      };
    }

    test('records a detached frame as a failure and keeps other frames', async () => {
      failFirstChildFrame.call(this,
        'Execution Context is not available in detached frame "x" (are you trying to evaluate?)');
      this.crawler = await HCCrawler.launch(extend({
        linkGraph: true,
        obeyRobotsTxt: false,
        maxDepth: 1,
        retryCount: 0,
        onSuccess: this.onSuccess,
        onError: this.onError,
      }, DEFAULT_OPTIONS));
      await this.crawler.queue(`${PREFIX_A}/frames.html`);
      await this.crawler.onIdle();
      expect(this.onError).not.toHaveBeenCalled();
      const result = this.onSuccess.mock.calls[0][0];
      const texts = result.linkGraph.map(edge => edge.text);
      expect(texts).toContain('main link');
      expect(texts).toContain('healthy link');
      expect(texts).not.toContain('frame link');
      expect(result.frameFailures).toHaveLength(1);
      expect(result.frameFailures[0].framePath).toEqual([0]);
      expect(result.frameFailures[0].reason).toBe('detached');
      expect(result.frameFailures[0].documentUrl).toBe(`${PREFIX_A}/frame.html`);
    });

    test('records a navigating frame as a failure and keeps other frames', async () => {
      failFirstChildFrame.call(this,
        'Execution context was destroyed, most likely because of a navigation.');
      this.crawler = await HCCrawler.launch(extend({
        linkGraph: true,
        obeyRobotsTxt: false,
        maxDepth: 1,
        retryCount: 0,
        onSuccess: this.onSuccess,
        onError: this.onError,
      }, DEFAULT_OPTIONS));
      await this.crawler.queue(`${PREFIX_A}/frames.html`);
      await this.crawler.onIdle();
      expect(this.onError).not.toHaveBeenCalled();
      const result = this.onSuccess.mock.calls[0][0];
      const texts = result.linkGraph.map(edge => edge.text);
      expect(texts).toContain('main link');
      expect(texts).toContain('healthy link');
      expect(texts).not.toContain('frame link');
      expect(result.frameFailures).toHaveLength(1);
      expect(result.frameFailures[0].framePath).toEqual([0]);
      expect(result.frameFailures[0].reason).toBe('navigating');
      expect(result.frameFailures[0].documentUrl).toBe(`${PREFIX_A}/frame.html`);
    });
  });

  describe('when linkGraph is disabled (default)', () => {
    beforeEach(() => {
      this.serverA.setContent('/plain.html', `<html><body>
        <a href="${PREFIX_A}/one.html">one</a>
        <a href="${PREFIX_A}/one.html">one again</a>
        <iframe src="${PREFIX_B}/cross-inner.html"></iframe>
      </body></html>`);
      this.serverB.setContent('/cross-inner.html', `<html><body><a href="${PREFIX_B}/two.html">two</a></body></html>`);
    });

    test('keeps the legacy behavior without graph fields', async () => {
      this.crawler = await HCCrawler.launch(extend({
        obeyRobotsTxt: false,
        maxDepth: 1,
        onSuccess: this.onSuccess,
        onError: this.onError,
      }, DEFAULT_OPTIONS));
      await this.crawler.queue(`${PREFIX_A}/plain.html`);
      await this.crawler.onIdle();
      const result = this.onSuccess.mock.calls[0][0];
      // Legacy mode cannot read cross-origin frame documents, so it falls back
      // to the iframe's src instead of the links inside it.
      expect(result.links).toEqual([
        `${PREFIX_A}/one.html`,
        `${PREFIX_B}/cross-inner.html`,
      ]);
      expect(result.linkGraph).toBe(undefined);
      expect(result.frameFailures).toBe(undefined);
    });
  });
});
