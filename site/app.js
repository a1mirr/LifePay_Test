(function () {
  'use strict';

  // H3 resolution 12: average cell ≈ 307 m², i.e. ≈ 3 256 cells per km².
  var RES = 12;
  var EARTH_RADIUS_M = 6371008.8;
  var DIRECT_LIMIT = 100000;  // up to this many (estimated) cells: one polygonToCells call
  var AUTO_LIMIT = 600000;    // up to this many: exact count is always done (tiled, with progress)
  var HARD_LIMIT = 50000000;  // above this many even the exact mode refuses
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
  var nf3 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 });

  // { latlngs, layer, results: { [containment]: { count, cells | null } }, declined, areaM2, estimate }
  var shapes = [];
  var mode = 'poly';
  var draft = null;            // polygon mode: array of L.LatLng
  var draftLine = null, draftRubber = null;
  var freePts = null, freeLine = null, freePointer = null;
  var renderToken = 0;
  var cancelRequested = false;

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

  // Spherical polygon area, m² (same approach as Leaflet.draw).
  function ringAreaM2(latlngs) {
    var d2r = Math.PI / 180, sum = 0, n = latlngs.length;
    for (var i = 0; i < n; i++) {
      var p1 = latlngs[i], p2 = latlngs[(i + 1) % n];
      sum += (p2.lng - p1.lng) * d2r * (2 + Math.sin(p1.lat * d2r) + Math.sin(p2.lat * d2r));
    }
    return Math.abs(sum * EARTH_RADIUS_M * EARTH_RADIUS_M / 2);
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

  function shapeRing(shape) {
    return shape.latlngs.map(function (ll) { var w = ll.wrap(); return [w.lat, w.lng]; });
  }

  function computeCells(shape, containment) {
    return h3.polygonToCellsExperimental([shapeRing(shape)], RES, containment);
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

  var threadsParam = new URLSearchParams(location.search).get('threads');
  var THREADS = threadsParam !== null && !isNaN(parseInt(threadsParam, 10))
    ? Math.max(0, parseInt(threadsParam, 10))
    : Math.min(navigator.hardwareConcurrency || 4, 16);
  var currentRun = null;
  var threadsLabel = '';

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

  // Runs the tasks on a pool of Web Workers. Resolves to the total count, null if aborted,
  // or 'fallback' if workers are unavailable or failed (the caller then counts on the main thread).
  function runInWorkers(tasks, containment, token, onDone) {
    return new Promise(function (resolve) {
      var workers = [], next = 0, finished = 0, count = 0, over = false;

      function end(result) {
        if (over) return;
        over = true;
        workers.forEach(function (w) { w.terminate(); });
        currentRun = null;
        resolve(result);
      }
      currentRun = { abort: function () { end(null); } };

      function feed(w) {
        if (next < tasks.length) {
          w.postMessage({ task: tasks[next++], res: RES, containment: containment });
        }
      }

      var n = Math.min(THREADS, tasks.length);
      try {
        for (var i = 0; i < n; i++) {
          var w = new Worker('worker.js');
          w.onmessage = function (e) {
            count += e.data.count;
            finished++;
            onDone();
            if (token !== renderToken || cancelRequested) return end(null);
            if (finished === tasks.length) return end(count);
            feed(e.target);
          };
          w.onerror = function () { end('fallback'); };
          workers.push(w);
        }
      } catch (err) {
        return end('fallback');
      }
      workers.forEach(feed);
    });
  }

  // Exact count for a big shape: the bounding box is cut into tiles, each tile is counted with its own
  // polygonToCells call (on the polygon clipped to the tile plus a margin) and only cells whose centre lies
  // in the tile are kept, so seams neither double-count nor lose cells. The result equals a single call.
  // Tiles are independent, so they run in parallel in Web Workers (THREADS of them; ?threads=0 disables).
  // Resolves to the count, or null if aborted (superseded by a newer recalc, or cancelled by the user).
  async function countTiled(shape, containment, token) {
    var ring = shapeRing(shape);
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

    var tasks = [];
    for (var i = 0; i < nLat; i++) {
      for (var j = 0; j < nLng; j++) {
        var lat0 = minLat + i * dLat, lat1 = lat0 + dLat;
        var lng0 = minLng + j * dLng, lng1 = lng0 + dLng;
        var marginLng = TILE_MARGIN_DEG / Math.max(Math.cos(Math.max(Math.abs(lat0), Math.abs(lat1)) * Math.PI / 180), 0.05);
        var clipped = clipRect(ring, lat0 - TILE_MARGIN_DEG, lat1 + TILE_MARGIN_DEG, lng0 - marginLng, lng1 + marginLng);
        if (!clipped) continue;
        tasks.push({
          clipped: clipped,
          // Cells at the outer edge of the bounding box may have their centre outside it (overlap modes).
          loLat: i === 0 ? -Infinity : lat0, hiLat: i === nLat - 1 ? Infinity : lat1,
          loLng: j === 0 ? -Infinity : lng0, hiLng: j === nLng - 1 ? Infinity : lng1
        });
      }
    }
    var skipped = total - tasks.length;   // tiles the polygon does not reach

    if (THREADS > 0 && typeof Worker !== 'undefined') {
      threadsLabel = ' · потоков: ' + Math.min(THREADS, tasks.length);
      var done = skipped;
      showProgress(done, total);
      var result = await runInWorkers(tasks, containment, token, function () { showProgress(++done, total); });
      if (result !== 'fallback') return result;
    }

    threadsLabel = '';
    var count = 0;
    showProgress(skipped, total);
    for (var t = 0; t < tasks.length; t++) {
      await yieldToUi();
      if (token !== renderToken || cancelRequested) return null;
      count += countTile(h3, tasks[t], RES, containment);
      showProgress(skipped + t + 1, total);
    }
    return count;
  }

  $('cancel').addEventListener('click', function () {
    cancelRequested = true;
    abortRun();
  });

  // Computes what is missing for the current options, then refreshes the numbers and the map.
  async function recalc() {
    var token = ++renderToken;
    abortRun();
    cancelRequested = false;
    var containment = $('containment').value;
    var exactMode = $('exact').checked;

    var pending = shapes.filter(function (s) {
      if (s.results[containment]) return false;
      if (s.estimate > HARD_LIMIT) return false;
      if (s.estimate > AUTO_LIMIT) return exactMode;
      return exactMode || s.declined !== containment;
    });
    if (pending.length) {
      setStatus('Считаю…');
      await yieldToUi();
      if (token !== renderToken) return;
    }

    for (var n = 0; n < pending.length; n++) {
      var s = pending[n];
      if (s.estimate <= DIRECT_LIMIT) {
        var cells = computeCells(s, containment);
        s.results[containment] = { count: cells.length, cells: cells };
        continue;
      }
      var count = await countTiled(s, containment, token);
      showProgress(null);
      if (count === null) {
        if (token !== renderToken) return;        // superseded: the newer recalc takes over
        s.declined = containment;                 // cancelled by the user
        if (s.estimate > AUTO_LIMIT) $('exact').checked = false;
        continue;
      }
      s.results[containment] = { count: count, cells: null };
    }
    showProgress(null);

    var withCells = [], countOnly = [], approx = [];
    shapes.forEach(function (s) {
      var r = s.results[containment];
      if (!r) approx.push(s);
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

    var approxTotal = approx.reduce(function (sum, s) { return sum + s.estimate; }, 0);
    var countOnlyTotal = countOnly.reduce(function (sum, r) { return sum + r.count; }, 0);
    var total = all.length + countOnlyTotal + Math.round(approxTotal);
    var area = shapes.reduce(function (sum, s) { return sum + s.areaM2; }, 0) / 1e6;

    $('count').textContent = (approx.length ? '≈ ' : '') + nf0.format(total);
    $('area').textContent = nf3.format(area);
    $('density').textContent = area > 0 ? nf0.format(total / area) : '—';
    $('shapes').textContent = shapes.length;

    var msgs = [];
    if (approx.length) {
      var tooBig = approx.some(function (s) { return s.estimate > HARD_LIMIT; });
      msgs.push(tooBig
        ? 'Одна из областей больше ' + nf0.format(HARD_LIMIT) + ' ячеек — считается только оценка по площади.'
        : 'Для больших областей показана оценка по площади. Включите «Точный подсчёт», чтобы посчитать точно.');
    }
    if (countOnly.length && shapes.length > 1) {
      msgs.push('Пересечения больших фигур с другими вычитаются не полностью.');
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
    var areaM2 = ringAreaM2(latlngs);
    var layer = L.polygon(latlngs, {
      color: '#b45309', weight: 2, fillColor: '#f59e0b', fillOpacity: 0.08, interactive: false
    }).addTo(shapesLayer);
    shapes.push({
      latlngs: latlngs, layer: layer, results: {}, declined: null,
      areaM2: areaM2, estimate: areaM2 / AVG_CELL_M2
    });
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
  $('exact').addEventListener('change', recalc);

  $('undo').addEventListener('click', function () {
    var s = shapes.pop();
    if (s) shapesLayer.removeLayer(s.layer);
    recalc();
  });

  $('clear').addEventListener('click', function () {
    shapes = [];
    shapesLayer.clearLayers();
    resetDraft();
    recalc();
  });

  $('scale').textContent = 'Разрешение H3: ' + RES + ' · средняя ячейка ' + nf0.format(AVG_CELL_M2) +
    ' м² · ≈' + nf0.format(1e6 / AVG_CELL_M2) + ' ячеек на км²';
  setMode('poly');
  recalc();

  // Exposed for tests.
  window.__h3calc = { map: map, shapes: function () { return shapes; } };
})();
