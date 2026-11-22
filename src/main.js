/**
 * src/main.js — Tebak Gambar
 *
 * Fase 1b: canvas gambar lokal, 100% client-side.
 * Native Canvas API, tanpa library eksternal.
 *
 * Fitur:
 *   - Drawing dengan mouse/touch via Pointer Events API
 *   - Pilihan warna (swatch + color picker)
 *   - Pilihan ukuran kuas (S / M / L)
 *   - Tombol clear canvas
 *   - Custom brush cursor (ukuran & warna mengikuti pilihan)
 *   - Canvas auto-resize mengikuti lebar wrapper (16:9)
 */

/* ============================================================
 * State
 * ============================================================ */

/** @type {{ color: string, size: number, drawing: boolean, lastX: number, lastY: number }} */
const state = {
  color: '#f1f5f9',
  size: 12,
  drawing: false,
  lastX: 0,
  lastY: 0,
};

/* ============================================================
 * DOM refs
 * ============================================================ */
const canvas      = /** @type {HTMLCanvasElement} */ (document.getElementById('drawCanvas'));
const ctx         = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
const brushCursor = /** @type {HTMLElement} */ (document.getElementById('brushCursor'));
const colorPicker = /** @type {HTMLInputElement} */ (document.getElementById('colorPicker'));
const clearBtn    = document.getElementById('clearBtn');

/* ============================================================
 * Canvas sizing — maintain 16:9, fill wrapper width
 * ============================================================ */

/**
 * resize - Adjust canvas pixel dimensions to match CSS layout.
 *
 * Canvas backing store must match the displayed CSS size to avoid
 * blurry lines.  We preserve existing pixel content by blitting to
 * a temporary canvas before resizing, then restoring.
 */
function resize() {
  /* snapshot current content */
  const tmp    = document.createElement('canvas');
  tmp.width    = canvas.width;
  tmp.height   = canvas.height;
  tmp.getContext('2d').drawImage(canvas, 0, 0);

  /* recalculate pixel size from CSS layout */
  const w = canvas.offsetWidth;
  const h = Math.round(w * (9 / 16));

  canvas.width  = w;
  canvas.height = h;
  canvas.style.height = `${h}px`;

  /* restore content and reset context state (lost on resize) */
  ctx.drawImage(tmp, 0, 0);
  applyCtxDefaults();
}

/** applyCtxDefaults - Set context rendering defaults after resize. */
function applyCtxDefaults() {
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  ctx.strokeStyle = state.color;
  ctx.lineWidth   = state.size;
}

/* ============================================================
 * Drawing
 * ============================================================ */

/**
 * canvasPoint - Convert a pointer event into canvas-local coordinates.
 *
 * @param {PointerEvent} e
 * @returns {{ x: number, y: number }}
 */
function canvasPoint(e) {
  const rect  = canvas.getBoundingClientRect();
  /* scale from CSS pixels to canvas pixels */
  const scaleX = canvas.width  / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top)  * scaleY,
  };
}

/**
 * startDraw - Begin a new stroke on pointerdown.
 *
 * We call moveTo so the first pointermove draws from the click point
 * rather than from wherever the path was left previously.
 *
 * @param {PointerEvent} e
 */
function startDraw(e) {
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);

  const { x, y } = canvasPoint(e);
  state.drawing = true;
  state.lastX   = x;
  state.lastY   = y;

  /* draw a dot on click-without-move */
  ctx.beginPath();
  ctx.arc(x, y, state.size / 2, 0, Math.PI * 2);
  ctx.fillStyle = state.color;
  ctx.fill();
}

/**
 * draw - Extend the current stroke on pointermove.
 *
 * Uses quadratic Bézier midpoints for smooth curves.
 *
 * @param {PointerEvent} e
 */
