// Web Worker: counts one tile per message. See tile.js.
importScripts('vendor/h3-js.umd.js', 'tile.js');

self.onmessage = function (e) {
  var m = e.data;
  self.postMessage({ count: self.countTile(self.h3, m.task, m.res, m.containment) });
};
