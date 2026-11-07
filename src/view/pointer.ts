import type { Mouse } from "../terminal/input";
import type { App } from "./app";
import { contains } from "./layout";
import type { Phone } from "./phone";
import { sidebarMouse } from "./sidebar";

const moveInterval = 12;
const wheelWindow = 100;
const wheelStep = 30;
const liftDelay = 200;

// Pointer turns clicks and drags into touches on the phones, and the wheel
// into swipes or a held finger's drag.
export class Pointer {
  private wheelPhone: Phone | null = null;
  private wheelDY = 0;
  private wheelX = 0;
  private wheelY = 0;
  private wheelTimer: ReturnType<typeof setTimeout> | undefined;

  private drag: { p: Phone; x: number; y: number } | null = null;
  private lastTick = 0;
  private liftTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private a: App) {}

  stop(): void {
    clearTimeout(this.wheelTimer);
    clearTimeout(this.liftTimer);
  }

  async mouse(m: Mouse): Promise<void> {
    const a = this.a;
    if (await sidebarMouse(a, m)) return;
    if (m.button >= 64) {
      if (m.button > 65 || m.release || m.motion) return;
      const p = this.phoneAt(m.x, m.y);
      if (!p) return;
      const dir = m.button === 64 ? 1 : -1;
      if (p.session?.dragScroll) {
        this.dragWheel(p, m, dir);
        return;
      }
      if (p !== this.wheelPhone && this.wheelPhone) this.flushSwipe();
      this.wheelPhone = p;
      this.wheelDY += dir;
      [this.wheelX, this.wheelY] = p.point(m.x, m.y);
      this.wheelTimer ??= setTimeout(() => a.events.push({ kind: "wheel" }), wheelWindow);
    } else if (m.button === 0 && !m.motion && !m.release) {
      this.lift();
      const p = this.phoneAt(m.x, m.y);
      if (!p) {
        for (const q of a.phones) if (contains(q.frame, m.x, m.y)) a.setFocus(q);
        return;
      }
      a.setFocus(p);
      p.touching = true;
      p.lastMove = performance.now();
      this.touch(p, m, true);
    } else if (m.motion && m.button === 0) {
      for (const p of a.phones) {
        if (p.touching && performance.now() - p.lastMove >= moveInterval) {
          p.lastMove = performance.now();
          this.touch(p, m, true);
        }
      }
    } else if (m.release) {
      for (const p of a.phones) {
        if (p.touching) {
          p.touching = false;
          this.touch(p, m, false);
        }
      }
    }
  }

  // flushWheel acts on a wheel that has rested: it sends the pending swipe,
  // and lifts a scrolling finger once no tick came for liftDelay.
  flushWheel(): void {
    this.flushSwipe();
    if (this.drag && performance.now() - this.lastTick >= liftDelay) this.lift();
  }

  // flushSwipe turns the wheel ticks of the last moment into one swipe
  // centred on the pointer. Sending a swipe per tick would queue up faster
  // than the phone plays them.
  private flushSwipe(): void {
    clearTimeout(this.wheelTimer);
    this.wheelTimer = undefined;
    const p = this.wheelPhone;
    const d = Math.min(Math.max(this.wheelDY * wheelStep, -400), 400);
    this.wheelDY = 0;
    const s = p?.session;
    if (!p || !s || d === 0) return;
    const h = p.screen.heightPoints;
    const y0 = Math.min(Math.max(this.wheelY - d / 2, 1), h - 1);
    const y1 = Math.min(Math.max(this.wheelY + d / 2, 1), h - 1);
    this.a.report(s.swipe(this.wheelX, y0, this.wheelX, y1, 0.08));
  }

  // dragWheel moves a finger that stays down while the wheel turns, starting
  // at the pointer. One that reaches the screen's edge lifts and starts again
  // from the far side.
  private dragWheel(p: Phone, m: Mouse, dir: number): void {
    const s = p.session!;
    const h = p.screen.heightPoints;
    if (this.drag && this.drag.p !== p) this.lift();
    let d = this.drag;
    if (d && (d.y + dir * wheelStep < 1 || d.y + dir * wheelStep > h - 1)) {
      this.lift();
      d = { p, x: d.x, y: dir > 0 ? h * 0.2 : h * 0.8 };
    } else if (!d) {
      const [x, y] = p.point(m.x, m.y);
      d = { p, x, y };
    }
    if (d !== this.drag) {
      this.drag = d;
      this.a.report(s.touch(d.x, d.y, true));
    }
    d.y = Math.min(Math.max(d.y + dir * wheelStep, 1), h - 1);
    this.a.report(s.touch(d.x, d.y, true));
    this.lastTick = performance.now();
    clearTimeout(this.liftTimer);
    this.liftTimer = setTimeout(() => this.a.events.push({ kind: "wheel" }), liftDelay);
  }

  private lift(): void {
    clearTimeout(this.liftTimer);
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    const s = d.p.session;
    if (s) this.a.report(s.touch(d.x, d.y, false));
  }

  private touch(p: Phone, m: Mouse, down: boolean): void {
    const s = p.session;
    if (!s) return;
    const [x, y] = p.point(m.x, m.y);
    this.a.report(s.touch(x, y, down));
  }

  private phoneAt(px: number, py: number): Phone | null {
    return this.a.phones.find((p) => p.session && contains(p.box, px, py)) ?? null;
  }
}