function draw(e) {
  if (!state.drawing) return;
  e.preventDefault();

  const { x, y } = canvasPoint(e);

  ctx.beginPath();
  ctx.strokeStyle = state.color;
  ctx.lineWidth   = state.size;
  ctx.moveTo(state.lastX, state.lastY);
  ctx.lineTo(x, y);
  ctx.stroke();

  state.lastX = x;
  state.lastY = y;
}

/**
 * stopDraw - End the current stroke on pointerup / pointerleave.
 *
 * @param {PointerEvent} e
 */
function stopDraw(e) {
  if (!state.drawing) return;
  e.preventDefault();
  state.drawing = false;
  ctx.closePath();
}

/* ============================================================
 * Custom brush cursor
 * ============================================================ */

/**
 * updateCursor - Reposition and resize the brush cursor overlay.
 *
 * The cursor div is a circle that tracks pointer position on the
 * canvas wrapper, reflecting current brush size and color.
 *
 * @param {PointerEvent} e
 */
function updateCursor(e) {
  const rect = canvas.getBoundingClientRect();
  const x    = e.clientX - rect.left;
  const y    = e.clientY - rect.top;

  /* brush size in CSS pixels (canvas pixel → CSS pixel) */
  const cssSize = state.size * (rect.width / canvas.width);

  brushCursor.style.left   = `${x}px`;
  brushCursor.style.top    = `${y}px`;
  brushCursor.style.width  = `${cssSize}px`;
  brushCursor.style.height = `${cssSize}px`;
}

function showCursor() { brushCursor.style.display = 'block'; }
function hideCursor() { brushCursor.style.display = 'none';  }

/* ============================================================
 * Toolbar — color
 * ============================================================ */

/**
 * setColor - Update active drawing color and sync all UI.
 *
 * @param {string} hex  — CSS hex color string
 */
function setColor(hex) {
  state.color = hex;
  ctx.strokeStyle = hex;
  colorPicker.value = hex;

  /* update active swatch */
  document.querySelectorAll('.swatch[data-color]').forEach((el) => {
    el.classList.toggle('active', el.dataset.color === hex);
  });
}

/* swatch click */
document.querySelectorAll('.swatch[data-color]').forEach((btn) => {
  btn.addEventListener('click', () => setColor(btn.dataset.color));
});

/* native color picker */
colorPicker.addEventListener('input', (e) => setColor(e.target.value));

/* ============================================================
 * Toolbar — brush size
 * ============================================================ */

/**
 * setSize - Update brush size and sync UI.
 *
 * @param {number} px
 */
function setSize(px) {
  state.size      = px;
  ctx.lineWidth   = px;

  document.querySelectorAll('.size-btn').forEach((btn) => {
    btn.classList.toggle('active', Number(btn.dataset.size) === px);
  });
}

document.querySelectorAll('.size-btn').forEach((btn) => {
  btn.addEventListener('click', () => setSize(Number(btn.dataset.size)));
});

/* ============================================================
 * Toolbar — clear
 * ============================================================ */

/** clearCanvas - Wipe the entire canvas to transparent black. */
function clearCanvas() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

clearBtn.addEventListener('click', clearCanvas);

/* ============================================================
 * Canvas event listeners
 * ============================================================ */
canvas.addEventListener('pointerdown',  startDraw,  { passive: false });
canvas.addEventListener('pointermove',  draw,       { passive: false });
canvas.addEventListener('pointerup',    stopDraw,   { passive: false });
canvas.addEventListener('pointerleave', stopDraw,   { passive: false });

/* custom cursor tracking */
canvas.addEventListener('pointermove', updateCursor, { passive: true });
canvas.addEventListener('pointerenter', showCursor,  { passive: true });
canvas.addEventListener('pointerleave', hideCursor,  { passive: true });

/* ============================================================
 * Init
 * ============================================================ */

/** init - Bootstrap canvas dimensions and default context state. */
function init() {
  resize();
  applyCtxDefaults();
}

window.addEventListener('resize', resize);
init();
