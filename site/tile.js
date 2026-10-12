// Counts the cells of one tile. Shared by the main thread (fallback) and worker.js.
// task: { clipped: [[lat, lng], ...], loLat, hiLat, loLng, hiLng }
// The polygon is already clipped to the tile plus a margin; only cells whose centre lies inside
// [loLat, hiLat) x [loLng, hiLng) are counted, so neighbouring tiles never count the same cell.
(function (root) {
  'use strict';
  root.countTile = function (h3, task, res, containment) {
    var cells = h3.polygonToCellsExperimental([task.clipped], res, containment);
    var count = 0;
    for (var k = 0; k < cells.length; k++) {
      var c = h3.cellToLatLng(cells[k]);
      if (c[0] >= task.loLat && c[0] < task.hiLat && c[1] >= task.loLng && c[1] < task.hiLng) count++;
    }
    return count;
  };
})(typeof self !== 'undefined' ? self : this);
