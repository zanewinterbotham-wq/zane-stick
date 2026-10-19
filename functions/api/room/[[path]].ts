// Pages Function for /api/room/*: hands every request (WebSocket upgrades included) to the room Durable Objects.
import { routeRoom, type DONamespace } from '../../../server/rooms/index';

export const onRequest = (ctx: { request: Request; env: { ROOMS: DONamespace } }) => routeRoom(ctx.request, ctx.env.ROOMS);
