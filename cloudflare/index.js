import { DurableObject } from 'cloudflare:workers';
import { HostedController } from './controller.js';
import { route } from './protocol.js';

export class UiExecutionContainer extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.hosted = new HostedController(ctx, env); }
  fetch(request) { return this.hosted.fetch(request); }
  alarm() { return this.hosted.alarm(); }
}
export default { fetch: route };
