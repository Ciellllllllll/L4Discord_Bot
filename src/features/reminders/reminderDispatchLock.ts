const lockChains = new Map<string, Promise<void>>();

export async function withReminderDispatchLock<T>(
  reminderId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = lockChains.get(reminderId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prev.then(() => current);
  lockChains.set(reminderId, tail);

  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (lockChains.get(reminderId) === tail) {
      lockChains.delete(reminderId);
    }
  }
}
