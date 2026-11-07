import type { Mouse } from "../terminal/input";
import type { App } from "./app";
import { contains } from "./layout";
import type { Phone } from "./phone";
import { sidebarMouse } from "./sidebar";

const moveInterval = 12;
const wheelStep = 30;
const liftDelay = 200;

// Pointer turns clicks and drags into touches on the phones, and the wheel
// into a held finger's drag.
export class Pointer {
  private drag: { p: Phone; x: number; y: number } | null = null;
  private lastTick = 0;
  private liftTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private a: App) {}

  stop(): void {
    clearTimeout(this.liftTimer);
  }

  async mouse(m: Mouse): Promise<void> {
    const a = this.a;
    if (await sidebarMouse(a, m)) return;
    if (m.button >= 64) {
      if (m.button > 65 || m.release || m.motion) return;
      const p = this.phoneAt(m.x, m.y);
      if (!p || (a.solo && p !== a.focus)) return;
      this.dragWheel(p, m, m.button === 64 ? 1 : -1);
    } else if (m.button === 0 && !m.motion && !m.release) {
      this.lift();
      const p = this.phoneAt(m.x, m.y);
      if (!p || (a.solo && p !== a.focus)) {
        const q = p ?? a.phones.find((q) => contains(q.frame, m.x, m.y));
        if (q) await a.select(q);
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

  // flushWheel lifts a scrolling finger once no tick came for liftDelay.
  flushWheel(): void {
    if (this.drag && performance.now() - this.lastTick >= liftDelay) this.lift();
  }

  // dragWheel moves a finger that stays down while the wheel turns, starting
  // at the pointer. A swipe per burst of the wheel would put down a new
  // finger each time, which stops the fling the last one started, and
  // Android ignores the first few points of every drag. A finger that
  // reaches the screen's edge lifts and starts again from the far side.
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
