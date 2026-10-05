import { describe, expect, it } from 'vitest';
import { dragRect, fittedRect } from './ImageCropper';

describe('crop frame', () => {
  it('fits a fixed shape centered in the picture', () => {
    expect(fittedRect(1, 2000, 1000)).toEqual({ x: 0.25, y: 0, w: 0.5, h: 1 });
    expect(fittedRect(null, 2000, 1000)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
  it('moves inside the picture and resizes from a corner without leaving it', () => {
    const start = { x: 0.2, y: 0.2, w: 0.5, h: 0.5 };
    expect(dragRect(start, 'move', 0.9, -0.9, null, 100, 100)).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.5 });
    const grown = dragRect(start, 'se', 0.5, 0.5, null, 100, 100);
    expect(grown.x).toBeCloseTo(0.2); expect(grown.w).toBeCloseTo(0.8); expect(grown.h).toBeCloseTo(0.8);
    const shrunk = dragRect(start, 'nw', 0.6, 0.6, null, 100, 100);
    expect(shrunk.w).toBeCloseTo(0.06); expect(shrunk.x + shrunk.w).toBeCloseTo(0.7);
  });
  it('keeps the square shape on a wide picture while resizing', () => {
    const square = fittedRect(1, 2000, 1000), next = dragRect(square, 'se', -0.1, 0.05, 1, 2000, 1000);
    expect((next.w * 2000) / (next.h * 1000)).toBeCloseTo(1);
    expect(next.x).toBeCloseTo(square.x); expect(next.y).toBeCloseTo(square.y);
  });
});
