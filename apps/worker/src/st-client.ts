import type { InstallDO, StRequest, StResponse } from './install-do.js';

export type InstallStub = DurableObjectStub<InstallDO>;

type Typed<T> = Omit<StResponse, 'body'> & { body: T };

/**
 * Typed view over InstallDO.stFetch. RPC stub types can't carry generics (and choke on the
 * recursive JsonValue), so we narrow the stub to the plain method signature here.
 */
export async function st<T>(stub: InstallStub, req: StRequest): Promise<Typed<T>> {
  const plain = stub as unknown as { stFetch(r: StRequest): Promise<StResponse> };
  return (await plain.stFetch(req)) as unknown as Typed<T>;
}
