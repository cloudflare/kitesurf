// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A classic worker served from the fixture origin. It answers every message
// with its own location and the body of a same-origin fetch, so a test can
// see both the script URL and the gateway route a worker's fetch takes.
var hops = 0;
self.onmessage = function (event) {
  hops += 1;
  fetch("/__fixtures/xhr-data.txt")
    .then(function (r) { return r.text(); })
    .then(function (body) {
      self.postMessage({
        echo: event.data,
        hops: hops,
        href: self.location.href,
        body: body.trim(),
      });
    }, function (err) {
      self.postMessage({ error: String(err) });
    });
};
