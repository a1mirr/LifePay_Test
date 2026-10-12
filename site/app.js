(function () {
  'use strict';

  // H3 resolution 12: average cell ≈ 307 m², i.e. ≈ 3 256 cells per km².
  var RES = 12;
  var EARTH_RADIUS_M = 6371008.8;
  var EXACT_LIMIT = 600000;   // above this many (estimated) cells only an estimate is shown
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

  // { latlngs, layer, cells: string[] | null, containment, areaM2, estimate }
  var shapes = [];
  var mode = 'poly';
  var draft = null;            // polygon mode: array of L.LatLng
  var draftLine = null, draftRubber = null;
  var freePts = null, freeLine = null, freePointer = null;
  var renderToken = 0;

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

  function nextFrame() {
    return new Promise(function (resolve) { setTimeout(resolve, 30); });
  }

  // ---- counting -----------------------------------------------------------

  function computeCells(shape, containment) {
    var ring = shape.latlngs.map(function (ll) { var w = ll.wrap(); return [w.lat, w.lng]; });
    return h3.polygonToCellsExperimental([ring], RES, containment);
  }

  // Recomputes cells for shapes whose cached result is stale, then refreshes the numbers and the map.
  async function recalc() {
    var token = ++renderToken;
    var containment = $('containment').value;
    var stale = shapes.filter(function (s) { return s.containment !== containment; });
    if (stale.length) {
      setStatus('Считаю…');
      await nextFrame();
      if (token !== renderToken) return;
    }

    stale.forEach(function (s) {
      s.containment = containment;
      s.cells = s.estimate > EXACT_LIMIT ? null : computeCells(s, containment);
    });

    var exact = shapes.filter(function (s) { return s.cells; });
    var approx = shapes.filter(function (s) { return !s.cells; });

    var all;
    if (exact.length === 1) {
      all = exact[0].cells;
    } else {
      var set = new Set();
      exact.forEach(function (s) { s.cells.forEach(function (c) { set.add(c); }); });
      all = Array.from(set);
    }

    var approxTotal = approx.reduce(function (sum, s) { return sum + s.estimate; }, 0);
    var total = all.length + Math.round(approxTotal);
    var area = shapes.reduce(function (sum, s) { return sum + s.areaM2; }, 0) / 1e6;

    $('count').textContent = (approx.length ? '≈ ' : '') + nf0.format(total);
    $('area').textContent = nf3.format(area);
    $('density').textContent = area > 0 ? nf0.format(total / area) : '—';
    $('shapes').textContent = shapes.length;

    var msg = '';
    if (approx.length) {
      msg = 'Область слишком большая для точного подсчёта (больше ' + nf0.format(EXACT_LIMIT) +
        ' ячеек), показана оценка по площади.';
    }

    cellsLayer.clearLayers();
    if ($('show-cells').checked && all.length) {
      if (all.length > RENDER_LIMIT) {
        msg = (msg ? msg + ' ' : '') + 'Ячеек больше ' + nf0.format(RENDER_LIMIT) + ' — на карте не рисую.';
      } else {
        all.forEach(function (c) {
          L.polygon(cellBoundary(c), {
            color: '#1d4ed8', weight: 0.6, fillColor: '#3b82f6', fillOpacity: 0.3, interactive: false
          }).addTo(cellsLayer);
        });
      }
    }
    setStatus(msg, false);
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
      latlngs: latlngs, layer: layer, cells: null, containment: null,
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
  window.__h3calc = { shapes: function () { return shapes; } };
})();
