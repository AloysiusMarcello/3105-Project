import { EndAction } from '../core/route.js';
import { NavState } from '../core/engine.js';
import { RouteGeometry } from '../core/guidance.js';
import { angleDiff } from '../core/detectors.js';

const C = {
  bg: '#F1F3F4',
  corridorFill: '#FFFFFF',
  corridorEdge: '#DADCE0',
  routeOutline: '#1557B0',
  routeActive: '#4285F4',
  routeInactive: '#AECBFA',
  routeWalked: '#BDC1C6',
  haloFill: 'rgba(66,133,244,0.20)',
  haloEdge: 'rgba(66,133,244,0.40)',
  arrow: '#1A73E8',
  arrowLost: '#9AA0A6',
  pinRed: '#EA4335',
  pinDark: '#B31412',
  poi: '#80868B',
  label: '#3C4043',
};

/**
 * Maps-style schematic map of the surveyed route (port of RouteMapView.kt).
 *
 * Navigating: heading-up, the user's arrow fixed in the lower third, the active leg in blue and
 * the walked part in grey. The light-blue halo around the arrow is the position uncertainty (±σ).
 * Before starting (or after tapping the overview button): north-up overview of the whole route.
 */
export class RouteMap {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.route = null;
    this.geo = null;
    this.snap = null;
    this._overview = true;
    this.initialised = false;
    this.frame = 0;
    // Smoothly animated camera
    Object.assign(this, { camX: 0, camY: 0, camHeading: 0, dotX: 0, dotY: 0, arrowHeading: 0, halo: 0 });
    new ResizeObserver(() => this.invalidate()).observe(canvas);
  }

  get overview() { return this._overview; }
  set overview(v) { this._overview = v; this.invalidate(); }

  setRoute(r) {
    this.route = r;
    this.geo = new RouteGeometry(r);
    this.initialised = false;
    this.invalidate();
  }

  update(s) {
    const isNav = (x) => x != null && x.state !== NavState.IDLE && x.state !== NavState.FINISHED;
    const wasNavigating = isNav(this.snap);
    const navigating = isNav(s);
    this.snap = s;
    // Follow the user when navigation starts; show the whole route when it ends.
    if (navigating !== wasNavigating) this._overview = !navigating;
    this.invalidate();
  }

  invalidate() {
    if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.draw(); });
  }

  draw() {
    const cv = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const width = cv.clientWidth;
    const height = cv.clientHeight;
    if (cv.width !== Math.round(width * dpr) || cv.height !== Math.round(height * dpr)) {
      cv.width = Math.round(width * dpr);
      cv.height = Math.round(height * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, width, height);
    const g = this.geo;
    const r = this.route;
    if (!g || !r || width === 0) return;
    const s = this.snap;

    // Target camera
    const segI = s?.segmentIndex ?? 0;
    const p = g.pointAt(segI, s?.positionM ?? 0);
    const routeHeading = g.headingAt(segI);
    const userHeading = routeHeading + (s?.netTurnDeg ?? 0);
    const tgtHalo = Math.min(s?.sigmaM ?? 0, 8);

    if (!this.initialised) {
      Object.assign(this, { camX: p.x, camY: p.y, camHeading: routeHeading, dotX: p.x, dotY: p.y, arrowHeading: userHeading, halo: tgtHalo });
      this.initialised = true;
    }
    const k = 0.18;
    this.dotX += (p.x - this.dotX) * k;
    this.dotY += (p.y - this.dotY) * k;
    this.halo += (tgtHalo - this.halo) * k;
    this.arrowHeading += angleDiff(userHeading, this.arrowHeading) * k;

    // Camera: heading-up following the user, or north-up overview of the whole route
    let scale;
    let anchorY;
    const anchorX = width / 2;
    if (this._overview) {
      const xs = g.segments.flatMap((q) => [q.x0, q.x1]);
      const ys = g.segments.flatMap((q) => [q.y0, q.y1]);
      const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      const spanX = Math.max(maxX - minX, 10);
      const spanY = Math.max(maxY - minY, 10);
      scale = Math.min((width * 0.75) / spanX, (height * 0.5) / spanY);
      this.camX += ((maxX + minX) / 2 - this.camX) * k;
      this.camY += ((maxY + minY) / 2 - this.camY) * k;
      this.camHeading += angleDiff(0, this.camHeading) * k;
      anchorY = height * 0.52;
    } else {
      scale = height / 45; // ~45 m of corridor visible
      this.camX += (this.dotX - this.camX) * k;
      this.camY += (this.dotY - this.camY) * k;
      this.camHeading += angleDiff(routeHeading, this.camHeading) * k;
      anchorY = height * 0.68;
    }
    const rot = this.camHeading;
    const th = (-rot * Math.PI) / 180;
    const cos = Math.cos(th);
    const sin = Math.sin(th);
    // world (x east, y north) -> screen
    const scr = (x, y) => {
      const sx = (x - this.camX) * scale;
      const sy = -(y - this.camY) * scale;
      return [sx * cos - sy * sin + anchorX, sx * sin + sy * cos + anchorY];
    };
    const line = (a, b, color, w) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    };
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Corridors (drawn wide, like streets)
    ctx.beginPath();
    for (const q of g.segments) {
      const a = scr(q.x0, q.y0);
      const b = scr(q.x1, q.y1);
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
    }
    ctx.strokeStyle = C.corridorEdge;
    ctx.lineWidth = 3.4 * scale + 2;
    ctx.stroke();
    ctx.strokeStyle = C.corridorFill;
    ctx.lineWidth = 3.4 * scale;
    ctx.stroke();

    // Route: inactive legs, active leg (to next waypoint), walked part
    const [aFrom, aTo] = activeRange(r, segI);
    const inActive = (i) => i >= aFrom && i <= aTo;
    const w = 7;
    g.segments.forEach((q, i) => { if (!inActive(i)) line(scr(q.x0, q.y0), scr(q.x1, q.y1), C.routeInactive, w); });
    for (let i = aFrom; i <= aTo; i++) {
      const q = g.segments[i];
      const start = i === segI ? g.pointAt(i, s?.positionM ?? 0) : { x: q.x0, y: q.y0 };
      line(scr(start.x, start.y), scr(q.x1, q.y1), C.routeOutline, w + 3);
      line(scr(start.x, start.y), scr(q.x1, q.y1), C.routeActive, w);
      if (i === segI) line(scr(q.x0, q.y0), scr(start.x, start.y), C.routeWalked, w);
    }

    // Landmarks (grey dots with labels) and waypoints (red pins)
    ctx.font = 'bold 12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    const label = (text, x, y) => {
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#FFFFFF';
      ctx.strokeText(text, x, y);
      ctx.fillStyle = C.label;
      ctx.fillText(text, x, y);
    };
    r.segments.forEach((seg, i) => {
      for (const lm of seg.landmarks) {
        if (lm.confirmsArrival) continue;
        const lp = g.pointAt(i, lm.positionM);
        const [x, y] = scr(lp.x, lp.y);
        circle(ctx, x, y, 5, '#FFFFFF');
        circle(ctx, x, y, 3.5, C.poi);
        label(lm.text, x + 8, y + 4);
      }
      if (seg.endAction === EndAction.ARRIVE) {
        const [x, y] = scr(g.segments[i].x1, g.segments[i].y1);
        pin(ctx, x, y, inActive(i) ? C.pinRed : C.pinDark, inActive(i));
        label(seg.to, x + 14, y - 16);
      }
    });

    // User arrow with uncertainty halo
    const [ux, uy] = scr(this.dotX, this.dotY);
    const haloPx = Math.max(this.halo * scale, 14);
    circle(ctx, ux, uy, haloPx, C.haloFill);
    ctx.strokeStyle = C.haloEdge;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(ux, uy, haloPx, 0, Math.PI * 2);
    ctx.stroke();
    ctx.save();
    ctx.translate(ux, uy);
    ctx.rotate(((this.arrowHeading - rot) * Math.PI) / 180);
    ctx.beginPath();
    ctx.moveTo(0, -14); ctx.lineTo(11, 12); ctx.lineTo(0, 6); ctx.lineTo(-11, 12); ctx.closePath();
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = s?.state === NavState.LOST ? C.arrowLost : C.arrow;
    ctx.fill();
    ctx.restore();

    // Keep animating until settled
    const moving = Math.abs(p.x - this.dotX) > 0.01 || Math.abs(p.y - this.dotY) > 0.01 ||
      Math.abs(tgtHalo - this.halo) > 0.01 ||
      Math.abs(angleDiff(userHeading, this.arrowHeading)) > 0.2 ||
      Math.abs(angleDiff(this._overview ? 0 : routeHeading, this.camHeading)) > 0.2;
    if (moving) this.invalidate();
  }
}

/** Segments from the current one up to and including the next ARRIVE. */
function activeRange(r, from) {
  let end = from;
  while (end < r.segments.length - 1 && r.segments[end].endAction !== EndAction.ARRIVE) end++;
  return [from, end];
}

function circle(ctx, x, y, radius, fill) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

function pin(ctx, x, y, fill, big) {
  const r = big ? 11 : 8;
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - r * 0.75, y - r * 1.4);
  // Arc from 150° to 30° clockwise (screen angles) around the pin head
  ctx.arc(x, y - r * 1.6, r, (150 * Math.PI) / 180, (30 * Math.PI) / 180, false);
  ctx.closePath();
  ctx.fill();
  circle(ctx, x, y - r * 1.6, r * 0.38, fill === C.pinDark ? '#FFFFFF' : C.pinDark);
}
