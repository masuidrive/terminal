import { useEffect, useState } from 'react';

/** Reactive `matchMedia`. Returns the current match and updates on change. */
export function useMediaQuery(query: string): boolean {
  const get = () =>
    typeof window === 'undefined' ? false : window.matchMedia(query).matches;
  const [matches, setMatches] = useState(get);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange(); // sync after mount
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
