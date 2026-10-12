(function () {
  'use strict';

  var MAX_CELLS = 20000;
  var EARTH_RADIUS_M = 6371008.8;

  var map = L.map('map', { preferCanvas: true, worldCopyJump: true, zoomControl: false }).setView([55.751, 37.618], 10);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(map);
  L.control.zoom({ position: 'topright' }).addTo(map);
  var cellsLayer = L.layerGroup().addTo(map);

  var $ = function (id) { return document.getElementById(id); };
  var resInput = $('res');
  var statusEl = $('status');

  // cell -> { layer, area (m²), res }
  var selected = new Map();
  // resolution -> Set of selected cells at that resolution
  var byRes = new Map();
  var totalArea = 0;
  var mode = 'click';

  var nf = function (digits) {
    return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits });
  };
  var fmtKm2 = nf(4), fmtHa = nf(2), fmtM2 = nf(0), fmtInt = nf(0);

  function setStatus(text, isError) {
    statusEl.textContent = text || '';
    statusEl.classList.toggle('error', !!isError);
  }

  function currentRes() { return parseInt(resInput.value, 10); }

  // ---- geometry -----------------------------------------------------------

  function boundaryLatLngs(cell) {
    var ring = h3.cellToBoundary(cell); // [[lat, lng], ...]
    var minLng = Infinity, maxLng = -Infinity;
    ring.forEach(function (p) { minLng = Math.min(minLng, p[1]); maxLng = Math.max(maxLng, p[1]); });
    // Cell crosses the antimeridian: shift western points so the polygon is not drawn across the world.
    if (maxLng - minLng > 180) {
      ring = ring.map(function (p) { return [p[0], p[1] < 0 ? p[1] + 360 : p[1]]; });
    }
    return ring;
  }

  // ---- selection model ----------------------------------------------------

  function register(cell, res) {
    var area = h3.cellArea(cell, h3.UNITS.m2);
    var layer = L.polygon(boundaryLatLngs(cell), {
      color: '#1d4ed8', weight: 1, fillColor: '#3b82f6', fillOpacity: 0.35
    }).addTo(cellsLayer);
    selected.set(cell, { layer: layer, area: area, res: res });
    if (!byRes.has(res)) byRes.set(res, new Set());
    byRes.get(res).add(cell);
    totalArea += area;
  }

  function unregister(cell) {
    var rec = selected.get(cell);
    if (!rec) return;
    cellsLayer.removeLayer(rec.layer);
    selected.delete(cell);
    var set = byRes.get(rec.res);
    set.delete(cell);
    if (!set.size) byRes.delete(rec.res);
    totalArea -= rec.area;
  }

  // Returns the already selected cell that covers `cell` (itself or a coarser ancestor), if any.
  function coveringCell(cell, res) {
    var found = null;
    byRes.forEach(function (set, r) {
      if (found || r > res) return;
      var candidate = r === res ? cell : h3.cellToParent(cell, r);
      if (set.has(candidate)) found = candidate;
    });
    return found;
  }

  // Adds cells of one resolution. Cells already covered by a coarser/equal selected cell are skipped,
  // finer selected cells inside a new cell are replaced, so the area is never counted twice.
  function addCells(cells, res) {
    var fresh = [];
    cells.forEach(function (cell) {
      if (!coveringCell(cell, res)) fresh.push(cell);
    });
    if (!fresh.length) return 0;

    var freshSet = new Set(fresh);
    var toRemove = [];
    byRes.forEach(function (set, r) {
      if (r <= res) return;
      set.forEach(function (child) {
        if (freshSet.has(h3.cellToParent(child, res))) toRemove.push(child);
      });
    });
    toRemove.forEach(unregister);
    fresh.forEach(function (cell) { register(cell, res); });
    return fresh.length;
  }

  function clearAll() {
    cellsLayer.clearLayers();
    selected.clear();
    byRes.clear();
    totalArea = 0;
  }

  // ---- UI -----------------------------------------------------------------

  function render() {
    var m2 = Math.max(totalArea, 0);
    $('area-km2').textContent = fmtKm2.format(m2 / 1e6);
    $('area-ha').textContent = fmtHa.format(m2 / 1e4);
    $('area-m2').textContent = fmtM2.format(m2);
    $('count').textContent = fmtInt.format(selected.size);

    var parts = [];
    Array.from(byRes.keys()).sort(function (a, b) { return a - b; }).forEach(function (r) {
      parts.push('r' + r + ': ' + fmtInt.format(byRes.get(r).size));
    });
    $('breakdown').textContent = parts.length ? parts.join(', ') : '—';

    if ($('indexes-box').open) $('indexes').value = Array.from(selected.keys()).join('\n');
  }

  function updateResHint() {
    var r = currentRes();
    $('res-value').textContent = r;
    $('res-hint').textContent = 'Средняя площадь ячейки: ' +
      fmtKm2.format(h3.getHexagonAreaAvg(r, h3.UNITS.km2)) + ' км², ребро ≈ ' +
      fmtKm2.format(h3.getHexagonEdgeLengthAvg(r, h3.UNITS.km)) + ' км';
  }

  function updateModeHint() {
    $('mode-hint').textContent = mode === 'click'
      ? 'Клик по карте добавляет ячейку, повторный клик убирает её.'
      : 'Зажмите кнопку мыши и протяните рамку — добавятся ячейки, центры которых попали в рамку.';
  }

  function setMode(next) {
    mode = next;
    $('mode-click').classList.toggle('active', mode === 'click');
    $('mode-frame').classList.toggle('active', mode === 'frame');
    map.getContainer().style.cursor = mode === 'frame' ? 'crosshair' : '';
    updateModeHint();
  }

  // ---- events -------------------------------------------------------------

  resInput.addEventListener('input', updateResHint);
  $('mode-click').addEventListener('click', function () { setMode('click'); });
  $('mode-frame').addEventListener('click', function () { setMode('frame'); });

  // Keep panel interactions from reaching the map.
  L.DomEvent.disableClickPropagation($('panel'));
  L.DomEvent.disableScrollPropagation($('panel'));

  map.on('click', function (e) {
    if (mode !== 'click') return;
    var ll = e.latlng.wrap();
    var res = currentRes();
    var cell = h3.latLngToCell(ll.lat, ll.lng, res);

    if (selected.has(cell)) {
      unregister(cell);
      setStatus('Ячейка убрана.');
    } else {
      var cover = coveringCell(cell, res);
      if (cover) {
        setStatus('Эта область уже входит в выбранную ячейку ' + cover + ' (r' + h3.getResolution(cover) + '). ' +
          'Кликните по ней на этом же разрешении, чтобы убрать.');
      } else {
        addCells([cell], res);
        setStatus('');
      }
    }
    render();
  });

  // Frame selection
  var frameStart = null;
  var frameRect = null;

  map.on('mousedown', function (e) {
    if (mode !== 'frame' || e.originalEvent.button !== 0) return;
    frameStart = e.latlng;
    map.dragging.disable();
    frameRect = L.rectangle([frameStart, frameStart], {
      color: '#b45309', weight: 1, dashArray: '4', fillOpacity: 0.08, interactive: false
    }).addTo(map);
  });

  map.on('mousemove', function (e) {
    if (frameRect) frameRect.setBounds(L.latLngBounds(frameStart, e.latlng));
  });

  function finishFrame(e) {
    if (!frameRect) return;
    var bounds = L.latLngBounds(frameStart, e.latlng);
    map.removeLayer(frameRect);
    frameRect = null;
    frameStart = null;
    map.dragging.enable();
    fillBounds(bounds);
  }
  map.on('mouseup', finishFrame);

  function fillBounds(bounds) {
    var res = currentRes();
    var south = Math.max(bounds.getSouth(), -85), north = Math.min(bounds.getNorth(), 85);
    var west = bounds.getWest(), east = bounds.getEast();
    var latSpan = (north - south) * Math.PI / 180;
    var lngSpan = (east - west) * Math.PI / 180;
    var midLat = (north + south) / 2 * Math.PI / 180;
    var rectArea = Math.abs(latSpan * lngSpan * Math.cos(midLat)) * EARTH_RADIUS_M * EARTH_RADIUS_M;
    var estimate = rectArea / h3.getHexagonAreaAvg(res, h3.UNITS.m2);

    if (estimate > MAX_CELLS) {
      setStatus('Слишком много ячеек (≈' + fmtInt.format(estimate) + ', максимум ' + fmtInt.format(MAX_CELLS) +
        '). Уменьшите рамку или понизьте разрешение.', true);
      return;
    }

    var ring = [[south, west], [north, west], [north, east], [south, east]];
    var cells = h3.polygonToCells([ring], res);
    if (!cells.length) {
      // Frame is smaller than a cell: take the cell under its centre.
      var c = bounds.getCenter().wrap();
      cells = [h3.latLngToCell(c.lat, c.lng, res)];
    }
    var added = addCells(cells, res);
    setStatus(added ? 'Добавлено ячеек: ' + fmtInt.format(added) + '.' : 'Эта область уже выбрана.');
    render();
  }

  $('clear').addEventListener('click', function () {
    clearAll();
    setStatus('');
    render();
  });

  $('fit').addEventListener('click', function () {
    var bounds = L.latLngBounds([]);
    selected.forEach(function (rec) { bounds.extend(rec.layer.getBounds()); });
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [30, 30] });
  });

  $('copy').addEventListener('click', function () {
    var text = Array.from(selected.keys()).join('\n');
    if (!text) { setStatus('Нечего копировать.'); return; }
    var done = function () { setStatus('Индексы скопированы: ' + fmtInt.format(selected.size) + '.'); };
    var fail = function () {
      $('indexes-box').open = true;
      $('indexes').value = text;
      $('indexes').select();
      setStatus('Не удалось скопировать автоматически — выделите текст в поле ниже.', true);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fail);
    } else {
      fail();
    }
  });

  $('indexes-box').addEventListener('toggle', function () {
    if ($('indexes-box').open) $('indexes').value = Array.from(selected.keys()).join('\n');
  });

  $('add-indexes').addEventListener('click', function () {
    var tokens = $('indexes').value.split(/[\s,;]+/).filter(Boolean);
    var valid = {}, invalid = 0;
    tokens.forEach(function (t) {
      t = t.toLowerCase();
      if (h3.isValidCell(t)) {
        var r = h3.getResolution(t);
        (valid[r] = valid[r] || []).push(t);
      } else {
        invalid++;
      }
    });
    var total = 0;
    Object.keys(valid).map(Number).sort(function (a, b) { return a - b; }).forEach(function (r) {
      total += addCells(valid[r], r);
    });
    setStatus('Добавлено ячеек: ' + fmtInt.format(total) + (invalid ? ', некорректных индексов: ' + invalid : '') + '.', invalid > 0 && !total);
    render();
    $('fit').click();
  });

  updateResHint();
  updateModeHint();
  render();

  // Exposed for debugging / tests.
  window.__h3calc = { addCells: addCells, clearAll: clearAll, render: render, state: function () {
    return { count: selected.size, areaM2: totalArea };
  } };
})();
