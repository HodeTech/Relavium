/** A success publication includes actual worker settlement and owned installation removal. */
export async function completeConsumer({ exercise, cleanup, cleanupFailed, publish }) {
  let result;
  let primary;
  let primaryFailure = false;
  try {
    result = await exercise();
  } catch (error) {
    primary = error;
    primaryFailure = true;
  }
  try {
    await cleanup();
  } catch (error) {
    if (!primaryFailure) throw error;
    try {
      cleanupFailed();
    } catch {
      // A failed secondary diagnostic cannot replace the original exercise failure.
    }
  }
  if (primaryFailure) throw primary;
  return publish(result);
}
