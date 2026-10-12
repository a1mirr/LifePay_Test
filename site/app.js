(function () {
  'use strict';

  // H3 resolution 12: average cell ≈ 307 m², i.e. ≈ 3 256 cells per km².
  var RES = 12;
  var EARTH_RADIUS_M = 6371008.8;
  var DIRECT_LIMIT = 100000;  // up to this many (estimated) cells: one polygonToCells call
  var AUTO_LIMIT = 600000;    // up to this many: exact count is always done (tiled, with progress)
  var HUGE_LIMIT = 50000000;  // above this many (estimated) cells the exact mode warns once per page load
  var MAX_GRID_TILES = 4000000; // the tile highlight is skipped for grids with more tiles than this
  var TILE_TARGET = 40000;    // cells per tile in the tiled count
  var TILE_MARGIN_DEG = 0.0004; // ≈ 44 m, more than a cell diameter at resolution 12
  var RENDER_LIMIT = 20000;   // above this many cells they are not drawn on the map
  var CLOSE_PX = 12;          // click this close to the first vertex to close the polygon
  var MIN_STEP_PX = 3;        // minimum distance between recorded points

  var AVG_CELL_M2 = h3.getHexagonAreaAvg(RES, h3.UNITS.m2);

  var map = L.map('map', { preferCanvas: true, worldCopyJump: true, zoomControl: false, doubleClickZoom: false })
    .setView([55.751, 37.618], 15);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(map);
  L.control.zoom({ position: 'topright' }).addTo(map);

  var cellsLayer = L.layerGroup().addTo(map);
  var shapesLayer = L.layerGroup().addTo(map);
  var draftLayer = L.layerGroup().addTo(map);

  var $ = function (id) { return document.getElementById(id); };
  var mapEl = map.getContainer();
  var nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
  var nf1 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
  var nf3 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 });

  // Drawn shapes: { latlngs, layer }.
  var shapes = [];
  // Union of all shapes: disjoint polygons { rings: [[lat, lng], ...] (outer + holes), areaM2, estimate, key }.
  var polys = [];
  var shapesAreaM2 = 0;         // sum of the areas of the drawn shapes (overlaps counted repeatedly)
  var resultCache = new Map();  // polygon key + containment -> { count, cells | null }
  var declined = new Set();     // polygon key + containment the user cancelled the exact count for
  var mode = 'poly';
  var draft = null;            // polygon mode: array of L.LatLng
  var draftLine = null, draftRubber = null;
  var freePts = null, freeLine = null, freePointer = null;
  var renderToken = 0;
  var cancelRequested = false;
  var hugeWarned = false;      // the «very large area» popup is shown once until the page is reloaded
  var announceExact = false;   // report the result of the recount triggered by the «exact» toggle

  var HINTS = {
    poly: 'Кликайте по карте, расставляя вершины. Закрыть: клик по первой точке, двойной клик или Enter. Esc — отмена.',
    free: 'Зажмите кнопку мыши (или палец) и обведите область, отпустите — контур замкнётся.',
    pan: 'Обычное перемещение карты, рисование выключено.'
  };

  function setStatus(text, isError) {
    var el = $('status');
    el.textContent = text || '';
    el.classList.toggle('error', !!isError);
  }

  // ---- geometry -----------------------------------------------------------

  // Spherical polygon area of a ring of [lat, lng], m² (same approach as Leaflet.draw).
  function ringAreaM2(ring) {
    var d2r = Math.PI / 180, sum = 0, n = ring.length;
    for (var i = 0; i < n; i++) {
      var p1 = ring[i], p2 = ring[(i + 1) % n];
      sum += (p2[1] - p1[1]) * d2r * (2 + Math.sin(p1[0] * d2r) + Math.sin(p2[0] * d2r));
    }
    return Math.abs(sum * EARTH_RADIUS_M * EARTH_RADIUS_M / 2);
  }

  function hashRings(rings) {
    var h = 2166136261, points = 0;
    rings.forEach(function (ring) {
      h = Math.imul(h ^ ring.length, 16777619);
      ring.forEach(function (pt) {
        points++;
        h = Math.imul(h ^ Math.round(pt[0] * 1e7), 16777619);
        h = Math.imul(h ^ Math.round(pt[1] * 1e7), 16777619);
      });
    });
    return (h >>> 0).toString(36) + ':' + rings.length + ':' + points;
  }

  function makePoly(rings) {
    var area = ringAreaM2(rings[0]);
    for (var i = 1; i < rings.length; i++) area -= ringAreaM2(rings[i]);
    area = Math.max(area, 0);
    return { rings: rings, areaM2: area, estimate: area / AVG_CELL_M2, key: hashRings(rings) };
  }

  function shapeRing(shape) {
    return shape.latlngs.map(function (ll) { var w = ll.wrap(); return [w.lat, w.lng]; });
  }

  // Glues overlapping shapes together: the union of all drawn shapes as disjoint polygons with holes.
  function rebuildGeometry() {
    polys = [];
    shapesAreaM2 = shapes.reduce(function (sum, sh) { return sum + ringAreaM2(shapeRing(sh)); }, 0);
    if (!shapes.length) return;
    var inputs = shapes.map(function (sh) {
      var ring = shapeRing(sh).map(function (p) { return [p[1], p[0]]; });   // polygon-clipping wants [lng, lat]
      ring.push(ring[0]);
      return [ring];
    });
    var union;
    try {
      union = polygonClipping.union.apply(polygonClipping, inputs);
    } catch (err) {
      union = inputs;     // degenerate input: fall back to the shapes as they are
    }
    union.forEach(function (polygon) {
      var rings = polygon.map(function (ring) {
        return ring.slice(0, -1).map(function (p) { return [p[1], p[0]]; });  // back to [lat, lng], open ring
      }).filter(function (ring) { return ring.length >= 3; });
      if (rings.length) polys.push(makePoly(rings));
    });
  }

  function cellBoundary(cell) {
    var ring = h3.cellToBoundary(cell);
    var min = Infinity, max = -Infinity;
    ring.forEach(function (p) { min = Math.min(min, p[1]); max = Math.max(max, p[1]); });
    if (max - min > 180) ring = ring.map(function (p) { return [p[0], p[1] < 0 ? p[1] + 360 : p[1]]; });
    return ring;
  }

  function yieldToUi() {
    return new Promise(function (resolve) { setTimeout(resolve, 0); });
  }

  // ---- counting -----------------------------------------------------------

  function computeCells(poly, containment) {
    return h3.polygonToCellsExperimental(poly.rings, RES, containment);
  }

  // Sutherland–Hodgman clip of a [lat, lng] ring against one half-plane.
  function clipHalfPlane(ring, axis, bound, keepAbove) {
    var out = [];
    var inside = function (p) { return keepAbove ? p[axis] >= bound : p[axis] <= bound; };
    for (var i = 0; i < ring.length; i++) {
      var a = ring[i], b = ring[(i + 1) % ring.length];
      var ai = inside(a), bi = inside(b);
      if (ai !== bi) {
        var t = (bound - a[axis]) / (b[axis] - a[axis]);
        var q = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
        q[axis] = bound;
        out.push(q);
      }
      if (bi) out.push(b);
    }
    return out;
  }

  function clipRect(ring, lat0, lat1, lng0, lng1) {
    var steps = [[0, lat0, true], [0, lat1, false], [1, lng0, true], [1, lng1, false]];
    for (var i = 0; i < steps.length; i++) {
      ring = clipHalfPlane(ring, steps[i][0], steps[i][1], steps[i][2]);
      if (ring.length < 3) return null;
    }
    return ring;
  }

  // Clips a polygon with holes (rings[0] is the outer ring). Null if the outer ring does not reach the tile.
  function clipRings(rings, lat0, lat1, lng0, lng1) {
    var outer = clipRect(rings[0], lat0, lat1, lng0, lng1);
    if (!outer) return null;
    var out = [outer];
    for (var i = 1; i < rings.length; i++) {
      var hole = clipRect(rings[i], lat0, lat1, lng0, lng1);
      if (hole) out.push(hole);
    }
    return out;
  }

  var threadsParam = new URLSearchParams(location.search).get('threads');
  var THREADS = threadsParam !== null && !isNaN(parseInt(threadsParam, 10))
    ? Math.max(0, parseInt(threadsParam, 10))
    : Math.min(navigator.hardwareConcurrency || 4, 16);
  var currentRun = null;
  var threadsLabel = '';

  // ---- tile highlight: one canvas, one byte of state per tile ---------------

  var TILE_TODO = 1, TILE_RUN = 2, TILE_DONE = 3;   // 0 = tile not reached by the polygon, not drawn
  var TILE_FILL = [null, 'rgba(156,163,175,0.14)', 'rgba(245,158,11,0.5)', 'rgba(34,197,94,0.22)'];
  var TILE_STROKE = [null, 'rgba(107,114,128,0.7)', 'rgba(217,119,6,0.9)', 'rgba(21,128,61,0.7)'];

  // Draws the tile grid { minLat, minLng, dLat, dLng, nLat, nLng, states } over the map. Only the tiles in the
  // view are drawn, so even a grid of hundreds of thousands of tiles costs one cheap canvas repaint.
  var TileGrid = L.Layer.extend({
    initialize: function (grid) { this.grid = grid; this._frame = 0; this._timer = 0; },

    onAdd: function (m) {
      this._canvas = L.DomUtil.create('canvas', 'tile-grid leaflet-zoom-hide');
      m.getPanes().overlayPane.appendChild(this._canvas);
      m.on('move zoomend viewreset resize', this.invalidate, this);
      this.invalidate();
    },

    onRemove: function (m) {
      m.off('move zoomend viewreset resize', this.invalidate, this);
      if (this._frame) cancelAnimationFrame(this._frame);
      if (this._timer) clearTimeout(this._timer);
      this._frame = this._timer = 0;
      L.DomUtil.remove(this._canvas);
    },

    invalidate: function () {
      if (this._frame || !this._map) return;
      var self = this;
      this._frame = requestAnimationFrame(function () { self._frame = 0; self._draw(); });
    },

    // Tile states change very often while counting; repaint at most every 120 ms.
    touch: function () {
      if (this._timer || !this._map) return;
      var self = this;
      this._timer = setTimeout(function () { self._timer = 0; self.invalidate(); }, 120);
    },

    _draw: function () {
      var map = this._map, g = this.grid, c = this._canvas;
      if (!map) return;
      var size = map.getSize();
      if (c.width !== size.x || c.height !== size.y) { c.width = size.x; c.height = size.y; }
      L.DomUtil.setPosition(c, map.containerPointToLayerPoint([0, 0]));
      var ctx = c.getContext('2d');
      ctx.clearRect(0, 0, c.width, c.height);

      var b = map.getBounds();
      var i0 = Math.max(0, Math.floor((b.getSouth() - g.minLat) / g.dLat));
      var i1 = Math.min(g.nLat - 1, Math.floor((b.getNorth() - g.minLat) / g.dLat));
      var j0 = Math.max(0, Math.floor((b.getWest() - g.minLng) / g.dLng));
      var j1 = Math.min(g.nLng - 1, Math.floor((b.getEast() - g.minLng) / g.dLng));
      if (i0 > i1 || j0 > j1) return;

      var xs = [], ys = [], i, j;
      for (j = j0; j <= j1 + 1; j++) xs.push(map.latLngToContainerPoint([g.minLat, g.minLng + j * g.dLng]).x);
      for (i = i0; i <= i1 + 1; i++) ys.push(map.latLngToContainerPoint([g.minLat + i * g.dLat, g.minLng]).y);

      var last = -1;
      for (i = i0; i <= i1; i++) {
        var top = ys[i - i0 + 1], h = ys[i - i0] - top;
        for (j = j0; j <= j1; j++) {
          var st = g.states[i * g.nLng + j];
          if (!st) continue;
          if (st !== last) { ctx.fillStyle = TILE_FILL[st]; ctx.strokeStyle = TILE_STROKE[st]; last = st; }
          var x = xs[j - j0], w = xs[j - j0 + 1] - x;
          ctx.fillRect(x, top, w, h);
          if (w >= 6 && h >= 6) ctx.strokeRect(x + 0.5, top + 0.5, w - 1, h - 1);
        }
      }
    }
  });

  var gridLayer = null;

  function clearTiles() {
    if (gridLayer) { map.removeLayer(gridLayer); gridLayer = null; }
    $('tile-legend').hidden = true;
  }

  // Marks which tiles of the grid the polygon touches: the polygon is rasterised at one pixel per tile.
  // Purely cosmetic (the count itself clips exactly); returns null if the grid is too big or degenerate.
  function reachableTiles(rings, g) {
    var n = g.nLat * g.nLng;
    if (n > MAX_GRID_TILES || !(g.dLat > 0) || !(g.dLng > 0)) return null;
    var canvas = document.createElement('canvas');
    canvas.width = g.nLng;
    canvas.height = g.nLat;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.beginPath();
    rings.forEach(function (ring) {
      ring.forEach(function (pt, k) {
        var x = (pt[1] - g.minLng) / g.dLng, y = (pt[0] - g.minLat) / g.dLat;
        if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.closePath();
    });
    ctx.fillStyle = '#000';
    ctx.fill('evenodd');
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#000';
    ctx.stroke();
    var data = ctx.getImageData(0, 0, g.nLng, g.nLat).data;
    var states = new Uint8Array(n);
    for (var k = 0; k < n; k++) if (data[4 * k + 3] > 0) states[k] = TILE_TODO;
    return states;
  }

  function showProgress(done, total) {
    $('progress').hidden = done === null;
    if (done === null) return;
    $('bar').max = total;
    $('bar').value = done;
    $('progress-text').textContent = 'Тайл ' + nf0.format(done) + ' из ' + nf0.format(total) +
      ' · ' + Math.round(done / total * 100) + '%' + threadsLabel;
  }

  function abortRun() {
    if (currentRun) currentRun.abort();
  }

  // Runs tiles on a pool of Web Workers. nextEntry() returns the next { task, rect } or null when the tiles
  // are exhausted. Resolves to the total count, null if aborted, or 'fallback' if workers are unavailable
  // or failed (the caller then counts on the main thread).
  function runInWorkers(nextEntry, containment, token, onStart, onDone) {
    return new Promise(function (resolve) {
      var workers = [], inFlight = 0, count = 0, over = false;

      function end(result) {
        if (over) return;
        over = true;
        workers.forEach(function (w) { w.terminate(); });
        currentRun = null;
        resolve(result);
      }
      currentRun = { abort: function () { end(null); } };

      function feed(w) {
        var entry = nextEntry();
        if (!entry) return;
        w.entry = entry;
        inFlight++;
        onStart(entry);
        w.postMessage({ task: entry.task, res: RES, containment: containment });
      }

      try {
        for (var i = 0; i < THREADS; i++) {
          var w = new Worker('worker.js');
          w.onmessage = function (e) {
            var worker = e.target;
            count += e.data.count;
            inFlight--;
            onDone(worker.entry);
            worker.entry = null;
            if (token !== renderToken || cancelRequested) return end(null);
            feed(worker);
            if (inFlight === 0) end(count);
          };
          w.onerror = function () { end('fallback'); };
          workers.push(w);
        }
      } catch (err) {
        return end('fallback');
      }
      workers.forEach(feed);
      if (inFlight === 0) end(count);
    });
  }

  // Exact count for a big shape: the bounding box is cut into tiles, each tile is counted with its own
  // polygonToCells call (on the polygon clipped to the tile plus a margin) and only cells whose centre lies
  // in the tile are kept, so seams neither double-count nor lose cells. The result equals a single call.
  // Tiles are independent, so they run in parallel in Web Workers (THREADS of them; ?threads=0 disables).
  // Tiles are built lazily, so the grid may be arbitrarily large without holding it all in memory. While
  // counting, the grid is drawn on the map: grey = not counted, amber = counting, green = counted; it is
  // removed as soon as the count is over.
  // Resolves to the count, or null if aborted (superseded by a newer recalc, or cancelled by the user).
  async function countTiled(poly, containment, token) {
    var rings = poly.rings, ring = rings[0];
    var minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    ring.forEach(function (p) {
      minLat = Math.min(minLat, p[0]); maxLat = Math.max(maxLat, p[0]);
      minLng = Math.min(minLng, p[1]); maxLng = Math.max(maxLng, p[1]);
    });
    var midLatRad = (minLat + maxLat) / 2 * Math.PI / 180;
    var latSpanM = Math.max((maxLat - minLat) * 111195, 1);
    var lngSpanM = Math.max((maxLng - minLng) * 111195 * Math.cos(midLatRad), 1);
    var wanted = Math.max(1, Math.ceil(latSpanM * lngSpanM / AVG_CELL_M2 / TILE_TARGET));
    var nLat = Math.min(wanted, Math.max(1, Math.round(Math.sqrt(wanted * latSpanM / lngSpanM))));
    var nLng = Math.max(1, Math.ceil(wanted / nLat));
    var dLat = (maxLat - minLat) / nLat, dLng = (maxLng - minLng) / nLng;
    var total = nLat * nLng;
    var done = 0;                 // finished tiles, including those the polygon does not reach

    var grid = { minLat: minLat, minLng: minLng, dLat: dLat, dLng: dLng, nLat: nLat, nLng: nLng, states: null };
    grid.states = reachableTiles(rings, grid);
    clearTiles();
    if (grid.states) {
      gridLayer = new TileGrid(grid).addTo(map);
      $('tile-legend').hidden = false;
    }
    function setState(idx, state) {
      if (!grid.states) return;
      grid.states[idx] = state;
      gridLayer.touch();
    }

    // Builds tile idx: { task, idx } or null if the polygon does not reach it.
    function buildTile(idx) {
      var i = Math.floor(idx / nLng), j = idx % nLng;
      var lat0 = minLat + i * dLat, lat1 = lat0 + dLat;
      var lng0 = minLng + j * dLng, lng1 = lng0 + dLng;
      var marginLng = TILE_MARGIN_DEG / Math.max(Math.cos(Math.max(Math.abs(lat0), Math.abs(lat1)) * Math.PI / 180), 0.05);
      var clipped = clipRings(rings, lat0 - TILE_MARGIN_DEG, lat1 + TILE_MARGIN_DEG, lng0 - marginLng, lng1 + marginLng);
      if (!clipped) { setState(idx, 0); return null; }
      return {
        idx: idx,
        task: {
          rings: clipped,
          // Cells at the outer edge of the bounding box may have their centre outside it (overlap modes).
          loLat: i === 0 ? -Infinity : lat0, hiLat: i === nLat - 1 ? Infinity : lat1,
          loLng: j === 0 ? -Infinity : lng0, hiLng: j === nLng - 1 ? Infinity : lng1
        }
      };
    }

    var cursor = 0;
    function nextEntry() {
      while (cursor < total) {
        var entry = buildTile(cursor++);
        if (entry) return entry;
        done++;
      }
      return null;
    }
    function onStart(entry) { setState(entry.idx, TILE_RUN); }
    function onDone(entry) {
      setState(entry.idx, TILE_DONE);
      showProgress(++done, total);
    }

    try {
      showProgress(done, total);
      var useWorkers = THREADS > 0 && typeof Worker !== 'undefined';
      var result;
      if (useWorkers) {
        threadsLabel = ' · потоков: ' + THREADS;
        result = await runInWorkers(nextEntry, containment, token, onStart, onDone);
      }
      if (!useWorkers || result === 'fallback') {
        if (result === 'fallback') {          // workers failed: start over on the main thread
          cursor = 0;
          done = 0;
          if (grid.states) {
            for (var k = 0; k < grid.states.length; k++) if (grid.states[k] > TILE_TODO) grid.states[k] = TILE_TODO;
          }
        }
        threadsLabel = '';
        showProgress(done, total);
        var count = 0, entry;
        while ((entry = nextEntry())) {
          await yieldToUi();
          if (token !== renderToken || cancelRequested) { count = null; break; }
          onStart(entry);
          await yieldToUi();                  // let the "counting" highlight be painted before the blocking call
          count += countTile(h3, entry.task, RES, containment);
          onDone(entry);
        }
        result = count;
      }
      return result;
    } finally {
      clearTiles();
    }
  }

  $('cancel').addEventListener('click', function () {
    cancelRequested = true;
    abortRun();
  });

  function showHugeWarning(estimate) {
    $('huge-count').textContent = nf0.format(Math.round(estimate));
    var dlg = $('huge-dialog');
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else alert($('huge-text').textContent);
  }
  $('huge-ok').addEventListener('click', function () { $('huge-dialog').close(); });

  // Computes what is missing for the current options, then refreshes the numbers and the map.
  async function recalc() {
    var token = ++renderToken;
    abortRun();
    cancelRequested = false;
    var containment = $('containment').value;
    var exactMode = $('exact').checked;
    var announce = announceExact;
    announceExact = false;
    var startedAt = Date.now();

    function ckey(poly) { return poly.key + '|' + containment; }
    function needsCount(poly) {
      if (resultCache.has(ckey(poly))) return false;
      if (poly.estimate > AUTO_LIMIT) return exactMode;
      return exactMode || !declined.has(ckey(poly));
    }
    var pending = polys.filter(needsCount);

    // A very large area: switch exact mode off and warn, once per page load. After that it counts anything.
    if (exactMode && !hugeWarned) {
      var huge = pending.filter(function (poly) { return poly.estimate > HUGE_LIMIT; })[0];
      if (huge) {
        hugeWarned = true;
        exactMode = false;
        $('exact').checked = false;
        showHugeWarning(huge.estimate);
        pending = polys.filter(needsCount);
      }
    }
    clearTiles();
    if (pending.length) {
      setStatus('Считаю…');
      await yieldToUi();
      if (token !== renderToken) return;
    }

    for (var n = 0; n < pending.length; n++) {
      var poly = pending[n];
      if (poly.estimate <= DIRECT_LIMIT) {
        var cells = computeCells(poly, containment);
        resultCache.set(ckey(poly), { count: cells.length, cells: cells });
        continue;
      }
      var count = await countTiled(poly, containment, token);
      showProgress(null);
      if (count === null) {
        if (token !== renderToken) return;        // superseded: the newer recalc takes over
        declined.add(ckey(poly));                 // cancelled by the user
        if (poly.estimate > AUTO_LIMIT) $('exact').checked = false;
        continue;
      }
      resultCache.set(ckey(poly), { count: count, cells: null });
    }
    showProgress(null);

    // The polygons are disjoint pieces of the union, so their counts simply add up.
    var withCells = [], countOnly = [], approx = [];
    polys.forEach(function (poly) {
      var r = resultCache.get(ckey(poly));
      if (!r) approx.push(poly);
      else if (r.cells) withCells.push(r);
      else countOnly.push(r);
    });

    var all;
    if (withCells.length === 1) {
      all = withCells[0].cells;
    } else {
      var set = new Set();
      withCells.forEach(function (r) { r.cells.forEach(function (c) { set.add(c); }); });
      all = Array.from(set);
    }

    var approxTotal = approx.reduce(function (sum, poly) { return sum + poly.estimate; }, 0);
    var countOnlyTotal = countOnly.reduce(function (sum, r) { return sum + r.count; }, 0);
    var total = all.length + countOnlyTotal + Math.round(approxTotal);
    var area = polys.reduce(function (sum, poly) { return sum + poly.areaM2; }, 0) / 1e6;

    $('count').textContent = (approx.length ? '≈ ' : '') + nf0.format(total);
    $('area').textContent = nf3.format(area);
    $('density').textContent = area > 0 ? nf0.format(total / area) : '—';
    $('shapes').textContent = shapes.length;

    var msgs = [];
    if (announce && !approx.length && shapes.length) {
      var secs = (Date.now() - startedAt) / 1000;
      msgs.push('Точный подсчёт выполнен' + (secs >= 1 ? ' за ' + nf1.format(secs) + ' с' : '') + '.');
    }
    if (approx.length) {
      msgs.push('Для больших областей показана оценка по площади. Включите «Точный подсчёт», чтобы посчитать точно.');
    }
    if (shapes.length > 1 && shapesAreaM2 - area * 1e6 > shapesAreaM2 * 0.001) {
      msgs.push('Пересекающиеся фигуры объединены: ячейки и площадь считаются один раз.');
    }

    cellsLayer.clearLayers();
    if ($('show-cells').checked && all.length) {
      if (all.length > RENDER_LIMIT) {
        msgs.push('Ячеек больше ' + nf0.format(RENDER_LIMIT) + ' — на карте не рисую.');
      } else {
        all.forEach(function (c) {
          L.polygon(cellBoundary(c), {
            color: '#1d4ed8', weight: 0.6, fillColor: '#3b82f6', fillOpacity: 0.3, interactive: false
          }).addTo(cellsLayer);
        });
      }
    }
    setStatus(msgs.join(' '), false);
  }

  function addShape(latlngs) {
    latlngs = latlngs.filter(function (ll, i) { return i === 0 || !ll.equals(latlngs[i - 1]); });
    if (latlngs.length < 3) {
      setStatus('Нужно минимум три точки.', true);
      return;
    }
    var layer = L.polygon(latlngs, {
      color: '#b45309', weight: 2, fillColor: '#f59e0b', fillOpacity: 0.08, interactive: false
    }).addTo(shapesLayer);
    shapes.push({ latlngs: latlngs, layer: layer });
    rebuildGeometry();
    recalc();
  }

  // ---- polygon drawing ----------------------------------------------------

  function px(ll) { return map.latLngToContainerPoint(ll); }

  function resetDraft() {
    draft = null;
    draftLayer.clearLayers();
    draftLine = draftRubber = null;
    $('finish').hidden = true;
  }

  function finishDraft() {
    if (!draft) return;
    var pts = draft;
    resetDraft();
    if (pts.length) addShape(pts);
  }

  function updateDraftLine(cursor) {
    if (!draftLine) {
      draftLine = L.polyline([], { color: '#b45309', weight: 2, interactive: false }).addTo(draftLayer);
      draftRubber = L.polyline([], { color: '#b45309', weight: 1, dashArray: '4', interactive: false }).addTo(draftLayer);
    }
    draftLine.setLatLngs(draft);
    var last = draft[draft.length - 1];
    draftRubber.setLatLngs(cursor && last ? [last, cursor, draft[0]] : []);
  }

  map.on('click', function (e) {
    if (mode !== 'poly') return;
    if (!draft) {
      draft = [];
      $('finish').hidden = false;
    }
    var p = px(e.latlng);
    if (draft.length >= 3 && p.distanceTo(px(draft[0])) <= CLOSE_PX) {
      finishDraft();
      return;
    }
    // Second click of a double-click lands on the same spot: ignore it as a new vertex.
    if (draft.length && p.distanceTo(px(draft[draft.length - 1])) < MIN_STEP_PX) return;
    draft.push(e.latlng);
    if (draft.length === 1) {
      L.circleMarker(e.latlng, {
        radius: 5, color: '#b45309', fillColor: '#fff', fillOpacity: 1, weight: 2, interactive: false
      }).addTo(draftLayer);
    }
    updateDraftLine(null);
  });

  map.on('mousemove', function (e) {
    if (mode === 'poly' && draft && draft.length) updateDraftLine(e.latlng);
  });

  map.on('dblclick', function () {
    if (mode === 'poly' && draft) finishDraft();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && draft) finishDraft();
    if (e.key === 'Escape' && draft) resetDraft();
  });

  $('finish').addEventListener('click', finishDraft);

  // ---- freehand drawing ---------------------------------------------------

  mapEl.addEventListener('pointerdown', function (e) {
    if (mode !== 'free' || e.button !== 0 || freePts) return;
    freePointer = e.pointerId;
    mapEl.setPointerCapture(e.pointerId);
    freePts = [map.mouseEventToLatLng(e)];
    freeLine = L.polyline(freePts, { color: '#b45309', weight: 2, interactive: false }).addTo(draftLayer);
    e.preventDefault();
  });

  mapEl.addEventListener('pointermove', function (e) {
    if (!freePts || e.pointerId !== freePointer) return;
    var ll = map.mouseEventToLatLng(e);
    if (px(ll).distanceTo(px(freePts[freePts.length - 1])) < MIN_STEP_PX) return;
    freePts.push(ll);
    freeLine.setLatLngs(freePts);
  });

  function endFree(e) {
    if (!freePts || e.pointerId !== freePointer) return;
    var pts = freePts;
    freePts = null;
    freePointer = null;
    freeLine = null;
    draftLayer.clearLayers();
    if (pts.length >= 3) addShape(pts);
    else setStatus('Контур слишком короткий — обведите область.', true);
  }
  mapEl.addEventListener('pointerup', endFree);
  mapEl.addEventListener('pointercancel', endFree);

  // ---- modes & controls ---------------------------------------------------

  function setMode(next) {
    resetDraft();
    mode = next;
    ['poly', 'free', 'pan'].forEach(function (m) {
      $('mode-' + m).classList.toggle('active', m === next);
    });
    mapEl.classList.toggle('draw', next === 'free');
    mapEl.style.cursor = next === 'poly' ? 'crosshair' : '';
    if (next === 'free') map.dragging.disable(); else map.dragging.enable();
    $('mode-hint').textContent = HINTS[next];
  }

  ['poly', 'free', 'pan'].forEach(function (m) {
    $('mode-' + m).addEventListener('click', function () { setMode(m); });
  });

  // Panel clicks must not reach the map as drawing clicks.
  L.DomEvent.disableClickPropagation($('panel'));
  L.DomEvent.disableScrollPropagation($('panel'));

  $('containment').addEventListener('change', recalc);
  $('show-cells').addEventListener('change', recalc);
  // Turning exact mode on recounts every drawn shape from scratch (also those already counted exactly),
  // so the user always sees the recount run.
  $('exact').addEventListener('change', function () {
    if ($('exact').checked) {
      var containment = $('containment').value;
      polys.forEach(function (poly) {
        resultCache.delete(poly.key + '|' + containment);
        declined.delete(poly.key + '|' + containment);
      });
      announceExact = true;
    }
    recalc();
  });

  $('undo').addEventListener('click', function () {
    var s = shapes.pop();
    if (s) shapesLayer.removeLayer(s.layer);
    rebuildGeometry();
    recalc();
  });

  $('clear').addEventListener('click', function () {
    shapes = [];
    shapesLayer.clearLayers();
    resetDraft();
    rebuildGeometry();
    recalc();
  });

  $('scale').textContent = 'Разрешение H3: ' + RES + ' · средняя ячейка ' + nf0.format(AVG_CELL_M2) +
    ' м² · ≈' + nf0.format(1e6 / AVG_CELL_M2) + ' ячеек на км²';
  setMode('poly');
  recalc();

  // Exposed for tests.
  window.__h3calc = { map: map, shapes: function () { return shapes; }, polys: function () { return polys; },
    tiles: function () {
      if (!gridLayer) return null;
      var t = { todo: 0, run: 0, done: 0 }, st = gridLayer.grid.states;
      for (var k = 0; k < st.length; k++) { if (st[k] === 1) t.todo++; else if (st[k] === 2) t.run++; else if (st[k] === 3) t.done++; }
      return t;
    } };
})();
