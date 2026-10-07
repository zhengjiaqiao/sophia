/// `/`：按 lang cookie / Accept-Language 跳语言页，见 _lib/lang.ts
import { handleIndex } from "./_lib/lang.ts";

export const onRequest = (context: { request: Request; next: () => Promise<Response> }): Promise<Response> =>
  handleIndex(context.request, () => context.next());
