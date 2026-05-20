import { useEffect, useState } from 'react';

// Detects the on-screen keyboard via the VisualViewport API. The keyboard
// shrinks visualViewport.height; we compare it against the tallest height
// seen so far rather than window.innerHeight, because Android Chrome
// shrinks the layout viewport along with the visual one (iOS keeps
// innerHeight fixed, so that difference would work there but not on
// Android). Gated to touch devices so desktop window resizes don't
// false-positive. Publishes the visible height as the --app-height CSS
// var so the layout sits above the keyboard instead of behind it.
export function useSoftKeyboard(): boolean {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    // A soft keyboard only exists on touch devices; a fine pointer means
    // a hardware keyboard, where a window resize would false-positive.
    if (!window.matchMedia('(pointer: coarse)').matches) return;
    const vv = window.visualViewport;
    if (!vv) return;

    let maxHeight = vv.height;
    let baseWidth = vv.width;

    function update() {
      const v = window.visualViewport;
      if (!v) return;
      // A width change is a rotation / resize, not a keyboard — rebaseline.
      if (v.width !== baseWidth) {
        baseWidth = v.width;
        maxHeight = v.height;
      } else if (v.height > maxHeight) {
        maxHeight = v.height;
      }
      document.documentElement.style.setProperty('--app-height', `${v.height}px`);
      setOpen(maxHeight - v.height > 150);
    }

    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      document.documentElement.style.removeProperty('--app-height');
    };
  }, []);

  return open;
}
