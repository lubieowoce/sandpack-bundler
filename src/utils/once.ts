type Maybe<T> = null | { value: T };

export function once<T>(create: () => T) {
  let cache: Maybe<T> = null;
  return (): T => {
    if (!cache) {
      cache = { value: create() };
    }
    return cache.value;
  };
}
