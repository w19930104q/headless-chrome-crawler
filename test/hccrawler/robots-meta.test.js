const { unlink, readFile } = require('fs');
const HCCrawler = require('../../');
const CSVExporter = require('../../exporter/csv');
const Server = require('../server');

const PORT = 8081;
const PREFIX = `http://127.0.0.1:${PORT}`;
const CSV_FILE = './tmp/robots-meta.csv';
const ENCODING = 'utf8';

const DEFAULT_OPTIONS = { args: ['--no-sandbox'] };

function evaluatePage() {
  return window.document.title;
}

function removeFile(file) {
  return new Promise(resolve => unlink(file, () => resolve()));
}

function readTemporaryFile(file) {
  return new Promise((resolve, reject) => {
    readFile(file, ENCODING, ((error, result) => {
      if (error) return reject(error);
      return resolve(result);
    }));
  });
}

describe('HCCrawler obeyRobotsMeta', () => {
  beforeAll(async () => {
    this.server = await Server.run(PORT);
  });

  afterAll(() => this.server.stop());

  beforeEach(() => {
    this.server.reset();
    this.onSuccess = jest.fn();
  });

  afterEach(() => this.crawler.close());

  const launch = async options => {
    this.crawler = await HCCrawler.launch(Object.assign({
      evaluatePage,
      onSuccess: this.onSuccess,
    }, DEFAULT_OPTIONS, options));
  };

  test('keeps crawling and scraping unchanged when the mode is off by default', async () => {
    this.server.setHeaders('/', { 'X-Robots-Tag': 'noindex' });
    this.server.setContent('/', '<title>index</title>');
    await launch({ obeyRobotsTxt: false });
    await this.crawler.queue(`${PREFIX}/`);
    await this.crawler.onIdle();
    expect(this.onSuccess).toHaveBeenCalledTimes(1);
    const result = this.onSuccess.mock.calls[0][0];
    expect(result.result).toBe('index');
    expect(result.robotsMeta).toBe(null);
  });

  describe('when obeyRobotsMeta = true', () => {
    beforeEach(() => launch({ obeyRobotsTxt: false, obeyRobotsMeta: true }));

    test('skips evaluatePage on noindex but still reports response and policy', async () => {
      this.server.setContent('/', '<title>index</title><meta name="robots" content="noindex">');
      await this.crawler.queue(`${PREFIX}/`);
      await this.crawler.onIdle();
      expect(this.onSuccess).toHaveBeenCalledTimes(1);
      const result = this.onSuccess.mock.calls[0][0];
      expect(result.result).toBe(null);
      expect(result.response.status).toBe(200);
      expect(result.response.url).toBe(`${PREFIX}/`);
      expect(result.robotsMeta.noindex).toBe(true);
      expect(result.robotsMeta.nofollow).toBe(false);
    });

    test('skips the screenshot on noindex', async () => {
      this.server.setContent('/', '<meta name="robots" content="noindex">');
      await this.crawler.queue({ url: `${PREFIX}/`, screenshot: {} });
      await this.crawler.onIdle();
      const result = this.onSuccess.mock.calls[0][0];
      expect(result.robotsMeta.noindex).toBe(true);
      expect(result.screenshot).toBe(null);
    });

    test('does not write the exporter line on noindex', async () => {
      await removeFile(CSV_FILE);
      await this.crawler.close();
      const exporter = new CSVExporter({ file: CSV_FILE, fields: ['result'] });
      await launch({ obeyRobotsTxt: false, obeyRobotsMeta: true, exporter });
      this.server.setContent('/1.html', '<meta name="robots" content="noindex"><title>blocked</title>');
      this.server.setContent('/2.html', '<title>allowed</title>');
      await this.crawler.queue(`${PREFIX}/1.html`);
      await this.crawler.queue(`${PREFIX}/2.html`);
      await this.crawler.onIdle();
      const csv = await readTemporaryFile(CSV_FILE);
      expect(csv).toBe('result\nallowed\n');
      await removeFile(CSV_FILE);
    });

    test('reads the meta tag after waitFor settles', async () => {
      this.server.setContent('/', `
      <script>
      setTimeout(() => {
        const meta = window.document.createElement('meta');
        meta.name = 'robots';
        meta.content = 'noindex';
        window.document.head.appendChild(meta);
      }, 200);
      </script>
      <title>index</title>
      `);
      await this.crawler.queue({
        url: `${PREFIX}/`,
        waitFor: { selectorOrFunctionOrTimeout: 'meta[name="robots"]' },
      });
      await this.crawler.onIdle();
      const result = this.onSuccess.mock.calls[0][0];
      expect(result.robotsMeta.noindex).toBe(true);
      expect(result.result).toBe(null);
    });

    test('prefers noindex when the header and the meta conflict', async () => {
      this.server.setHeaders('/', { 'X-Robots-Tag': 'noindex' });
      this.server.setContent('/', '<meta name="robots" content="all"><title>index</title>');
      await this.crawler.queue(`${PREFIX}/`);
      await this.crawler.onIdle();
      const result = this.onSuccess.mock.calls[0][0];
      expect(result.robotsMeta.noindex).toBe(true);
      expect(result.result).toBe(null);
    });

    test('treats none as both noindex and nofollow', async () => {
      this.server.setContent('/1.html', `<meta name="robots" content="none"><a href="${PREFIX}/2.html">2</a>`);
      this.server.setContent('/2.html', '<title>two</title>');
      await this.crawler.queue({ url: `${PREFIX}/1.html`, maxDepth: 2 });
      await this.crawler.onIdle();
      expect(this.onSuccess).toHaveBeenCalledTimes(1);
      const result = this.onSuccess.mock.calls[0][0];
      expect(result.robotsMeta.noindex).toBe(true);
      expect(result.robotsMeta.nofollow).toBe(true);
      expect(result.links).toEqual([`${PREFIX}/2.html`]);
    });

    test('schedules no links on nofollow but keeps the page result', async () => {
      this.server.setContent('/1.html', `<meta name="robots" content="nofollow"><title>one</title><a href="${PREFIX}/2.html">2</a>`);
      this.server.setContent('/2.html', '<title>two</title>');
      await this.crawler.queue({ url: `${PREFIX}/1.html`, maxDepth: 2 });
      await this.crawler.onIdle();
      expect(this.onSuccess).toHaveBeenCalledTimes(1);
      const result = this.onSuccess.mock.calls[0][0];
      expect(result.result).toBe('one');
      expect(result.robotsMeta.nofollow).toBe(true);
      expect(result.links).toEqual([`${PREFIX}/2.html`]);
    });

    test('merges the generic and two explicit bot rules', async () => {
      this.server.setHeaders('/', { 'X-Robots-Tag': 'googlebot: noindex, bingbot: nofollow' });
      await this.crawler.queue({ url: `${PREFIX}/`, robotsMetaUserAgents: ['googlebot', 'bingbot'] });
      await this.crawler.onIdle();
      const { robotsMeta } = this.onSuccess.mock.calls[0][0];
      expect(robotsMeta.bots).toEqual(['googlebot', 'bingbot']);
      expect(robotsMeta.policies.googlebot.noindex).toBe(true);
      expect(robotsMeta.policies.bingbot.nofollow).toBe(true);
      expect(robotsMeta.noindex).toBe(true);
      expect(robotsMeta.nofollow).toBe(true);
    });

    test('still discovers links from a noindex page when nofollow is not set', async () => {
      this.server.setContent('/1.html', `<meta name="robots" content="noindex"><a href="${PREFIX}/2.html">2</a>`);
      this.server.setContent('/2.html', '<title>two</title>');
      await this.crawler.queue({ url: `${PREFIX}/1.html`, maxDepth: 2 });
      await this.crawler.onIdle();
      expect(this.onSuccess).toHaveBeenCalledTimes(2);
      const first = this.onSuccess.mock.calls[0][0];
      expect(first.robotsMeta.noindex).toBe(true);
      expect(first.robotsMeta.nofollow).toBe(false);
    });

    test('ignores the redirect intermediate and only applies the final page policy', async () => {
      this.server.setRedirect('/1.html', '/2.html');
      this.server.setHeaders('/1.html', { 'X-Robots-Tag': 'noindex, nofollow' });
      this.server.setContent('/2.html', '<title>two</title>');
      await this.crawler.queue({ url: `${PREFIX}/1.html`, maxDepth: 2 });
      await this.crawler.onIdle();
      expect(this.onSuccess).toHaveBeenCalledTimes(1);
      const result = this.onSuccess.mock.calls[0][0];
      expect(result.result).toBe('two');
      expect(result.robotsMeta.noindex).toBe(false);
      expect(result.robotsMeta.nofollow).toBe(false);
      expect(result.redirectChain).toHaveLength(1);
    });

    test('excludes iframe policies from the main document merge', async () => {
      this.server.setContent('/frame.html', '<meta name="robots" content="noindex">');
      this.server.setContent('/', `<title>index</title><iframe src="${PREFIX}/frame.html"></iframe>`);
      await this.crawler.queue(`${PREFIX}/`);
      await this.crawler.onIdle();
      const result = this.onSuccess.mock.calls[0][0];
      expect(result.robotsMeta.noindex).toBe(false);
      expect(result.result).toBe('index');
    });

    test('still allows the same target to be discovered from another allowed page', async () => {
      this.server.setContent('/a.html', `<meta name="robots" content="nofollow"><a href="${PREFIX}/target.html">t</a>`);
      this.server.setContent('/b.html', `<a href="${PREFIX}/target.html">t</a>`);
      this.server.setContent('/target.html', '<title>target</title>');
      await this.crawler.queue([
        { url: `${PREFIX}/a.html`, maxDepth: 2 },
        { url: `${PREFIX}/b.html`, maxDepth: 2 },
      ]);
      await this.crawler.onIdle();
      const urls = this.onSuccess.mock.calls.map(call => call[0].options.url);
      expect(urls).toContain(`${PREFIX}/a.html`);
      expect(urls).toContain(`${PREFIX}/b.html`);
      expect(urls).toContain(`${PREFIX}/target.html`);
      expect(this.onSuccess).toHaveBeenCalledTimes(3);
    });
  });
});
