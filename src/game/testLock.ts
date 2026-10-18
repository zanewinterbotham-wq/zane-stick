// Automated test browsers (navigator.webdriver) must never capture the real cursor: on Windows a headless
// browser's pointer lock clips the owner's mouse to its invisible window. Simulate the lock instead.
if (typeof navigator !== 'undefined' && navigator.webdriver) {
  let locked: Element | null = null;
  const changed = () => document.dispatchEvent(new Event('pointerlockchange'));
  Object.defineProperty(Document.prototype, 'pointerLockElement', { configurable: true, get: () => locked });
  Element.prototype.requestPointerLock = function (this: Element) { locked = this; changed(); return Promise.resolve(); } as typeof Element.prototype.requestPointerLock;
  Document.prototype.exitPointerLock = function () { if (locked) { locked = null; changed(); } };
}
export {};
