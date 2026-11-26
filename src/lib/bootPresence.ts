/**
 * Boot da telemetria de presença. Extraído do index para testar o catch
 * não-fatal sem subir o servidor HTTP.
 */
export async function bootPresence(): Promise<void> {
  try {
    const { startPresencePersistence } = await import("./devicePresence.js");
    startPresencePersistence();
  } catch (e) {
    console.error("[presence] não iniciou (não-fatal):", e);
  }
}
