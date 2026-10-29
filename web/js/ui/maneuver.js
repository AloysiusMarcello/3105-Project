import { Maneuver } from '../core/guidance.js';

/** Filled arrow head with its tip at (x, y), pointing `deg` clockwise from up. */
const head = (x, y, deg) =>
  `<path d="M0,-1 L4.5,5 L-4.5,5 Z" fill="#fff" stroke="none" transform="translate(${x} ${y}) rotate(${deg})"/>`;

const SHAPES = {
  [Maneuver.STRAIGHT]: `<path d="M12,21 L12,5"/>${head(12, 3, 0)}`,
  [Maneuver.TURN_LEFT]: `<path d="M16,21 L16,13 Q16,9 12,9 L6,9"/>${head(4, 9, -90)}`,
  [Maneuver.TURN_RIGHT]: `<path d="M8,21 L8,13 Q8,9 12,9 L18,9"/>${head(20, 9, 90)}`,
  [Maneuver.FACE_LEFT]: `<path d="M18,12 L7,12"/>${head(4.5, 12, -90)}<path d="M2,5 L2,19" stroke-width="2"/>`,
  [Maneuver.FACE_RIGHT]: `<path d="M6,12 L17,12"/>${head(19.5, 12, 90)}<path d="M21,5 L21,19" stroke-width="2"/>`,
  [Maneuver.TURN_AROUND]: `<path d="M16,21 L16,8 A4,4 0 0 0 8,8 L8,17"/>${head(8, 19.5, 180)}`,
  [Maneuver.LOST]: '<circle cx="12" cy="12" r="9.5"/><path d="M12,7 L12,13.5"/><circle cx="12" cy="17" r="1.5" fill="#fff" stroke="none"/>',
};
const PIN = '<path d="M12,22 L6.37,12.25 A6.5,6.5 0 1 1 17.63,12.25 Z" fill="#fff" stroke="none"/>' +
  '<circle cx="12" cy="9" r="2.4" fill="#188038" stroke="none"/>';
SHAPES[Maneuver.ARRIVE] = PIN;
SHAPES[Maneuver.DONE] = PIN;

/** The turn arrow drawn in the instruction banner (white strokes, like a navigation turn card). */
export function maneuverSvg(m) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="#fff" stroke-width="2.6" ` +
    `stroke-linecap="round" stroke-linejoin="round">${SHAPES[m] ?? SHAPES[Maneuver.STRAIGHT]}</svg>`;
}
