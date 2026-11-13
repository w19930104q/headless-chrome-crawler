const HCCrawler = require('headless-chrome-crawler');

(async () => {
  const crawler = await HCCrawler.launch({
    // Enable the link graph. The legacy `links` string array is still returned.
    linkGraph: true,
    // Edges whose rel contains "nofollow" are recorded but never followed.
    maxDepth: 2,
    obeyRobotsTxt: false,
    onSuccess: result => {
      // Every `a[href]` across the page and all of its frames, one edge each.
      // Duplicate edges are kept, ordered by the frame tree and DOM order.
      result.linkGraph.forEach(edge => {
        console.log(JSON.stringify({
          rawHref: edge.rawHref, // href as written in the document
          url: edge.url, // href resolved against the document base/final url
          text: edge.text, // link text
          rel: edge.rel, // raw rel attribute
          nofollow: edge.nofollow, // true when rel contains nofollow
          framePath: edge.framePath, // [] for the main frame, [0], [0, 1], ...
          documentUrl: edge.documentUrl, // final url of the owning document
        }));
      });
      // Frames that were detached or navigating while the graph was collected.
      result.frameFailures.forEach(failure => {
        console.warn(`Frame ${failure.framePath.join('.')} (${failure.documentUrl}) `
          + `was not collected: ${failure.reason}`);
      });
    },
  });
  await crawler.queue('http://127.0.0.1:8080/');
  await crawler.onIdle();
  await crawler.close();
})();
